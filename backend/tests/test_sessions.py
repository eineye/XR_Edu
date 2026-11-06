from app.db import db_session
from app.demo import seed_demo_contents


def _base(client):
    client.post("/api/v1/devices/bulk", json={"count": 20})
    with db_session() as conn:
        seed_demo_contents(conn)


def test_assign_20_no_duplicates(client, setup_session):
    parts = setup_session["participants"]
    assert len(parts) == 20
    devices = [p["device_id"] for p in parts]
    assert len(set(devices)) == 20 and None not in devices
    assert setup_session["status"] == "running"
    assert setup_session["session_code"] == "SESSION-20261106-001"


def test_duplicate_device_and_student_rejected(client):
    _base(client)
    body = {"institution_name": "A", "session_date": "2026-11-06",
            "participants": [{"student_code": "S1", "device_id": "HMD-01"}, {"student_code": "S2", "device_id": "HMD-01"}]}
    assert client.post("/api/v1/sessions", json=body).status_code == 400
    body["participants"] = [{"student_code": "S1"}, {"student_code": "S1"}]
    assert client.post("/api/v1/sessions", json=body).status_code == 400
    body["participants"] = [{"student_code": "홍길동"}]
    assert client.post("/api/v1/sessions", json=body).status_code == 422


def test_mismatch_warning_and_lifecycle(client):
    _base(client)
    r = client.post("/api/v1/sessions", json={"institution_name": "B", "session_date": "2026-11-07",
                                              "content_id": "ENV-01", "expected_students": 3,
                                              "participants": [{"student_code": "A1"}]}).json()
    assert any("다릅니다" in w for w in r["warnings"])
    sid = r["id"]
    assert client.post(f"/api/v1/sessions/{sid}/complete").status_code == 409  # running 아님
    assert client.post(f"/api/v1/sessions/{sid}/ready").status_code == 200
    assert client.post(f"/api/v1/sessions/{sid}/start").status_code == 400  # 배정 장비 없음
    client.post(f"/api/v1/sessions/{sid}/auto-assign")
    assert client.post(f"/api/v1/sessions/{sid}/start").status_code == 200
    assert client.patch(f"/api/v1/sessions/{sid}", json={"grade": "3"}).status_code == 409
    assert client.patch(f"/api/v1/sessions/{sid}", json={"memo": "메모"}).status_code == 200
    # 미동기화(결과 없음) → 경고 후 강제 종료
    r = client.post(f"/api/v1/sessions/{sid}/complete", json={})
    assert r.status_code == 409 and r.json()["detail"]["issues"]
    r = client.post(f"/api/v1/sessions/{sid}/complete", json={"force": True})
    assert r.status_code == 200 and r.json()["status"] == "completed"
    c = client.post(f"/api/v1/sessions/{sid}/clone").json()
    assert c["status"] == "draft" and c["participant_count"] == 1


def test_device_conflict_between_running_sessions(client, setup_session):
    r = client.post("/api/v1/sessions", json={"institution_name": "C", "session_date": "2026-11-06",
                                              "content_id": "SAFETY-01",
                                              "participants": [{"student_code": "X1", "device_id": "HMD-01"}]}).json()
    assert client.post(f"/api/v1/sessions/{r['id']}/start").status_code == 409
