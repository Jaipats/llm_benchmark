# llm-benchmarks app

The AppKit (React + Express) front end of the LLM Benchmarks project. See the
[repository README](../README.md) for deployment, architecture and usage.

Local development (after the stack has been deployed once with `../deploy.sh`):

```bash
npm install
cp .env.example .env   # fill in DATABRICKS_JOB_ID and the Lakebase PG*/LAKEBASE_ENDPOINT values
npm run dev
```
