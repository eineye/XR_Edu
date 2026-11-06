"""HMD → 서버 데이터 수신 (이벤트, 결과 일괄 업로드).

원칙
- 저장(commit) 성공 후에만 ACK 를 반환한다.
- event_id / result_id 기준 idempotent: 재전송은 오류가 아닌 duplicates 로 응답.
- 부분 성공 지원: 잘못된 항목은 rejected 에 사유와 함께 반환하고 나머지는 저장.
"""
from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError, field_validator

from ..db import get_db
from ..realtime import manager
from ..security import verify_device
from ..timeutil import now_iso, to_utc_iso

log = logging.getLogger("mr_edu.sync")
router = APIRouter(prefix="/api/v1", tags=["hmd-sync"], dependencies=[Depends(verify_device)])

MAX_BATCH = 500


def _iso(v: str | None) -> str | None:
    if v is None:
        return None
    try:
        return to_utc_iso(v)
    except ValueError:
        raise ValueError("ISO 8601 형식의 시각이 아닙니다")


class ResultItem(BaseModel):
    result_id: str = Field(min_length=1, max_length=128)
    event_id: str = Field(min_length=1, max_length=128)
    student_code: str = Field(min_length=1, max_length=32)
    content_id: str = Field(min_length=1, max_length=64)
    content_version: str | None = Field(default=None, max_length=32)
    mission_id: str = Field(min_length=1, max_length=64)
    answer: Any = None
    is_correct: bool | None = None
    score: float | None = Field(default=None, ge=0, le=1000)
    attempt_count: int | None = Field(default=None, ge=0, le=1000)
    duration_seconds: float | None = Field(default=None, ge=0, le=86400)
    started_at: str | None = None
    completed_at: str | None = None
    occurred_at: str

    _t1 = field_validator("occurred_at")(lambda cls, v: _iso(v))
    _t2 = field_validator("started_at", "completed_at")(lambda cls, v: _iso(v))


class ResultBatch(BaseModel):
    device_id: str = Field(min_length=1, max_length=32)
    session_id: str = Field(min_length=1, max_length=64)
    results: list[dict] = Field(max_length=MAX_BATCH)


EventType = Literal[
    "session.joined", "mission.started", "mission.progress", "mission.completed",
    "session.finished", "app.error", "app.status",
]


class EventItem(BaseModel):
    event_id: str = Field(min_length=1, max_length=128)
    event_type: EventType
    session_id: str | None = Field(default=None, max_length=64)
    student_code: str | None = Field(default=None, max_length=32)
    content_id: str | None = Field(default=None, max_length=64)
    mission_id: str | None = Field(default=None, max_length=64)
    step: str | None = Field(default=None, max_length=64)
    progress: float | None = Field(default=None, ge=0, le=1)
    error_code: str | None = Field(default=None, max_length=64)
    message: str | None = Field(default=None, max_length=500)
    occurred_at: str

    _t = field_validator("occurred_at")(lambda cls, v: _iso(v))


class EventBatch(BaseModel):
    device_id: str = Field(min_length=1, max_length=32)
    events: list[dict] = Field(max_length=MAX_BATCH)


def _err_text(e: ValidationError) -> str:
    parts = []
    for err in e.errors():
        loc = ".".join(str(x) for x in err["loc"])
        parts.append(f"{loc}: {err['msg']}")
    return "; ".join(parts)


def _reject(conn, rejected: list, device_id, session_id, raw: dict, reason: str, now: str) -> None:
    eid = raw.get("event_id") if isinstance(raw, dict) else None
    rejected.append({"event_id": eid, "result_id": raw.get("result_id") if isinstance(raw, dict) else None,
                     "reason": reason})
    conn.execute(
        "INSERT INTO result_rejections(device_id, session_id, event_id, result_id, reason, payload_json, received_at)"
        " VALUES (?,?,?,?,?,?,?)",
        (device_id, session_id, eid, raw.get("result_id") if isinstance(raw, dict) else None, reason,
         json.dumps(raw, ensure_ascii=False, default=str)[:4000], now),
    )


@router.post("/results/batch")
def upload_results(body: ResultBatch, conn: sqlite3.Connection = Depends(get_db)):
    now = now_iso()
    dev = conn.execute("SELECT device_id, active FROM devices WHERE device_id=?", (body.device_id,)).fetchone()
    if dev is None:
        raise HTTPException(404, f"등록되지 않은 장비입니다: {body.device_id}")
    session = conn.execute("SELECT id, session_code, status, content_id FROM sessions WHERE session_code=? AND deleted=0",
                           (body.session_id,)).fetchone()
    accepted, duplicates, rejected = [], [], []
    try:
        conn.execute("BEGIN IMMEDIATE")
        students = set()
        if session is not None:
            students = {r[0] for r in conn.execute(
                "SELECT student_code FROM participants WHERE session_id=?", (session["id"],)).fetchall()}
        for raw in body.results:
            if not isinstance(raw, dict):
                _reject(conn, rejected, body.device_id, body.session_id, {"raw": raw}, "결과 항목 형식 오류", now)
                continue
            try:
                item = ResultItem.model_validate(raw)
            except ValidationError as e:
                _reject(conn, rejected, body.device_id, body.session_id, raw, f"입력 검증 실패: {_err_text(e)}", now)
                continue
            existing = conn.execute(
                "SELECT event_id, result_id FROM mission_results WHERE event_id=? OR result_id=?",
                (item.event_id, item.result_id)).fetchall()
            if existing:
                if any(r["event_id"] == item.event_id and r["result_id"] == item.result_id for r in existing):
                    duplicates.append(item.event_id)  # 이미 저장됨 → HMD는 synced 처리 가능
                else:
                    _reject(conn, rejected, body.device_id, body.session_id, raw,
                            "result_id 또는 event_id 가 다른 결과와 충돌합니다", now)
                continue
            if session is None:
                _reject(conn, rejected, body.device_id, body.session_id, raw, f"존재하지 않는 세션: {body.session_id}", now)
                continue
            if session["status"] in ("draft", "cancelled"):
                _reject(conn, rejected, body.device_id, body.session_id, raw,
                        f"결과를 받을 수 없는 세션 상태: {session['status']}", now)
                continue
            if item.student_code not in students:
                _reject(conn, rejected, body.device_id, body.session_id, raw,
                        f"세션에 등록되지 않은 학생 코드: {item.student_code}", now)
                continue
            conn.execute(
                """INSERT INTO mission_results(result_id, event_id, session_id, device_id, student_code, content_id,
                     content_version, mission_id, answer_json, is_correct, score, attempt_count, duration_seconds,
                     started_at, completed_at, occurred_at, received_at, sync_status)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced')""",
                (item.result_id, item.event_id, body.session_id, body.device_id, item.student_code, item.content_id,
                 item.content_version, item.mission_id,
                 None if item.answer is None else json.dumps(item.answer, ensure_ascii=False),
                 None if item.is_correct is None else int(item.is_correct), item.score, item.attempt_count,
                 item.duration_seconds, item.started_at, item.completed_at, item.occurred_at, now),
            )
            accepted.append(item.event_id)
        conn.execute("UPDATE devices SET last_sync_at=? WHERE device_id=?", (now, body.device_id))
        conn.execute(
            "INSERT INTO sync_logs(device_id, session_id, received_count, accepted_count, duplicate_count, rejected_count,"
            " created_at) VALUES (?,?,?,?,?,?,?)",
            (body.device_id, body.session_id, len(body.results), len(accepted), len(duplicates), len(rejected), now),
        )
        conn.commit()  # 저장 성공 후에만 ACK
    except sqlite3.Error:
        conn.rollback()
        log.exception("결과 저장 실패 device=%s", body.device_id)
        raise HTTPException(503, "서버 저장 오류로 결과를 수신하지 못했습니다. 재시도하세요")

    if accepted:
        manager.publish("result.received", {"device_id": body.device_id, "session_id": body.session_id,
                                            "count": len(accepted)})
    if rejected:
        manager.publish("result.sync_error", {"device_id": body.device_id, "session_id": body.session_id,
                                              "count": len(rejected)})
    return {"success": True, "accepted": accepted, "duplicates": duplicates, "rejected": rejected,
            "server_time": now}


@router.post("/events")
def receive_events(body: EventBatch, conn: sqlite3.Connection = Depends(get_db)):
    now = now_iso()
    if conn.execute("SELECT 1 FROM devices WHERE device_id=?", (body.device_id,)).fetchone() is None:
        raise HTTPException(404, f"등록되지 않은 장비입니다: {body.device_id}")
    accepted, duplicates, rejected = [], [], []
    publish: list[tuple[str, dict]] = []
    try:
        conn.execute("BEGIN IMMEDIATE")
        for raw in body.events:
            try:
                ev = EventItem.model_validate(raw)
            except ValidationError as e:
                rejected.append({"event_id": raw.get("event_id") if isinstance(raw, dict) else None,
                                 "reason": f"입력 검증 실패: {_err_text(e)}"})
                continue
            if conn.execute("SELECT 1 FROM device_events WHERE event_id=?", (ev.event_id,)).fetchone():
                duplicates.append(ev.event_id)
                continue
            conn.execute(
                "INSERT INTO device_events(event_id, device_id, event_type, session_id, payload_json, occurred_at,"
                " received_at) VALUES (?,?,?,?,?,?,?)",
                (ev.event_id, body.device_id, ev.event_type, ev.session_id,
                 ev.model_dump_json(exclude={"event_id", "event_type", "occurred_at"}), ev.occurred_at, now),
            )
            accepted.append(ev.event_id)
            if ev.event_type == "app.error":
                conn.execute("UPDATE devices SET last_error_code=?, last_error_at=? WHERE device_id=?",
                             (ev.error_code or "APP_ERROR", now, body.device_id))
                publish.append(("device.error", {"device_id": body.device_id, "error_code": ev.error_code}))
            if ev.session_id and ev.event_type.startswith(("mission.", "session.")) or (
                    ev.session_id and ev.event_type == "app.error"):
                state = {"session.joined": "waiting", "mission.started": "in_progress",
                         "mission.progress": "in_progress", "mission.completed": "in_progress",
                         "session.finished": "completed", "app.error": "error"}[ev.event_type]
                progress = ev.progress
                if ev.event_type == "session.finished":
                    progress = 1.0
                # 늦게 도착한(과거) 이벤트가 최신 진행 상태를 덮어쓰지 않도록 occurred_at 비교
                conn.execute(
                    """INSERT INTO device_progress(session_id, device_id, student_code, content_id, mission_id, step,
                         progress, state, last_report_at)
                       VALUES (?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(session_id, device_id) DO UPDATE SET
                         student_code=COALESCE(excluded.student_code, student_code),
                         content_id=COALESCE(excluded.content_id, content_id),
                         mission_id=COALESCE(excluded.mission_id, mission_id),
                         step=COALESCE(excluded.step, step),
                         progress=COALESCE(excluded.progress, progress),
                         state=excluded.state,
                         last_report_at=excluded.last_report_at
                       WHERE excluded.last_report_at >= device_progress.last_report_at""",
                    (ev.session_id, body.device_id, ev.student_code, ev.content_id, ev.mission_id, ev.step,
                     progress, state, ev.occurred_at),
                )
                publish.append(("session.progress", {"session_id": ev.session_id, "device_id": body.device_id,
                                                     "event_type": ev.event_type}))
        conn.commit()
    except sqlite3.Error:
        conn.rollback()
        log.exception("이벤트 저장 실패 device=%s", body.device_id)
        raise HTTPException(503, "서버 저장 오류로 이벤트를 수신하지 못했습니다. 재시도하세요")
    for t, d in publish:
        manager.publish(t, d)
    return {"success": True, "accepted": accepted, "duplicates": duplicates, "rejected": rejected,
            "server_time": now}
