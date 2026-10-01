#!/usr/bin/env python3
"""서버 본체에서 도는 Claude 작업기.

앱 API(127.0.0.1:3100)의 작업 대기열에서 작업을 하나씩 꺼내, 이 서버에 로그인된
Claude Code(llm-wiki 플러그인 포함)로 실행하고 결과를 돌려준다.
deploy.sh 가 cron 으로 2분마다 살아 있는지 확인하고, 꺼져 있으면 다시 띄운다.

안전 규칙
- 셸(Bash), 웹(WebFetch/WebSearch), 하위 에이전트(Task)는 항상 막는다.
- 작업마다 허용 도구를 API가 정한다: 일정 추출은 도구 없음, 위키 질문은 읽기만, 위키 기록·정리는 편집까지.
- 위키 작업은 위키 허브 폴더에서, 일정 추출은 빈 임시 폴더에서 실행한다.
"""
import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HOME = Path.home()
ENV_FILE = Path(os.environ.get("CHECK_ENV_FILE", str(HOME / "check" / ".env")))
API = os.environ.get("CHECK_API", "http://127.0.0.1:3100/check/api")
CLAUDE = os.environ.get("CLAUDE_BIN", str(HOME / ".local" / "bin" / "claude"))
BLOCKED = "Bash,WebFetch,WebSearch,Task,NotebookEdit"
ALLOWED = {"", "Read,Glob,Grep", "Read,Glob,Grep,Write,Edit"}
TIMEOUT = 900


def log(message: str) -> None:
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), message, flush=True)


def secret() -> str:
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith("SESSION_SECRET="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("SESSION_SECRET 을 찾을 수 없습니다")


def hub() -> Path:
    if os.environ.get("WIKI_HUB"):
        return Path(os.environ["WIKI_HUB"])
    try:
        config = json.loads((HOME / ".config" / "llm-wiki" / "config.json").read_text())
        path = config.get("hub_path") or config.get("resolved_path") or "~/wiki"
    except (OSError, ValueError):
        path = "~/wiki"
    return Path(os.path.expanduser(path))


def call(path: str, token: str, body: dict | None = None):
    request = urllib.request.Request(f"{API}{path}", method="POST",
                                     data=json.dumps(body or {}).encode(),
                                     headers={"Content-Type": "application/json", "X-Worker-Token": token})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status == 204:
            return None
        return json.loads(response.read() or b"null")


def run(job: dict) -> tuple[str, str, object]:
    tools = job.get("tools") or ""
    if tools not in ALLOWED:
        return "error", f"허용되지 않은 도구 조합입니다: {tools}", None
    args = [CLAUDE, "-p", job["prompt"], "--setting-sources", job.get("settings") or "",
            "--strict-mcp-config", "--tools", tools, "--disallowedTools", BLOCKED,
            "--permission-mode", "dontAsk", "--no-session-persistence", "--output-format", "json"]
    if tools:
        args += ["--allowedTools", tools]
    if not job.get("settings"):
        args.append("--disable-slash-commands")
    if job.get("system"):
        args += ["--system-prompt", job["system"]]
    if job.get("schema"):
        args += ["--json-schema", json.dumps(job["schema"], ensure_ascii=False)]
    env = {k: v for k, v in os.environ.items() if k not in ("SESSION_SECRET", "APP_PASSWORD", "POSTGRES_PASSWORD")}
    with tempfile.TemporaryDirectory() as scratch:
        cwd = str(hub()) if job.get("workdir") == "hub" else scratch
        try:
            done = subprocess.run(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                  capture_output=True, text=True, timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            return "error", f"{TIMEOUT // 60}분 안에 끝나지 않아 멈췄습니다.", None
        except FileNotFoundError:
            return "error", "서버에 Claude Code가 설치되어 있지 않습니다.", None
    try:
        data = json.loads(done.stdout)
    except json.JSONDecodeError:
        return "error", f"Claude Code 실행 실패: {(done.stderr or done.stdout).strip()[:300]}", None
    text = str(data.get("result") or "").strip()
    if data.get("is_error"):
        if "login" in text.lower():
            text = "서버의 Claude Code 로그인이 풀렸습니다. 서버에서 claude를 실행해 /login 하세요."
        elif "limit" in text.lower():
            text = "Claude 구독 사용량 한도에 걸렸습니다. 잠시 뒤 다시 시도하세요."
        return "error", text or "Claude Code 오류", None
    return "done", text, data.get("structured_output")


def main() -> None:
    token = hmac.new(secret().encode(), b"check-worker-v1", hashlib.sha256).hexdigest()
    log(f"worker started, api={API}, hub={hub()}")
    while True:
        try:
            job = call("/worker/claim", token)
        except (urllib.error.URLError, OSError) as error:
            log(f"api unreachable: {error}")
            time.sleep(15)
            continue
        if not job:
            time.sleep(3)
            continue
        log(f"job {job['id']} {job['kind']} start")
        status, result, structured = run(job)
        log(f"job {job['id']} {status}")
        for attempt in range(5):
            try:
                call(f"/worker/jobs/{job['id']}", token, {"status": status, "result": result, "structured": structured})
                break
            except (urllib.error.URLError, OSError) as error:
                log(f"report failed ({attempt + 1}/5): {error}")
                time.sleep(5)


if __name__ == "__main__":
    sys.exit(main())
