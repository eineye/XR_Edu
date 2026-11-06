from __future__ import annotations

import csv
import io
import json
import re
import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from ..audit import audit
from ..db import get_db, get_settings, rows_to_dicts
from ..realtime import manager
from ..security import any_user, operator_user, verify_device
from ..status import evaluate_device
from ..timeutil import now_iso, to_local_str, to_utc_iso

router = APIRouter(prefix="/api/v1/devices", tags=["devices"])

DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$")


class DeviceCreate(BaseModel):
    device_id: str = Field(max_length=32)
    device_name: str | None = Field(default=None, max_length=64)
    model: str = Field(default="Meta Quest 3", max_length=64)
    notes: str | None = Field(default=None, max_length=500)

    @field_validator("device_id")
    @classmethod
    def _check_id(cls, v: str) -> str:
        v = v.strip()
        if not DEVICE_ID_RE.match(v):
            raise ValueError("장비 ID는 영문·숫자·-·_ 2~32자여야 합니다 (예: HMD-01)")
        return v


class DeviceBulkCreate(BaseModel):
    prefix: str = Field(default="HMD-", max_length=16)
    start: int = Field(default=1, ge=1, le=999)
    count: int = Field(default=20, ge=1, le=100)
    model: str = Field(default="Meta Quest 3", max_length=64)


class DeviceUpdate(BaseModel):
    device_name: str | None = Field(default=None, max_length=64)
    model: str | None = Field(default=None, max_length=64)
    notes: str | None = Field(default=None, max_length=500)
    active: bool | None = None


class InstalledContent(BaseModel):
    content_id: str = Field(max_length=64)
    version: str | None = Field(default=None, max_length=32)


class HeartbeatIn(BaseModel):
    device_id: str = Field(max_length=32)
    app_version: str | None = Field(default=None, max_length=32)
    content_version: str | None = Field(default=None, max_length=32)
    app_status: Literal["running", "idle", "error", "unknown"] = "unknown"
    # 기기에서 확인할 수 없는 값은 null 로 보낸다. 추정값 금지.
    battery_level: int | None = Field(default=None, ge=0, le=100)
    storage_available: int | None = Field(default=None, ge=0, description="MB")
    error_code: str | None = Field(default=None, max_length=64)
    pending_count: int | None = Field(default=None, ge=0, description="HMD 미전송 결과 수")
    sent_total: int | None = Field(default=None, ge=0, description="HMD가 누적 전송(ACK)한 결과 수")
    session_id: str | None = Field(default=None, max_length=64)
    installed_contents: list[InstalledContent] | None = None
    simulated: bool = False
    occurred_at: str

    @field_validator("occurred_at")
    @classmethod
    def _check_time(cls, v: str) -> str:
        try:
            return to_utc_iso(v)
        except ValueError:
            raise ValueError("occurred_at 은 ISO 8601 형식이어야 합니다")


def _get_device(conn, device_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM devices WHERE device_id=?", (device_id,)).fetchone()
    if row is None:
        raise HTTPException(404, f"등록되지 않은 장비입니다: {device_id}")
    return row


def _current_assignments(conn) -> dict[str, dict]:
    rows = conn.execute(
        """SELECT p.device_id, p.student_code, s.id AS session_pk, s.session_code, s.status, s.content_id
           FROM participants p JOIN sessions s ON s.id = p.session_id
           WHERE s.deleted=0 AND s.status IN ('ready','running') AND p.device_id IS NOT NULL
           ORDER BY CASE s.status WHEN 'running' THEN 0 ELSE 1 END, s.session_date"""
    ).fetchall()
    out: dict[str, dict] = {}
    for r in rows:
        out.setdefault(r["device_id"], dict(r))
    return out


def list_devices_evaluated(conn, include_inactive: bool = True) -> list[dict]:
    settings = get_settings(conn)
    q = "SELECT * FROM devices" + ("" if include_inactive else " WHERE active=1") + " ORDER BY device_id"
    assignments = _current_assignments(conn)
    out = []
    for r in conn.execute(q).fetchall():
        d = evaluate_device(dict(r), settings)
        d["assignment"] = assignments.get(d["device_id"])
        out.append(d)
    return out


@router.get("")
def list_devices(
    q: str | None = None,
    health: str | None = None,
    include_inactive: bool = True,
    user: dict = Depends(any_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    items = list_devices_evaluated(conn, include_inactive)
    if q:
        ql = q.lower()
        items = [d for d in items if ql in d["device_id"].lower() or ql in (d.get("device_name") or "").lower()]
    if health:
        wanted = set(health.split(","))
        items = [d for d in items if d["health"] in wanted]
    return {"items": items, "server_time": now_iso()}


@router.post("", status_code=201)
def create_device(body: DeviceCreate, user: dict = Depends(operator_user), conn: sqlite3.Connection = Depends(get_db)):
    if conn.execute("SELECT 1 FROM devices WHERE device_id=?", (body.device_id,)).fetchone():
        raise HTTPException(409, f"이미 등록된 장비 ID입니다: {body.device_id}")
    now = now_iso()
    conn.execute(
        "INSERT INTO devices(device_id, device_name, model, notes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        (body.device_id, body.device_name, body.model, body.notes, now, now),
    )
    audit(conn, user, "device.create", "device", body.device_id, body.model_dump())
    conn.commit()
    return dict(_get_device(conn, body.device_id))


@router.post("/bulk", status_code=201)
def bulk_create(body: DeviceBulkCreate, user: dict = Depends(operator_user), conn: sqlite3.Connection = Depends(get_db)):
    width = max(2, len(str(body.start + body.count - 1)))
    created, skipped = [], []
    now = now_iso()
    for n in range(body.start, body.start + body.count):
        did = f"{body.prefix}{n:0{width}d}"
        if not DEVICE_ID_RE.match(did):
            raise HTTPException(400, f"잘못된 장비 ID 형식: {did}")
        if conn.execute("SELECT 1 FROM devices WHERE device_id=?", (did,)).fetchone():
            skipped.append(did)
            continue
        conn.execute(
            "INSERT INTO devices(device_id, model, created_at, updated_at) VALUES (?,?,?,?)",
            (did, body.model, now, now),
        )
        created.append(did)
    audit(conn, user, "device.bulk_create", "device", None, {"created": created, "skipped": skipped})
    conn.commit()
    return {"created": created, "skipped": skipped}


@router.get("/export.csv")
def export_csv(user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db)):
    items = list_devices_evaluated(conn)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["장비 ID", "별칭", "모델", "상태", "연결", "앱 상태", "배터리(%)", "저장공간(MB)",
                "앱 버전", "콘텐츠 버전", "최근 오류", "마지막 통신", "배정 세션", "활성", "비고"])
    for d in items:
        w.writerow([
            d["device_id"], d.get("device_name") or "", d["model"], d["health_label"], d["connection_status"],
            d["app_status"], "확인불가" if d["battery_level"] is None else d["battery_level"],
            "확인불가" if d["storage_available"] is None else d["storage_available"],
            d.get("app_version") or "", d.get("content_version") or "", d.get("last_error_code") or "",
            to_local_str(d.get("last_seen_at")), (d.get("assignment") or {}).get("session_code", ""),
            "Y" if d["active"] else "N", d.get("notes") or "",
        ])
    data = "﻿" + buf.getvalue()  # Excel 한글 깨짐 방지 BOM
    return Response(data, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="devices.csv"'})


@router.post("/heartbeat", dependencies=[Depends(verify_device)])
def heartbeat(body: HeartbeatIn, conn: sqlite3.Connection = Depends(get_db)):
    """HMD 상태 보고. HMD는 WebSocket 없이 이 API만으로 상태를 전달한다."""
    row = _get_device(conn, body.device_id)
    if not row["active"]:
        raise HTTPException(403, "비활성화된 장비입니다")
    settings = get_settings(conn)
    now = now_iso()
    was = evaluate_device(dict(row), settings)
    error_at = now if (body.error_code or body.app_status == "error") else row["last_error_at"]
    conn.execute(
        """UPDATE devices SET app_version=COALESCE(?, app_version), content_version=COALESCE(?, content_version),
             app_status=?, battery_level=?, storage_available=?, last_seen_at=?, connection_status='online',
             last_error_code=COALESCE(?, last_error_code), last_error_at=?, reported_pending_count=?,
             reported_sent_total=?, is_simulated=?, updated_at=? WHERE device_id=?""",
        (body.app_version, body.content_version, body.app_status, body.battery_level, body.storage_available,
         now, body.error_code, error_at, body.pending_count, body.sent_total, 1 if body.simulated else 0, now,
         body.device_id),
    )
    if body.installed_contents is not None:
        for ic in body.installed_contents:
            conn.execute(
                """INSERT INTO content_installs(device_id, content_id, version, source, status, updated_at)
                   VALUES (?,?,?,'reported','installed',?)
                   ON CONFLICT(device_id, content_id) DO UPDATE SET version=excluded.version,
                     source='reported', status='installed', updated_at=excluded.updated_at""",
                (body.device_id, ic.content_id, ic.version, now),
            )
    conn.execute(
        "INSERT INTO heartbeat_logs(device_id, payload_json, received_at) VALUES (?,?,?)",
        (body.device_id, body.model_dump_json(), now),
    )
    cmds = conn.execute(
        "SELECT id, command, payload_json FROM device_commands WHERE device_id=? AND status='pending'",
        (body.device_id,),
    ).fetchall()
    if cmds:
        conn.execute(
            f"UPDATE device_commands SET status='delivered', delivered_at=? WHERE id IN ({','.join('?' * len(cmds))})",
            (now, *[c["id"] for c in cmds]),
        )
    conn.commit()

    new_row = evaluate_device(dict(_get_device(conn, body.device_id)), settings)
    if was["connection_status"] != "online":
        manager.publish("device.connected", {"device_id": body.device_id})
    if row["app_status"] != body.app_status:
        manager.publish("device.app_status_changed", {"device_id": body.device_id, "app_status": body.app_status})
    if body.error_code or body.app_status == "error":
        manager.publish("device.error", {"device_id": body.device_id, "error_code": body.error_code})
    manager.publish("device.heartbeat", {"device_id": body.device_id, "health": new_row["health"]})

    return {
        "success": True,
        "server_time": now,
        "heartbeat_interval_sec": settings["heartbeat_interval_sec"],
        "sync": {
            "batch_size": settings["sync_batch_size"],
            "retry_base_sec": settings["sync_retry_base_sec"],
            "retry_max_sec": settings["sync_retry_max_sec"],
        },
        "commands": [
            {"id": c["id"], "command": c["command"], "payload": json.loads(c["payload_json"] or "{}")} for c in cmds
        ],
    }


@router.get("/{device_id}/assignment", dependencies=[Depends(verify_device)])
def device_assignment(device_id: str, conn: sqlite3.Connection = Depends(get_db)):
    """HMD가 자신에게 배정된 세션·학생 코드·콘텐츠를 조회 (수업 전 미리 받아 로컬 보관)."""
    _get_device(conn, device_id)
    a = _current_assignments(conn).get(device_id)
    if not a:
        return {"assigned": False}
    s = conn.execute("SELECT * FROM sessions WHERE id=?", (a["session_pk"],)).fetchone()
    content = None
    if s["content_id"]:
        c = conn.execute("SELECT content_id, title, version FROM contents WHERE content_id=?", (s["content_id"],)).fetchone()
        content = dict(c) if c else None
    return {
        "assigned": True,
        "session_id": s["session_code"],
        "session_status": s["status"],
        "student_code": a["student_code"],
        "content": content,
        "institution_name": s["institution_name"],
        "session_date": s["session_date"],
    }


@router.get("/{device_id}")
def device_detail(device_id: str, user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db)):
    settings = get_settings(conn)
    d = evaluate_device(dict(_get_device(conn, device_id)), settings)
    d["assignment"] = _current_assignments(conn).get(device_id)
    d["heartbeats"] = rows_to_dicts(conn.execute(
        "SELECT received_at, payload_json FROM heartbeat_logs WHERE device_id=? ORDER BY id DESC LIMIT 30",
        (device_id,)).fetchall())
    d["events"] = rows_to_dicts(conn.execute(
        "SELECT event_id, event_type, session_id, payload_json, occurred_at, received_at FROM device_events"
        " WHERE device_id=? ORDER BY occurred_at DESC LIMIT 30", (device_id,)).fetchall())
    d["sessions"] = rows_to_dicts(conn.execute(
        """SELECT s.id, s.session_code, s.institution_name, s.session_date, s.status, p.student_code,
             (SELECT COUNT(*) FROM mission_results r WHERE r.session_id=s.session_code AND r.device_id=p.device_id) AS result_count
           FROM participants p JOIN sessions s ON s.id=p.session_id
           WHERE p.device_id=? AND s.deleted=0 ORDER BY s.session_date DESC, s.id DESC LIMIT 50""",
        (device_id,)).fetchall())
    d["sync_logs"] = rows_to_dicts(conn.execute(
        "SELECT * FROM sync_logs WHERE device_id=? ORDER BY id DESC LIMIT 20", (device_id,)).fetchall())
    d["installs"] = rows_to_dicts(conn.execute(
        "SELECT * FROM content_installs WHERE device_id=? ORDER BY content_id", (device_id,)).fetchall())
    d["received_result_total"] = conn.execute(
        "SELECT COUNT(*) FROM mission_results WHERE device_id=?", (device_id,)).fetchone()[0]
    d["pending_commands"] = rows_to_dicts(conn.execute(
        "SELECT * FROM device_commands WHERE device_id=? ORDER BY id DESC LIMIT 10", (device_id,)).fetchall())
    return d


@router.patch("/{device_id}")
def update_device(
    device_id: str, body: DeviceUpdate, user: dict = Depends(operator_user), conn: sqlite3.Connection = Depends(get_db)
):
    _get_device(conn, device_id)
    data = body.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(400, "변경할 항목이 없습니다")
    if "active" in data:
        data["active"] = 1 if data["active"] else 0
    sets = ", ".join(f"{k}=?" for k in data)
    conn.execute(f"UPDATE devices SET {sets}, updated_at=? WHERE device_id=?", (*data.values(), now_iso(), device_id))
    audit(conn, user, "device.update", "device", device_id, body.model_dump(exclude_unset=True))
    conn.commit()
    return dict(_get_device(conn, device_id))


@router.post("/{device_id}/resync")
def request_resync(device_id: str, user: dict = Depends(operator_user), conn: sqlite3.Connection = Depends(get_db)):
    """미전송/실패 결과 재전송 요청. 다음 heartbeat 응답의 commands 로 HMD에 전달된다."""
    _get_device(conn, device_id)
    existing = conn.execute(
        "SELECT id FROM device_commands WHERE device_id=? AND command='resync' AND status='pending'", (device_id,)
    ).fetchone()
    if existing:
        return {"success": True, "command_id": existing["id"], "already_pending": True}
    cur = conn.execute(
        "INSERT INTO device_commands(device_id, command, payload_json, created_at) VALUES (?,?,?,?)",
        (device_id, "resync", json.dumps({"include_rejected": False}), now_iso()),
    )
    audit(conn, user, "device.resync_requested", "device", device_id)
    conn.commit()
    return {"success": True, "command_id": cur.lastrowid, "already_pending": False}
