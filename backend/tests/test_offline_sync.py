"""시뮬레이터의 로컬 큐 + 서버 ACK 로 오프라인 복구 시나리오 검증."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "simulator"))

from hmd_simulator import LocalStore, VirtualHMD  # noqa: E402


class FlakyHttp:
    """첫 결과 업로드는 서버에 저장되지만 응답(ACK)이 유실되는 상황을 모사."""

    def __init__(self, client):
        self.client = client
        self.lose_next_result_ack = False

    def get(self, path, **kw):
        return self.client.get(path, **kw)

    def post(self, path, **kw):
        r = self.client.post(path, **kw)
        if self.lose_next_result_ack and path.endswith("/results/batch"):
            self.lose_next_result_ack = False
            raise ConnectionError("응답 유실")
        return r


def _hmd(client, tmp_path, device_id, http=None, offline=None):
    offline = offline if offline is not None else set()
    store = LocalStore(tmp_path / f"{device_id}.db")
    hmd = VirtualHMD(device_id, http or client, client.device_key, store, offline_check=lambda d: d in offline,
                     log=lambda *_: None)
    hmd.retry_base = 0
    return hmd, store, offline


def test_wifi_outage_then_recovery(client, setup_session, tmp_path):
    dev = setup_session["participants"][0]["device_id"]
    hmd, store, offline = _hmd(client, tmp_path, dev)
    hmd.refresh_assignment()
    assert hmd.assignment and hmd.assignment["session_status"] == "running"

    offline.add(dev)  # Wi-Fi 단절
    for i in range(5):
        hmd.record_result(f"M{i}", True, "2026-11-06T10:00:00+09:00")
    assert hmd.sync(force=True)["failed"]
    assert store.count("result", "pending") == 5          # 서버 없이도 결과 보존
    assert client.get("/api/v1/results").json()["total"] == 0

    offline.clear()  # 연결 복구
    hmd.batch_size = 2
    s = hmd.sync(force=True)
    assert s["accepted"] == 5 and not s["failed"]
    assert store.count("result", "pending") == 0 and store.count("result", "synced") == 5
    assert client.get("/api/v1/results").json()["total"] == 5

    hmd.heartbeat()
    un = client.get("/api/v1/results/unsynced").json()
    d = next(x for x in un["devices"] if x["device_id"] == dev)
    assert d["reported_pending_count"] == 0 and d["received_total"] == 5 and d["mismatch"] is False


def test_lost_ack_no_duplicates(client, setup_session, tmp_path):
    dev = setup_session["participants"][1]["device_id"]
    http = FlakyHttp(client)
    hmd, store, _ = _hmd(client, tmp_path, dev, http=http)
    hmd.refresh_assignment()
    for i in range(3):
        hmd.record_result(f"M{i}", i % 2 == 0, "2026-11-06T10:00:00+09:00")
    http.lose_next_result_ack = True
    assert hmd.sync(force=True)["failed"]
    assert store.count("result", "pending") == 3            # ACK 못 받음 → synced 아님
    assert client.get("/api/v1/results").json()["total"] == 3  # 서버엔 저장됨
    s = hmd.sync(force=True)                                 # 같은 event_id 로 재전송
    assert s["duplicates"] == 3 and s["accepted"] == 0
    assert store.count("result", "synced") == 3
    assert client.get("/api/v1/results").json()["total"] == 3  # 중복 저장 없음


def test_queue_survives_app_restart(client, setup_session, tmp_path):
    dev = setup_session["participants"][2]["device_id"]
    hmd, store, offline = _hmd(client, tmp_path, dev)
    hmd.refresh_assignment()
    offline.add(dev)
    hmd.record_result("M1", True, "2026-11-06T10:00:00+09:00")
    store.conn.close()
    # 앱 재실행: 새 인스턴스가 같은 로컬 DB 를 열어 배정·pending 큐 복원
    hmd2, store2, _ = _hmd(client, tmp_path, dev)
    assert hmd2.assignment["session_id"] == "SESSION-20261106-001"
    assert store2.count("result", "pending") == 1
    assert hmd2.sync(force=True)["accepted"] == 1


def test_full_content_flow(client, setup_session, tmp_path):
    dev = setup_session["participants"][3]["device_id"]
    hmd, store, _ = _hmd(client, tmp_path, dev)
    hmd.speed = 10_000
    hmd.refresh_assignment()
    for _ in range(30):
        hmd.step_content()
    assert hmd.mission_state.get("finished")
    hmd.sync(force=True)
    hmd.heartbeat()
    p = client.get(f"/api/v1/sessions/{setup_session['id']}/progress").json()
    item = next(i for i in p["items"] if i["device_id"] == dev)
    assert item["live_state"] == "completed" and item["result_count"] == 4 and item["upload_state"] == "synced"


def test_reconnect_resets_backoff(client, setup_session, tmp_path):
    """장시간 단절로 백오프가 최대치까지 늘어도, 연결 복구(heartbeat 성공) 즉시 재전송한다."""
    dev = setup_session["participants"][4]["device_id"]
    hmd, store, offline = _hmd(client, tmp_path, dev)
    hmd.retry_base, hmd.retry_max = 5, 300
    hmd.refresh_assignment()
    offline.add(dev)
    hmd.record_result("M1", True, "2026-11-06T10:00:00+09:00")
    for _ in range(10):
        hmd.sync(force=True)
    assert hmd.backoff == 300
    offline.clear()
    assert hmd.sync()["accepted"] == 0       # 아직 백오프 대기 중
    assert hmd.heartbeat()                    # 연결 복구 감지
    assert hmd.sync()["accepted"] == 1
