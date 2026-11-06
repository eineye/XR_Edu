"""관리자 작업 감사 로그. 비밀번호 등 민감정보는 기록하지 않는다."""
from __future__ import annotations

import json
import sqlite3

from .timeutil import now_iso

SENSITIVE_KEYS = {"password", "reset_password", "new_password", "current_password", "password_hash", "device_api_key", "token"}


def _scrub(obj):
    if isinstance(obj, dict):
        return {k: ("***" if k in SENSITIVE_KEYS else _scrub(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_scrub(v) for v in obj]
    return obj


def audit(
    conn: sqlite3.Connection,
    user: dict | None,
    action: str,
    target_type: str | None = None,
    target_id: str | int | None = None,
    detail: dict | None = None,
) -> None:
    conn.execute(
        "INSERT INTO audit_logs(admin_user_id, action, target_type, target_id, detail_json, created_at)"
        " VALUES (?,?,?,?,?,?)",
        (
            user["id"] if user else None,
            action,
            target_type,
            None if target_id is None else str(target_id),
            json.dumps(_scrub(detail), ensure_ascii=False) if detail else None,
            now_iso(),
        ),
    )
