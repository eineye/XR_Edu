from __future__ import annotations

import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..audit import audit
from ..db import get_db, rows_to_dicts
from ..security import ROLE_LABELS, admin_user, hash_password, validate_password_policy
from ..timeutil import now_iso

router = APIRouter(prefix="/api/v1/users", tags=["users"])

Role = Literal["admin", "operator", "viewer"]


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_.-]+$")
    display_name: str | None = Field(default=None, max_length=64)
    password: str = Field(min_length=8, max_length=256)
    role: Role


class UserUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=64)
    role: Role | None = None
    active: bool | None = None
    reset_password: str | None = Field(default=None, min_length=8, max_length=256)
    unlock: bool | None = None


COLUMNS = "id, username, display_name, role, active, failed_attempts, locked_until, must_change_password, created_at, last_login_at"


def _active_admins(conn, exclude_id: int | None = None) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM admin_users WHERE role='admin' AND active=1 AND id != ?", (exclude_id or -1,)
    ).fetchone()[0]


@router.get("")
def list_users(user: dict = Depends(admin_user), conn: sqlite3.Connection = Depends(get_db)):
    rows = rows_to_dicts(conn.execute(f"SELECT {COLUMNS} FROM admin_users ORDER BY id").fetchall())
    for r in rows:
        r["role_label"] = ROLE_LABELS[r["role"]]
    return {"items": rows, "roles": ROLE_LABELS}


@router.post("", status_code=201)
def create_user(body: UserCreate, user: dict = Depends(admin_user), conn: sqlite3.Connection = Depends(get_db)):
    validate_password_policy(body.password)
    if conn.execute("SELECT 1 FROM admin_users WHERE username=?", (body.username,)).fetchone():
        raise HTTPException(409, "이미 존재하는 아이디입니다")
    cur = conn.execute(
        "INSERT INTO admin_users(username, display_name, password_hash, role, must_change_password, created_at)"
        " VALUES (?,?,?,?,1,?)",
        (body.username, body.display_name, hash_password(body.password), body.role, now_iso()),
    )
    audit(conn, user, "user.create", "admin_user", cur.lastrowid, {"username": body.username, "role": body.role})
    conn.commit()
    return dict(conn.execute(f"SELECT {COLUMNS} FROM admin_users WHERE id=?", (cur.lastrowid,)).fetchone())


@router.patch("/{user_id}")
def update_user(
    user_id: int, body: UserUpdate, user: dict = Depends(admin_user), conn: sqlite3.Connection = Depends(get_db)
):
    row = conn.execute("SELECT * FROM admin_users WHERE id=?", (user_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "사용자를 찾을 수 없습니다")
    demoting = (body.role is not None and body.role != "admin") or body.active is False
    if row["role"] == "admin" and demoting and _active_admins(conn, user_id) == 0:
        raise HTTPException(400, "마지막 시스템 관리자는 권한 변경·비활성화할 수 없습니다")
    fields, values = [], []
    if body.display_name is not None:
        fields.append("display_name=?"); values.append(body.display_name)
    if body.role is not None:
        fields.append("role=?"); values.append(body.role)
    if body.active is not None:
        fields.append("active=?"); values.append(1 if body.active else 0)
    if body.reset_password:
        validate_password_policy(body.reset_password)
        fields.append("password_hash=?"); values.append(hash_password(body.reset_password))
        fields.append("must_change_password=1")
    if body.unlock:
        fields.append("failed_attempts=0"); fields.append("locked_until=NULL")
    if fields:
        conn.execute(f"UPDATE admin_users SET {', '.join(fields)} WHERE id=?", (*values, user_id))
        audit(conn, user, "user.update", "admin_user", user_id, body.model_dump(exclude_none=True))
        conn.commit()
    return dict(conn.execute(f"SELECT {COLUMNS} FROM admin_users WHERE id=?", (user_id,)).fetchone())
