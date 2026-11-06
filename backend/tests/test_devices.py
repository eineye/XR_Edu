from datetime import datetime, timedelta, timezone

from app.db import db_session


def hb(device_id="HMD-01", **kw):
    body = {"device_id": device_id, "app_version": "1.0.0", "content_version": "2026.11", "app_status": "running",
            "battery_level": 82, "occurred_at": "2026-11-06T10:30:00+09:00"}
    body.update(kw)
    return body


def test_device_crud_and_validation(client):
    assert client.post("/api/v1/devices", json={"device_id": "HMD 01"}).status_code == 422
    assert client.post("/api/v1/devices", json={"device_id": "HMD-01", "device_name": "1번"}).status_code == 201
    assert client.post("/api/v1/devices", json={"device_id": "HMD-01"}).status_code == 409
    assert client.patch("/api/v1/devices/HMD-01", json={"active": False}).json()["active"] == 0
    d = client.get("/api/v1/devices").json()["items"][0]
    assert d["health"] == "inactive"


def test_heartbeat_20_devices(client, dev_headers):
    client.post("/api/v1/devices/bulk", json={"count": 20})
    for i in range(1, 21):
        r = client.post("/api/v1/devices/heartbeat", json=hb(f"HMD-{i:02d}"), headers=dev_headers)
        assert r.status_code == 200, r.text
        assert r.json()["heartbeat_interval_sec"] == 30
    s = client.get("/api/v1/dashboard/summary").json()
    assert s["devices"]["total"] == 20 and s["devices"]["online"] == 20 and s["devices"]["normal"] == 20


def test_heartbeat_requires_device_key(client):
    client.post("/api/v1/devices/bulk", json={"count": 1})
    assert client.post("/api/v1/devices/heartbeat", json=hb()).status_code == 401
    assert client.post("/api/v1/devices/heartbeat", json=hb(), headers={"X-Device-Key": "wrong"}).status_code == 401


def test_unknown_device_rejected(client, dev_headers):
    assert client.post("/api/v1/devices/heartbeat", json=hb("HMD-77"), headers=dev_headers).status_code == 404


def test_status_rules(client, dev_headers):
    client.post("/api/v1/devices/bulk", json={"count": 4})
    client.post("/api/v1/devices/heartbeat", json=hb("HMD-01", battery_level=None), headers=dev_headers)
    client.post("/api/v1/devices/heartbeat", json=hb("HMD-02", battery_level=10), headers=dev_headers)
    client.post("/api/v1/devices/heartbeat", json=hb("HMD-03", app_status="error", error_code="E100"), headers=dev_headers)
    old = (datetime.now(timezone.utc) - timedelta(seconds=600)).isoformat()
    with db_session() as conn:
        conn.execute("UPDATE devices SET last_seen_at=? WHERE device_id='HMD-04'", (old,))
        conn.commit()
    items = {d["device_id"]: d for d in client.get("/api/v1/devices").json()["items"]}
    assert items["HMD-01"]["health"] == "normal"       # 배터리 미지원 장비는 저배터리 아님
    assert items["HMD-01"]["battery_level"] is None
    assert items["HMD-02"]["health"] == "warning"
    assert items["HMD-03"]["health"] == "error"
    assert items["HMD-04"]["health"] == "offline"
    assert items["HMD-04"]["connection_status"] == "offline"


def test_resync_command_delivered_via_heartbeat(client, dev_headers):
    client.post("/api/v1/devices/bulk", json={"count": 1})
    assert client.post("/api/v1/devices/HMD-01/resync").status_code == 200
    r = client.post("/api/v1/devices/heartbeat", json=hb(), headers=dev_headers).json()
    assert r["commands"][0]["command"] == "resync"
    assert client.post("/api/v1/devices/heartbeat", json=hb(), headers=dev_headers).json()["commands"] == []


def test_csv_export(client):
    client.post("/api/v1/devices/bulk", json={"count": 3})
    r = client.get("/api/v1/devices/export.csv")
    assert r.status_code == 200 and "HMD-03" in r.text and "확인불가" in r.text
