// API for the benchmark app.
// Results are read from Lakebase (benchmarks.* tables, written by the benchmark job — the app
// only reads them). Runs are started and cancelled through the Jobs plugin; in-flight state that
// hasn't reached Lakebase yet (queued/starting runs) comes from the Jobs API.

import { randomUUID } from 'node:crypto';
import { getWorkspaceClient, type JobAPI } from '@databricks/appkit';
import type { Application, Request, Response } from 'express';
import { z } from 'zod';
import { AREAS, BENCHMARKS, BENCHMARK_KEYS, SAMPLE_LIMITS } from '../benchmarks';

interface AppKitForBenchmarks {
  lakebase: {
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  jobs(jobKey: string): JobAPI;
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

interface ModelOption {
  name: string;
  servedEntity: string | null;
}

const JOB_KEY = 'default';
const MODEL_CACHE_MS = 5 * 60 * 1000;
const ACTIVE_STATES = new Set(['QUEUED', 'PENDING', 'RUNNING', 'BLOCKED', 'WAITING_FOR_RETRY', 'TERMINATING']);

const StartRunBody = z.object({
  endpoint: z.string().min(1),
  benchmarks: z.array(z.enum(BENCHMARK_KEYS)).min(1),
  sampleLimit: z.number().int().refine((v) => SAMPLE_LIMITS.some((s) => s.value === v), 'Unsupported sample limit'),
});

const RUNS_SQL = `
  SELECT run_id, job_run_id, endpoint, served_entity, benchmarks, sample_limit, status,
         started_at, finished_at, duration_s, request_params, mlflow_run_id, error, requested_by
  FROM benchmarks.benchmark_runs
  ORDER BY started_at DESC
  LIMIT 100`;

// Latest headline score per model x benchmark. Optional $1 restricts to one sample size
// (0 = full benchmark) so a column never mixes 10-question smoke tests with full runs.
const LEADERBOARD_SQL = `
  SELECT DISTINCT ON (s.endpoint, s.benchmark)
         s.endpoint, s.benchmark, s.value, s.stderr, s.n_samples, s.run_id,
         COALESCE(r.sample_limit, 0) AS sample_limit, r.finished_at, r.served_entity
  FROM benchmarks.benchmark_scores s
  JOIN benchmarks.benchmark_runs r ON r.run_id = s.run_id
  WHERE s.is_primary
    AND r.status IN ('SUCCEEDED', 'PARTIAL')
    AND ($1::int IS NULL OR COALESCE(r.sample_limit, 0) = $1::int)
  ORDER BY s.endpoint, s.benchmark, r.finished_at DESC`;

const RUN_SCORES_SQL = `
  SELECT benchmark, task, metric, filter, value, stderr, n_samples, is_primary
  FROM benchmarks.benchmark_scores
  WHERE run_id = $1
  ORDER BY benchmark, is_primary DESC, task, metric`;

function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

function sendError(res: Response, status: number, e: unknown) {
  console.error('[benchmarks]', e);
  res.status(status).json({ error: errorMessage(e) });
}

function jobParam(run: { job_parameters?: { name?: string; value?: string }[] }, name: string) {
  return run.job_parameters?.find((p) => p.name === name)?.value ?? '';
}

export function setupBenchmarkRoutes(appkit: AppKitForBenchmarks) {
  let modelCache: { at: number; models: ModelOption[] } | null = null;

  async function listChatModels(): Promise<ModelOption[]> {
    if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
    const models: ModelOption[] = [];
    for await (const ep of getWorkspaceClient({}).servingEndpoints.list()) {
      if (ep.task !== 'llm/v1/chat' || ep.state?.ready !== 'READY' || !ep.name) continue;
      const entity = ep.config?.served_entities?.[0];
      models.push({
        name: ep.name,
        servedEntity: entity?.entity_name ?? entity?.foundation_model?.name ?? null,
      });
    }
    models.sort((a, b) => a.name.localeCompare(b.name));
    modelCache = { at: Date.now(), models };
    return models;
  }

  appkit.server.extend((app) => {
    app.get('/api/whoami', (req: Request, res: Response) => {
      res.json({ email: req.header('x-forwarded-email') ?? null });
    });

    app.get('/api/benchmarks', (_req: Request, res: Response) => {
      res.json({ benchmarks: BENCHMARKS, sampleLimits: SAMPLE_LIMITS, areas: AREAS });
    });

    app.get('/api/models', async (_req: Request, res: Response) => {
      try {
        res.json({ models: await listChatModels() });
      } catch (e) {
        sendError(res, 502, e);
      }
    });

    app.post('/api/runs', async (req: Request, res: Response) => {
      const parsed = StartRunBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const { endpoint, benchmarks, sampleLimit } = parsed.data;
      try {
        const models = await listChatModels();
        if (!models.some((m) => m.name === endpoint)) {
          res.status(400).json({ error: `Endpoint ${endpoint} is not a ready chat endpoint` });
          return;
        }
        const runId = randomUUID();
        const result = await appkit.jobs(JOB_KEY).runNow({
          job_parameters: {
            endpoint,
            benchmarks: benchmarks.join(','),
            sample_limit: String(sampleLimit),
            run_id: runId,
            requested_by: req.header('x-forwarded-email') ?? '',
          },
        });
        if (!result.ok) {
          sendError(res, 502, `Could not start the benchmark job (status ${result.status})`);
          return;
        }
        res.status(201).json({ runId, jobRunId: result.data.run_id });
      } catch (e) {
        sendError(res, 500, e);
      }
    });

    app.get('/api/runs', async (_req: Request, res: Response) => {
      try {
        const [{ rows }, jobRuns] = await Promise.all([
          appkit.lakebase.query(RUNS_SQL),
          appkit.jobs(JOB_KEY).listRuns({ limit: 25 }),
        ]);
        const recent = jobRuns.ok ? jobRuns.data : [];
        const byJobRunId = new Map(recent.map((r) => [r.run_id, r]));
        const recorded = new Set(rows.map((r) => Number(r.job_run_id)));

        const runs = rows.map((row) => {
          const job = byJobRunId.get(Number(row.job_run_id));
          const lifecycle = job?.state?.life_cycle_state;
          // The job crashed before it could record a final status.
          const orphaned = row.status === 'RUNNING' && job && lifecycle && !ACTIVE_STATES.has(lifecycle);
          return {
            ...row,
            status: orphaned ? 'FAILED' : row.status,
            error: orphaned ? (row.error ?? job.state?.state_message ?? 'Job ended unexpectedly') : row.error,
            run_page_url: job?.run_page_url ?? null,
            cancellable: Boolean(lifecycle && ACTIVE_STATES.has(lifecycle)),
          };
        });

        // Runs the job hasn't recorded yet (queued, or installing the environment).
        const pending = recent
          .filter((r) => r.run_id && !recorded.has(r.run_id) && ACTIVE_STATES.has(r.state?.life_cycle_state ?? ''))
          .map((r) => ({
            run_id: jobParam(r, 'run_id') || `job-${r.run_id}`,
            job_run_id: r.run_id,
            endpoint: jobParam(r, 'endpoint'),
            benchmarks: jobParam(r, 'benchmarks'),
            sample_limit: Number(jobParam(r, 'sample_limit')) || null,
            status: r.state?.life_cycle_state === 'QUEUED' ? 'QUEUED' : 'STARTING',
            started_at: r.start_time ? new Date(r.start_time).toISOString() : null,
            requested_by: jobParam(r, 'requested_by') || null,
            run_page_url: r.run_page_url ?? null,
            cancellable: true,
          }));

        res.json({ runs: [...pending, ...runs], jobsApiAvailable: jobRuns.ok });
      } catch (e) {
        sendError(res, 500, e);
      }
    });

    app.delete('/api/runs/:jobRunId', async (req: Request, res: Response) => {
      const jobRunId = Number(req.params.jobRunId);
      if (!Number.isInteger(jobRunId)) {
        res.status(400).json({ error: 'Invalid job run id' });
        return;
      }
      const result = await appkit.jobs(JOB_KEY).cancelRun(jobRunId);
      if (!result.ok) {
        sendError(res, result.status === 404 ? 404 : 502, `Could not cancel run (status ${result.status})`);
        return;
      }
      res.status(204).send();
    });

    app.get('/api/runs/:runId/scores', async (req: Request, res: Response) => {
      try {
        const { rows } = await appkit.lakebase.query(RUN_SCORES_SQL, [req.params.runId]);
        res.json({ scores: rows });
      } catch (e) {
        sendError(res, 500, e);
      }
    });

    app.get('/api/leaderboard', async (req: Request, res: Response) => {
      const raw = req.query.sampleLimit;
      const sampleLimit = raw === undefined || raw === 'any' ? null : Number(raw);
      if (sampleLimit !== null && !SAMPLE_LIMITS.some((s) => s.value === sampleLimit)) {
        res.status(400).json({ error: 'Unsupported sample limit' });
        return;
      }
      try {
        const { rows } = await appkit.lakebase.query(LEADERBOARD_SQL, [sampleLimit]);
        res.json({ scores: rows });
      } catch (e) {
        sendError(res, 500, e);
      }
    });
  });
}
