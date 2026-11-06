"""가상 HMD 시뮬레이터 (실제 Meta Quest 3 없이 관리자 기능을 시험하기 위한 도구).

HMD 앱 연동 규격(설계서 9장)을 그대로 따른다.
  1. 미션 결과 발생 즉시 로컬 DB(SQLite)에 pending 으로 저장
  2. /health 확인 후 연결되면 pending 을 batch 업로드
  3. ACK(accepted/duplicates)에 포함된 항목만 synced 로 변경, rejected 는 사유와 함께 보존
  4. 실패 시 지수형 백오프로 재시도, 재실행 후에도 큐 복원, 재전송 시 같은 event_id 사용
  5. 결과는 삭제하지 않는다

사용 예)
  python simulator/hmd_simulator.py --server http://127.0.0.1:8000 --key <장비키> --devices 20
  python simulator/hmd_simulator.py --key <장비키> --drop-rate 0.2 --no-battery HMD-05,HMD-06

실행 중 Wi-Fi 단절 시험: simulator/data/offline.txt 에 장비 ID(줄 단위, 또는 ALL)를 적으면
해당 장비는 서버와 통신하지 못하는 상태가 되고, 지우면 복구된다.
"""
from __future__ import annotations

import argparse
import json
import random
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

KST = timezone(timedelta(hours=9))
DATA_DIR = Path(__file__).resolve().parent / "data"

DEFAULT_MISSIONS = {
    "SAFETY-01": ["FORKLIFT-HAZARD-01", "FORKLIFT-HAZARD-02", "PPE-CHECK-01", "EVAC-ROUTE-01"],
    "CAREER-01": ["DRONE-PARTS-01", "DRONE-PARTS-02", "DRONE-FLIGHT-01"],
    "ENV-01": ["RECYCLE-01", "RECYCLE-02", "RECYCLE-03", "RECYCLE-04", "RECYCLE-05"],
}


class NetworkDown(Exception):
    pass


def now_kst() -> str:
    return datetime.now(KST).replace(microsecond=0).isoformat()


class LocalStore:
    """HMD 로컬 DB. 앱 재실행 후에도 pending 큐가 유지된다."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS outbox (
                event_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL CHECK (kind IN ('result','event')),
                session_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','synced','rejected')),
                reject_reason TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                synced_at TEXT
            );
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
        """)
        self.conn.commit()

    def add(self, kind: str, session_id: str, payload: dict) -> None:
        with self.lock:
            self.conn.execute("INSERT INTO outbox(event_id, kind, session_id, payload, created_at) VALUES (?,?,?,?,?)",
                              (payload["event_id"], kind, session_id, json.dumps(payload, ensure_ascii=False), now_kst()))
            self.conn.commit()

    def pending(self, kind: str, limit: int) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute("SELECT * FROM outbox WHERE kind=? AND status='pending' ORDER BY created_at LIMIT ?",
                                     (kind, limit)).fetchall()

    def mark(self, event_ids: list[str], status: str, reason: str | None = None) -> None:
        if not event_ids:
            return
        with self.lock:
            self.conn.executemany("UPDATE outbox SET status=?, reject_reason=?, synced_at=? WHERE event_id=?",
                                  [(status, reason, now_kst(), e) for e in event_ids])
            self.conn.commit()

    def bump_attempts(self, event_ids: list[str]) -> None:
        with self.lock:
            self.conn.executemany("UPDATE outbox SET attempts=attempts+1 WHERE event_id=?", [(e,) for e in event_ids])
            self.conn.commit()

    def count(self, kind: str, status: str) -> int:
        with self.lock:
            return self.conn.execute("SELECT COUNT(*) FROM outbox WHERE kind=? AND status=?", (kind, status)).fetchone()[0]

    def get_meta(self, k: str, default=None):
        with self.lock:
            r = self.conn.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return json.loads(r[0]) if r else default

    def set_meta(self, k: str, v) -> None:
        with self.lock:
            self.conn.execute("INSERT OR REPLACE INTO meta(k, v) VALUES (?,?)", (k, json.dumps(v)))
            self.conn.commit()


class VirtualHMD:
    def __init__(self, device_id: str, http, key: str, store: LocalStore, *, battery_supported: bool = True,
                 drop_rate: float = 0.0, speed: float = 1.0, offline_check=None, log=print):
        self.device_id = device_id
        self.http = http
        self.headers = {"X-Device-Key": key}
        self.store = store
        self.battery = random.randint(60, 100) if battery_supported else None
        self.drop_rate = drop_rate
        self.speed = speed
        self.offline_check = offline_check or (lambda _d: False)
        self.log = log
        self.interval = 30
        self.batch_size = 50
        self.retry_base = 5.0
        self.retry_max = 300.0
        self.backoff = 0.0
        self.next_sync_at = 0.0
        self.app_status = "idle"
        self.assignment: dict | None = store.get_meta("assignment")
        self.mission_state = store.get_meta("mission_state", {})

    # ---------- 통신 ----------
    def _request(self, method: str, path: str, **kw):
        if self.offline_check(self.device_id) or (self.drop_rate and random.random() < self.drop_rate):
            raise NetworkDown("simulated network down")
        try:
            r = getattr(self.http, method)(path, headers=self.headers, timeout=10, **kw)
        except Exception as e:  # noqa: BLE001  (연결 실패 등)
            raise NetworkDown(str(e))
        return r

    def server_ok(self) -> bool:
        try:
            return self._request("get", "/health").status_code == 200
        except NetworkDown:
            return False

    def heartbeat(self) -> bool:
        if self.battery is not None:
            self.battery = max(0, self.battery - random.choice([0, 0, 1]))
        body = {
            "device_id": self.device_id, "app_version": "1.0.0", "content_version": "2026.11",
            "app_status": self.app_status, "battery_level": self.battery,
            "storage_available": None,  # 실제 기기에서 확인 불가 항목은 null
            "pending_count": self.store.count("result", "pending"),
            "sent_total": self.store.count("result", "synced"),
            "session_id": (self.assignment or {}).get("session_id"),
            "installed_contents": [{"content_id": c, "version": "1.0.0"} for c in DEFAULT_MISSIONS],
            "simulated": True, "occurred_at": now_kst(),
        }
        try:
            r = self._request("post", "/api/v1/devices/heartbeat", json=body)
        except NetworkDown:
            return False
        if r.status_code != 200:
            self.log(f"[{self.device_id}] heartbeat 거부 {r.status_code}: {r.text[:120]}")
            return False
        j = r.json()
        self.interval = j.get("heartbeat_interval_sec", self.interval)
        sync = j.get("sync", {})
        self.batch_size = sync.get("batch_size", self.batch_size)
        self.retry_base = sync.get("retry_base_sec", self.retry_base)
        self.retry_max = sync.get("retry_max_sec", self.retry_max)
        for cmd in j.get("commands", []):
            if cmd["command"] == "resync":
                self.log(f"[{self.device_id}] 관리자 재전송 요청 수신 → 즉시 동기화")
                self.backoff, self.next_sync_at = 0.0, 0.0
        return True

    def refresh_assignment(self) -> None:
        try:
            r = self._request("get", f"/api/v1/devices/{self.device_id}/assignment")
        except NetworkDown:
            return  # 오프라인: 마지막으로 받은 배정 정보로 계속 교육 진행
        if r.status_code == 200:
            j = r.json()
            new = j if j.get("assigned") else None
            if (new or {}).get("session_id") != (self.assignment or {}).get("session_id"):
                self.mission_state = {}
                self.store.set_meta("mission_state", {})
            self.assignment = new
            self.store.set_meta("assignment", new)

    def sync(self, force: bool = False) -> dict:
        """pending 결과/이벤트 업로드. ACK 받은 항목만 synced."""
        stats = {"accepted": 0, "duplicates": 0, "rejected": 0, "failed": False}
        if not force and time.monotonic() < self.next_sync_at:
            return stats
        if not self.server_ok():
            self._fail()
            stats["failed"] = True
            return stats
        for kind, path in (("event", "/api/v1/events"), ("result", "/api/v1/results/batch")):
            while True:
                rows = self.store.pending(kind, self.batch_size)
                if not rows:
                    break
                by_session: dict[str, list] = {}
                for r in rows:
                    by_session.setdefault(r["session_id"], []).append(json.loads(r["payload"]))
                for session_id, items in by_session.items():
                    ids = [i["event_id"] for i in items]
                    self.store.bump_attempts(ids)
                    body = ({"device_id": self.device_id, "events": items} if kind == "event" else
                            {"device_id": self.device_id, "session_id": session_id, "results": items})
                    try:
                        resp = self._request("post", path, json=body)
                    except NetworkDown:
                        self._fail(); stats["failed"] = True
                        return stats
                    if resp.status_code != 200:
                        self.log(f"[{self.device_id}] 업로드 실패 {resp.status_code} → 재시도 예정")
                        self._fail(); stats["failed"] = True
                        return stats
                    ack = resp.json()
                    self.store.mark(ack.get("accepted", []) + ack.get("duplicates", []), "synced")
                    for rej in ack.get("rejected", []):
                        if rej.get("event_id"):
                            self.store.mark([rej["event_id"]], "rejected", rej.get("reason"))
                    if kind == "result":
                        stats["accepted"] += len(ack.get("accepted", []))
                        stats["duplicates"] += len(ack.get("duplicates", []))
                        stats["rejected"] += len(ack.get("rejected", []))
                    # ACK 에 없는 항목은 pending 유지 (다음 주기에 같은 event_id 로 재전송)
                    acked = set(ack.get("accepted", [])) | set(ack.get("duplicates", [])) | \
                        {x.get("event_id") for x in ack.get("rejected", [])}
                    if not acked & set(ids):
                        self._fail(); stats["failed"] = True
                        return stats
        self.backoff = 0.0
        self.next_sync_at = 0.0
        return stats

    def _fail(self) -> None:
        self.backoff = min(self.retry_max, max(self.retry_base, self.backoff * 2 or self.retry_base))
        self.next_sync_at = time.monotonic() + self.backoff * random.uniform(0.8, 1.2)

    # ---------- 교육 콘텐츠 시뮬레이션 (서버 없이도 동작) ----------
    def _event(self, event_type: str, **extra) -> None:
        a = self.assignment
        payload = {"event_id": f"{self.device_id}-evt-{uuid.uuid4()}", "event_type": event_type,
                   "session_id": a["session_id"], "student_code": a["student_code"],
                   "content_id": (a.get("content") or {}).get("content_id"), "occurred_at": now_kst(), **extra}
        self.store.add("event", a["session_id"], payload)

    def record_result(self, mission_id: str, correct: bool, started: str) -> dict:
        a = self.assignment
        content = a.get("content") or {}
        result = {
            "result_id": f"{self.device_id}-res-{uuid.uuid4()}",
            "event_id": f"{self.device_id}-evt-{uuid.uuid4()}",
            "student_code": a["student_code"], "content_id": content.get("content_id", "UNKNOWN"),
            "content_version": content.get("version"), "mission_id": mission_id,
            "answer": random.choice(["A", "B", "C", "D"]) if not correct else "B",
            "is_correct": correct, "score": 100 if correct else random.choice([0, 30, 50]),
            "attempt_count": 1 if correct else random.randint(1, 3),
            "duration_seconds": random.randint(15, 90), "started_at": started, "completed_at": now_kst(),
            "occurred_at": now_kst(),
        }
        self.store.add("result", a["session_id"], result)  # 서버 연결과 무관하게 즉시 로컬 저장
        return result

    def step_content(self) -> None:
        a = self.assignment
        if not a or a.get("session_status") != "running":
            self.app_status = "idle"
            return
        self.app_status = "running"
        cid = (a.get("content") or {}).get("content_id")
        missions = DEFAULT_MISSIONS.get(cid, ["MISSION-01", "MISSION-02", "MISSION-03"])
        st = self.mission_state
        if st.get("finished"):
            self.app_status = "idle"
            return
        if not st.get("joined"):
            self._event("session.joined", progress=0.0)
            st.update(joined=True, idx=0, mission_started=None)
        idx = st["idx"]
        if idx >= len(missions):
            self._event("session.finished", progress=1.0)
            st["finished"] = True
        elif st.get("mission_started") is None:
            st["mission_started"] = now_kst()
            st["mission_due"] = time.time() + random.uniform(8, 25) / self.speed
            self._event("mission.started", mission_id=missions[idx], step=f"{idx + 1}/{len(missions)}",
                        progress=round(idx / len(missions), 3))
        elif time.time() >= st["mission_due"]:
            self.record_result(missions[idx], random.random() < 0.7, st["mission_started"])
            st["idx"] = idx + 1
            st["mission_started"] = None
            self._event("mission.completed", mission_id=missions[idx], step=f"{idx + 1}/{len(missions)}",
                        progress=round((idx + 1) / len(missions), 3))
        self.mission_state = st
        self.store.set_meta("mission_state", st)

    def run(self, stop: threading.Event) -> None:
        last_hb = 0.0
        last_assign = 0.0
        time.sleep(random.uniform(0, 3))
        while not stop.is_set():
            t = time.monotonic()
            if t - last_hb >= self.interval / self.speed:
                self.heartbeat(); last_hb = t
            if t - last_assign >= 10 / self.speed:
                self.refresh_assignment(); last_assign = t
            self.step_content()
            s = self.sync()
            if s["accepted"] or s["rejected"]:
                self.log(f"[{self.device_id}] 업로드 accepted={s['accepted']} dup={s['duplicates']}"
                         f" rejected={s['rejected']} pending={self.store.count('result', 'pending')}")
            stop.wait(1.0)


def main() -> None:
    import httpx

    ap = argparse.ArgumentParser(description="MR EDU MOBILE 2.0 가상 HMD 시뮬레이터")
    ap.add_argument("--server", default="http://127.0.0.1:8000")
    ap.add_argument("--key", required=True, help="장비 키 (backend 에서 python -m app.cli device-key)")
    ap.add_argument("--devices", type=int, default=20)
    ap.add_argument("--prefix", default="HMD-")
    ap.add_argument("--drop-rate", type=float, default=0.0, help="요청 실패 확률 (0~1), 불안정 Wi-Fi 모사")
    ap.add_argument("--no-battery", default="", help="배터리 미지원으로 보고할 장비 (쉼표 구분)")
    ap.add_argument("--speed", type=float, default=1.0, help="시간 배속 (2 = 2배 빠르게)")
    ap.add_argument("--reset", action="store_true", help="시뮬레이터 로컬 DB 초기화")
    args = ap.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    offline_file = DATA_DIR / "offline.txt"

    def offline_check(device_id: str) -> bool:
        try:
            ids = {l.strip() for l in offline_file.read_text(encoding="utf-8").splitlines() if l.strip()}
        except FileNotFoundError:
            return False
        return "ALL" in ids or device_id in ids

    no_batt = {x.strip() for x in args.no_battery.split(",") if x.strip()}
    lock = threading.Lock()

    def log(msg):
        with lock:
            print(datetime.now(KST).strftime("%H:%M:%S"), msg, flush=True)

    http = httpx.Client(base_url=args.server)
    stop = threading.Event()
    threads = []
    for i in range(1, args.devices + 1):
        did = f"{args.prefix}{i:02d}"
        db = DATA_DIR / f"{did}.db"
        if args.reset:
            db.unlink(missing_ok=True)
        hmd = VirtualHMD(did, http, args.key, LocalStore(db), battery_supported=did not in no_batt,
                         drop_rate=args.drop_rate, speed=args.speed, offline_check=offline_check, log=log)
        th = threading.Thread(target=hmd.run, args=(stop,), daemon=True, name=did)
        th.start()
        threads.append(th)
    log(f"가상 HMD {args.devices}대 시작 → {args.server}  (단절 시험: {offline_file})  Ctrl+C 로 종료")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log("종료 중... (로컬 pending 큐는 보존되어 다음 실행 시 재전송)")
        stop.set()
        for th in threads:
            th.join(timeout=3)


if __name__ == "__main__":
    main()
