import os
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
_tmp = tempfile.mkdtemp(prefix="mredu_test_")
os.environ["MR_EDU_DB_PATH"] = os.path.join(_tmp, "init.db")
os.environ["MR_EDU_SECRET_KEY"] = "test-secret-key-for-unit-tests-only-0123456789"

from fastapi.testclient import TestClient  # noqa: E402

from app.config import config  # noqa: E402
from app.db import db_session, get_settings, init_db  # noqa: E402
from app.demo import seed_demo_contents  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client(tmp_path):
    config.db_path = str(tmp_path / "test.db")
    config.backup_dir = str(tmp_path / "backups")
    init_db()
    with db_session() as conn:
        conn.execute("UPDATE system_settings SET value=? WHERE key='backup_dir'", (str(tmp_path / "backups"),))
        conn.execute("UPDATE system_settings SET value='false' WHERE key='auto_backup_enabled'")
        conn.commit()
    with TestClient(app) as c:
        r = c.post("/api/v1/auth/login", json={"username": "admin", "password": "admin1234"})
        assert r.status_code == 200, r.text
        c.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
        with db_session() as conn:
            c.device_key = get_settings(conn)["device_api_key"]
        yield c


@pytest.fixture()
def dev_headers(client):
    return {"X-Device-Key": client.device_key}


@pytest.fixture()
def setup_session(client, dev_headers):
    """장비 20대 + 데모 콘텐츠 + 학생 20명 배정된 진행 중 세션."""
    assert client.post("/api/v1/devices/bulk", json={"count": 20}).status_code == 201
    with db_session() as conn:
        seed_demo_contents(conn)
    parts = [{"student_code": f"S{i:03d}"} for i in range(1, 21)]
    r = client.post("/api/v1/sessions", json={
        "institution_name": "테스트초등학교", "session_date": "2026-11-06", "grade": "5", "class_group": "2",
        "session_no": 1, "content_id": "SAFETY-01", "expected_students": 20, "participants": parts})
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    r = client.post(f"/api/v1/sessions/{sid}/auto-assign")
    assert r.status_code == 200 and len(r.json()["assigned"]) == 20
    r = client.post(f"/api/v1/sessions/{sid}/start")
    assert r.status_code == 200, r.text
    return r.json()


def make_result(i, student="S001", mission="FORKLIFT-HAZARD-01", correct=True):
    return {"result_id": f"res-{i}", "event_id": f"evt-{i}", "student_code": student, "content_id": "SAFETY-01",
            "content_version": "1.0.0", "mission_id": mission, "answer": "B", "is_correct": correct,
            "score": 100 if correct else 0, "attempt_count": 1, "duration_seconds": 42,
            "occurred_at": "2026-11-06T10:28:10+09:00"}
