"""Gmail(IMAP)과 디스코드(REST)에서 새 메시지를 읽어 Claude로 일정을 뽑고 items에 넣는다."""
import email
import imaplib
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from email.policy import default as email_policy
from html import unescape

import httpx
from psycopg.types.json import Jsonb

import llm
import secretbox
from db import pool

NAMES = ("gmail", "discord")
SECRET_FIELDS = {"gmail": ("app_password",), "discord": ("bot_token",)}
CONFIG_FIELDS = {
    "gmail": ("enabled", "address"),
    "discord": ("enabled", "channel_ids"),
}
MAX_MESSAGES_PER_RUN = 20
LOOKBACK_DAYS = 2
_sync_lock = threading.Lock()


# ---------- 저장 ----------
def load(name: str) -> tuple[dict, dict, dict]:
    with pool.connection() as conn:
        row = conn.execute("SELECT config, secrets, status FROM integrations WHERE name = %s", (name,)).fetchone()
    if not row:
        return {}, {}, {}
    return row[0], secretbox.open_(row[1]), row[2]


def save(name: str, config: dict, secrets: dict) -> None:
    with pool.connection() as conn:
        conn.execute(
            """
            INSERT INTO integrations (name, config, secrets, updated_at) VALUES (%s, %s, %s, now())
            ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, secrets = EXCLUDED.secrets, updated_at = now()
            """,
            (name, Jsonb(config), secretbox.seal(secrets)),
        )


def set_status(name: str, status: dict) -> None:
    with pool.connection() as conn:
        conn.execute(
            """
            INSERT INTO integrations (name, status) VALUES (%s, %s)
            ON CONFLICT (name) DO UPDATE SET status = integrations.status || EXCLUDED.status
            """,
            (name, Jsonb(status)),
        )


def update(name: str, body: dict) -> None:
    config, secrets, _ = load(name)
    for field in CONFIG_FIELDS[name]:
        if field in body:
            config[field] = body[field]
    for field in SECRET_FIELDS[name]:
        value = body.get(field)
        if value:  # 빈 칸이면 기존 비밀값을 유지한다.
            secrets[field] = value.strip()
        if body.get(f"clear_{field}"):
            secrets.pop(field, None)
    save(name, config, secrets)


def public_view() -> dict:
    """화면에 보여줄 상태. 비밀값은 설정 여부와 끝 네 글자만 알려준다."""
    result = {}
    for name in NAMES:
        config, secrets, status = load(name)
        masked = {f: (f"••••{secrets[f][-4:]}" if secrets.get(f) else "") for f in SECRET_FIELDS[name]}
        result[name] = {**config, "secrets": masked, "status": status}
    return result


# ---------- 일정 넣기 ----------
def _already(conn, source: str, ref: str) -> bool:
    return conn.execute("SELECT 1 FROM ingested WHERE source = %s AND ref = %s", (source, ref)).fetchone() is not None


def _add_events(source: str, ref: str, events: list, origin: str) -> int:
    added = 0
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    with pool.connection() as conn, conn.transaction():
        existing = {(row[0], row[1]) for row in conn.execute("SELECT data->>'title', coalesce(data->>'date', '') FROM items")}
        top = conn.execute("SELECT coalesce(max(position), 0) FROM items").fetchone()[0]
        for event in events:
            date = event.date if re.fullmatch(r"\d{4}-\d{2}-\d{2}", event.date or "") else ""
            time_ = event.time if re.fullmatch(r"\d{2}:\d{2}", event.time or "") and date else ""
            if (event.title, date) in existing:
                continue  # 같은 일정이 여러 곳에 있어도 한 번만 넣는다.
            existing.add((event.title, date))
            top += 1
            item = {
                "id": f"{source}-{uuid.uuid4().hex[:12]}",
                "title": event.title[:80],
                "date": date or None,
                "time": time_,
                "repeat": "none",
                "category": event.category,
                "memo": event.memo[:300],
                "status": "backlog",
                "completedAt": None,
                "overrides": {},
                "createdAt": now,
                "updatedAt": now,
                "source": source,
                "sourceRef": origin,
                "aiAdded": True,
            }
            conn.execute("INSERT INTO items (id, data, position) VALUES (%s, %s, %s)", (item["id"], Jsonb(item), top))
            added += 1
        conn.execute("INSERT INTO ingested (source, ref) VALUES (%s, %s) ON CONFLICT DO NOTHING", (source, ref))
    return added


# ---------- Gmail ----------
def _plain_text(message) -> str:
    part = message.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    text = part.get_content()
    if part.get_content_type() == "text/html":
        text = re.sub(r"(?is)<(script|style).*?</\1>", " ", text)
        text = unescape(re.sub(r"<[^>]+>", " ", text))
    return re.sub(r"\s+\n", "\n", re.sub(r"[ \t]+", " ", text)).strip()


def _gmail_connect(config: dict, secrets: dict) -> imaplib.IMAP4_SSL:
    if not config.get("address") or not secrets.get("app_password"):
        raise ValueError("Gmail 주소와 앱 비밀번호를 입력해 주세요.")
    imap = imaplib.IMAP4_SSL("imap.gmail.com", timeout=30)
    try:
        imap.login(config["address"], secrets["app_password"].replace(" ", ""))
    except imaplib.IMAP4.error as error:
        raise ValueError("Gmail 로그인 실패: 주소와 앱 비밀번호, IMAP 사용 설정을 확인하세요.") from error
    return imap


def run_gmail() -> int:
    config, secrets, _ = load("gmail")
    imap = _gmail_connect(config, secrets)
    added = 0
    try:
        imap.select("INBOX", readonly=True)  # 읽음 표시를 바꾸지 않는다.
        since = (datetime.now() - timedelta(days=LOOKBACK_DAYS)).strftime("%d-%b-%Y")
        _, data = imap.uid("search", None, "SINCE", since)
        uids = data[0].split()[-MAX_MESSAGES_PER_RUN * 3:]
        handled = 0
        for uid in reversed(uids):
            if handled >= MAX_MESSAGES_PER_RUN:
                break
            _, header = imap.uid("fetch", uid, "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
            raw_id = header[0][1].decode(errors="ignore") if header and header[0] else ""
            ref = raw_id.split(":", 1)[-1].strip() or f"uid-{uid.decode()}"
            with pool.connection() as conn:
                if _already(conn, "gmail", ref):
                    continue
            _, body = imap.uid("fetch", uid, "(BODY.PEEK[])")
            message = email.message_from_bytes(body[0][1], policy=email_policy)
            text = f"보낸 사람: {message['from']}\n제목: {message['subject']}\n날짜: {message['date']}\n\n{_plain_text(message)}"
            events = llm.extract_events("Gmail", text)
            added += _add_events("gmail", ref, events, f"메일: {message['subject'] or '(제목 없음)'}"[:120])
            handled += 1
    finally:
        try:
            imap.logout()
        except Exception:
            pass
    return added


# ---------- Discord ----------
def _channel_ids(config: dict) -> list[str]:
    return [c for c in re.split(r"[\s,]+", config.get("channel_ids") or "") if c.isdigit()]


def _discord_get(token: str, path: str, params=None):
    response = httpx.get(f"https://discord.com/api/v10{path}", params=params, timeout=20,
                         headers={"Authorization": f"Bot {token}", "User-Agent": "check-app (home server, 1.0)"})
    if response.status_code == 401:
        raise ValueError("디스코드 봇 토큰이 올바르지 않습니다.")
    if response.status_code == 403:
        raise ValueError(f"봇이 채널 {path.split('/')[2]}을 읽을 권한이 없습니다.")
    if response.status_code == 404:
        raise ValueError(f"채널 {path.split('/')[2]}을 찾을 수 없습니다.")
    response.raise_for_status()
    return response.json()


def run_discord() -> int:
    config, secrets, status = load("discord")
    token = secrets.get("bot_token")
    channels = _channel_ids(config)
    if not token or not channels:
        raise ValueError("봇 토큰과 채널 ID를 입력해 주세요.")
    last_ids = dict(status.get("last_ids") or {})
    cutoff = datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)
    added = 0
    for channel in channels:
        params = {"limit": 50}
        if last_ids.get(channel):
            params["after"] = last_ids[channel]
        messages = _discord_get(token, f"/channels/{channel}/messages", params)
        messages.sort(key=lambda m: int(m["id"]))
        if messages:
            last_ids[channel] = messages[-1]["id"]
        fresh = [m for m in messages if not m["author"].get("bot") and m.get("content")
                 and datetime.fromisoformat(m["timestamp"]) >= cutoff][-MAX_MESSAGES_PER_RUN:]
        for message in fresh:
            ref = message["id"]
            with pool.connection() as conn:
                if _already(conn, "discord", ref):
                    continue
            text = f"작성자: {message['author'].get('global_name') or message['author']['username']}\n시각: {message['timestamp']}\n\n{message['content']}"
            events = llm.extract_events("디스코드 채널", text)
            added += _add_events("discord", ref, events, f"디스코드: {message['content'][:60]}")
    set_status("discord", {"last_ids": last_ids})
    return added


# ---------- 실행 ----------
RUNNERS = {"gmail": run_gmail, "discord": run_discord}


def sync(only: str | None = None) -> dict:
    if not _sync_lock.acquire(blocking=False):
        return {"busy": True}
    try:
        results = {}
        for name, runner in RUNNERS.items():
            config, _, _ = load(name)
            if only and name != only:
                continue
            if not only and not config.get("enabled"):
                continue
            stamp = datetime.now(timezone.utc).isoformat()
            try:
                count = runner()
                results[name] = {"ok": True, "added": count}
                set_status(name, {"last_run": stamp, "last_error": "", "last_added": count})
            except Exception as error:  # 한 연동이 실패해도 다른 연동은 계속한다.
                message = str(error) or error.__class__.__name__
                results[name] = {"ok": False, "error": message}
                set_status(name, {"last_run": stamp, "last_error": message, "last_added": 0})
        return results
    finally:
        _sync_lock.release()


def test(name: str) -> str:
    config, secrets, _ = load(name)
    if name == "gmail":
        imap = _gmail_connect(config, secrets)
        imap.logout()
        return "Gmail 로그인 성공"
    if name == "discord":
        if not secrets.get("bot_token"):
            raise ValueError("봇 토큰을 입력해 주세요.")
        me = _discord_get(secrets["bot_token"], "/users/@me")
        names = []
        for channel in _channel_ids(config):
            names.append("#" + _discord_get(secrets["bot_token"], f"/channels/{channel}").get("name", channel))
        return f"봇 {me.get('username')} 연결됨" + (f" · 채널 {', '.join(names)}" if names else " · 채널 ID를 입력하세요")
    raise ValueError("알 수 없는 연동")


def interval_minutes() -> int:
    with pool.connection() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = 'syncMinutes'").fetchone()
    try:
        return max(5, int(row[0])) if row else 15
    except (TypeError, ValueError):
        return 15


def start_background_loop() -> None:
    def loop():
        time.sleep(30)
        while True:
            try:
                sync()
            except Exception:
                pass
            time.sleep(interval_minutes() * 60)
    threading.Thread(target=loop, name="integration-sync", daemon=True).start()
