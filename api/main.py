"""check 앱의 저장 API.

- 사용자는 한 명이다. 비밀번호(APP_PASSWORD) 하나로 로그인하면 세션 토큰을 준다.
- 일정(items)과 설정(settings)을 Postgres에 저장한다.
- 프런트는 일정 배열 전체를 PUT으로 보내고, 서버는 행 단위로 맞춰 저장한다.
"""
import hmac
import hashlib
import os
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from pydantic import BaseModel

DATABASE_URL = os.environ["DATABASE_URL"]
APP_PASSWORD = os.environ["APP_PASSWORD"]
SESSION_SECRET = os.environ["SESSION_SECRET"]

pool = ConnectionPool(DATABASE_URL, min_size=1, max_size=5, open=False)


def session_token() -> str:
    """서버 비밀값으로 만든 고정 토큰. 비밀값을 바꾸면 모든 기기가 로그아웃된다."""
    return hmac.new(SESSION_SECRET.encode(), b"check-session-v1", hashlib.sha256).hexdigest()


def init_db() -> None:
    # DB 컨테이너가 늦게 뜰 수 있어 몇 번 다시 시도한다.
    for attempt in range(30):
        try:
            pool.open()
            with pool.connection() as conn:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS items (
                        id TEXT PRIMARY KEY,
                        data JSONB NOT NULL,
                        position INTEGER NOT NULL DEFAULT 0,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    );
                    CREATE TABLE IF NOT EXISTS settings (
                        key TEXT PRIMARY KEY,
                        value JSONB NOT NULL,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    );
                    """
                )
            return
        except Exception:
            if attempt == 29:
                raise
            time.sleep(2)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield
    pool.close()


app = FastAPI(title="check API", lifespan=lifespan, docs_url=None, redoc_url=None)


def require_auth(request: Request) -> None:
    header = request.headers.get("authorization", "")
    token = header[7:] if header.lower().startswith("bearer ") else ""
    if not hmac.compare_digest(token, session_token()):
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")


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


@app.get("/api/items", dependencies=[Depends(require_auth)])
def list_items():
    with pool.connection() as conn:
        rows = conn.execute("SELECT data FROM items ORDER BY position, updated_at").fetchall()
    return [row[0] for row in rows]


@app.put("/api/items", dependencies=[Depends(require_auth)])
def replace_items(items: list[dict]):
    ids = []
    for item in items:
        if not isinstance(item.get("id"), str) or not isinstance(item.get("title"), str):
            raise HTTPException(status_code=400, detail="id와 title이 있는 일정만 저장할 수 있습니다.")
        ids.append(item["id"])
    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=400, detail="같은 id의 일정이 두 번 들어 있습니다.")
    with pool.connection() as conn, conn.transaction():
        for position, item in enumerate(items):
            conn.execute(
                """
                INSERT INTO items (id, data, position, updated_at) VALUES (%s, %s, %s, now())
                ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, position = EXCLUDED.position, updated_at = now()
                """,
                (item["id"], Jsonb(item), position),
            )
        if ids:
            conn.execute("DELETE FROM items WHERE NOT (id = ANY(%s))", (ids,))
        else:
            conn.execute("DELETE FROM items")
    return items


@app.get("/api/settings", dependencies=[Depends(require_auth)])
def get_settings():
    with pool.connection() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    return {key: value for key, value in rows}


@app.put("/api/settings", dependencies=[Depends(require_auth)])
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
