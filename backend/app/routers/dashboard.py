from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from ..analytics import EFF_CORRECT, EFF_SCORE
from ..db import get_db, rows_to_dicts
from ..security import any_user
from ..timeutil import now_iso
from .devices import list_devices_evaluated
from .sessions import STATUS_LABELS

router = APIRouter(prefix="/api/v1/dashboard", tags=["dashboard"])


@router.get("/summary")
def summary(user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db)):
    devices = list_devices_evaluated(conn, include_inactive=False)
    counts = {k: 0 for k in ("normal", "warning", "offline", "error", "unknown")}
    for d in devices:
        counts[d["health"]] = counts.get(d["health"], 0) + 1
    online = sum(1 for d in devices if d["connection_status"] == "online")

    running = []
    for s in conn.execute("SELECT * FROM sessions WHERE status='running' AND deleted=0 ORDER BY started_at").fetchall():
        total = conn.execute("SELECT COUNT(*) FROM participants WHERE session_id=?", (s["id"],)).fetchone()[0]
        prog = conn.execute(
            "SELECT AVG(CASE WHEN state='completed' THEN 1.0 ELSE COALESCE(progress, 0) END), "
            "SUM(CASE WHEN state='completed' THEN 1 ELSE 0 END) FROM device_progress WHERE session_id=?",
            (s["session_code"],)).fetchone()
        reported = conn.execute("SELECT COUNT(*) FROM device_progress WHERE session_id=?", (s["session_code"],)).fetchone()[0]
        content = conn.execute("SELECT title FROM contents WHERE content_id=?", (s["content_id"],)).fetchone()
        avg_prog = ((prog[0] or 0) * reported / total) if total else 0
        running.append({
            "id": s["id"], "session_code": s["session_code"], "institution_name": s["institution_name"],
            "grade": s["grade"], "class_group": s["class_group"], "session_no": s["session_no"],
            "content_title": content["title"] if content else s["content_id"], "started_at": s["started_at"],
            "participants": total, "completed": prog[1] or 0, "progress": avg_prog,
            "status_label": STATUS_LABELS[s["status"]],
        })

    pending_total = sum(d["reported_pending_count"] or 0 for d in devices)
    pending_unknown = sum(1 for d in devices if d["reported_pending_count"] is None)
    rejected_24h = conn.execute(
        "SELECT COUNT(*) FROM result_rejections WHERE received_at >= strftime('%Y-%m-%dT%H:%M:%S+00:00','now','-1 day')").fetchone()[0]

    alerts = []
    for d in devices:
        if d["health"] in ("warning", "offline", "error") or (d["health"] == "unknown" and d.get("assignment")):
            alerts.append({"level": d["health"], "device_id": d["device_id"],
                           "message": " / ".join(d["health_reasons"]), "at": d.get("last_seen_at")})
    for e in conn.execute(
            "SELECT device_id, payload_json, received_at FROM device_events WHERE event_type='app.error'"
            " ORDER BY id DESC LIMIT 5").fetchall():
        alerts.append({"level": "error", "device_id": e["device_id"], "message": "앱 오류 이벤트 수신", "at": e["received_at"]})
    for r in conn.execute("SELECT device_id, reason, received_at FROM result_rejections ORDER BY id DESC LIMIT 5").fetchall():
        alerts.append({"level": "warning", "device_id": r["device_id"], "message": f"결과 거부: {r['reason']}",
                       "at": r["received_at"]})
    order = {"error": 0, "offline": 1, "unknown": 1, "warning": 2}
    alerts.sort(key=lambda a: (order.get(a["level"], 3), a["at"] or ""), reverse=False)

    recent = conn.execute(
        f"""SELECT r.mission_id, r.content_id, COUNT(*) AS attempts,
              AVG(CASE WHEN {EFF_CORRECT} IS NULL THEN NULL ELSE {EFF_CORRECT} END) AS accuracy,
              AVG({EFF_SCORE}) AS avg_score
            FROM mission_results r WHERE r.received_at >= strftime('%Y-%m-%dT%H:%M:%S+00:00','now','-7 day')
            GROUP BY r.content_id, r.mission_id ORDER BY r.content_id, r.mission_id LIMIT 20""").fetchall()
    last_results = rows_to_dicts(conn.execute(
        f"SELECT r.result_id, r.session_id, r.device_id, r.student_code, r.mission_id, {EFF_CORRECT} AS is_correct,"
        f" {EFF_SCORE} AS score, r.received_at FROM mission_results r ORDER BY r.id DESC LIMIT 8").fetchall())
    last_hb = conn.execute("SELECT MAX(last_seen_at) FROM devices").fetchone()[0]
    simulated = sum(1 for d in devices if d["is_simulated"])

    return {
        "devices": {"total": len(devices), "online": online, **counts},
        "device_tiles": [{"device_id": d["device_id"], "device_name": d.get("device_name"), "health": d["health"],
                          "health_label": d["health_label"], "battery_level": d["battery_level"],
                          "app_status": d["app_status"], "last_seen_at": d["last_seen_at"],
                          "is_simulated": d["is_simulated"], "reasons": d["health_reasons"]} for d in devices],
        "running_sessions": running,
        "unsynced": {"pending_total": pending_total, "devices_unknown": pending_unknown, "rejected_24h": rejected_24h},
        "alerts": alerts[:15],
        "mission_accuracy": rows_to_dicts(recent),
        "recent_results": last_results,
        "demo": {"simulated_devices": simulated},
        "data_as_of": now_iso(),
        "last_heartbeat_at": last_hb,
    }
