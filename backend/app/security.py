"""인증·권한·장비 요청 검증."""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import sqlite3
from datetime import timedelta

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import config
from .db import get_db, get_settings
from .timeutil import now_utc

PBKDF2_ITERATIONS = 240_000
ROLES = ("admin", "operator", "viewer")
ROLE_LABELS = {"admin": "시스템 관리자", "operator": "교육 운영자", "viewer": "조회 전용"}


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ITERATIONS, base64.b64encode(salt).decode(), base64.b64encode(dk).decode()
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iterations, salt_b64, hash_b64 = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), base64.b64decode(salt_b64), int(iterations)
        )
        return hmac.compare_digest(dk, base64.b64decode(hash_b64))
    except (ValueError, TypeError):
        return False


def validate_password_policy(password: str) -> None:
    if len(password) < 8:
        raise HTTPException(400, "비밀번호는 8자 이상이어야 합니다")
    if password.isdigit() or password.isalpha():
        raise HTTPException(400, "비밀번호는 영문과 숫자를 함께 포함해야 합니다")


def create_access_token(user_id: int, role: str, expire_minutes: int) -> str:
    payload = {
        "sub": str(user_id),
        "role": role,
        "iat": int(now_utc().timestamp()),
        "exp": int((now_utc() + timedelta(minutes=expire_minutes)).timestamp()),
    }
    return jwt.encode(payload, config.secret_key, algorithm="HS256")


def decode_token(token: str) -> dict:
    return jwt.decode(token, config.secret_key, algorithms=["HS256"])


bearer = HTTPBearer(auto_error=False)


def get_current_user(
    cred: HTTPAuthorizationCredentials | None = Depends(bearer),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    if cred is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "로그인이 필요합니다")
    try:
        payload = decode_token(cred.credentials)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "로그인 세션이 만료되었습니다. 다시 로그인하세요")
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "유효하지 않은 인증 정보입니다")
    row = conn.execute(
        "SELECT id, username, display_name, role, active, must_change_password FROM admin_users WHERE id=?",
        (int(payload["sub"]),),
    ).fetchone()
    if row is None or not row["active"]:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "비활성화되었거나 존재하지 않는 계정입니다")
    return dict(row)


def require_roles(*roles: str):
    def checker(user: dict = Depends(get_current_user)) -> dict:
        if user["role"] not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "이 작업을 수행할 권한이 없습니다")
        return user

    return checker


# 권한 단축 의존성
any_user = get_current_user
operator_user = require_roles("admin", "operator")
admin_user = require_roles("admin")


def verify_device(
    x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
    conn: sqlite3.Connection = Depends(get_db),
) -> None:
    """HMD → 서버 요청 검증. 설정에서 끌 수 있다(개발용)."""
    settings = get_settings(conn)
    if not settings["require_device_key"]:
        return
    expected = str(settings["device_api_key"] or "")
    if not x_device_key or not expected or not hmac.compare_digest(x_device_key, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "장비 키(X-Device-Key)가 올바르지 않습니다")
