"""Claude 작업 대기열.

API 컨테이너는 Claude를 직접 실행하지 않는다. 작업을 이 표(claude_jobs)에 넣으면
서버 본체에서 도는 deploy/claude_worker.py 가 꺼내서 서버에 로그인된 Claude Code로 실행하고
결과를 /api/worker/* 로 돌려준다. 그래서 로그인 정보는 컨테이너에 들어오지 않는다.
"""
import json
import time
import uuid

from psycopg.types.json import Jsonb

from db import pool

SCHEMA = """
CREATE TABLE IF NOT EXISTS claude_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,              -- wiki: llm-wiki 명령, extract: 메일·디스코드 일정 추출
    action TEXT NOT NULL DEFAULT '',
    topic TEXT,
    input TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL,
    system TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '',  -- 허용 도구. 빈 문자열이면 도구 없음
    settings TEXT NOT NULL DEFAULT '', -- user 면 플러그인(llm-wiki)을 읽는다
    workdir TEXT NOT NULL DEFAULT 'tmp', -- hub 면 위키 허브에서, tmp 면 빈 임시 폴더에서 실행
    schema JSONB,
    status TEXT NOT NULL DEFAULT 'queued',
    result TEXT NOT NULL DEFAULT '',
    structured JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS claude_jobs_queue ON claude_jobs (status, created_at);
"""
STALE_MINUTES = 20  # 이보다 오래 '진행 중'이면 작업기가 죽은 것으로 보고 실패 처리한다.
PUBLIC_COLS = "id, kind, action, topic, input, status, result, created_at, started_at, finished_at"


class JobError(Exception):
    pass


def init() -> None:
    with pool.connection() as conn:
        conn.execute(SCHEMA)


def enqueue(kind: str, prompt: str, *, action: str = "", topic: str | None = None, text: str = "",
            system: str = "", tools: str = "", settings: str = "", workdir: str = "tmp",
            schema: dict | None = None) -> str:
    job_id = uuid.uuid4().hex[:12]
    with pool.connection() as conn:
        conn.execute(
            """INSERT INTO claude_jobs (id, kind, action, topic, input, prompt, system, tools, settings, workdir, schema)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (job_id, kind, action, topic, text, prompt, system, tools, settings, workdir,
             Jsonb(schema) if schema else None))
    return job_id


def _public(row) -> dict:
    job = dict(zip(PUBLIC_COLS.split(", "), row))
    for key in ("created_at", "started_at", "finished_at"):
        job[key] = job[key].isoformat() if job[key] else None
    return job


def get(job_id: str) -> dict:
    with pool.connection() as conn:
        row = conn.execute(f"SELECT {PUBLIC_COLS} FROM claude_jobs WHERE id = %s", (job_id,)).fetchone()
    if not row:
        raise JobError("작업을 찾을 수 없습니다.")
    return _public(row)


def recent(kind: str, limit: int = 20) -> list[dict]:
    expire()
    with pool.connection() as conn:
        rows = conn.execute(f"SELECT {PUBLIC_COLS} FROM claude_jobs WHERE kind = %s ORDER BY created_at DESC LIMIT %s",
                            (kind, limit)).fetchall()
    return [_public(r) for r in rows]


def wait(job_id: str, timeout: int = 360) -> tuple[str, str, object]:
    """작업이 끝날 때까지 기다린다. (상태, 결과 글, 구조화 결과)"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with pool.connection() as conn:
            row = conn.execute("SELECT status, result, structured, started_at FROM claude_jobs WHERE id = %s",
                               (job_id,)).fetchone()
        if row and row[0] in ("done", "error"):
            return row[0], row[1], row[2]
        if row and row[0] == "queued" and time.time() > deadline - timeout + 90:
            # 90초가 지나도 아무도 가져가지 않으면 작업기가 꺼진 것이다.
            cancel(job_id, "서버의 Claude 작업기가 꺼져 있습니다.")
            return "error", "서버의 Claude 작업기가 꺼져 있습니다.", None
        time.sleep(2)
    cancel(job_id, "시간 안에 끝나지 않았습니다.")
    return "error", "시간 안에 끝나지 않았습니다.", None


def cancel(job_id: str, reason: str) -> None:
    with pool.connection() as conn:
        conn.execute("UPDATE claude_jobs SET status = 'error', result = %s, finished_at = now() "
                     "WHERE id = %s AND status IN ('queued', 'running')", (reason, job_id))


def expire() -> None:
    with pool.connection() as conn:
        conn.execute("UPDATE claude_jobs SET status = 'error', result = '작업기가 응답하지 않아 중단되었습니다.', "
                     "finished_at = now() WHERE status = 'running' AND started_at < now() - %s * interval '1 minute'",
                     (STALE_MINUTES,))


# ---------- 작업기용 ----------
def claim() -> dict | None:
    """가장 오래된 대기 작업 하나를 '진행 중'으로 바꾸고 실행 정보를 돌려준다."""
    expire()
    with pool.connection() as conn, conn.transaction():
        row = conn.execute(
            """UPDATE claude_jobs SET status = 'running', started_at = now()
               WHERE id = (SELECT id FROM claude_jobs WHERE status = 'queued' ORDER BY created_at
                           LIMIT 1 FOR UPDATE SKIP LOCKED)
               RETURNING id, kind, prompt, system, tools, settings, workdir, schema""").fetchone()
    if not row:
        return None
    keys = ("id", "kind", "prompt", "system", "tools", "settings", "workdir", "schema")
    return dict(zip(keys, row))


def finish(job_id: str, status: str, result: str, structured) -> None:
    if status not in ("done", "error"):
        raise JobError("status는 done 또는 error 여야 합니다.")
    with pool.connection() as conn:
        conn.execute("UPDATE claude_jobs SET status = %s, result = %s, structured = %s, finished_at = now() "
                     "WHERE id = %s AND status = 'running'",
                     (status, result[:100000], Jsonb(structured) if structured is not None else None, job_id))
