import { useCallback, useEffect, useState } from 'react';

export interface BenchmarkInfo {
  key: string;
  label: string;
  category: string;
  metric: string;
  fullSize: number;
  subtasks: number;
  description: string;
  note?: string;
}

export interface SampleLimit {
  value: number;
  label: string;
}

export interface ModelOption {
  name: string;
  servedEntity: string | null;
}

export type RunStatus = 'QUEUED' | 'STARTING' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED';

export interface BenchmarkRun {
  run_id: string;
  job_run_id: number | null;
  endpoint: string;
  served_entity?: string | null;
  benchmarks: string;
  sample_limit: number | null;
  status: RunStatus;
  started_at: string | null;
  finished_at?: string | null;
  duration_s?: number | null;
  request_params?: string | null;
  mlflow_run_id?: string | null;
  error?: string | null;
  requested_by?: string | null;
  run_page_url: string | null;
  cancellable: boolean;
}

export interface LeaderboardScore {
  endpoint: string;
  benchmark: string;
  value: number;
  stderr: number | null;
  n_samples: number | null;
  run_id: string;
  sample_limit: number;
  finished_at: string;
  served_entity: string | null;
}

export interface RunScore {
  benchmark: string;
  task: string;
  metric: string;
  filter: string;
  value: number;
  stderr: number | null;
  n_samples: number | null;
  is_primary: boolean;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Fetch JSON on mount and whenever `path` changes; `reload` refetches, keeping the current data visible. */
export function useApi<T>(path: string | null) {
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ key: string | null; path: string | null; data: T | null; error: string | null }>({
    key: null,
    path: null,
    data: null,
    error: null,
  });
  const key = path ? `${path}#${version}` : null;

  useEffect(() => {
    if (!path || !key) return;
    let cancelled = false;
    apiFetch<T>(path)
      .then((data) => {
        if (!cancelled) setResult({ key, path, data, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setResult((r) => ({
            key,
            path,
            data: r.path === path ? r.data : null,
            error: e instanceof Error ? e.message : String(e),
          }));
      });
    return () => {
      cancelled = true;
    };
  }, [path, key]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const current = result.path === path;
  return {
    data: current ? result.data : null,
    error: current ? result.error : null,
    loading: key !== null && result.key !== key,
    reload,
  };
}

export function formatPct(value: number | null | undefined, digits = 1) {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(digits)}%`;
}

export function formatDateTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : '—';
}

export function formatDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m ${Math.round(seconds % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function sampleLabel(limit: number | null | undefined) {
  return limit ? `${limit}/task` : 'Full';
}
