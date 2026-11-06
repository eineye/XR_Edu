from __future__ import annotations

import re
import sqlite3
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from ..audit import audit
from ..db import get_db, get_settings, rows_to_dicts
from ..realtime import manager
from ..security import any_user, operator_user
from ..status import evaluate_device
from ..timeutil import now_iso

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])

STUDENT_CODE_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
STATUS_LABELS = {"draft": "작성 중", "ready": "준비 완료", "running": "진행 중", "completed": "완료", "cancelled": "취소"}
EDITABLE = ("draft", "ready")


class ParticipantIn(BaseModel):
    student_code: str
    device_id: str | None = None

    @field_validator("student_code")
    @classmethod
    def _code(cls, v: str) -> str:
        v = v.strip()
        if not STUDENT_CODE_RE.match(v):
            raise ValueError(f"익명 학생 코드는 영문·숫자·-·_ 1~32자만 가능합니다 (실명 입력 금지): {v!r}")
        return v

    @field_validator("device_id")
    @classmethod
    def _dev(cls, v: str | None) -> str | None:
        v = (v or "").strip()
        return v or None


class SessionBase(BaseModel):
    institution_name: str | None = Field(default=None, max_length=100)
    institution_code: str | None = Field(default=None, max_length=32)
    session_date: str | None = None
    grade: str | None = Field(default=None, max_length=16)
    class_group: str | None = Field(default=None, max_length=16)
    session_no: int | None = Field(default=None, ge=1, le=999)
    topic: str | None = Field(default=None, max_length=200)
    content_id: str | None = Field(default=None, max_length=64)
    scheduled_start_at: str | None = Field(default=None, max_length=5, description="HH:MM")
    instructor: str | None = Field(default=None, max_length=64)
    expected_students: int | None = Field(default=None, ge=0, le=200)
    memo: str | None = Field(default=None, max_length=1000)

    @field_validator("session_date")
    @classmethod
    def _date(cls, v: str | None) -> str | None:
        if v is None:
            return v
        try:
            return date.fromisoformat(v).isoformat()
        except ValueError:
            raise ValueError("교육 날짜는 YYYY-MM-DD 형식이어야 합니다")

    @field_validator("scheduled_start_at")
    @classmethod
    def _time(cls, v: str | None) -> str | None:
        if v and not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", v):
            raise ValueError("시작 예정 시각은 HH:MM 형식이어야 합니다")
        return v or None


class SessionCreate(SessionBase):
    institution_name: str = Field(min_length=1, max_length=100)
    session_date: str
    participants: list[ParticipantIn] = []


class SessionUpdate(SessionBase):
    pass


class ParticipantsIn(BaseModel):
    participants: list[ParticipantIn]


class CompleteIn(BaseModel):
    force: bool = False


def _get(conn, session_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM sessions WHERE id=? AND deleted=0", (session_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "세션을 찾을 수 없습니다")
    return row


def _next_code(conn, session_date: str) -> str:
    prefix = f"SESSION-{session_date.replace('-', '')}-"
    rows = conn.execute("SELECT session_code FROM sessions WHERE session_code LIKE ?", (prefix + "%",)).fetchall()
    nums = [int(r[0][len(prefix):]) for r in rows if r[0][len(prefix):].isdigit()]
    return f"{prefix}{(max(nums) + 1) if nums else 1:03d}"


def _check_content(conn, content_id: str | None) -> None:
    if content_id is None:
        return
    row = conn.execute("SELECT active FROM contents WHERE content_id=?", (content_id,)).fetchone()
    if row is None:
        raise HTTPException(400, f"등록되지 않은 콘텐츠입니다: {content_id}")
    if not row["active"]:
        raise HTTPException(400, f"비활성화된 콘텐츠입니다: {content_id}")


def _validate_participants(conn, items: list[ParticipantIn]) -> None:
    seen_codes, seen_devices = set(), set()
    for p in items:
        if p.student_code in seen_codes:
            raise HTTPException(400, f"학생 코드가 중복되었습니다: {p.student_code}")
        seen_codes.add(p.student_code)
        if p.device_id:
            if p.device_id in seen_devices:
                raise HTTPException(400, f"한 장비를 두 학생에게 배정할 수 없습니다: {p.device_id}")
            seen_devices.add(p.device_id)
            dev = conn.execute("SELECT active FROM devices WHERE device_id=?", (p.device_id,)).fetchone()
            if dev is None:
                raise HTTPException(400, f"등록되지 않은 장비입니다: {p.device_id}")
            if not dev["active"]:
                raise HTTPException(400, f"비활성화된 장비입니다: {p.device_id}")


def _replace_participants(conn, session_pk: int, items: list[ParticipantIn]) -> None:
    _validate_participants(conn, items)
    conn.execute("DELETE FROM participants WHERE session_id=?", (session_pk,))
    now = now_iso()
    conn.executemany(
        "INSERT INTO participants(session_id, student_code, device_id, created_at) VALUES (?,?,?,?)",
        [(session_pk, p.student_code, p.device_id, now) for p in items],
    )


def _warnings(conn, s: sqlite3.Row) -> list[str]:
    w = []
    total = conn.execute("SELECT COUNT(*) FROM participants WHERE session_id=?", (s["id"],)).fetchone()[0]
    assigned = conn.execute(
        "SELECT COUNT(*) FROM participants WHERE session_id=? AND device_id IS NOT NULL", (s["id"],)
    ).fetchone()[0]
    if s["expected_students"] is not None and s["expected_students"] != total:
        w.append(f"참여 예정 학생 수({s['expected_students']}명)와 등록 학생 수({total}명)가 다릅니다")
    if assigned < total:
        w.append(f"HMD 미배정 학생 {total - assigned}명")
    if total == 0:
        w.append("등록된 학생이 없습니다")
    if not s["content_id"]:
        w.append("콘텐츠가 선택되지 않았습니다")
    return w


def session_summary(conn, s: sqlite3.Row) -> dict:
    d = dict(s)
    d["status_label"] = STATUS_LABELS[d["status"]]
    d["participant_count"] = conn.execute("SELECT COUNT(*) FROM participants WHERE session_id=?", (s["id"],)).fetchone()[0]
    d["assigned_count"] = conn.execute(
        "SELECT COUNT(*) FROM participants WHERE session_id=? AND device_id IS NOT NULL", (s["id"],)).fetchone()[0]
    d["result_count"] = conn.execute(
        "SELECT COUNT(*) FROM mission_results WHERE session_id=?", (s["session_code"],)).fetchone()[0]
    d["completed_students"] = conn.execute(
        "SELECT COUNT(*) FROM device_progress WHERE session_id=? AND state='completed'", (s["session_code"],)).fetchone()[0]
    c = conn.execute("SELECT title FROM contents WHERE content_id=?", (s["content_id"],)).fetchone() if s["content_id"] else None
    d["content_title"] = c["title"] if c else None
    return d


@router.get("")
def list_sessions(
    status: str | None = None,
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    user: dict = Depends(any_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    sql, params = "SELECT * FROM sessions WHERE deleted=0", []
    if status:
        sts = status.split(",")
        sql += f" AND status IN ({','.join('?' * len(sts))})"; params += sts
    if q:
        sql += " AND (institution_name LIKE ? OR session_code LIKE ? OR topic LIKE ? OR instructor LIKE ?)"
        params += [f"%{q}%"] * 4
    if date_from:
        sql += " AND session_date >= ?"; params.append(date_from)
    if date_to:
        sql += " AND session_date <= ?"; params.append(date_to)
    sql += " ORDER BY session_date DESC, id DESC"
    return {"items": [session_summary(conn, r) for r in conn.execute(sql, params).fetchall()],
            "status_labels": STATUS_LABELS}


@router.post("", status_code=201)
def create_session(body: SessionCreate, user: dict = Depends(operator_user), conn: sqlite3.Connection = Depends(get_db)):
    _check_content(conn, body.content_id)
    now = now_iso()
    code = _next_code(conn, body.session_date)
    data = body.model_dump(exclude={"participants"})
    cur = conn.execute(
        f"""INSERT INTO sessions(session_code, {', '.join(data)}, status, created_at, updated_at)
            VALUES (?, {', '.join('?' * len(data))}, 'draft', ?, ?)""",
        (code, *data.values(), now, now),
    )
    _replace_participants(conn, cur.lastrowid, body.participants)
    audit(conn, user, "session.create", "session", code, {**data, "participants": len(body.participants)})
    conn.commit()
    return session_detail(cur.lastrowid, user, conn)


@router.get("/{session_id}")
def session_detail(session_id: int, user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db)):
    s = _get(conn, session_id)
    d = session_summary(conn, s)
    d["participants"] = rows_to_dicts(conn.execute(
        """SELECT p.id, p.student_code, p.device_id,
             (SELECT COUNT(*) FROM mission_results r WHERE r.session_id=? AND r.student_code=p.student_code) AS result_count
           FROM participants p WHERE p.session_id=? ORDER BY p.student_code""",
        (s["session_code"], s["id"])).fetchall())
    d["warnings"] = _warnings(conn, s)
    return d


@router.patch("/{session_id}")
def update_session(
    session_id: int, body: SessionUpdate, user: dict = Depends(operator_user), conn: sqlite3.Connection = Depends(get_db)
):
    s = _get(conn, session_id)
    data = body.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(400, "변경할 항목이 없습니다")
    if s["status"] not in EDITABLE and set(data) - {"memo", "instructor"}:
        raise HTTPException(409, f"'{STATUS_LABELS[s['status']]}' 상태의 세션은 메모·담당 강사만 수정할 수 있습니다")
    if "content_id" in data:
        _check_content(conn, data["content_id"])
    if data.get("institution_name") == "":
        raise HTTPException(400, "기관명은 비울 수 없습니다")
    sets = ", ".join(f"{k}=?" for k in data)
    conn.execute(f"UPDATE sessions SET {sets}, updated_at=? WHERE id=?", (*data.values(), now_iso(), session_id))
    audit(conn, user, "session.update", "session", s["session_code"], data)
    conn.commit()
    return session_detail(session_id, user, conn)


@router.put("/{session_id}/participants")
def set_participants(
    session_id: int, body: ParticipantsIn, user: dict = Depends(operator_user), conn: sqlite3.Connection = Depends(get_db)
):
    s = _get(conn, session_id)
    if s["status"] not in EDITABLE + ("running",):
        raise HTTPException(409, "완료·취소된 세션의 배정은 변경할 수 없습니다")
    if s["status"] == "running":
        # 진행 중에는 이미 결과가 있는 학생을 제거하지 못하게 한다
        have = {r[0] for r in conn.execute(
            "SELECT DISTINCT student_code FROM mission_results WHERE session_id=?", (s["session_code"],)).fetchall()}
        missing = have - {p.student_code for p in body.participants}
        if missing:
            raise HTTPException(409, f"결과가 수신된 학생은 제외할 수 없습니다: {', '.join(sorted(missing))}")
    _replace_participants(conn, session_id, body.participants)
    audit(conn, user, "session.participants", "session", s["session_code"], {"count": len(body.participants)})
    conn.commit()
    manager.publish("session.progress", {"session_id": s["session_code"]})
    return session_detail(session_id, user, conn)


def _busy_devices(conn, exclude_session: int) -> set[str]:
    return {r[0] for r in conn.execute(
        """SELECT p.device_id FROM participants p JOIN sessions s ON s.id=p.session_id
           WHERE s.status='running' AND s.deleted=0 AND s.id != ? AND p.device_id IS NOT NULL""",
        (exclude_session,)).fetchall()}


@router.post("/{session_id}/auto-assign")
def auto_assign(session_id: int, user: dict = Depends(operator_user), conn: sqlite3.Connection = Depends(get_db)):
    """HMD 미배정 학생에게 사용 가능한 장비를 ID 순으로 자동 배정. 오프라인·오류 장비는 후순위."""
    s = _get(conn, session_id)
    if s["status"] not in EDITABLE:
        raise HTTPException(409, "작성 중·준비 완료 상태에서만 자동 배정할 수 있습니다")
    settings = get_settings(conn)
    parts = conn.execute("SELECT * FROM participants WHERE session_id=? ORDER BY student_code", (session_id,)).fetchall()
    used = {p["device_id"] for p in parts if p["device_id"]} | _busy_devices(conn, session_id)
    devices = [evaluate_device(dict(r), settings) for r in
               conn.execute("SELECT * FROM devices WHERE active=1 ORDER BY device_id").fetchall()]
    rank = {"normal": 0, "warning": 1, "unknown": 2, "offline": 3, "error": 4}
    pool = [d["device_id"] for d in sorted(devices, key=lambda d: (rank.get(d["health"], 5), d["device_id"]))
            if d["device_id"] not in used]
    assigned = []
    for p in parts:
        if p["device_id"] or not pool:
            continue
        dev = pool.pop(0)
        conn.execute("UPDATE participants SET device_id=? WHERE id=?", (dev, p["id"]))
        assigned.append({"student_code": p["student_code"], "device_id": dev})
    unassigned = sum(1 for p in parts if not p["device_id"]) - len(assigned)
    audit(conn, user, "session.auto_assign", "session", s["session_code"], {"assigned": len(assigned)})
    conn.commit()
    return {"assigned": assigned, "unassigned_count": unassigned, "session": session_detail(session_id, user, conn)}


def _transition(conn, user, s, new_status: str, extra_sql: str = "", extra_params: tuple = ()) -> None:
    conn.execute(f"UPDATE sessions SET status=?, updated_at=?{extra_sql} WHERE id=?",
                 (new_status, now_iso(), *extra_params, s["id"]))
    audit(conn, user, f"session.{new_status}", "session", s["session_code"], {"from": s["status"]})
    conn.commit()


@router.post("/{session_id}/ready")
def mark_ready(session_id: int, user: dict = Depends(operator_user), conn: sqlite3.Connection = Depends(get_db)):
    s = _get(conn, session_id)
    if s["status"] != "draft":
        raise HTTPException(409, "작성 중 상태의 세션만 준비 완료로 변경할 수 있습니다")
    if not s["content_id"]:
        raise HTTPException(400, "콘텐츠를 먼저 선택하세요")
    if conn.execute("SELECT COUNT(*) FROM participants WHERE session_id=?", (session_id,)).fetchone()[0] == 0:
        raise HTTPException(400, "참여 학생을 먼저 등록하세요")
    _transition(conn, user, s, "ready")
    return session_detail(session_id, user, conn)


@router.post("/{session_id}/start")
def start_session(session_id: int, user: dict = Depends(operator_user), conn: sqlite3.Connection = Depends(get_db)):
    s = _get(conn, session_id)
    if s["status"] not in EDITABLE:
        raise HTTPException(409, f"'{STATUS_LABELS[s['status']]}' 상태의 세션은 시작할 수 없습니다")
    if not s["content_id"]:
        raise HTTPException(400, "콘텐츠를 먼저 선택하세요")
    mine = {r[0] for r in conn.execute(
        "SELECT device_id FROM participants WHERE session_id=? AND device_id IS NOT NULL", (session_id,)).fetchall()}
    if not mine:
        raise HTTPException(400, "HMD가 배정된 학생이 없습니다")
    conflict = mine & _busy_devices(conn, session_id)
    if conflict:
        raise HTTPException(409, f"다른 진행 중 세션에 배정된 장비가 있습니다: {', '.join(sorted(conflict))}")
    _transition(conn, user, s, "running", ", started_at=?", (now_iso(),))
    manager.publish("session.started", {"session_id": s["session_code"], "id": session_id})
    return session_detail(session_id, user, conn)


def sync_check(conn, s: sqlite3.Row) -> dict:
    """세션 종료 전 결과 업로드 확인."""
    settings = get_settings(conn)
    issues = []
    rows = conn.execute(
        """SELECT p.student_code, p.device_id, d.reported_pending_count, d.last_seen_at, d.active, d.app_status,
             d.last_error_at, d.battery_level, d.last_error_code,
             (SELECT COUNT(*) FROM mission_results r WHERE r.session_id=? AND r.student_code=p.student_code) AS result_count
           FROM participants p LEFT JOIN devices d ON d.device_id=p.device_id WHERE p.session_id=?""",
        (s["session_code"], s["id"])).fetchall()
    for r in rows:
        if r["device_id"] is None:
            continue
        ev = evaluate_device(dict(r), settings)
        if r["reported_pending_count"]:
            issues.append({"device_id": r["device_id"], "student_code": r["student_code"],
                           "type": "pending", "message": f"HMD 미전송 결과 {r['reported_pending_count']}건 (HMD 보고 기준)"})
        if ev["connection_status"] != "online":
            issues.append({"device_id": r["device_id"], "student_code": r["student_code"],
                           "type": "offline", "message": "오프라인 — HMD에 남은 결과를 확인할 수 없음"})
        if r["result_count"] == 0:
            issues.append({"device_id": r["device_id"], "student_code": r["student_code"],
                           "type": "no_result", "message": "수신된 결과 없음"})
    return {"ok": not issues, "issues": issues}


@router.get("/{session_id}/sync-check")
def get_sync_check(session_id: int, user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db)):
    return sync_check(conn, _get(conn, session_id))


@router.post("/{session_id}/complete")
def complete_session(
    session_id: int, body: CompleteIn | None = None, user: dict = Depends(operator_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    s = _get(conn, session_id)
    if s["status"] != "running":
        raise HTTPException(409, "진행 중인 세션만 종료할 수 있습니다")
    check = sync_check(conn, s)
    if not check["ok"] and not (body and body.force):
        raise HTTPException(409, {"message": "미동기화 결과 또는 확인 불가 장비가 있습니다. 확인 후 강제 종료를 선택하세요.",
                                  "issues": check["issues"]})
    # 미동기화 데이터가 있어도 로컬/서버 데이터는 삭제하지 않는다. 이후 도착한 결과도 계속 수신한다.
    _transition(conn, user, s, "completed", ", ended_at=?", (now_iso(),))
    manager.publish("session.completed", {"session_id": s["session_code"], "id": session_id,
                                          "unsynced_issues": len(check["issues"])})
    d = session_detail(session_id, user, conn)
    d["sync_issues"] = check["issues"]
    return d


@router.post("/{session_id}/cancel")
def cancel_session(session_id: int, user: dict = Depends(operator_user), conn: sqlite3.Connection = Depends(get_db)):
    s = _get(conn, session_id)
    if s["status"] not in EDITABLE:
        raise HTTPException(409, "작성 중·준비 완료 상태의 세션만 취소할 수 있습니다")
    _transition(conn, user, s, "cancelled")
    return session_detail(session_id, user, conn)


@router.post("/{session_id}/clone", status_code=201)
def clone_session(session_id: int, user: dict = Depends(operator_user), conn: sqlite3.Connection = Depends(get_db)):
    s = _get(conn, session_id)
    today = date.today().isoformat()
    session_date = max(s["session_date"], today)
    code = _next_code(conn, session_date)
    now = now_iso()
    cols = ["institution_name", "institution_code", "grade", "class_group", "session_no", "topic", "content_id",
            "scheduled_start_at", "instructor", "expected_students", "memo"]
    cur = conn.execute(
        f"INSERT INTO sessions(session_code, session_date, {', '.join(cols)}, status, created_at, updated_at)"
        f" VALUES (?, ?, {', '.join('?' * len(cols))}, 'draft', ?, ?)",
        (code, session_date, *[s[c] for c in cols], now, now),
    )
    conn.execute(
        "INSERT INTO participants(session_id, student_code, device_id, created_at)"
        " SELECT ?, student_code, device_id, ? FROM participants WHERE session_id=?",
        (cur.lastrowid, now, session_id),
    )
    audit(conn, user, "session.clone", "session", code, {"from": s["session_code"]})
    conn.commit()
    return session_detail(cur.lastrowid, user, conn)


@router.get("/{session_id}/progress")
def session_progress(session_id: int, user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db)):
    """실시간 진행 현황 (미션 이벤트 기반, 화면 스트리밍 없음)."""
    s = _get(conn, session_id)
    settings = get_settings(conn)
    rows = conn.execute(
        """SELECT p.student_code, p.device_id, d.*, 
             g.mission_id AS cur_mission, g.step, g.progress, g.state AS progress_state, g.last_report_at,
             (SELECT COUNT(*) FROM mission_results r WHERE r.session_id=? AND r.student_code=p.student_code) AS result_count,
             (SELECT MAX(received_at) FROM mission_results r WHERE r.session_id=? AND r.student_code=p.student_code) AS last_result_at
           FROM participants p
           LEFT JOIN devices d ON d.device_id = p.device_id
           LEFT JOIN device_progress g ON g.session_id=? AND g.device_id=p.device_id
           WHERE p.session_id=? ORDER BY p.device_id IS NULL, p.device_id, p.student_code""",
        (s["session_code"], s["session_code"], s["session_code"], s["id"])).fetchall()
    items = []
    for r in rows:
        r = dict(r)
        r["device_id"] = r.get("device_id")
        dev = evaluate_device(r, settings) if r.get("device_id") and r.get("created_at") else None
        if dev is None:
            live = "unassigned"
        elif dev["health"] in ("offline", "unknown"):
            live = "offline"
        elif dev["health"] == "error" or r["progress_state"] == "error":
            live = "error"
        elif r["progress_state"] == "completed":
            live = "completed"
        elif r["progress_state"] == "in_progress":
            live = "in_progress"
        else:
            live = "waiting"
        pending = r.get("reported_pending_count")
        items.append({
            "student_code": r["student_code"],
            "device_id": r["device_id"],
            "health": dev["health"] if dev else None,
            "health_label": dev["health_label"] if dev else "미배정",
            "battery_level": r.get("battery_level"),
            "live_state": live,
            "mission_id": r["cur_mission"],
            "step": r["step"],
            "progress": r["progress"],
            "last_report_at": r["last_report_at"] or r.get("last_seen_at"),
            "result_count": r["result_count"],
            "last_result_at": r["last_result_at"],
            "pending_count": pending,
            "upload_state": ("unknown" if pending is None else "pending" if pending > 0 else "synced"),
        })
    total = len(items)
    progress_vals = [i["progress"] or (1.0 if i["live_state"] == "completed" else 0.0) for i in items]
    counts: dict[str, int] = {}
    for i in items:
        counts[i["live_state"]] = counts.get(i["live_state"], 0) + 1
    content = conn.execute("SELECT title FROM contents WHERE content_id=?", (s["content_id"],)).fetchone() if s["content_id"] else None
    return {
        "session": {**dict(s), "status_label": STATUS_LABELS[s["status"]], "content_title": content["title"] if content else None},
        "items": items,
        "summary": {"total": total, "counts": counts,
                    "overall_progress": (sum(progress_vals) / total) if total else 0.0},
        "server_time": now_iso(),
    }
