"""check 앱의 API.

- 사용자는 한 명이다. 비밀번호(APP_PASSWORD) 하나로 로그인하면 세션 토큰을 준다.
- 일정(items)·설정(settings)·노트(notes)를 Postgres에 저장한다.
- 노트는 [[제목]]으로 서로 연결되는 개인 위키이고, Claude로 요약·질문할 수 있다.
- 연동(Gmail, 디스코드, Claude API 키)은 설정 화면에서 등록하며 비밀값은 암호화해 저장한다.
"""
import hashlib
import hmac
import io
import os
import re
import time
import uuid
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb
from pydantic import BaseModel

import integrations
import llm
from db import init_db, pool

APP_PASSWORD = os.environ["APP_PASSWORD"]
SESSION_SECRET = os.environ["SESSION_SECRET"]
LINK_RE = re.compile(r"\[\[([^\[\]\n]{1,120})\]\]")


def session_token() -> str:
    """서버 비밀값으로 만든 고정 토큰. 비밀값을 바꾸면 모든 기기가 로그아웃된다."""
    return hmac.new(SESSION_SECRET.encode(), b"check-session-v1", hashlib.sha256).hexdigest()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    if os.environ.get("DISABLE_SYNC") != "1":
        integrations.start_background_loop()
    yield
    pool.close()


app = FastAPI(title="check API", lifespan=lifespan, docs_url=None, redoc_url=None)


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


# ---------- 노트 (개인 위키) ----------
class NoteBody(BaseModel):
    title: str
    body: str = ""
    item_id: str | None = None


def note_row(row) -> dict:
    return {"id": row[0], "title": row[1], "body": row[2], "item_id": row[3],
            "created_at": row[4].isoformat(), "updated_at": row[5].isoformat()}


NOTE_COLS = "id, title, body, item_id, created_at, updated_at"


def clean_title(title: str) -> str:
    title = re.sub(r"[\[\]\n]", "", title).strip()
    if not title:
        raise HTTPException(status_code=400, detail="노트 제목을 입력해 주세요.")
    return title[:120]


@app.get("/api/notes", dependencies=auth)
def list_notes(q: str = ""):
    with pool.connection() as conn:
        if q.strip():
            pattern = f"%{q.strip()}%"
            rows = conn.execute(
                f"SELECT {NOTE_COLS} FROM notes WHERE title ILIKE %s OR body ILIKE %s ORDER BY updated_at DESC LIMIT 200",
                (pattern, pattern)).fetchall()
        else:
            rows = conn.execute(f"SELECT {NOTE_COLS} FROM notes ORDER BY updated_at DESC LIMIT 500").fetchall()
    return [{**note_row(r), "body": r[2][:160]} for r in rows]


@app.get("/api/notes/export", dependencies=auth)
def export_notes():
    """노트 전체를 마크다운 파일 묶음(zip)으로 내려준다."""
    with pool.connection() as conn:
        rows = conn.execute(f"SELECT {NOTE_COLS} FROM notes ORDER BY title").fetchall()
    buffer = io.BytesIO()
    used = set()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for row in rows:
            name = re.sub(r'[\\/:*?"<>|]', "_", row[1]) or "untitled"
            while name.lower() in used:
                name += "_"
            used.add(name.lower())
            archive.writestr(f"notes/{name}.md", f"# {row[1]}\n\n{row[2]}\n")
    buffer.seek(0)
    stamp = datetime.now().strftime("%Y%m%d")
    return StreamingResponse(buffer, media_type="application/zip",
                             headers={"Content-Disposition": f'attachment; filename="check-notes-{stamp}.zip"'})


@app.get("/api/notes/{note_id}", dependencies=auth)
def get_note(note_id: str):
    with pool.connection() as conn:
        row = conn.execute(f"SELECT {NOTE_COLS} FROM notes WHERE id = %s", (note_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="노트를 찾을 수 없습니다.")
        note = note_row(row)
        targets = list(dict.fromkeys(m.strip() for m in LINK_RE.findall(note["body"])))
        found = {}
        if targets:
            for r in conn.execute("SELECT id, title FROM notes WHERE lower(title) = ANY(%s)",
                                  ([t.lower() for t in targets],)).fetchall():
                found[r[1].lower()] = {"id": r[0], "title": r[1]}
        backlinks = conn.execute(
            "SELECT id, title FROM notes WHERE id <> %s AND body ILIKE %s ORDER BY updated_at DESC",
            (note_id, f"%[[{note['title']}]]%")).fetchall()
    note["links"] = [found.get(t.lower(), {"id": None, "title": t}) for t in targets]
    note["backlinks"] = [{"id": r[0], "title": r[1]} for r in backlinks]
    return note


@app.post("/api/notes", dependencies=auth)
def create_note(body: NoteBody):
    note_id = uuid.uuid4().hex[:16]
    try:
        with pool.connection() as conn:
            row = conn.execute(
                f"INSERT INTO notes (id, title, body, item_id) VALUES (%s, %s, %s, %s) RETURNING {NOTE_COLS}",
                (note_id, clean_title(body.title), body.body, body.item_id)).fetchone()
    except UniqueViolation:
        raise HTTPException(status_code=409, detail="같은 제목의 노트가 이미 있습니다.")
    return note_row(row)


@app.put("/api/notes/{note_id}", dependencies=auth)
def update_note(note_id: str, body: NoteBody):
    try:
        with pool.connection() as conn, conn.transaction():
            old = conn.execute("SELECT title FROM notes WHERE id = %s", (note_id,)).fetchone()
            if not old:
                raise HTTPException(status_code=404, detail="노트를 찾을 수 없습니다.")
            title = clean_title(body.title)
            row = conn.execute(
                f"UPDATE notes SET title = %s, body = %s, item_id = %s, updated_at = now() WHERE id = %s RETURNING {NOTE_COLS}",
                (title, body.body, body.item_id, note_id)).fetchone()
            if old[0] != title:
                # 제목을 바꾸면 다른 노트의 [[옛 제목]] 링크도 함께 고친다.
                conn.execute("UPDATE notes SET body = replace(body, %s, %s) WHERE body LIKE %s",
                             (f"[[{old[0]}]]", f"[[{title}]]", f"%[[{old[0]}]]%"))
    except UniqueViolation:
        raise HTTPException(status_code=409, detail="같은 제목의 노트가 이미 있습니다.")
    return note_row(row)


@app.delete("/api/notes/{note_id}", dependencies=auth)
def delete_note(note_id: str):
    with pool.connection() as conn:
        conn.execute("DELETE FROM notes WHERE id = %s", (note_id,))
    return {"ok": True}


def llm_config() -> dict:
    config, secrets, _ = integrations.load("llm")
    return {**config, **secrets}


def llm_guard(fn):
    try:
        return fn()
    except llm.LLMError as error:
        raise HTTPException(status_code=400, detail=str(error))


@app.post("/api/notes/{note_id}/summary", dependencies=auth)
def summarize(note_id: str):
    with pool.connection() as conn:
        row = conn.execute("SELECT title, body FROM notes WHERE id = %s", (note_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="노트를 찾을 수 없습니다.")
    if not row[1].strip():
        raise HTTPException(status_code=400, detail="요약할 내용이 없습니다.")
    return {"summary": llm_guard(lambda: llm.summarize_note(llm_config(), row[0], row[1]))}


class AskBody(BaseModel):
    question: str


@app.post("/api/ask", dependencies=auth)
def ask(body: AskBody):
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="질문을 입력해 주세요.")
    words = [w for w in re.findall(r"[\w가-힣]+", question) if len(w) >= 2][:8]
    with pool.connection() as conn:
        rows = conn.execute("SELECT title, body FROM notes ORDER BY updated_at DESC LIMIT 500").fetchall()
    # 질문 낱말이 많이 들어 있는 노트부터 고른다. 맞는 노트가 없으면 최근 노트를 쓴다.
    scored = sorted(((sum((t + b).lower().count(w.lower()) for w in words), t, b) for t, b in rows), key=lambda x: -x[0])
    picked = [(t, b) for score, t, b in scored if score > 0][:8] or [(t, b) for _, t, b in scored[:8]]
    if not picked:
        raise HTTPException(status_code=400, detail="아직 노트가 없습니다.")
    answer = llm_guard(lambda: llm.answer_question(llm_config(), question, picked))
    return {"answer": answer, "sources": [t for t, _ in picked]}


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
    except (ValueError, llm.LLMError) as error:
        return {"ok": False, "message": str(error)}
    except Exception as error:
        return {"ok": False, "message": f"연결 실패: {error.__class__.__name__}"}


@app.post("/api/integrations/sync", dependencies=auth)
def sync_now(only: str | None = None):
    if only and only not in integrations.RUNNERS:
        raise HTTPException(status_code=404, detail="알 수 없는 연동입니다.")
    return integrations.sync(only)
