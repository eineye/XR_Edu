from .conftest import make_result


def upload(client, h, results, session="SESSION-20261106-001", device="HMD-01"):
    return client.post("/api/v1/results/batch", json={"device_id": device, "session_id": session, "results": results},
                       headers=h)


def test_upload_and_ack(client, dev_headers, setup_session):
    r = upload(client, dev_headers, [make_result(1), make_result(2, mission="PPE-CHECK-01", correct=False)])
    assert r.status_code == 200
    j = r.json()
    assert j["accepted"] == ["evt-1", "evt-2"] and j["duplicates"] == [] and j["rejected"] == []
    items = client.get("/api/v1/results", params={"session_id": "SESSION-20261106-001"}).json()
    assert items["total"] == 2


def test_duplicate_upload_is_idempotent(client, dev_headers, setup_session):
    for _ in range(5):
        j = upload(client, dev_headers, [make_result(1)]).json()
    assert j["accepted"] == [] and j["duplicates"] == ["evt-1"]
    assert client.get("/api/v1/results").json()["total"] == 1


def test_partial_failure(client, dev_headers, setup_session):
    bad_time = make_result(3); bad_time["occurred_at"] = "어제"
    unknown_student = make_result(4, student="S999")
    missing = {"event_id": "evt-5"}
    conflict = make_result(6); conflict["result_id"] = "res-1"
    j = upload(client, dev_headers, [make_result(1), bad_time, unknown_student, missing, conflict]).json()
    assert j["accepted"] == ["evt-1"]
    reasons = {x["event_id"]: x["reason"] for x in j["rejected"]}
    assert set(reasons) == {"evt-3", "evt-4", "evt-5", "evt-6"}
    assert "등록되지 않은 학생" in reasons["evt-4"]
    un = client.get("/api/v1/results/unsynced").json()
    assert len(un["rejections"]) == 4


def test_unknown_session_rejected(client, dev_headers, setup_session):
    j = upload(client, dev_headers, [make_result(1)], session="SESSION-NOPE").json()
    assert j["accepted"] == [] and len(j["rejected"]) == 1


def test_stats_and_correction(client, dev_headers, setup_session):
    upload(client, dev_headers, [make_result(1), make_result(2, student="S002", correct=False)])
    st = client.get("/api/v1/results/stats", params={"session_id": "SESSION-20261106-001"}).json()
    m = st["by_mission"][0]
    assert m["attempts"] == 2 and m["accuracy"] == 0.5
    assert st["wrong_answers"][0]["count"] == 1
    r = client.post("/api/v1/results/res-2/corrections", json={"is_correct": True, "score": 100, "reason": "채점 오류 보정"})
    assert r.status_code == 200
    d = r.json()
    assert d["is_correct"] == 0 and d["eff_is_correct"] == 1  # 원본 보존 + 보정값 적용
    assert len(d["corrections"]) == 2
    st = client.get("/api/v1/results/stats", params={"session_id": "SESSION-20261106-001"}).json()
    assert st["by_mission"][0]["accuracy"] == 1.0


def test_events_progress(client, dev_headers, setup_session):
    sid = setup_session["id"]
    dev = next(p for p in setup_session["participants"] if p["student_code"] == "S001")["device_id"]
    evs = [{"event_id": "e1", "event_type": "mission.started", "session_id": "SESSION-20261106-001",
            "student_code": "S001", "mission_id": "M1", "progress": 0.2, "occurred_at": "2026-11-06T10:00:00+09:00"},
           {"event_id": "e2", "event_type": "session.finished", "session_id": "SESSION-20261106-001",
            "student_code": "S001", "occurred_at": "2026-11-06T10:20:00+09:00"},
           {"event_id": "e0", "event_type": "mission.progress", "session_id": "SESSION-20261106-001",
            "student_code": "S001", "progress": 0.1, "occurred_at": "2026-11-06T09:59:00+09:00"},
           {"event_id": "bad", "event_type": "nope", "occurred_at": "2026-11-06T10:00:00+09:00"}]
    client.post("/api/v1/devices/heartbeat", json={"device_id": dev, "app_status": "running",
                "occurred_at": "2026-11-06T10:20:00+09:00"}, headers=dev_headers)
    j = client.post("/api/v1/events", json={"device_id": dev, "events": evs}, headers=dev_headers).json()
    assert j["accepted"] == ["e1", "e2", "e0"] and len(j["rejected"]) == 1
    j = client.post("/api/v1/events", json={"device_id": dev, "events": evs[:1]}, headers=dev_headers).json()
    assert j["duplicates"] == ["e1"]
    p = client.get(f"/api/v1/sessions/{sid}/progress").json()
    item = next(i for i in p["items"] if i["student_code"] == "S001")
    assert item["mission_id"] == "M1"  # 늦게 온 과거 이벤트가 최신 상태를 덮어쓰지 않음
    assert item["live_state"] == "completed" and p["summary"]["counts"]["completed"] == 1


def test_reports_export(client, dev_headers, setup_session):
    upload(client, dev_headers, [make_result(1), make_result(2, student="S002", correct=False)])
    sid = setup_session["id"]
    rep = client.get(f"/api/v1/reports/session/{sid}").json()
    assert rep["summary"]["participants"] == 20
    assert rep["relearn"][0]["mission_id"] == "FORKLIFT-HAZARD-01"
    for fmt, sig in (("csv", b"\xef\xbb\xbf"), ("xlsx", b"PK"), ("pdf", b"%PDF")):
        r = client.get(f"/api/v1/reports/session/{sid}", params={"format": fmt})
        assert r.status_code == 200 and r.content.startswith(sig), fmt
    for t in ("operations", "class_performance", "students", "content_effect", "mission_accuracy",
              "device_incidents", "results_raw"):
        assert client.get(f"/api/v1/reports/{t}").status_code == 200, t
        assert client.get(f"/api/v1/reports/{t}", params={"format": "xlsx"}).status_code == 200, t
