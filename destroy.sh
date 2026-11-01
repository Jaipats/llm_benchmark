#!/usr/bin/env bash
# Remove a deployment made by deploy.sh.
#
#   ./destroy.sh --profile <cli-profile> [--app-name NAME]                 # app + jobs only; results kept
#   ./destroy.sh --profile <cli-profile> --delete-data --catalog <catalog>  # also drop results + Lakebase project
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE=""
APP_NAME="llm-benchmarks"
DELETE_DATA=false
CATALOG=""
SCHEMA="llm_benchmarks"
LAKEBASE_PROJECT="llm-benchmarks"
ASSUME_YES=false

usage() {
  cat <<EOF
Usage: ./destroy.sh --profile PROFILE [options]

  -p, --profile NAME          Databricks CLI profile (required)
  -a, --app-name NAME         App name used at deploy time      (default: $APP_NAME)
      --delete-data           Also delete the results schema (Delta tables + artifacts volume)
                              and the Lakebase project. Irreversible.
  -c, --catalog NAME          Catalog of the results schema (required with --delete-data)
  -s, --schema NAME           Results schema                    (default: $SCHEMA)
  -l, --lakebase-project ID   Lakebase project                  (default: $LAKEBASE_PROJECT)
  -y, --yes                   Don't ask for confirmation
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p | --profile) PROFILE="$2"; shift 2 ;;
    -a | --app-name) APP_NAME="$2"; shift 2 ;;
    --delete-data) DELETE_DATA=true; shift ;;
    -c | --catalog) CATALOG="$2"; shift 2 ;;
    -s | --schema) SCHEMA="$2"; shift 2 ;;
    -l | --lakebase-project) LAKEBASE_PROJECT="$2"; shift 2 ;;
    -y | --yes) ASSUME_YES=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "$PROFILE" ]] || { usage >&2; exit 2; }
$DELETE_DATA && [[ -z "$CATALOG" ]] && { echo "--delete-data needs --catalog" >&2; exit 2; }

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

echo "This removes app '$APP_NAME' and its benchmark/setup jobs."
$DELETE_DATA && echo "It also DELETES schema $CATALOG.$SCHEMA (all results) and Lakebase project '$LAKEBASE_PROJECT'."
if ! $ASSUME_YES; then
  read -r -p "Continue? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || { echo "Aborted"; exit 1; }
fi

# Destroy works from deployment state; required variables only need placeholder values.
step "Removing app '$APP_NAME'"
cd "$ROOT/llm-benchmarks"
rm -rf .databricks
databricks bundle destroy --auto-approve --profile "$PROFILE" --var "app_name=$APP_NAME" \
  --var job_id=0 --var postgres_branch=unused --var postgres_database=unused

step "Removing jobs"
cd "$ROOT"
rm -rf .databricks
databricks bundle destroy --auto-approve --profile "$PROFILE" --var "app_name=$APP_NAME" \
  --var catalog=unused --var lakebase_endpoint=unused

if $DELETE_DATA; then
  step "Deleting schema $CATALOG.$SCHEMA"
  databricks schemas delete "$CATALOG.$SCHEMA" --force --profile "$PROFILE" || echo "Schema not found; skipping"
  step "Deleting Lakebase project '$LAKEBASE_PROJECT'"
  databricks postgres delete-project "projects/$LAKEBASE_PROJECT" --profile "$PROFILE" || echo "Project not found; skipping"
fi

step "Done"
