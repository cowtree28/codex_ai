"""check 앱의 API.

- 사용자는 한 명이다. 비밀번호(APP_PASSWORD) 하나로 로그인하면 세션 토큰을 준다.
- 일정(items)·설정(settings)을 Postgres에 저장한다.
- 위키는 서버의 llm-wiki 허브를 그대로 읽고, 질문·기록·정리는 서버의 Claude Code에 맡긴다.
- AI 기능은 서버 컴퓨터에 로그인된 Claude Code를 쓴다. Gmail·디스코드는 설정 화면에서 등록하고 비밀값은 암호화해 저장한다.
"""
import hashlib
import hmac
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from psycopg.types.json import Jsonb
from pydantic import BaseModel

import integrations
import jobs
import wiki
from db import init_db, pool

APP_PASSWORD = os.environ["APP_PASSWORD"]
SESSION_SECRET = os.environ["SESSION_SECRET"]


def worker_token() -> str:
    """서버 본체의 Claude 작업기가 쓰는 토큰. 같은 SESSION_SECRET에서 다른 값으로 만든다."""
    return hmac.new(SESSION_SECRET.encode(), b"check-worker-v1", hashlib.sha256).hexdigest()


def session_token() -> str:
    """서버 비밀값으로 만든 고정 토큰. 비밀값을 바꾸면 모든 기기가 로그아웃된다."""
    return hmac.new(SESSION_SECRET.encode(), b"check-session-v1", hashlib.sha256).hexdigest()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    jobs.init()
    if os.environ.get("DISABLE_SYNC") != "1":
        integrations.start_background_loop()
    yield
    pool.close()


app = FastAPI(title="check API", lifespan=lifespan, docs_url=None, redoc_url=None)
# GitHub Pages(https://cowtree28.github.io)에서 여는 화면이 이 API를 부를 수 있게 허용한다.
# 쿠키 없이 Authorization 헤더로만 로그인하므로 credentials는 허용하지 않는다.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.environ.get("CORS_ORIGINS", "https://cowtree28.github.io").split(",") if o.strip()],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["X-Server-Time", "Content-Disposition"],
    max_age=600,
)


def require_auth(request: Request) -> None:
    header = request.headers.get("authorization", "")
    token = header[7:] if header.lower().startswith("bearer ") else ""
    if not hmac.compare_digest(token, session_token()):
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")


auth = [Depends(require_auth)]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------- 로그인 ----------
class LoginBody(BaseModel):
    password: str


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/login")
def login(body: LoginBody):
    if not hmac.compare_digest(body.password.encode(), APP_PASSWORD.encode()):
        time.sleep(1)  # 무차별 대입을 느리게 만든다.
        raise HTTPException(status_code=401, detail="비밀번호가 맞지 않습니다.")
    return {"token": session_token()}


# ---------- 일정 ----------
@app.get("/api/items", dependencies=auth)
def list_items(response: Response):
    with pool.connection() as conn:
        rows = conn.execute("SELECT data FROM items ORDER BY position, created_at").fetchall()
    # 화면이 이 시각을 기억했다가 저장할 때 보낸다. 그 뒤에 서버가 추가한 일정은 지우지 않는다.
    response.headers["X-Server-Time"] = now_iso()
    return [row[0] for row in rows]


@app.put("/api/items", dependencies=auth)
def replace_items(items: list[dict], response: Response, since: str | None = None):
    ids = []
    for item in items:
        if not isinstance(item.get("id"), str) or not isinstance(item.get("title"), str):
            raise HTTPException(status_code=400, detail="id와 title이 있는 일정만 저장할 수 있습니다.")
        ids.append(item["id"])
    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=400, detail="같은 id의 일정이 두 번 들어 있습니다.")
    try:
        cutoff = datetime.fromisoformat(since.replace("Z", "+00:00")) if since else None
    except ValueError:
        raise HTTPException(status_code=400, detail="since 형식이 올바르지 않습니다.")
    with pool.connection() as conn, conn.transaction():
        for position, item in enumerate(items):
            conn.execute(
                """
                INSERT INTO items (id, data, position, updated_at) VALUES (%s, %s, %s, now())
                ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, position = EXCLUDED.position, updated_at = now()
                """,
                (item["id"], Jsonb(item), position),
            )
        if cutoff is None:
            conn.execute("DELETE FROM items WHERE NOT (id = ANY(%s))", (ids,))
        else:
            conn.execute("DELETE FROM items WHERE NOT (id = ANY(%s)) AND created_at <= %s", (ids, cutoff))
        rows = conn.execute("SELECT data FROM items ORDER BY position, created_at").fetchall()
    response.headers["X-Server-Time"] = now_iso()
    return [row[0] for row in rows]


# ---------- 설정 ----------
@app.get("/api/settings", dependencies=auth)
def get_settings():
    with pool.connection() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    return {key: value for key, value in rows}


@app.put("/api/settings", dependencies=auth)
def put_settings(settings: dict):
    with pool.connection() as conn, conn.transaction():
        for key, value in settings.items():
            conn.execute(
                """
                INSERT INTO settings (key, value, updated_at) VALUES (%s, %s, now())
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
                """,
                (key, Jsonb(value)),
            )
    return settings


# ---------- 위키 (서버의 llm-wiki) ----------
def wiki_guard(fn):
    try:
        return fn()
    except wiki.WikiError as error:
        raise HTTPException(status_code=400, detail=str(error))


@app.get("/api/wiki/topics", dependencies=auth)
def wiki_topics():
    return wiki.topics()


@app.get("/api/wiki/files", dependencies=auth)
def wiki_files(topic: str):
    return wiki_guard(lambda: wiki.files(topic))


@app.get("/api/wiki/file", dependencies=auth)
def wiki_file(path: str):
    return wiki_guard(lambda: wiki.read(path))


class JobBody(BaseModel):
    action: str
    topic: str = ""
    text: str = ""
    options: dict = {}


@app.post("/api/wiki/jobs", dependencies=auth)
def wiki_create_job(body: JobBody):
    return wiki_guard(lambda: wiki.create_job(body.action, body.topic, body.text, body.options))


@app.get("/api/wiki/jobs", dependencies=auth)
def wiki_jobs():
    return wiki.list_jobs()


@app.get("/api/wiki/jobs/{job_id}", dependencies=auth)
def wiki_job(job_id: str):
    return wiki_guard(lambda: wiki.get_job(job_id))


# ---------- 서버 Claude 작업기 ----------
def require_worker(request: Request) -> None:
    if not hmac.compare_digest(request.headers.get("x-worker-token", ""), worker_token()):
        raise HTTPException(status_code=401, detail="작업기 토큰이 올바르지 않습니다.")


@app.post("/api/worker/claim", dependencies=[Depends(require_worker)])
def worker_claim():
    job = jobs.claim()
    return job or Response(status_code=204)


class FinishBody(BaseModel):
    status: str
    result: str = ""
    structured: dict | list | None = None


@app.post("/api/worker/jobs/{job_id}", dependencies=[Depends(require_worker)])
def worker_finish(job_id: str, body: FinishBody):
    try:
        jobs.finish(job_id, body.status, body.result, body.structured)
    except jobs.JobError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {"ok": True}


# ---------- 연동 ----------
@app.get("/api/integrations", dependencies=auth)
def get_integrations():
    return {**integrations.public_view(), "syncMinutes": integrations.interval_minutes()}


@app.put("/api/integrations/{name}", dependencies=auth)
def put_integration(name: str, body: dict):
    if name not in integrations.NAMES:
        raise HTTPException(status_code=404, detail="알 수 없는 연동입니다.")
    integrations.update(name, body)
    return integrations.public_view()[name]


@app.post("/api/integrations/{name}/test", dependencies=auth)
def test_integration(name: str):
    if name not in integrations.NAMES:
        raise HTTPException(status_code=404, detail="알 수 없는 연동입니다.")
    try:
        return {"ok": True, "message": integrations.test(name)}
    except ValueError as error:
        return {"ok": False, "message": str(error)}
    except Exception as error:
        return {"ok": False, "message": f"연결 실패: {error.__class__.__name__}"}


@app.post("/api/integrations/sync", dependencies=auth)
def sync_now(only: str | None = None):
    if only and only not in integrations.RUNNERS:
        raise HTTPException(status_code=404, detail="알 수 없는 연동입니다.")
    return integrations.sync(only)
