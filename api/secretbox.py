"""연동 비밀값(API 키, 앱 비밀번호, 봇 토큰)을 SESSION_SECRET에서 만든 키로 암호화한다."""
import base64
import hashlib
import json
import os

from cryptography.fernet import Fernet, InvalidToken

_key = base64.urlsafe_b64encode(hashlib.sha256(("secrets:" + os.environ["SESSION_SECRET"]).encode()).digest())
_box = Fernet(_key)


def seal(data: dict) -> str:
    return _box.encrypt(json.dumps(data).encode()).decode() if data else ""


def open_(token: str) -> dict:
    if not token:
        return {}
    try:
        return json.loads(_box.decrypt(token.encode()))
    except InvalidToken:
        return {}  # SESSION_SECRET이 바뀌면 다시 입력해야 한다.
