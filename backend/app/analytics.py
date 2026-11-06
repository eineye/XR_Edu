"""결과 조회·통계 공통 쿼리. 관리자 보정값이 있으면 보정값을 우선 사용한다."""
from __future__ import annotations

import sqlite3

EFF_CORRECT = "COALESCE(r.corrected_is_correct, r.is_correct)"
EFF_SCORE = "COALESCE(r.corrected_score, r.score)"

RESULT_SELECT = f"""SELECT r.*, {EFF_CORRECT} AS eff_is_correct, {EFF_SCORE} AS eff_score,
    s.institution_name, s.grade, s.class_group, s.session_no, s.session_date, s.id AS session_pk,
    c.title AS content_title
  FROM mission_results r
  LEFT JOIN sessions s ON s.session_code = r.session_id
  LEFT JOIN contents c ON c.content_id = r.content_id"""


def build_filters(f: dict) -> tuple[str, list]:
    where, params = ["1=1"], []
    mapping = {
        "session_id": "r.session_id = ?",
        "device_id": "r.device_id = ?",
        "student_code": "r.student_code = ?",
        "content_id": "r.content_id = ?",
        "mission_id": "r.mission_id = ?",
        "grade": "s.grade = ?",
        "class_group": "s.class_group = ?",
    }
    for k, clause in mapping.items():
        if f.get(k):
            where.append(clause); params.append(f[k])
    if f.get("institution"):
        where.append("s.institution_name LIKE ?"); params.append(f"%{f['institution']}%")
    if f.get("date_from"):
        where.append("s.session_date >= ?"); params.append(f["date_from"])
    if f.get("date_to"):
        where.append("s.session_date <= ?"); params.append(f["date_to"])
    if f.get("is_correct") in ("true", "false"):
        where.append(f"{EFF_CORRECT} = ?"); params.append(1 if f["is_correct"] == "true" else 0)
    if f.get("q"):
        where.append("(r.student_code LIKE ? OR r.mission_id LIKE ? OR r.device_id LIKE ? OR r.event_id LIKE ?)")
        params += [f"%{f['q']}%"] * 4
    return " AND ".join(where), params


def stats(conn: sqlite3.Connection, f: dict) -> dict:
    where, params = build_filters(f)
    base = f"FROM mission_results r LEFT JOIN sessions s ON s.session_code=r.session_id WHERE {where}"
    overall = conn.execute(
        f"""SELECT COUNT(*) AS result_count, COUNT(DISTINCT r.session_id || '|' || r.student_code) AS student_count,
              AVG({EFF_SCORE}) AS avg_score, AVG(r.duration_seconds) AS avg_duration,
              AVG(CASE WHEN {EFF_CORRECT} IS NULL THEN NULL ELSE {EFF_CORRECT} END) AS accuracy {base}""",
        params).fetchone()
    by_mission = conn.execute(
        f"""SELECT r.mission_id, r.content_id, COUNT(*) AS attempts,
              SUM(CASE WHEN {EFF_CORRECT}=1 THEN 1 ELSE 0 END) AS correct,
              AVG(CASE WHEN {EFF_CORRECT} IS NULL THEN NULL ELSE {EFF_CORRECT} END) AS accuracy,
              AVG({EFF_SCORE}) AS avg_score, AVG(r.duration_seconds) AS avg_duration,
              AVG(r.attempt_count) AS avg_attempts
            {base} GROUP BY r.content_id, r.mission_id ORDER BY r.content_id, r.mission_id""",
        params).fetchall()
    by_content = conn.execute(
        f"""SELECT r.content_id, c.title, COUNT(*) AS result_count,
              COUNT(DISTINCT r.session_id || '|' || r.student_code) AS student_count,
              AVG({EFF_SCORE}) AS avg_score,
              AVG(CASE WHEN {EFF_CORRECT} IS NULL THEN NULL ELSE {EFF_CORRECT} END) AS accuracy,
              AVG(r.duration_seconds) AS avg_duration
            FROM mission_results r LEFT JOIN sessions s ON s.session_code=r.session_id
            LEFT JOIN contents c ON c.content_id=r.content_id WHERE {where}
            GROUP BY r.content_id ORDER BY r.content_id""",
        params).fetchall()
    wrong = conn.execute(
        f"""SELECT r.mission_id, r.answer_json AS answer, COUNT(*) AS count
            {base} AND {EFF_CORRECT}=0 GROUP BY r.mission_id, r.answer_json
            ORDER BY count DESC LIMIT 20""",
        params).fetchall()
    return {
        "overall": dict(overall),
        "by_mission": [dict(r) for r in by_mission],
        "by_content": [dict(r) for r in by_content],
        "wrong_answers": [dict(r) for r in wrong],
    }


def students_of_session(conn: sqlite3.Connection, session_code: str, session_pk: int) -> list[dict]:
    rows = conn.execute(
        f"""SELECT p.student_code, p.device_id,
              COUNT(r.id) AS result_count,
              AVG({EFF_SCORE}) AS avg_score, SUM({EFF_SCORE}) AS total_score,
              AVG(CASE WHEN {EFF_CORRECT} IS NULL THEN NULL ELSE {EFF_CORRECT} END) AS accuracy,
              SUM(r.duration_seconds) AS total_duration,
              (SELECT state FROM device_progress g WHERE g.session_id=? AND g.device_id=p.device_id) AS progress_state
            FROM participants p
            LEFT JOIN mission_results r ON r.session_id=? AND r.student_code=p.student_code
            WHERE p.session_id=? GROUP BY p.student_code, p.device_id ORDER BY p.student_code""",
        (session_code, session_code, session_pk)).fetchall()
    return [dict(r) for r in rows]
