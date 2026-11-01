#!/usr/bin/env bash
# One-command deployment of the LLM Benchmarks stack to a Databricks workspace.
#
#   ./deploy.sh --profile <cli-profile> --catalog <existing-catalog>
#
# Idempotent: re-run it to update code or settings. See README.md for details.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT/llm-benchmarks"
MIN_CLI_VERSION="0.294.0"

PROFILE=""
CATALOG=""
SCHEMA="llm_benchmarks"
LAKEBASE_PROJECT="llm-benchmarks"
APP_NAME="llm-benchmarks"
EXPERIMENT="/Shared/llm-benchmarks"
HF_TOKEN_SECRET=""
SMOKE_TEST_ENDPOINT=""

usage() {
  cat <<EOF
Usage: ./deploy.sh --profile PROFILE --catalog CATALOG [options]

Required:
  -p, --profile NAME          Databricks CLI profile for the target workspace (see: databricks auth profiles)
  -c, --catalog NAME          Existing Unity Catalog catalog you can create a schema in

Options:
  -s, --schema NAME           Results schema to create              (default: $SCHEMA)
  -l, --lakebase-project ID   Lakebase project, created if missing  (default: $LAKEBASE_PROJECT)
  -a, --app-name NAME         Databricks App name                   (default: $APP_NAME)
  -e, --experiment PATH       MLflow experiment path                (default: $EXPERIMENT)
      --hf-token-secret S/K   Secret scope/key holding a Hugging Face token (enables gated GPQA)
      --smoke-test ENDPOINT   After deploying, run IFEval + GSM8K (10 questions each) on ENDPOINT
  -h, --help                  Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p | --profile) PROFILE="$2"; shift 2 ;;
    -c | --catalog) CATALOG="$2"; shift 2 ;;
    -s | --schema) SCHEMA="$2"; shift 2 ;;
    -l | --lakebase-project) LAKEBASE_PROJECT="$2"; shift 2 ;;
    -a | --app-name) APP_NAME="$2"; shift 2 ;;
    -e | --experiment) EXPERIMENT="$2"; shift 2 ;;
    --hf-token-secret) HF_TOKEN_SECRET="$2"; shift 2 ;;
    --smoke-test) SMOKE_TEST_ENDPOINT="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
dbx() { databricks "$@" --profile "$PROFILE"; }
# Evaluate a Python expression against JSON on stdin, bound to `d`.
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); v=($1); print('' if v is None else v)"; }

[[ -n "$PROFILE" && -n "$CATALOG" ]] || { usage >&2; exit 2; }
[[ "$APP_NAME" =~ ^[a-z][a-z0-9-]{1,25}$ ]] || fail "--app-name must be 2-26 chars: lowercase letters, numbers, hyphens"
[[ "$LAKEBASE_PROJECT" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || fail "--lakebase-project must be lowercase letters, numbers, hyphens"

# --- 1. Prerequisites -------------------------------------------------------------------
step "Checking prerequisites"
command -v databricks >/dev/null || fail "Databricks CLI not found: https://docs.databricks.com/dev-tools/cli/install"
command -v python3 >/dev/null || fail "python3 is required"
CLI_VERSION="$(databricks --version | sed -E 's/.*v?([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
python3 -c "import sys; v=lambda s: tuple(map(int, s.split('.'))); sys.exit(v('$CLI_VERSION') < v('$MIN_CLI_VERSION'))" ||
  fail "Databricks CLI $CLI_VERSION is too old; need >= $MIN_CLI_VERSION"
ME="$(dbx current-user me -o json | jget "d['userName']")" ||
  fail "Profile '$PROFILE' is not authenticated. Run: databricks auth login --profile $PROFILE"
HOST="$(databricks auth describe --profile "$PROFILE" -o json 2>/dev/null | jget "d.get('details', {}).get('host')" || true)"
dbx catalogs get "$CATALOG" >/dev/null 2>&1 || fail "Catalog '$CATALOG' not found or not accessible"
echo "CLI $CLI_VERSION · $ME · ${HOST:-$PROFILE} · catalog $CATALOG"

# --- 2. Lakebase project ----------------------------------------------------------------
step "Lakebase project '$LAKEBASE_PROJECT'"
if dbx postgres get-project "projects/$LAKEBASE_PROJECT" -o json >/dev/null 2>&1; then
  echo "Exists; reusing it"
else
  echo "Creating (takes a few minutes)..."
  dbx postgres create-project "$LAKEBASE_PROJECT" --json '{"spec": {"display_name": "LLM Benchmarks"}}' -o json >/dev/null
fi
BRANCH="$(dbx postgres list-branches "projects/$LAKEBASE_PROJECT" -o json |
  jget "next((b['name'] for b in d if b.get('status', {}).get('default')), d[0]['name'] if d else None)")"
[[ -n "$BRANCH" ]] || fail "No branch found in Lakebase project $LAKEBASE_PROJECT"
LB_ENDPOINT="$(dbx postgres list-endpoints "$BRANCH" -o json |
  jget "next((e['name'] for e in d if e.get('status', {}).get('endpoint_type') == 'ENDPOINT_TYPE_READ_WRITE'), None)")"
[[ -n "$LB_ENDPOINT" ]] || fail "No read-write endpoint on $BRANCH"
LB_DATABASE="$(dbx postgres list-databases "$BRANCH" -o json |
  jget "next((x['name'] for x in d if x.get('status', {}).get('postgres_database') == 'databricks_postgres'), None)")"
[[ -n "$LB_DATABASE" ]] || fail "Database databricks_postgres not found on $BRANCH"
echo "Branch $BRANCH · endpoint $LB_ENDPOINT"

# --- 3. Jobs bundle ---------------------------------------------------------------------
JOB_VARS=(
  --var "app_name=$APP_NAME" --var "catalog=$CATALOG" --var "schema=$SCHEMA" --var "lakebase_endpoint=$LB_ENDPOINT"
  --var "experiment=$EXPERIMENT" --var "hf_token_secret=$HF_TOKEN_SECRET"
)
step "Deploying jobs bundle (benchmark runner + setup)"
cd "$ROOT"
rm -rf "$ROOT/.databricks" # local cache only; deployment state is pulled from the workspace
databricks bundle deploy --profile "$PROFILE" "${JOB_VARS[@]}"
JOB_ID="$(databricks bundle summary --profile "$PROFILE" "${JOB_VARS[@]}" -o json |
  jget "d['resources']['jobs']['llm_benchmark_job']['id']")"
echo "Benchmark job id: $JOB_ID"

# --- 4. App bundle ----------------------------------------------------------------------
APP_VARS=(
  --var "app_name=$APP_NAME" --var "job_id=$JOB_ID"
  --var "postgres_branch=$BRANCH" --var "postgres_database=$LB_DATABASE"
)
step "Deploying app '$APP_NAME'"
cd "$APP_DIR"
rm -rf "$APP_DIR/.databricks"
databricks bundle deploy --profile "$PROFILE" "${APP_VARS[@]}"
databricks bundle run app --profile "$PROFILE" "${APP_VARS[@]}"
APP_JSON="$(dbx apps get "$APP_NAME" -o json)"
APP_SP="$(jget "d['service_principal_client_id']" <<<"$APP_JSON")"
APP_URL="$(jget "d.get('url')" <<<"$APP_JSON")"

# --- 5. Tables and grants -----------------------------------------------------------------
step "Creating tables and granting the app read access (setup job)"
cd "$ROOT"
databricks bundle run llm_benchmark_setup --profile "$PROFILE" "${JOB_VARS[@]}" --params "app_service_principal=$APP_SP"

# --- 6. Optional smoke test ---------------------------------------------------------------
if [[ -n "$SMOKE_TEST_ENDPOINT" ]]; then
  step "Smoke test: IFEval + GSM8K on $SMOKE_TEST_ENDPOINT (10 questions each)"
  dbx jobs run-now --json "{\"job_id\": $JOB_ID, \"job_parameters\": {\"endpoint\": \"$SMOKE_TEST_ENDPOINT\",
    \"benchmarks\": \"ifeval,gsm8k\", \"sample_limit\": \"10\", \"requested_by\": \"deploy.sh smoke test\"}}" -o json |
    jget "'Result state: ' + str(d.get('state', {}).get('result_state'))"
fi

step "Done"
cat <<EOF
App:             $APP_URL
Results (Delta): $CATALOG.$SCHEMA.benchmark_runs / benchmark_scores
Lakebase:        $LAKEBASE_PROJECT (schema: benchmarks)
MLflow:          $EXPERIMENT
Benchmark job:   ${HOST:+$HOST/jobs/$JOB_ID}
EOF
