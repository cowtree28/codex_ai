"""서버의 llm-wiki 허브를 앱에 연결한다.

- 읽기: 허브 폴더의 마크다운 파일을 그대로 읽는다 (Claude 호출 없음).
- 작업: 질문·기록·정리는 서버의 Claude Code에 /wiki:* 명령으로 맡긴다.
  안전을 위해 셸(Bash)과 웹(WebFetch, WebSearch)은 항상 끄고,
  질문은 읽기 도구만, 기록·정리는 허브 폴더 안의 파일 편집만 허용한다.
  URL 수집이나 웹 리서치가 필요하면 서버에서 직접 claude를 실행한다.
"""
import json
import os
import re
import subprocess
import threading
import uuid
from pathlib import Path

from db import pool

HUB = Path(os.environ.get("WIKI_HUB", str(Path.home() / "wiki"))).resolve()
JOB_TIMEOUT = 900
HIDDEN_ENV = ("APP_PASSWORD", "SESSION_SECRET", "DATABASE_URL", "POSTGRES_PASSWORD")
SKIP_DIRS = {".obsidian", ".librarian", ".audit", ".sessions", ".processed", ".git", ".archive", ".skills"}
TOPIC_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,60}$")
READ_TOOLS = "Read,Glob,Grep"
EDIT_TOOLS = "Read,Glob,Grep,Write,Edit"
BLOCKED_TOOLS = "Bash,WebFetch,WebSearch,Task,NotebookEdit"
_wake = threading.Event()

SCHEMA = """
CREATE TABLE IF NOT EXISTS wiki_jobs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    topic TEXT,
    input TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL,
    tools TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    result TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);
"""


class WikiError(Exception):
    pass


# ---------- 읽기 ----------
def _safe(rel: str) -> Path:
    path = (HUB / rel).resolve()
    if path != HUB and HUB not in path.parents:
        raise WikiError("허브 밖의 파일은 열 수 없습니다.")
    return path


def _frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end < 0:
        return {}, text
    meta = {}
    for line in text[4:end].splitlines():
        match = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if match:
            meta[match.group(1)] = match.group(2).strip().strip('"').strip("'")
    return meta, text[end + 4:].lstrip("\n")


def topics() -> list[dict]:
    root = HUB / "topics"
    if not root.is_dir():
        return []
    result = []
    for path in sorted(root.iterdir()):
        if not path.is_dir() or path.name.startswith("."):
            continue
        meta = _frontmatter((path / "config.md").read_text(errors="ignore"))[0] if (path / "config.md").exists() else {}
        articles = sum(1 for f in (path / "wiki").rglob("*.md") if f.name != "_index.md") if (path / "wiki").is_dir() else 0
        result.append({"name": path.name, "title": meta.get("title") or path.name, "articles": articles})
    return result


def files(topic: str) -> list[dict]:
    if not TOPIC_RE.match(topic):
        raise WikiError("주제 이름이 올바르지 않습니다.")
    base = _safe(f"topics/{topic}")
    if not base.is_dir():
        raise WikiError("주제를 찾을 수 없습니다.")
    result = []
    for path in base.rglob("*.md"):
        parts = path.relative_to(base).parts
        if any(part in SKIP_DIRS for part in parts):
            continue
        meta, body = _frontmatter(path.read_text(errors="ignore"))
        if path.name == "_index.md" and path.parent != base and not any(
                f.name != "_index.md" for f in path.parent.rglob("*.md")):
            continue  # 문서가 하나도 없는 폴더의 목차는 감춘다.
        result.append({"path": str(path.relative_to(HUB)), "section": parts[0] if len(parts) > 1 else "",
                       "title": meta.get("title") or ("목차" if path.name == "_index.md" else path.stem),
                       "summary": meta.get("summary", ""), "slug": path.stem, "updated": path.stat().st_mtime})
    order = {"wiki": 0, "output": 1, "": 2, "inventory": 3, "raw": 4, "inbox": 5}
    result.sort(key=lambda f: (order.get(f["section"], 6), f["path"]))
    return result


def read(rel: str) -> dict:
    path = _safe(rel)
    if path.suffix != ".md" or not path.is_file():
        raise WikiError("파일을 찾을 수 없습니다.")
    meta, body = _frontmatter(path.read_text(errors="ignore"))
    return {"path": str(path.relative_to(HUB)), "meta": meta, "body": body}


# ---------- 작업 ----------
def _quote(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'


def build(action: str, topic: str, text: str, options: dict) -> tuple[str, str]:
    """(프롬프트, 허용 도구)를 만든다."""
    text = (text or "").strip()
    if action == "init":
        if not TOPIC_RE.match(text):
            raise WikiError("주제 이름은 영어 소문자, 숫자, -만 쓸 수 있습니다. (예: school-2026)")
        return f"/wiki:wiki init {text}", EDIT_TOOLS
    if not TOPIC_RE.match(topic or ""):
        raise WikiError("주제를 골라 주세요.")
    wiki = f" --wiki {topic}"
    if action == "query":
        if not text:
            raise WikiError("질문을 입력해 주세요.")
        return f"/wiki:query {text}{' --deep' if options.get('deep') else ''}{wiki}", READ_TOOLS
    if action == "ingest":
        if not text:
            raise WikiError("기록할 내용을 입력해 주세요.")
        if re.fullmatch(r"https?://\S+", text):
            raise WikiError("URL 수집은 웹 접근이 필요해서 앱에서는 막아 두었습니다. 내용을 붙여 넣어 기록하세요.")
        title = f" --title {_quote(options['title'])}" if options.get("title") else ""
        prompt = f"/wiki:ingest {_quote(text)} --type notes{title}{wiki}"
        if options.get("compile"):
            prompt += f"\n\n수집이 끝나면 이어서 /wiki:compile{wiki} 를 실행해 위키 문서로 정리하세요."
        return prompt, EDIT_TOOLS
    if action == "compile":
        return f"/wiki:compile{wiki}", EDIT_TOOLS
    raise WikiError("알 수 없는 작업입니다.")


JOB_COLS = "id, action, topic, input, status, result, created_at, started_at, finished_at"


def _job(row) -> dict:
    job = dict(zip(JOB_COLS.split(", "), row))
    for key in ("created_at", "started_at", "finished_at"):
        job[key] = job[key].isoformat() if job[key] else None
    return job


def create_job(action: str, topic: str, text: str, options: dict) -> dict:
    prompt, tools = build(action, topic, text, options or {})
    job_id = uuid.uuid4().hex[:12]
    with pool.connection() as conn:
        conn.execute("INSERT INTO wiki_jobs (id, action, topic, input, prompt, tools) VALUES (%s, %s, %s, %s, %s, %s)",
                     (job_id, action, topic, (text or "").strip(), prompt, tools))
    _wake.set()
    return get_job(job_id)


def get_job(job_id: str) -> dict:
    with pool.connection() as conn:
        row = conn.execute(f"SELECT {JOB_COLS} FROM wiki_jobs WHERE id = %s", (job_id,)).fetchone()
    if not row:
        raise WikiError("작업을 찾을 수 없습니다.")
    return _job(row)


def list_jobs(limit: int = 20) -> list[dict]:
    with pool.connection() as conn:
        rows = conn.execute(f"SELECT {JOB_COLS} FROM wiki_jobs ORDER BY created_at DESC LIMIT %s", (limit,)).fetchall()
    return [_job(r) for r in rows]


def _run(prompt: str, tools: str) -> tuple[str, str]:
    # 플러그인을 쓰려면 사용자 설정(user)을 읽되, 도구는 명시한 것만 허용하고 셸·웹은 막는다.
    args = ["claude", "-p", prompt, "--setting-sources", "user", "--strict-mcp-config",
            "--tools", tools, "--allowedTools", tools, "--disallowedTools", BLOCKED_TOOLS,
            "--permission-mode", "dontAsk", "--no-session-persistence", "--output-format", "json"]
    env = {k: v for k, v in os.environ.items() if k not in HIDDEN_ENV}
    try:
        done = subprocess.run(args, cwd=str(HUB), env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=JOB_TIMEOUT)
    except FileNotFoundError:
        return "error", "서버에 Claude Code가 설치되어 있지 않습니다."
    except subprocess.TimeoutExpired:
        return "error", f"{JOB_TIMEOUT // 60}분 안에 끝나지 않아 멈췄습니다."
    try:
        data = json.loads(done.stdout)
    except json.JSONDecodeError:
        return "error", f"Claude Code 실행 실패: {(done.stderr or done.stdout).strip()[:300]}"
    text = str(data.get("result") or "").strip()
    if data.get("is_error"):
        if "login" in text.lower():
            text = "서버의 Claude Code 로그인이 풀렸습니다. 서버에서 claude를 실행해 /login 하세요."
        return "error", text or "Claude Code 오류"
    return "done", text


def _worker():
    while True:
        with pool.connection() as conn:
            row = conn.execute("SELECT id, prompt, tools FROM wiki_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").fetchone()
            if row:
                conn.execute("UPDATE wiki_jobs SET status = 'running', started_at = now() WHERE id = %s", (row[0],))
        if not row:
            _wake.wait(30)
            _wake.clear()
            continue
        status, result = _run(row[1], row[2])
        with pool.connection() as conn:
            conn.execute("UPDATE wiki_jobs SET status = %s, result = %s, finished_at = now() WHERE id = %s",
                         (status, result, row[0]))


def start_worker() -> None:
    with pool.connection() as conn:
        conn.execute(SCHEMA)
        conn.execute("UPDATE wiki_jobs SET status = 'error', result = '서버가 다시 시작되어 중단되었습니다.', "
                     "finished_at = now() WHERE status = 'running'")
    threading.Thread(target=_worker, name="wiki-jobs", daemon=True).start()
