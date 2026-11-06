from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from ..analytics import EFF_CORRECT, EFF_SCORE, RESULT_SELECT, build_filters, stats, students_of_session
from ..db import get_db, rows_to_dicts
from ..exporters import export_response
from ..security import any_user
from ..timeutil import now_iso, to_local_str
from .sessions import STATUS_LABELS, sync_check

router = APIRouter(prefix="/api/v1/reports", tags=["reports"])

RELEARN_THRESHOLD = 0.6  # 정답률 60% 미만 미션은 재학습 권장
ACC = f"AVG(CASE WHEN {EFF_CORRECT} IS NULL THEN NULL ELSE {EFF_CORRECT} END)"


def _pct(v):
    return None if v is None else round(v * 100, 1)


def _r(v, n=1):
    return None if v is None else round(v, n)


def _filters(**kw):
    return {k: v for k, v in kw.items() if v not in (None, "")}


def session_report(conn, session_pk: int) -> dict:
    s = conn.execute("SELECT * FROM sessions WHERE id=? AND deleted=0", (session_pk,)).fetchone()
    if s is None:
        raise HTTPException(404, "세션을 찾을 수 없습니다")
    content = conn.execute("SELECT * FROM contents WHERE content_id=?", (s["content_id"],)).fetchone() if s["content_id"] else None
    st = stats(conn, {"session_id": s["session_code"]})
    students = students_of_session(conn, s["session_code"], s["id"])
    participants = len(students)
    completed = sum(1 for x in students if x["progress_state"] == "completed")
    with_results = sum(1 for x in students if x["result_count"] > 0)
    missions = [{**m, "accuracy_pct": _pct(m["accuracy"]), "avg_score": _r(m["avg_score"]),
                 "avg_duration": _r(m["avg_duration"]), "avg_attempts": _r(m["avg_attempts"], 2)} for m in st["by_mission"]]
    relearn = [m for m in missions if m["accuracy"] is not None and m["accuracy"] < RELEARN_THRESHOLD]
    check = sync_check(conn, s) if s["status"] in ("running", "completed") else {"issues": []}
    incidents = rows_to_dicts(conn.execute(
        "SELECT device_id, event_type, payload_json, occurred_at FROM device_events WHERE session_id=?"
        " AND event_type='app.error' ORDER BY occurred_at", (s["session_code"],)).fetchall())
    rejections = conn.execute("SELECT COUNT(*) FROM result_rejections WHERE session_id=?", (s["session_code"],)).fetchone()[0]
    notes = [f"{i['device_id']} ({i['student_code']}): {i['message']}" for i in check["issues"]]
    notes += [f"{i['device_id']}: 앱 오류 보고 ({to_local_str(i['occurred_at'])})" for i in incidents]
    if rejections:
        notes.append(f"서버가 거부한 결과 {rejections}건 (학습 결과 관리 > 미동기화 결과에서 확인)")
    ov = st["overall"]
    grade_class = " ".join(x for x in [
        f"{s['grade']}학년" if s["grade"] else "", f"{s['class_group']}반" if s["class_group"] else "",
        f"{s['session_no']}회차" if s["session_no"] else ""] if x) or "-"
    return {
        "title": f"수업 운영 보고서 — {s['institution_name']} {s['session_date']}",
        "session": {**dict(s), "status_label": STATUS_LABELS[s["status"]]},
        "summary": {
            "participants": participants, "completed": completed, "with_results": with_results,
            "avg_score": _r(ov["avg_score"]), "accuracy_pct": _pct(ov["accuracy"]),
            "avg_duration": _r(ov["avg_duration"]), "result_count": ov["result_count"],
        },
        "relearn": relearn,
        "notes": notes,
        "meta": [
            ["기관명", s["institution_name"]], ["교육일", s["session_date"]], ["학년·학급·회차", grade_class],
            ["교육 콘텐츠", f"{content['title']} (v{content['version']})" if content else (s["content_id"] or "-")],
            ["담당 강사", s["instructor"] or "-"], ["세션 코드", s["session_code"]],
            ["세션 상태", STATUS_LABELS[s["status"]]],
            ["참여 인원", participants], ["완료 인원", completed], ["결과 수신 인원", with_results],
            ["평균 점수", _r(ov["avg_score"])], ["전체 정답률(%)", _pct(ov["accuracy"])],
            ["재학습 권장 항목", ", ".join(m["mission_id"] for m in relearn) or "없음"],
            ["장비·동기화 특이사항", " / ".join(notes) or "없음"],
            ["보고서 생성 시각", to_local_str(now_iso())],
        ],
        "tables": [
            {"title": "미션별 정답률", "columns": [["mission_id", "미션"], ["attempts", "응답 수"], ["correct", "정답 수"],
             ["accuracy_pct", "정답률(%)"], ["avg_score", "평균 점수"], ["avg_attempts", "평균 시도"],
             ["avg_duration", "평균 수행시간(초)"]], "rows": missions},
            {"title": "학생별 수행 결과", "columns": [["student_code", "학생 코드"], ["device_id", "HMD"],
             ["result_count", "결과 수"], ["avg_score", "평균 점수"], ["accuracy_pct", "정답률(%)"],
             ["total_duration", "총 수행시간(초)"], ["state", "진행 상태"]],
             "rows": [{**x, "avg_score": _r(x["avg_score"]), "accuracy_pct": _pct(x["accuracy"]),
                       "total_duration": _r(x["total_duration"]),
                       "state": {"completed": "완료", "in_progress": "진행 중", "waiting": "대기",
                                 "error": "오류"}.get(x["progress_state"] or "", "미보고")} for x in students]},
            {"title": "오답 유형", "columns": [["mission_id", "미션"], ["answer", "선택 답안"], ["count", "횟수"]],
             "rows": st["wrong_answers"]},
        ],
    }


@router.get("/session/{session_id}")
def get_session_report(session_id: int, format: str = "json", user: dict = Depends(any_user),
                       conn: sqlite3.Connection = Depends(get_db)):
    rep = session_report(conn, session_id)
    return export_response(rep, format, f"세션보고서_{rep['session']['session_code']}")


REPORT_TYPES = {
    "operations": "수업 운영 요약",
    "class_performance": "학급별 학습 성과",
    "students": "학생별 수행 결과",
    "content_effect": "콘텐츠별 효과 분석",
    "mission_accuracy": "미션별 정답률",
    "device_incidents": "장비 운영·장애 이력",
    "results_raw": "학습 결과 원본",
}


@router.get("/types")
def report_types(user: dict = Depends(any_user)):
    return REPORT_TYPES


@router.get("/{report_type}")
def generic_report(
    report_type: str, format: str = "json", date_from: str | None = None, date_to: str | None = None,
    institution: str | None = None, content_id: str | None = None, grade: str | None = None,
    class_group: str | None = None, session_id: str | None = None,
    user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db),
):
    if report_type not in REPORT_TYPES:
        raise HTTPException(404, "알 수 없는 보고서 종류입니다")
    f = _filters(date_from=date_from, date_to=date_to, institution=institution, content_id=content_id,
                 grade=grade, class_group=class_group, session_id=session_id)
    where, params = build_filters(f)
    title = REPORT_TYPES[report_type]
    meta = [["기간", f"{date_from or '처음'} ~ {date_to or '현재'}"], ["기관", institution or "전체"],
            ["콘텐츠", content_id or "전체"], ["생성 시각", to_local_str(now_iso())]]

    if report_type == "operations":
        sql, sp = "SELECT * FROM sessions s WHERE deleted=0", []
        for k, c in (("date_from", "s.session_date >= ?"), ("date_to", "s.session_date <= ?"),
                     ("content_id", "s.content_id = ?"), ("grade", "s.grade = ?"), ("class_group", "s.class_group = ?")):
            if f.get(k):
                sql += f" AND {c}"; sp.append(f[k])
        if institution:
            sql += " AND s.institution_name LIKE ?"; sp.append(f"%{institution}%")
        rows = []
        for s in conn.execute(sql + " ORDER BY session_date DESC, id DESC", sp).fetchall():
            agg = conn.execute(f"SELECT COUNT(DISTINCT r.student_code), AVG({EFF_SCORE}), {ACC} FROM mission_results r"
                               " WHERE r.session_id=?", (s["session_code"],)).fetchone()
            rows.append({
                "session_code": s["session_code"], "session_date": s["session_date"], "institution_name": s["institution_name"],
                "grade": s["grade"], "class_group": s["class_group"], "session_no": s["session_no"],
                "content_id": s["content_id"], "instructor": s["instructor"], "status": STATUS_LABELS[s["status"]],
                "participants": conn.execute("SELECT COUNT(*) FROM participants WHERE session_id=?", (s["id"],)).fetchone()[0],
                "completed": conn.execute("SELECT COUNT(*) FROM device_progress WHERE session_id=? AND state='completed'",
                                          (s["session_code"],)).fetchone()[0],
                "students_with_results": agg[0], "avg_score": _r(agg[1]), "accuracy_pct": _pct(agg[2]),
            })
        cols = [["session_code", "세션 코드"], ["session_date", "교육일"], ["institution_name", "기관"], ["grade", "학년"],
                ["class_group", "학급"], ["session_no", "회차"], ["content_id", "콘텐츠"], ["instructor", "강사"],
                ["status", "상태"], ["participants", "참여"], ["completed", "완료"],
                ["students_with_results", "결과 수신 인원"], ["avg_score", "평균 점수"], ["accuracy_pct", "정답률(%)"]]
    elif report_type == "class_performance":
        rows = rows_to_dicts(conn.execute(
            f"""SELECT s.institution_name, s.grade, s.class_group, COUNT(DISTINCT r.session_id) AS sessions,
                  COUNT(DISTINCT r.session_id || '|' || r.student_code) AS students, COUNT(*) AS results,
                  ROUND(AVG({EFF_SCORE}),1) AS avg_score, ROUND({ACC}*100,1) AS accuracy_pct,
                  ROUND(AVG(r.duration_seconds),1) AS avg_duration
                FROM mission_results r LEFT JOIN sessions s ON s.session_code=r.session_id WHERE {where}
                GROUP BY s.institution_name, s.grade, s.class_group ORDER BY s.institution_name, s.grade, s.class_group""",
            params).fetchall())
        cols = [["institution_name", "기관"], ["grade", "학년"], ["class_group", "학급"], ["sessions", "세션 수"],
                ["students", "학생 수"], ["results", "결과 수"], ["avg_score", "평균 점수"], ["accuracy_pct", "정답률(%)"],
                ["avg_duration", "평균 수행시간(초)"]]
    elif report_type == "students":
        rows = rows_to_dicts(conn.execute(
            f"""SELECT r.session_id, s.session_date, s.institution_name, r.student_code, r.device_id,
                  COUNT(*) AS results, ROUND(AVG({EFF_SCORE}),1) AS avg_score, ROUND({ACC}*100,1) AS accuracy_pct,
                  ROUND(SUM(r.duration_seconds),1) AS total_duration
                FROM mission_results r LEFT JOIN sessions s ON s.session_code=r.session_id WHERE {where}
                GROUP BY r.session_id, r.student_code ORDER BY s.session_date DESC, r.session_id, r.student_code""",
            params).fetchall())
        cols = [["session_id", "세션"], ["session_date", "교육일"], ["institution_name", "기관"],
                ["student_code", "학생 코드"], ["device_id", "HMD"], ["results", "결과 수"], ["avg_score", "평균 점수"],
                ["accuracy_pct", "정답률(%)"], ["total_duration", "총 수행시간(초)"]]
    elif report_type == "content_effect":
        rows = [{**c, "avg_score": _r(c["avg_score"]), "accuracy_pct": _pct(c["accuracy"]),
                 "avg_duration": _r(c["avg_duration"])} for c in stats(conn, f)["by_content"]]
        cols = [["content_id", "콘텐츠 ID"], ["title", "콘텐츠명"], ["student_count", "학습자 수"],
                ["result_count", "결과 수"], ["avg_score", "평균 점수"], ["accuracy_pct", "정답률(%)"],
                ["avg_duration", "평균 수행시간(초)"]]
    elif report_type == "mission_accuracy":
        rows = [{**m, "accuracy_pct": _pct(m["accuracy"]), "avg_score": _r(m["avg_score"]),
                 "avg_duration": _r(m["avg_duration"]),
                 "relearn": "권장" if (m["accuracy"] is not None and m["accuracy"] < RELEARN_THRESHOLD) else ""}
                for m in stats(conn, f)["by_mission"]]
        cols = [["content_id", "콘텐츠"], ["mission_id", "미션"], ["attempts", "응답 수"], ["correct", "정답 수"],
                ["accuracy_pct", "정답률(%)"], ["avg_score", "평균 점수"], ["avg_duration", "평균 수행시간(초)"],
                ["relearn", "재학습"]]
    elif report_type == "device_incidents":
        rows = []
        for e in conn.execute(
                "SELECT device_id, event_type, session_id, payload_json, occurred_at FROM device_events"
                " WHERE event_type='app.error' ORDER BY occurred_at DESC LIMIT 1000").fetchall():
            rows.append({"device_id": e["device_id"], "type": "앱 오류", "session_id": e["session_id"],
                         "detail": e["payload_json"], "at": to_local_str(e["occurred_at"])})
        for r in conn.execute("SELECT device_id, session_id, reason, received_at FROM result_rejections"
                              " ORDER BY id DESC LIMIT 1000").fetchall():
            rows.append({"device_id": r["device_id"], "type": "결과 거부", "session_id": r["session_id"],
                         "detail": r["reason"], "at": to_local_str(r["received_at"])})
        rows.sort(key=lambda x: x["at"], reverse=True)
        cols = [["at", "시각"], ["device_id", "장비"], ["type", "유형"], ["session_id", "세션"], ["detail", "내용"]]
        dev_rows = rows_to_dicts(conn.execute(
            """SELECT d.device_id, d.model, d.app_version, d.last_seen_at, d.last_error_code,
                 (SELECT COUNT(*) FROM device_events e WHERE e.device_id=d.device_id AND e.event_type='app.error') AS errors,
                 (SELECT COUNT(*) FROM result_rejections x WHERE x.device_id=d.device_id) AS rejections,
                 (SELECT COUNT(*) FROM sync_logs l WHERE l.device_id=d.device_id) AS uploads
               FROM devices d ORDER BY d.device_id""").fetchall())
        for d in dev_rows:
            d["last_seen_at"] = to_local_str(d["last_seen_at"])
        return export_response({"title": title, "meta": meta, "tables": [
            {"title": "장비별 현황", "columns": [["device_id", "장비"], ["model", "모델"], ["app_version", "앱 버전"],
                                              ["last_seen_at", "마지막 통신"], ["last_error_code", "최근 오류"],
                                              ["errors", "오류 수"], ["rejections", "결과 거부"], ["uploads", "업로드 횟수"]],
             "rows": dev_rows},
            {"title": "장애 이력", "columns": cols, "rows": rows}]}, format, title)
    else:  # results_raw
        rows = rows_to_dicts(conn.execute(f"{RESULT_SELECT} WHERE {where} ORDER BY r.occurred_at LIMIT 50000", params).fetchall())
        for r in rows:
            r["occurred_local"] = to_local_str(r["occurred_at"])
            r["received_local"] = to_local_str(r["received_at"])
            r["eff_is_correct"] = {1: "O", 0: "X"}.get(r["eff_is_correct"], "")
        cols = [["result_id", "result_id"], ["event_id", "event_id"], ["session_id", "세션"], ["device_id", "HMD"],
                ["student_code", "학생 코드"], ["content_id", "콘텐츠"], ["content_version", "콘텐츠 버전"],
                ["mission_id", "미션"], ["answer_json", "답안"], ["eff_is_correct", "정답"], ["eff_score", "점수"],
                ["attempt_count", "시도"], ["duration_seconds", "수행시간(초)"], ["occurred_local", "발생 시각"],
                ["received_local", "수신 시각"], ["sync_status", "상태"]]
    return export_response({"title": title, "meta": meta, "tables": [{"title": title, "columns": cols, "rows": rows}]},
                           format, title)
