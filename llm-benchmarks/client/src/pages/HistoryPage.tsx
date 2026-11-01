import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@databricks/appkit-ui/react';
import { ExternalLink, RefreshCw, Square } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  apiFetch,
  formatDateTime,
  formatDuration,
  formatPct,
  sampleLabel,
  useApi,
  type BenchmarkInfo,
  type BenchmarkRun,
  type RunScore,
  type RunStatus,
} from '../api';

const POLL_MS = 10_000;
const ACTIVE: RunStatus[] = ['QUEUED', 'STARTING', 'RUNNING'];

const STATUS_STYLE: Record<RunStatus, string> = {
  QUEUED: 'bg-muted text-muted-foreground',
  STARTING: 'bg-muted text-muted-foreground',
  RUNNING: 'bg-primary text-primary-foreground',
  SUCCEEDED: 'bg-success text-success-foreground',
  PARTIAL: 'bg-warning text-warning-foreground',
  FAILED: 'bg-destructive text-destructive-foreground',
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return <Badge className={STATUS_STYLE[status] ?? ''}>{status.toLowerCase()}</Badge>;
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function HistoryPage({ benchmarks }: { benchmarks: BenchmarkInfo[] }) {
  const runs = useApi<{ runs: BenchmarkRun[]; jobsApiAvailable: boolean }>('/api/runs');
  const [detail, setDetail] = useState<BenchmarkRun | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const labels = useMemo(() => new Map(benchmarks.map((b) => [b.key, b.label])), [benchmarks]);
  const anyActive = runs.data?.runs.some((r) => ACTIVE.includes(r.status)) ?? false;
  const { reload } = runs;

  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [anyActive, reload]);

  async function cancel(run: BenchmarkRun) {
    setCancelError(null);
    try {
      await apiFetch(`/api/runs/${run.job_run_id}`, { method: 'DELETE' });
      reload();
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Run history</CardTitle>
          <CardDescription>
            Last 100 benchmark runs{anyActive ? ' · refreshing every 10s while runs are active' : ''}.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={reload} disabled={runs.loading}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {runs.error && (
          <Alert variant="destructive">
            <AlertTitle>Could not load runs</AlertTitle>
            <AlertDescription>{runs.error}</AlertDescription>
          </Alert>
        )}
        {runs.data && !runs.data.jobsApiAvailable && (
          <Alert>
            <AlertTitle>Live job status unavailable</AlertTitle>
            <AlertDescription>Showing recorded runs only; queued runs may be missing.</AlertDescription>
          </Alert>
        )}
        {cancelError && (
          <Alert variant="destructive">
            <AlertTitle>Cancel failed</AlertTitle>
            <AlertDescription>{cancelError}</AlertDescription>
          </Alert>
        )}
        {runs.loading && !runs.data && <Skeleton className="h-48 w-full" />}
        {runs.data && runs.data.runs.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No runs yet</EmptyTitle>
              <EmptyDescription>Start one from the “Run a benchmark” tab.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {runs.data && runs.data.runs.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Benchmarks</TableHead>
                <TableHead>Sample</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data.runs.map((run) => (
                <TableRow key={run.run_id}>
                  <TableCell>
                    <StatusBadge status={run.status} />
                  </TableCell>
                  <TableCell className="font-medium">{run.endpoint}</TableCell>
                  <TableCell className="max-w-xs whitespace-normal text-sm">
                    {run.benchmarks
                      .split(',')
                      .map((k) => labels.get(k) ?? k)
                      .join(', ')}
                  </TableCell>
                  <TableCell>{sampleLabel(run.sample_limit)}</TableCell>
                  <TableCell className="text-sm">{formatDateTime(run.started_at)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatDuration(run.duration_s)}</TableCell>
                  <TableCell className="text-right space-x-1 whitespace-nowrap">
                    {!ACTIVE.includes(run.status) && (
                      <Button variant="ghost" size="sm" onClick={() => setDetail(run)}>
                        Details
                      </Button>
                    )}
                    {run.cancellable && run.job_run_id && (
                      <Button variant="ghost" size="sm" onClick={() => void cancel(run)}>
                        <Square className="h-3 w-3" />
                        Cancel
                      </Button>
                    )}
                    {run.run_page_url && (
                      <Button variant="ghost" size="sm" asChild>
                        <a href={run.run_page_url} target="_blank" rel="noopener noreferrer">
                          Job <ExternalLink className="h-3 w-3" />
                        </a>
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <RunDetailDialog run={detail} labels={labels} onClose={() => setDetail(null)} />
    </Card>
  );
}

interface RequestParams {
  unsupported?: string[];
  usage?: { prompt_tokens: number; completion_tokens: number; requests: number; failed: number };
}

function RunDetailDialog({
  run,
  labels,
  onClose,
}: {
  run: BenchmarkRun | null;
  labels: Map<string, string>;
  onClose: () => void;
}) {
  const scores = useApi<{ scores: RunScore[] }>(run ? `/api/runs/${encodeURIComponent(run.run_id)}/scores` : null);
  const params = parseJson<RequestParams>(run?.request_params);
  const errors = parseJson<Record<string, string>>(run?.error);

  return (
    <Dialog open={run !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        {run && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {run.endpoint} <StatusBadge status={run.status} />
              </DialogTitle>
              <DialogDescription>
                {sampleLabel(run.sample_limit)} · finished {formatDateTime(run.finished_at)} · run{' '}
                <code className="text-xs">{run.run_id}</code>
                {run.requested_by ? ` · by ${run.requested_by}` : ''}
              </DialogDescription>
            </DialogHeader>

            {params && (
              <p className="text-sm text-muted-foreground">
                {params.usage &&
                  `${params.usage.requests.toLocaleString()} requests, ${params.usage.completion_tokens.toLocaleString()} output tokens` +
                    (params.usage.failed ? `, ${params.usage.failed} failed requests scored as wrong` : '')}
                {params.unsupported?.length
                  ? `. Endpoint rejected ${params.unsupported.join(', ')}, so those were not sent (provider defaults applied).`
                  : '. Sent temperature 0 and task stop sequences.'}
              </p>
            )}

            {errors && (
              <Alert variant="destructive">
                <AlertTitle>Failures</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-4 space-y-1">
                    {Object.entries(errors).map(([k, v]) => (
                      <li key={k}>
                        <span className="font-medium">{labels.get(k) ?? k}:</span> {v}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {scores.loading && <Skeleton className="h-32 w-full" />}
            {scores.error && (
              <Alert variant="destructive">
                <AlertDescription>{scores.error}</AlertDescription>
              </Alert>
            )}
            {scores.data && scores.data.scores.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Benchmark</TableHead>
                    <TableHead>Task</TableHead>
                    <TableHead>Metric</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                    <TableHead className="text-right">± SE</TableHead>
                    <TableHead className="text-right">n</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scores.data.scores.map((s) => (
                    <TableRow key={`${s.task}|${s.metric}|${s.filter}`} className={s.is_primary ? 'font-semibold' : ''}>
                      <TableCell>{labels.get(s.benchmark) ?? s.benchmark}</TableCell>
                      <TableCell className="text-sm">{s.task}</TableCell>
                      <TableCell className="text-sm">
                        {s.metric}
                        {s.filter !== 'none' && <span className="text-muted-foreground"> ({s.filter})</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatPct(s.value)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatPct(s.stderr)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{s.n_samples ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {scores.data && scores.data.scores.length === 0 && !errors && (
              <p className="text-sm text-muted-foreground">No scores were recorded for this run.</p>
            )}
            <p className="text-xs text-muted-foreground">
              Bold rows are each benchmark&apos;s headline score. Raw lm-eval output and per-question logs are in the
              artifacts volume under this run ID, and in MLflow
              {run.mlflow_run_id ? ` (run ${run.mlflow_run_id})` : ''}.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
