"""Run public LLM benchmarks against a Databricks serving endpoint and record the scores.

Results go to:
- Delta (source of truth): <catalog>.<schema>.benchmark_runs / benchmark_scores
- Lakebase (serving copy for the app): benchmarks.benchmark_runs / benchmark_scores
- MLflow: one run per benchmark job run, in --experiment
- UC Volume: raw lm-eval results and per-sample logs under <volume>/<run_id>/<benchmark>/
"""

import argparse
import json
import logging
import math
import os
import subprocess
import sys
import tempfile
import time
import traceback
import uuid
from datetime import datetime, timezone

# Serverless spark_python_task exec()s the file without __file__; the code object keeps its path.
sys.path.insert(0, os.path.dirname(os.path.abspath(sys._getframe().f_code.co_filename)))

import lm_eval  # noqa: E402
import mlflow  # noqa: E402
from databricks.sdk import WorkspaceClient  # noqa: E402
from pyspark.sql import SparkSession  # noqa: E402

import lakebase  # noqa: E402
from benchmarks import BENCHMARKS  # noqa: E402
from databricks_lm import DatabricksChatLM  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("run_benchmark")

RUN_COLUMNS = [
    "run_id", "job_run_id", "endpoint", "served_entity", "benchmarks", "sample_limit", "status",
    "started_at", "finished_at", "duration_s", "harness_version", "request_params", "mlflow_run_id",
    "error", "requested_by",
]
RUN_SCHEMA = (
    "run_id STRING, job_run_id BIGINT, endpoint STRING, served_entity STRING, benchmarks STRING, "
    "sample_limit INT, status STRING, started_at TIMESTAMP, finished_at TIMESTAMP, duration_s DOUBLE, "
    "harness_version STRING, request_params STRING, mlflow_run_id STRING, error STRING, requested_by STRING"
)
SCORE_COLUMNS = [
    "score_id", "run_id", "endpoint", "benchmark", "task", "metric", "filter", "value", "stderr",
    "n_samples", "is_primary", "created_at",
]
SCORE_SCHEMA = (
    "score_id STRING, run_id STRING, endpoint STRING, benchmark STRING, task STRING, metric STRING, "
    "filter STRING, value DOUBLE, stderr DOUBLE, n_samples INT, is_primary BOOLEAN, created_at TIMESTAMP"
)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--endpoint", required=True)
    p.add_argument("--benchmarks", required=True, help="comma-separated keys from benchmarks.py")
    p.add_argument("--sample_limit", type=int, default=0, help="questions per task; 0 = full benchmark")
    p.add_argument("--run_id", default="")
    p.add_argument("--job_run_id", default="")
    p.add_argument("--requested_by", default="")
    p.add_argument("--num_concurrent", type=int, default=8)
    p.add_argument("--catalog", required=True)
    p.add_argument("--schema", required=True)
    p.add_argument("--volume", required=True, help="/Volumes/... path for artifacts")
    p.add_argument("--lakebase_endpoint", required=True, help="projects/<p>/branches/<b>/endpoints/<e>")
    p.add_argument("--lakebase_database", default="databricks_postgres")
    p.add_argument("--experiment", required=True)
    p.add_argument("--hf_token_secret", default="", help="scope/key of a Hugging Face token for gated datasets")
    return p.parse_args()


def now():
    return datetime.now(timezone.utc)


def finite(x):
    return x if isinstance(x, (int, float)) and math.isfinite(x) else None


class ResultStore:
    """Writes run and score rows to Delta (source of truth) and Lakebase (app serving copy)."""

    def __init__(self, spark, w: WorkspaceClient, args):
        self.spark, self.w = spark, w
        self.fq = f"`{args.catalog}`.`{args.schema}`"
        self.lb_endpoint, self.lb_db = args.lakebase_endpoint, args.lakebase_database

    def _merge_delta(self, table, rows, columns, schema, key):
        df = self.spark.createDataFrame([[r.get(c) for c in columns] for r in rows], schema)
        view = f"_src_{table}_{uuid.uuid4().hex[:8]}"
        df.createOrReplaceTempView(view)
        self.spark.sql(
            f"MERGE INTO {self.fq}.{table} t USING {view} s ON t.{key} = s.{key} "
            "WHEN MATCHED THEN UPDATE SET * WHEN NOT MATCHED THEN INSERT *"
        )

    def _upsert_lakebase(self, table, rows, columns, key):
        cols = ", ".join(columns)
        updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in columns if c != key)
        sql = (
            f"INSERT INTO benchmarks.{table} ({cols}) VALUES ({', '.join(['%s'] * len(columns))}) "
            f"ON CONFLICT ({key}) DO UPDATE SET {updates}"
        )
        with lakebase.connect(self.w, self.lb_endpoint, self.lb_db) as conn:
            conn.cursor().executemany(sql, [[r.get(c) for c in columns] for r in rows])

    def save_run(self, run: dict):
        self._merge_delta("benchmark_runs", [run], RUN_COLUMNS, RUN_SCHEMA, "run_id")
        self._upsert_lakebase("benchmark_runs", [run], RUN_COLUMNS, "run_id")

    def save_scores(self, rows: list[dict]):
        if rows:
            self._merge_delta("benchmark_scores", rows, SCORE_COLUMNS, SCORE_SCHEMA, "score_id")
            self._upsert_lakebase("benchmark_scores", rows, SCORE_COLUMNS, "score_id")


def score_rows(run_id, endpoint, bench, results) -> list[dict]:
    """Flatten lm-eval results into one row per (task, metric, filter)."""
    rows, created = [], now()
    n_samples = results.get("n-samples", {})
    subtasks = results.get("group_subtasks", {})
    for task, metrics in results["results"].items():
        n = n_samples.get(task, {}).get("effective")
        if n is None and subtasks.get(task):  # group: sum its subtasks
            n = sum(n_samples.get(t, {}).get("effective") or 0 for t in subtasks[task]) or None
        for key, value in metrics.items():
            if "," not in key or "_stderr," in key:
                continue
            metric, flt = key.split(",", 1)
            value = finite(value)
            if value is None:
                continue
            stderr = metrics.get(f"{metric}_stderr,{flt}")
            rows.append({
                "score_id": f"{run_id}|{task}|{metric}|{flt}",
                "run_id": run_id, "endpoint": endpoint, "benchmark": bench.key, "task": task,
                "metric": metric, "filter": flt, "value": float(value),
                "stderr": finite(stderr) if not isinstance(stderr, str) else None,
                "n_samples": n,
                "is_primary": task == bench.task and metric == bench.metric and flt == bench.filter,
                "created_at": created,
            })
    return rows


def rescore_code_execution(results, task, metric_key, timeout_s=15):
    """Re-run unit tests for code tasks in isolated subprocesses and overwrite pass@1.

    lm-eval's HF `code_eval` sandbox relies on multiprocessing/resource limits that fail silently
    on serverless compute (every sample scores 0), so we execute each candidate ourselves.
    """
    samples = (results.get("samples") or {}).get(task) or []
    if not samples:
        return
    passed = []
    with tempfile.TemporaryDirectory() as tmp:
        for s in samples:
            doc = s["doc"]
            pred = s["filtered_resps"][0]
            code = (pred[0] if isinstance(pred, list) else pred) + "\n\n" + doc["test"] + f"\n\ncheck({doc['entry_point']})\n"
            path = os.path.join(tmp, "candidate.py")
            with open(path, "w") as f:
                f.write(code)
            try:
                ok = subprocess.run(
                    [sys.executable, "-I", path], cwd=tmp, capture_output=True, timeout=timeout_s
                ).returncode == 0
            except subprocess.TimeoutExpired:
                ok = False
            s["executed_pass"] = ok
            passed.append(ok)
    p, n = sum(passed) / len(passed), len(passed)
    metrics = results["results"][task]
    metric, flt = metric_key.split(",", 1)
    metrics[f"{metric}_lm_eval,{flt}"] = metrics.get(metric_key)  # keep the harness value for reference
    metrics[metric_key] = p
    metrics[f"{metric}_stderr,{flt}"] = math.sqrt(p * (1 - p) / (n - 1)) if n > 1 else None


def write_artifacts(volume, run_id, bench_key, results) -> str:
    out = os.path.join(volume, run_id, bench_key)
    os.makedirs(out, exist_ok=True)
    samples = results.pop("samples", {}) or {}
    with open(os.path.join(out, "results.json"), "w") as f:
        json.dump(results, f, indent=2, default=str)
    for task, task_samples in samples.items():
        with open(os.path.join(out, f"samples_{task}.jsonl"), "w") as f:
            for s in task_samples:
                f.write(json.dumps(s, default=str) + "\n")
    return out


def served_entity(w, endpoint) -> str:
    try:
        ep = w.serving_endpoints.get(endpoint)
        for e in (ep.config.served_entities if ep.config else None) or []:
            return e.entity_name or (e.foundation_model.name if e.foundation_model else None) or e.name
    except Exception as e:  # informational only
        log.warning("Could not resolve served entity for %s: %s", endpoint, e)
    return None


def main():
    args = parse_args()
    keys = [k.strip() for k in args.benchmarks.split(",") if k.strip()]
    unknown = [k for k in keys if k not in BENCHMARKS]
    if unknown or not keys:
        raise ValueError(f"Unknown benchmarks {unknown}; choose from {list(BENCHMARKS)}")
    limit = args.sample_limit if args.sample_limit > 0 else None
    run_id = args.run_id or str(uuid.uuid4())

    spark = SparkSession.builder.getOrCreate()
    w = WorkspaceClient()
    store = ResultStore(spark, w, args)

    if args.hf_token_secret:
        scope, key = args.hf_token_secret.split("/", 1)
        try:
            import base64
            os.environ["HF_TOKEN"] = base64.b64decode(w.secrets.get_secret(scope, key).value).decode()
        except Exception as e:
            log.warning("Hugging Face token secret %s unavailable (%s); gated datasets will fail", args.hf_token_secret, e)
    os.environ["HF_ALLOW_CODE_EVAL"] = "1"

    run = {
        "run_id": run_id, "job_run_id": int(args.job_run_id) if args.job_run_id.isdigit() else None,
        "endpoint": args.endpoint, "served_entity": served_entity(w, args.endpoint),
        "benchmarks": ",".join(keys), "sample_limit": limit, "status": "RUNNING", "started_at": now(),
        "harness_version": f"lm_eval=={lm_eval.__version__}", "requested_by": args.requested_by or None,
    }
    store.save_run(run)

    mlflow.set_tracking_uri("databricks")
    mlflow.set_experiment(args.experiment)
    failures, t0 = {}, time.time()
    lm = None
    with mlflow.start_run(run_name=f"{args.endpoint} {run_id[:8]}") as mlrun:
        run["mlflow_run_id"] = mlrun.info.run_id
        mlflow.log_params({
            "endpoint": args.endpoint, "benchmarks": run["benchmarks"], "sample_limit": limit or "full",
            "harness": run["harness_version"], "run_id": run_id,
        })
        try:
            lm = DatabricksChatLM(endpoint=args.endpoint, num_concurrent=args.num_concurrent)
            mlflow.log_param("unsupported_params", ",".join(sorted(lm.unsupported)) or "none")
        except Exception as e:
            failures["_endpoint"] = f"{type(e).__name__}: {e}"
            log.exception("Endpoint probe failed")

        for key in keys if lm else []:
            bench = BENCHMARKS[key]
            log.info("=== %s (%s), limit=%s", bench.label, bench.task, limit)
            lm.respect_stop, lm.extract_code = bench.respect_stop, bench.extract_code
            try:
                results = lm_eval.simple_evaluate(
                    model=lm, tasks=[bench.task], apply_chat_template=True, limit=limit,
                    log_samples=True, bootstrap_iters=1000, confirm_run_unsafe_code=bench.unsafe_code,
                )
                if bench.unsafe_code:
                    rescore_code_execution(results, bench.task, f"{bench.metric},{bench.filter}")
                rows = score_rows(run_id, args.endpoint, bench, results)
                if not any(r["is_primary"] for r in rows):
                    raise RuntimeError(f"Headline metric {bench.metric},{bench.filter} missing for {bench.task}")
                store.save_scores(rows)
                for r in rows:
                    if r["is_primary"]:
                        mlflow.log_metric(key, r["value"])
                    mlflow.log_metric(f"{key}.{r['task']}.{r['metric']}.{r['filter']}".replace("@", "_at_"), r["value"])
                mlflow.log_artifacts(write_artifacts(args.volume, run_id, key, results), artifact_path=key)
            except Exception as e:
                failures[key] = f"{type(e).__name__}: {e}"
                log.error("Benchmark %s failed:\n%s", key, traceback.format_exc())

        run.update({
            "status": "FAILED" if (lm is None or len(failures) == len(keys)) else "PARTIAL" if failures else "SUCCEEDED",
            "finished_at": now(), "duration_s": round(time.time() - t0, 1),
            "request_params": json.dumps(lm.request_params) if lm else None,
            "error": json.dumps(failures)[:8000] if failures else None,
        })
        store.save_run(run)
        mlflow.set_tag("status", run["status"])

    log.info("Run %s finished: %s", run_id, run["status"])
    if run["status"] == "FAILED":
        raise RuntimeError(f"All benchmarks failed: {failures}")


if __name__ == "__main__":
    main()
