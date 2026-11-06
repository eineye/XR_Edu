"""웹 데모 모드 (MR_EDU_DEMO=1).

서버 시작 시 장비 20대·데모 콘텐츠·진행 중 데모 세션을 준비하고, 가상 HMD 20대를 서버 내부에서
실행한다. 실제 Quest 없이 웹 주소만으로 전체 기능을 시험하기 위한 기능이며, 화면에는 '데모 모드'로 표시된다.
현장 운영 환경에서는 사용하지 않는다.
"""
from __future__ import annotations

import logging
import os
import sys
import threading
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .config import ROOT_DIR, config
from .db import db_session, get_settings
from .demo import seed_demo_contents
from .security import any_user, operator_user
from .timeutil import now_iso

log = logging.getLogger("mr_edu.demo")

ENABLED = os.environ.get("MR_EDU_DEMO", "").lower() in ("1", "true", "yes", "on")
DEVICE_COUNT = int(os.environ.get("MR_EDU_DEMO_DEVICES", "20"))
SPEED = float(os.environ.get("MR_EDU_DEMO_SPEED", "3"))
NO_BATTERY = {"HMD-05", "HMD-06"}

_offline: set[str] = set()
_stop = threading.Event()
_threads: list[threading.Thread] = []


def seed() -> None:
    with db_session() as conn:
        now = now_iso()
        for i in range(1, DEVICE_COUNT + 1):
            conn.execute("INSERT OR IGNORE INTO devices(device_id, model, created_at, updated_at) VALUES (?,?,?,?)",
                         (f"HMD-{i:02d}", "Meta Quest 3", now, now))
        conn.commit()
        seed_demo_contents(conn)
        if conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0:
            today = date.today().isoformat()
            code = f"SESSION-{today.replace('-', '')}-001"
            cur = conn.execute(
                "INSERT INTO sessions(session_code, institution_name, grade, class_group, session_no, session_date, topic,"
                " content_id, instructor, expected_students, memo, status, started_at, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?)",
                (code, "[데모] 한빛초등학교", "5", "2", 1, today, "산업 안전 체험", "SAFETY-01", "데모 강사",
                 DEVICE_COUNT, "웹 데모용으로 자동 생성된 세션입니다", now, now, now))
            conn.executemany(
                "INSERT INTO participants(session_id, student_code, device_id, created_at) VALUES (?,?,?,?)",
                [(cur.lastrowid, f"S{i:03d}", f"HMD-{i:02d}", now) for i in range(1, DEVICE_COUNT + 1)])
            conn.commit()


def start() -> None:
    if not ENABLED:
        return
    seed()
    sys.path.insert(0, str(ROOT_DIR / "simulator"))
    import httpx
    from hmd_simulator import LocalStore, VirtualHMD

    with db_session() as conn:
        key = str(get_settings(conn)["device_api_key"])
    data_dir = config.db_file.parent / "demo_hmd"
    data_dir.mkdir(parents=True, exist_ok=True)
    http = httpx.Client(base_url=f"http://127.0.0.1:{config.port}")
    for i in range(1, DEVICE_COUNT + 1):
        did = f"HMD-{i:02d}"
        hmd = VirtualHMD(did, http, key, LocalStore(data_dir / f"{did}.db"), battery_supported=did not in NO_BATTERY,
                         drop_rate=0.05, speed=SPEED, offline_check=lambda d: d in _offline,
                         log=lambda m: log.info(m))
        t = threading.Thread(target=hmd.run, args=(_stop,), daemon=True, name=f"demo-{did}")
        t.start()
        _threads.append(t)
    log.info("데모 모드: 가상 HMD %d대 시작 (배속 %.1f)", DEVICE_COUNT, SPEED)


def stop() -> None:
    _stop.set()


router = APIRouter(prefix="/api/v1/demo", tags=["demo"])


class NetworkIn(BaseModel):
    device_ids: list[str]
    offline: bool


@router.get("/status")
def status(user: dict = Depends(any_user)):
    return {"enabled": ENABLED, "offline": sorted(_offline), "speed": SPEED}


@router.post("/network")
def set_network(body: NetworkIn, user: dict = Depends(operator_user)):
    """가상 HMD의 Wi-Fi 단절/복구를 흉내 낸다 (데모 모드 전용)."""
    if not ENABLED:
        raise HTTPException(404, "데모 모드가 아닙니다")
    for d in body.device_ids:
        (_offline.add if body.offline else _offline.discard)(d)
    return {"offline": sorted(_offline)}
