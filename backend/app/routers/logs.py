from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .. import backup as bk
from ..audit import audit
from ..db import get_db, rows_to_dicts
from ..realtime import manager
from ..security import admin_user

router = APIRouter(prefix="/api/v1", tags=["logs", "backup"])

LOG_TABLES = {
    "api_errors": ("api_error_logs", ["path", "message", "method"]),
    "heartbeats": ("heartbeat_logs", ["device_id"]),
    "audit": ("audit_logs", ["action", "target_type", "target_id"]),
    "sync": ("sync_logs", ["device_id", "session_id"]),
    "events": ("device_events", ["device_id", "event_type", "session_id", "event_id"]),
    "rejections": ("result_rejections", ["device_id", "session_id", "reason", "event_id"]),
    "backups": ("backup_history", ["action", "file_path", "result"]),
}


@router.get("/logs/{kind}")
def get_logs(kind: str, q: str | None = None, limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0),
             user: dict = Depends(admin_user), conn: sqlite3.Connection = Depends(get_db)):
    if kind not in LOG_TABLES:
        raise HTTPException(404, "알 수 없는 로그 종류입니다")
    table, cols = LOG_TABLES[kind]
    where, params = "1=1", []
    if q:
        where = "(" + " OR ".join(f"{c} LIKE ?" for c in cols) + ")"
        params = [f"%{q}%"] * len(cols)
    total = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}", params).fetchone()[0]
    if kind == "audit":
        sql = (f"SELECT a.*, u.username FROM audit_logs a LEFT JOIN admin_users u ON u.id=a.admin_user_id"
               f" WHERE {where.replace('action', 'a.action')} ORDER BY a.id DESC LIMIT ? OFFSET ?")
    else:
        sql = f"SELECT * FROM {table} WHERE {where} ORDER BY id DESC LIMIT ? OFFSET ?"
    return {"items": rows_to_dicts(conn.execute(sql, (*params, limit, offset)).fetchall()), "total": total}


class FileIn(BaseModel):
    file: str
    confirm: bool = False


@router.get("/backups")
def backups(user: dict = Depends(admin_user), conn: sqlite3.Connection = Depends(get_db)):
    return {"dir": str(bk.backup_dir(conn)), "items": bk.list_backups(conn)}


@router.post("/backups", status_code=201)
def make_backup(user: dict = Depends(admin_user), conn: sqlite3.Connection = Depends(get_db)):
    result = bk.create_backup(conn, "manual")
    audit(conn, user, "backup.create", "backup", result["file"])
    conn.commit()
    return result


@router.post("/backups/verify")
def verify(body: FileIn, user: dict = Depends(admin_user), conn: sqlite3.Connection = Depends(get_db)):
    try:
        return bk.verify_backup(conn, body.file)
    except FileNotFoundError:
        raise HTTPException(404, "백업 파일을 찾을 수 없습니다")


@router.post("/backups/restore")
def restore(body: FileIn, user: dict = Depends(admin_user), conn: sqlite3.Connection = Depends(get_db)):
    if not body.confirm:
        raise HTTPException(400, "복원하려면 confirm=true 로 확인해야 합니다")
    try:
        result = bk.restore_backup(conn, body.file)
    except FileNotFoundError:
        raise HTTPException(404, "백업 파일을 찾을 수 없습니다")
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(conn, user, "backup.restore", "backup", body.file, {"previous": result["previous_db_saved_as"]})
    conn.commit()
    manager.publish("system.restored", {"file": body.file})
    return result
