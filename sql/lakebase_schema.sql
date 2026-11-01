-- Applied by the setup job (src/benchmark_runner/setup.py); safe to re-run.
-- Lakebase (Postgres) serving copy of the Delta results tables.
-- Delta (<catalog>.<schema>.benchmark_*) remains the source of truth;
-- the benchmark job upserts the same rows here for fast reads by the app.
CREATE SCHEMA IF NOT EXISTS benchmarks;

CREATE TABLE IF NOT EXISTS benchmarks.benchmark_runs (
  run_id          TEXT PRIMARY KEY,
  job_run_id      BIGINT,
  endpoint        TEXT NOT NULL,
  served_entity   TEXT,
  benchmarks      TEXT,
  sample_limit    INTEGER,
  status          TEXT,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  duration_s      DOUBLE PRECISION,
  harness_version TEXT,
  request_params  TEXT,
  mlflow_run_id   TEXT,
  error           TEXT,
  requested_by    TEXT
);

CREATE TABLE IF NOT EXISTS benchmarks.benchmark_scores (
  score_id   TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  benchmark  TEXT NOT NULL,
  task       TEXT NOT NULL,
  metric     TEXT NOT NULL,
  filter     TEXT,
  value      DOUBLE PRECISION,
  stderr     DOUBLE PRECISION,
  n_samples  INTEGER,
  is_primary BOOLEAN,
  created_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS benchmark_scores_run_idx ON benchmarks.benchmark_scores (run_id);
CREATE INDEX IF NOT EXISTS benchmark_scores_primary_idx ON benchmarks.benchmark_scores (benchmark, is_primary);
CREATE INDEX IF NOT EXISTS benchmark_runs_started_idx ON benchmarks.benchmark_runs (started_at DESC);
