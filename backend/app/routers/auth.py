from __future__ import annotations

import sqlite3
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..audit import audit
from ..db import get_db, get_settings
from ..security import (
    ROLE_LABELS,
    create_access_token,
    get_current_user,
    hash_password,
    validate_password_policy,
    verify_password,
)
from ..timeutil import now_iso, now_utc, parse_iso

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=256)


@router.post("/login")
def login(body: LoginIn, conn: sqlite3.Connection = Depends(get_db)):
    settings = get_settings(conn)
    row = conn.execute("SELECT * FROM admin_users WHERE username=?", (body.username,)).fetchone()
    generic = HTTPException(401, "아이디 또는 비밀번호가 올바르지 않습니다")
    if row is None:
        raise generic
    if not row["active"]:
        raise HTTPException(403, "비활성화된 계정입니다. 시스템 관리자에게 문의하세요")
    if row["locked_until"] and parse_iso(row["locked_until"]) > now_utc():
        raise HTTPException(423, "로그인 실패 횟수 초과로 잠긴 계정입니다. 잠시 후 다시 시도하세요")

    if not verify_password(body.password, row["password_hash"]):
        failures = row["failed_attempts"] + 1
        locked_until = None
        if failures >= settings["login_max_failures"]:
            locked_until = (now_utc() + timedelta(minutes=settings["login_lock_minutes"])).isoformat()
            failures = 0
        conn.execute(
            "UPDATE admin_users SET failed_attempts=?, locked_until=? WHERE id=?",
            (failures, locked_until, row["id"]),
        )
        audit(conn, None, "auth.login_failed", "admin_user", row["id"], {"username": body.username})
        conn.commit()
        if locked_until:
            raise HTTPException(423, f"로그인 {settings['login_max_failures']}회 실패로 {settings['login_lock_minutes']}분간 잠깁니다")
        raise generic

    conn.execute(
        "UPDATE admin_users SET failed_attempts=0, locked_until=NULL, last_login_at=? WHERE id=?",
        (now_iso(), row["id"]),
    )
    audit(conn, dict(row), "auth.login", "admin_user", row["id"])
    conn.commit()
    token = create_access_token(row["id"], row["role"], settings["token_expire_minutes"])
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": settings["token_expire_minutes"] * 60,
        "user": {
            "id": row["id"],
            "username": row["username"],
            "display_name": row["display_name"],
            "role": row["role"],
            "role_label": ROLE_LABELS[row["role"]],
            "must_change_password": bool(row["must_change_password"]),
        },
    }


@router.get("/me")
def me(user: dict = Depends(get_current_user)):
    return {**user, "role_label": ROLE_LABELS[user["role"]], "must_change_password": bool(user["must_change_password"])}


@router.post("/change-password")
def change_password(
    body: PasswordChangeIn, user: dict = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)
):
    row = conn.execute("SELECT password_hash FROM admin_users WHERE id=?", (user["id"],)).fetchone()
    if not verify_password(body.current_password, row["password_hash"]):
        raise HTTPException(400, "현재 비밀번호가 올바르지 않습니다")
    if body.current_password == body.new_password:
        raise HTTPException(400, "새 비밀번호가 현재 비밀번호와 같습니다")
    validate_password_policy(body.new_password)
    conn.execute(
        "UPDATE admin_users SET password_hash=?, must_change_password=0 WHERE id=?",
        (hash_password(body.new_password), user["id"]),
    )
    audit(conn, user, "auth.password_changed", "admin_user", user["id"])
    conn.commit()
    return {"success": True}
