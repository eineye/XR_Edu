from __future__ import annotations

import os
import platform
import shutil
import sqlite3
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..audit import audit
from ..config import config
from ..db import DEFAULT_SETTINGS, encode_setting, get_db, get_settings
from ..netinfo import local_ips
from ..realtime import manager
from ..security import admin_user, any_user
from ..timeutil import now_iso
from .. import __version__

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])

LIMITS = {
    "heartbeat_interval_sec": (5, 600), "offline_threshold_sec": (15, 3600), "delay_threshold_sec": (10, 3600),
    "battery_warning_pct": (1, 99), "error_hold_sec": (0, 86400), "sync_batch_size": (1, 500),
    "sync_retry_base_sec": (1, 600), "sync_retry_max_sec": (5, 3600), "auto_backup_hour": (0, 23),
    "backup_keep_count": (1, 365), "log_retention_days": (1, 3650), "result_retention_days": (0, 36500),
    "token_expire_minutes": (10, 1440), "login_max_failures": (3, 20), "login_lock_minutes": (1, 1440),
}


class SettingsPatch(BaseModel):
    values: dict[str, object]


def backup_dir(settings: dict) -> str:
    return str(settings["backup_dir"] or config.default_backup_dir)


def _public(settings: dict, is_admin: bool) -> dict:
    out = dict(settings)
    if not is_admin:
        out["device_api_key"] = "********"
    out["backup_dir_effective"] = backup_dir(settings)
    return out


@router.get("")
def read_settings(user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db)):
    s = get_settings(conn)
    ips = local_ips()
    host = config.public_host or ips[0]
    return {
        "values": _public(s, user["role"] == "admin"),
        "descriptions": {k: v[2] for k, v in DEFAULT_SETTINGS.items()},
        "limits": LIMITS,
        "server": {"bind_host": config.host, "port": config.port, "public_host": host, "local_ips": ips,
                   "api_base": f"http://{host}:{config.port}", "db_path": str(config.db_file)},
    }


@router.patch("")
def patch_settings(body: SettingsPatch, user: dict = Depends(admin_user), conn: sqlite3.Connection = Depends(get_db)):
    current = get_settings(conn)
    changes = {}
    for key, value in body.values.items():
        if key not in DEFAULT_SETTINGS:
            raise HTTPException(400, f"알 수 없는 설정 항목: {key}")
        typ = DEFAULT_SETTINGS[key][1]
        try:
            if typ is bool:
                v = value if isinstance(value, bool) else str(value).lower() in ("1", "true", "yes", "on")
            elif typ is int:
                v = int(value)
            else:
                v = "" if value is None else str(value).strip()
        except (TypeError, ValueError):
            raise HTTPException(400, f"{key}: 올바른 값이 아닙니다")
        if key in LIMITS:
            lo, hi = LIMITS[key]
            if not lo <= v <= hi:
                raise HTTPException(400, f"{DEFAULT_SETTINGS[key][2]}: {lo}~{hi} 범위로 입력하세요")
        if key == "device_api_key" and len(v) < 12:
            raise HTTPException(400, "장비 키는 12자 이상이어야 합니다")
        if key == "backup_dir" and v:
            try:
                os.makedirs(v, exist_ok=True)
            except OSError as e:
                raise HTTPException(400, f"백업 경로를 사용할 수 없습니다: {e}")
        if v != current[key]:
            changes[key] = v
    merged = {**current, **changes}
    if merged["offline_threshold_sec"] <= merged["heartbeat_interval_sec"]:
        raise HTTPException(400, "오프라인 판정 시간은 heartbeat 주기보다 길어야 합니다")
    if merged["sync_retry_max_sec"] < merged["sync_retry_base_sec"]:
        raise HTTPException(400, "재시도 최대 대기는 최초 대기보다 커야 합니다")
    now = now_iso()
    for k, v in changes.items():
        conn.execute("INSERT INTO system_settings(key, value, updated_at) VALUES (?,?,?)"
                     " ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                     (k, encode_setting(v), now))
    if changes:
        audit(conn, user, "settings.update", "system_settings", None,
              {k: ("***" if k == "device_api_key" else v) for k, v in changes.items()})
        conn.commit()
    return {"values": _public(get_settings(conn), True), "changed": list(changes)}


@router.get("/system-status")
def system_status(user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db)):
    t0 = time.perf_counter()
    integrity = conn.execute("PRAGMA quick_check").fetchone()[0]
    db_ms = (time.perf_counter() - t0) * 1000
    s = get_settings(conn)
    bdir = backup_dir(s)
    try:
        du = shutil.disk_usage(bdir if os.path.isdir(bdir) else config.db_file.parent)
        disk = {"total": du.total, "free": du.free}
    except OSError:
        disk = None
    return {
        "version": __version__, "python": platform.python_version(), "platform": platform.platform(),
        "db": {"path": str(config.db_file), "size_bytes": config.db_file.stat().st_size if config.db_file.exists() else 0,
               "quick_check": integrity, "latency_ms": round(db_ms, 2)},
        "disk": disk, "websocket_clients": len(manager.clients), "server_time": now_iso(),
        "counts": {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in
                   ("devices", "sessions", "participants", "contents", "mission_results", "device_events",
                    "heartbeat_logs")},
    }
