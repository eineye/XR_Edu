"""데모용 콘텐츠 메타데이터. 실제 운영 데이터가 아니며 화면에 '데모'로 표시된다."""
from __future__ import annotations

from .timeutil import now_iso

DEMO_CONTENTS = [
    ("SAFETY-01", "산업 현장 안전 — 지게차 위험 요소 찾기", "safety", "1.0.0",
     ["FORKLIFT-HAZARD-01", "FORKLIFT-HAZARD-02", "PPE-CHECK-01", "EVAC-ROUTE-01"]),
    ("CAREER-01", "미래 직업 체험 — 드론 정비사", "career", "1.0.0",
     ["DRONE-PARTS-01", "DRONE-PARTS-02", "DRONE-FLIGHT-01"]),
    ("ENV-01", "환경 — 분리배출 미션", "environment", "1.0.0",
     ["RECYCLE-01", "RECYCLE-02", "RECYCLE-03", "RECYCLE-04", "RECYCLE-05"]),
]


def seed_demo_contents(conn) -> int:
    now, n = now_iso(), 0
    for cid, title, cat, ver, missions in DEMO_CONTENTS:
        cur = conn.execute(
            "INSERT OR IGNORE INTO contents(content_id, title, category, description, version, package_name,"
            " supported_models, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (cid, title, cat, f"[데모] 미션: {', '.join(missions)}", ver, f"com.mredu.{cid.lower()}.apk",
             "Meta Quest 3", now, now))
        if cur.rowcount:
            conn.execute("INSERT OR IGNORE INTO content_versions(content_id, version, release_notes, created_at)"
                         " VALUES (?,?,?,?)", (cid, ver, "[데모] 최초 등록", now))
            n += 1
    conn.commit()
    return n
