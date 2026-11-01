"""Lakebase (Postgres) connections as the job's identity, using a fresh OAuth database credential."""

import time

import psycopg
from databricks.sdk import WorkspaceClient


def connect(w: WorkspaceClient, endpoint: str, database: str, attempts: int = 5) -> psycopg.Connection:
    """Open an autocommit-off connection; retries while the compute wakes from scale-to-zero."""
    host = w.postgres.get_endpoint(name=endpoint).status.hosts.host
    user = w.current_user.me().user_name
    token = w.postgres.generate_database_credential(endpoint=endpoint).token
    for attempt in range(attempts):
        try:
            return psycopg.connect(
                host=host, dbname=database, user=user, password=token, sslmode="require", connect_timeout=30
            )
        except psycopg.OperationalError:
            if attempt == attempts - 1:
                raise
            time.sleep(2**attempt)
    raise AssertionError("unreachable")
