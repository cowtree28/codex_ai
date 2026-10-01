"""서버의 llm-wiki 허브를 앱에 연결한다.

- 읽기: 허브 폴더(읽기 전용으로 연결)의 마크다운 파일을 그대로 읽는다.
- 작업: 질문·기록·정리는 jobs 대기열에 넣고, 서버 본체의 작업기가 서버 Claude Code + llm-wiki로 실행한다.
  셸(Bash)과 웹(WebFetch, WebSearch)은 항상 막고, 질문은 읽기 도구만, 기록·정리는 파일 편집만 허용한다.
"""
import os
import re
from pathlib import Path

import jobs

HUB = Path(os.environ.get("WIKI_HUB", str(Path.home() / "wiki"))).resolve()
SKIP_DIRS = {".obsidian", ".librarian", ".audit", ".sessions", ".processed", ".git", ".archive", ".skills"}
TOPIC_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,60}$")
READ_TOOLS = "Read,Glob,Grep"
EDIT_TOOLS = "Read,Glob,Grep,Write,Edit"



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


def create_job(action: str, topic: str, text: str, options: dict) -> dict:
    prompt, tools = build(action, topic, text, options or {})
    job_id = jobs.enqueue("wiki", prompt, action=action, topic=topic or None, text=(text or "").strip(),
                          tools=tools, settings="user", workdir="hub")
    return jobs.get(job_id)


def get_job(job_id: str) -> dict:
    try:
        return jobs.get(job_id)
    except jobs.JobError as error:
        raise WikiError(str(error))


def list_jobs() -> list[dict]:
    return jobs.recent("wiki")
