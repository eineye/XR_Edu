import sqlite3

from app.config import config

from .conftest import make_result


def test_settings_validation(client):
    assert client.patch("/api/v1/settings", json={"values": {"battery_warning_pct": 150}}).status_code == 400
    assert client.patch("/api/v1/settings", json={"values": {"nope": 1}}).status_code == 400
    assert client.patch("/api/v1/settings", json={"values": {"offline_threshold_sec": 20}}).status_code == 400
    r = client.patch("/api/v1/settings", json={"values": {"battery_warning_pct": 30}})
    assert r.status_code == 200 and r.json()["values"]["battery_warning_pct"] == 30
    s = client.get("/api/v1/settings").json()
    assert s["server"]["port"] == config.port


def test_backup_verify_restore(client, dev_headers, setup_session):
    client.post("/api/v1/results/batch", json={"device_id": "HMD-01", "session_id": "SESSION-20261106-001",
                                               "results": [make_result(1)]}, headers=dev_headers)
    b = client.post("/api/v1/backups").json()
    assert b["integrity"] == "ok" and b["counts"]["mission_results"] == 1
    v = client.post("/api/v1/backups/verify", json={"file": b["file"]}).json()
    assert v["ok"] and v["checksum_ok"]
    # 백업 이후 추가된 데이터는 복원 시 사라지고, 이전 DB 는 별도 보존
    client.post("/api/v1/results/batch", json={"device_id": "HMD-01", "session_id": "SESSION-20261106-001",
                                               "results": [make_result(2)]}, headers=dev_headers)
    assert client.post("/api/v1/backups/restore", json={"file": b["file"]}).status_code == 400  # confirm 필요
    r = client.post("/api/v1/backups/restore", json={"file": b["file"], "confirm": True}).json()
    assert r["counts"]["mission_results"] == 1 and r["integrity"] == "ok"
    names = [x["file"] for x in client.get("/api/v1/backups").json()["items"]]
    assert r["previous_db_saved_as"] in names
    # 경로 조작 차단
    assert client.post("/api/v1/backups/verify", json={"file": "../test.db"}).status_code == 404


def test_tampered_backup_detected(client):
    b = client.post("/api/v1/backups").json()
    with open(b["path"], "ab") as f:
        f.write(b"tamper")
    v = client.post("/api/v1/backups/verify", json={"file": b["file"]}).json()
    assert v["checksum_ok"] is False and not v["ok"]
    assert client.post("/api/v1/backups/restore", json={"file": b["file"], "confirm": True}).status_code == 400


def test_data_survives_restart(client, dev_headers, setup_session):
    client.post("/api/v1/results/batch", json={"device_id": "HMD-01", "session_id": "SESSION-20261106-001",
                                               "results": [make_result(1)]}, headers=dev_headers)
    conn = sqlite3.connect(config.db_file)
    assert conn.execute("SELECT COUNT(*) FROM mission_results").fetchone()[0] == 1
    conn.close()


def test_logs(client):
    client.get("/api/v1/sessions/9999")
    j = client.get("/api/v1/logs/api_errors").json()
    assert j["total"] >= 1
    assert client.get("/api/v1/logs/audit").json()["total"] >= 1
