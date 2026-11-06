from app.db import db_session


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_requires_login(client):
    r = client.get("/api/v1/devices", headers={"Authorization": ""})
    assert r.status_code == 401


def test_login_lockout(client):
    for _ in range(4):
        assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "x"}).status_code == 401
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "x"}).status_code == 423
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "admin1234"}).status_code == 423


def test_password_not_plaintext_and_change(client):
    with db_session() as conn:
        h = conn.execute("SELECT password_hash FROM admin_users WHERE username='admin'").fetchone()[0]
    assert "admin1234" not in h and h.startswith("pbkdf2_sha256$")
    r = client.post("/api/v1/auth/change-password", json={"current_password": "admin1234", "new_password": "short"})
    assert r.status_code == 422
    r = client.post("/api/v1/auth/change-password", json={"current_password": "admin1234", "new_password": "newpass1234"})
    assert r.status_code == 200
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "newpass1234"}).status_code == 200


def test_roles(client):
    r = client.post("/api/v1/users", json={"username": "viewer1", "password": "viewpass1", "role": "viewer"})
    assert r.status_code == 201
    tok = client.post("/api/v1/auth/login", json={"username": "viewer1", "password": "viewpass1"}).json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    assert client.get("/api/v1/dashboard/summary", headers=h).status_code == 200
    assert client.post("/api/v1/devices", json={"device_id": "HMD-99"}, headers=h).status_code == 403
    assert client.patch("/api/v1/settings", json={"values": {"battery_warning_pct": 30}}, headers=h).status_code == 403
    # 감사 로그에 비밀번호가 남지 않음
    with db_session() as conn:
        rows = [r[0] or "" for r in conn.execute("SELECT detail_json FROM audit_logs").fetchall()]
    assert not any("viewpass1" in r for r in rows)


def test_last_admin_protected(client):
    assert client.patch("/api/v1/users/1", json={"role": "viewer"}).status_code == 400
