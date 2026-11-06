from __future__ import annotations

import json
import sqlite3
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ..analytics import RESULT_SELECT, build_filters, stats
from ..audit import audit
from ..db import get_db, get_settings, rows_to_dicts
from ..security import admin_user, any_user, operator_user
from ..timeutil import now_iso, now_utc

router = APIRouter(prefix="/api/v1/results", tags=["results"])

FILTER_KEYS = ("session_id", "device_id", "student_code", "content_id", "mission_id", "grade", "class_group",
               "institution", "date_from", "date_to", "is_correct", "q")
SORTABLE = {"occurred_at": "r.occurred_at", "received_at": "r.received_at", "score": "eff_score",
            "student_code": "r.student_code", "mission_id": "r.mission_id", "device_id": "r.device_id"}


def _filters(**kw) -> dict:
    return {k: v for k, v in kw.items() if v not in (None, "")}


class CorrectionIn(BaseModel):
    is_correct: bool | None = None
    score: float | None = Field(default=None, ge=0, le=1000)
    reason: str = Field(min_length=2, max_length=500)


class PurgeIn(BaseModel):
    confirm: bool = False


@router.get("")
def list_results(
    session_id: str | None = None, device_id: str | None = None, student_code: str | None = None,
    content_id: str | None = None, mission_id: str | None = None, grade: str | None = None,
    class_group: str | None = None, institution: str | None = None, date_from: str | None = None,
    date_to: str | None = None, is_correct: str | None = None, q: str | None = None,
    sort: str = "occurred_at", order: str = "desc",
    limit: int = Query(50, ge=1, le=1000), offset: int = Query(0, ge=0),
    user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db),
):
    f = _filters(session_id=session_id, device_id=device_id, student_code=student_code, content_id=content_id,
                 mission_id=mission_id, grade=grade, class_group=class_group, institution=institution,
                 date_from=date_from, date_to=date_to, is_correct=is_correct, q=q)
    where, params = build_filters(f)
    total = conn.execute(
        f"SELECT COUNT(*) FROM mission_results r LEFT JOIN sessions s ON s.session_code=r.session_id WHERE {where}",
        params).fetchone()[0]
    col = SORTABLE.get(sort, "r.occurred_at")
    direction = "ASC" if order.lower() == "asc" else "DESC"
    rows = conn.execute(f"{RESULT_SELECT} WHERE {where} ORDER BY {col} {direction}, r.id DESC LIMIT ? OFFSET ?",
                        (*params, limit, offset)).fetchall()
    return {"items": rows_to_dicts(rows), "total": total, "limit": limit, "offset": offset}


@router.get("/stats")
def result_stats(
    session_id: str | None = None, content_id: str | None = None, grade: str | None = None,
    class_group: str | None = None, institution: str | None = None, date_from: str | None = None,
    date_to: str | None = None, device_id: str | None = None,
    user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db),
):
    f = _filters(session_id=session_id, content_id=content_id, grade=grade, class_group=class_group,
                 institution=institution, date_from=date_from, date_to=date_to, device_id=device_id)
    return stats(conn, f)


@router.get("/unsynced")
def unsynced(user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db)):
    """미동기화 현황: HMD 보고 미전송 건수 + 서버 거부(실패) 건수 + 장비별 전송/수신 건수 비교."""
    devices = rows_to_dicts(conn.execute(
        """SELECT d.device_id, d.reported_pending_count, d.reported_sent_total, d.last_sync_at, d.last_seen_at,
             (SELECT COUNT(*) FROM mission_results r WHERE r.device_id=d.device_id) AS received_total,
             (SELECT COUNT(*) FROM result_rejections x WHERE x.device_id=d.device_id) AS rejected_total
           FROM devices d WHERE d.active=1 ORDER BY d.device_id""").fetchall())
    for d in devices:
        sent = d["reported_sent_total"]
        # HMD 가 ACK 받은 누적 건수(accepted+duplicates) 와 서버 보유 건수 비교
        d["mismatch"] = None if sent is None else (sent != d["received_total"])
    rejections = rows_to_dicts(conn.execute(
        "SELECT * FROM result_rejections ORDER BY id DESC LIMIT 200").fetchall())
    pending_total = sum(d["reported_pending_count"] or 0 for d in devices)
    return {"pending_total": pending_total,
            "devices_unknown": sum(1 for d in devices if d["reported_pending_count"] is None),
            "devices": devices, "rejections": rejections}


@router.post("/purge-expired")
def purge_expired(body: PurgeIn, user: dict = Depends(admin_user), conn: sqlite3.Connection = Depends(get_db)):
    """보관 기간이 지난 결과 삭제 (설정 result_retention_days, 0 = 무기한 보관)."""
    days = get_settings(conn)["result_retention_days"]
    if days <= 0:
        raise HTTPException(400, "결과 보관 기간이 '무기한(0)'으로 설정되어 있습니다")
    cutoff = (now_utc() - timedelta(days=days)).isoformat()
    count = conn.execute("SELECT COUNT(*) FROM mission_results WHERE occurred_at < ?", (cutoff,)).fetchone()[0]
    if not body.confirm:
        return {"would_delete": count, "cutoff": cutoff}
    conn.execute("DELETE FROM result_corrections WHERE result_id IN (SELECT result_id FROM mission_results WHERE occurred_at < ?)", (cutoff,))
    conn.execute("DELETE FROM mission_results WHERE occurred_at < ?", (cutoff,))
    audit(conn, user, "result.purge_expired", "mission_results", None, {"deleted": count, "cutoff": cutoff})
    conn.commit()
    return {"deleted": count, "cutoff": cutoff}


@router.get("/{result_id}")
def result_detail(result_id: str, user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db)):
    row = conn.execute(f"{RESULT_SELECT} WHERE r.result_id=?", (result_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "결과를 찾을 수 없습니다")
    d = dict(row)
    d["corrections"] = rows_to_dicts(conn.execute(
        """SELECT c.*, u.username FROM result_corrections c LEFT JOIN admin_users u ON u.id=c.admin_user_id
           WHERE c.result_id=? ORDER BY c.id""", (result_id,)).fetchall())
    d["answer"] = json.loads(d["answer_json"]) if d.get("answer_json") else None
    return d


@router.post("/{result_id}/corrections")
def correct_result(
    result_id: str, body: CorrectionIn, user: dict = Depends(operator_user), conn: sqlite3.Connection = Depends(get_db)
):
    """원본 이벤트는 덮어쓰지 않고, 보정값 컬럼 + 보정 이력으로 기록한다."""
    row = conn.execute("SELECT * FROM mission_results WHERE result_id=?", (result_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "결과를 찾을 수 없습니다")
    if body.is_correct is None and body.score is None:
        raise HTTPException(400, "보정할 값(정답 여부 또는 점수)을 입력하세요")
    now = now_iso()
    if body.is_correct is not None:
        old = row["corrected_is_correct"] if row["corrected_is_correct"] is not None else row["is_correct"]
        conn.execute("INSERT INTO result_corrections(result_id, field, old_value, new_value, reason, admin_user_id, created_at)"
                     " VALUES (?,?,?,?,?,?,?)", (result_id, "is_correct", str(old), str(int(body.is_correct)),
                                                 body.reason, user["id"], now))
        conn.execute("UPDATE mission_results SET corrected_is_correct=?, sync_status='corrected' WHERE result_id=?",
                     (int(body.is_correct), result_id))
    if body.score is not None:
        old = row["corrected_score"] if row["corrected_score"] is not None else row["score"]
        conn.execute("INSERT INTO result_corrections(result_id, field, old_value, new_value, reason, admin_user_id, created_at)"
                     " VALUES (?,?,?,?,?,?,?)", (result_id, "score", str(old), str(body.score), body.reason,
                                                 user["id"], now))
        conn.execute("UPDATE mission_results SET corrected_score=?, sync_status='corrected' WHERE result_id=?",
                     (body.score, result_id))
    audit(conn, user, "result.correct", "mission_result", result_id, body.model_dump(exclude_none=True))
    conn.commit()
    return result_detail(result_id, user, conn)
