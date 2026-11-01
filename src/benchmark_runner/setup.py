"""Create (idempotently) everything the benchmark job and app need, and grant the app read access.

- Unity Catalog: <catalog>.<schema> with the Delta results tables and the artifacts volume
- Lakebase: the `benchmarks` Postgres schema and tables (sql/lakebase_schema.sql)
- Lakebase grants: read-only access for the app's service principal, if one is given

Runs as the job's identity, which must be able to create a schema in the catalog and must own
(or be databricks_superuser on) the Lakebase project.
"""

import argparse
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(sys._getframe().f_code.co_filename)))

import lakebase  # noqa: E402
from databricks.sdk import WorkspaceClient  # noqa: E402
from pyspark.sql import SparkSession  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("setup")

LAKEBASE_DDL = os.path.join(
    os.path.dirname(os.path.abspath(sys._getframe().f_code.co_filename)), "..", "..", "sql", "lakebase_schema.sql"
)

DELTA_DDL = [
    "CREATE SCHEMA IF NOT EXISTS {fq} COMMENT 'LLM public benchmark results (lm-evaluation-harness)'",
    "CREATE VOLUME IF NOT EXISTS {fq}.artifacts COMMENT 'lm-eval raw results and per-sample logs'",
    """CREATE TABLE IF NOT EXISTS {fq}.benchmark_runs (
      run_id STRING NOT NULL COMMENT 'UUID generated per benchmark job run',
      job_run_id BIGINT, endpoint STRING NOT NULL, served_entity STRING,
      benchmarks STRING COMMENT 'comma-separated benchmark keys',
      sample_limit INT COMMENT 'per-task limit; NULL = full benchmark',
      status STRING COMMENT 'RUNNING | SUCCEEDED | FAILED | PARTIAL',
      started_at TIMESTAMP, finished_at TIMESTAMP, duration_s DOUBLE,
      harness_version STRING, request_params STRING COMMENT 'params actually sent to the endpoint (JSON)',
      mlflow_run_id STRING, error STRING, requested_by STRING,
      CONSTRAINT benchmark_runs_pk PRIMARY KEY (run_id)
    ) TBLPROPERTIES (delta.enableChangeDataFeed = true)""",
    """CREATE TABLE IF NOT EXISTS {fq}.benchmark_scores (
      score_id STRING NOT NULL COMMENT 'run_id|task|metric|filter', run_id STRING NOT NULL, endpoint STRING NOT NULL,
      benchmark STRING NOT NULL COMMENT 'app-level benchmark key, e.g. mmlu_pro',
      task STRING NOT NULL COMMENT 'lm-eval task or subtask',
      metric STRING NOT NULL, filter STRING, value DOUBLE, stderr DOUBLE, n_samples INT,
      is_primary BOOLEAN COMMENT 'headline score for the benchmark', created_at TIMESTAMP,
      CONSTRAINT benchmark_scores_pk PRIMARY KEY (score_id)
    ) TBLPROPERTIES (delta.enableChangeDataFeed = true)""",
]

APP_GRANTS = [
    'GRANT USAGE ON SCHEMA benchmarks TO "{sp}"',
    'GRANT SELECT ON ALL TABLES IN SCHEMA benchmarks TO "{sp}"',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA benchmarks GRANT SELECT ON TABLES TO "{sp}"',
]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--catalog", required=True)
    p.add_argument("--schema", required=True)
    p.add_argument("--lakebase_endpoint", required=True)
    p.add_argument("--lakebase_database", default="databricks_postgres")
    p.add_argument("--app_service_principal", default="", help="app SP client id to grant read access")
    args = p.parse_args()

    spark = SparkSession.builder.getOrCreate()
    fq = f"`{args.catalog}`.`{args.schema}`"
    for stmt in DELTA_DDL:
        spark.sql(stmt.format(fq=fq))
    log.info("Unity Catalog objects ready in %s", fq)

    w = WorkspaceClient()
    with open(LAKEBASE_DDL) as f:
        ddl = f.read()
    with lakebase.connect(w, args.lakebase_endpoint, args.lakebase_database) as conn:
        conn.execute(ddl)
        log.info("Lakebase schema 'benchmarks' ready")
        sp = args.app_service_principal.strip()
        if sp:
            if not all(c.isalnum() or c == "-" for c in sp):
                raise ValueError(f"Unexpected service principal id: {sp!r}")
            for stmt in APP_GRANTS:
                conn.execute(stmt.format(sp=sp))
            log.info("Granted read access on Lakebase schema 'benchmarks' to %s", sp)


if __name__ == "__main__":
    main()
