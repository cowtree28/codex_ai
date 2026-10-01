"""Postgres 연결과 테이블 준비."""
import os
import time

from psycopg_pool import ConnectionPool

pool = ConnectionPool(os.environ["DATABASE_URL"], min_size=1, max_size=8, open=False)

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE items ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    item_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS notes_title_lower ON notes (lower(title));
CREATE TABLE IF NOT EXISTS integrations (
    name TEXT PRIMARY KEY,
    config JSONB NOT NULL DEFAULT '{}',
    secrets TEXT NOT NULL DEFAULT '',
    status JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ingested (
    source TEXT NOT NULL,
    ref TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source, ref)
);
"""


def init_db() -> None:
    # DB 컨테이너가 늦게 뜰 수 있어 몇 번 다시 시도한다.
    for attempt in range(30):
        try:
            pool.open()
            with pool.connection() as conn:
                conn.execute(SCHEMA)
            return
        except Exception:
            if attempt == 29:
                raise
            time.sleep(2)
