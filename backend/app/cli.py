"""관리 명령. 예) python -m app.cli init-db / seed-devices / device-key / reset-password admin / backup / restore <파일>"""
from __future__ import annotations

import argparse
import getpass
import sys

from . import backup as bk
from .config import config
from .db import db_session, get_settings, init_db
from .security import hash_password, validate_password_policy
from .timeutil import now_iso


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m app.cli", description="MR EDU MOBILE 2.0 관리 명령")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init-db", help="DB 생성/스키마 적용 (기존 데이터 유지)")
    sd = sub.add_parser("seed-devices", help="HMD-01 ~ HMD-NN 장비 등록")
    sd.add_argument("--count", type=int, default=20)
    sd.add_argument("--prefix", default="HMD-")
    sub.add_parser("seed-demo", help="데모 콘텐츠 등록 (데모 모드 표시)")
    sub.add_parser("device-key", help="HMD 공용 장비 키 출력")
    rp = sub.add_parser("reset-password", help="관리자 비밀번호 재설정 (잠금 해제 포함)")
    rp.add_argument("username")
    sub.add_parser("backup", help="수동 백업")
    sub.add_parser("list-backups", help="백업 목록")
    rs = sub.add_parser("restore", help="백업 복원 (현재 DB 는 pre_restore 로 보존)")
    rs.add_argument("file", help="백업 폴더 안의 파일명")
    rs.add_argument("--yes", action="store_true")
    a = p.parse_args(argv)

    init_db()
    with db_session() as conn:
        if a.cmd == "init-db":
            print(f"DB 준비 완료: {config.db_file}")
            print("기본 관리자: admin / admin1234 (최초 로그인 후 변경 필요)")
        elif a.cmd == "seed-devices":
            now, made = now_iso(), 0
            for i in range(1, a.count + 1):
                cur = conn.execute("INSERT OR IGNORE INTO devices(device_id, model, created_at, updated_at) VALUES (?,?,?,?)",
                                   (f"{a.prefix}{i:02d}", "Meta Quest 3", now, now))
                made += cur.rowcount
            conn.commit()
            print(f"장비 {made}대 등록 (기존 장비 유지)")
        elif a.cmd == "seed-demo":
            from .demo import seed_demo_contents
            print(f"데모 콘텐츠 {seed_demo_contents(conn)}건 등록")
        elif a.cmd == "device-key":
            print(get_settings(conn)["device_api_key"])
        elif a.cmd == "reset-password":
            pw = getpass.getpass("새 비밀번호: ")
            try:
                validate_password_policy(pw)
            except Exception as e:  # noqa: BLE001
                print(getattr(e, "detail", e)); return 1
            cur = conn.execute("UPDATE admin_users SET password_hash=?, failed_attempts=0, locked_until=NULL,"
                               " must_change_password=1, active=1 WHERE username=?", (hash_password(pw), a.username))
            conn.commit()
            print("변경 완료" if cur.rowcount else "사용자를 찾을 수 없습니다")
        elif a.cmd == "backup":
            r = bk.create_backup(conn, "manual")
            print(f"백업 완료: {r['path']}\nSHA-256: {r['sha256']}\n무결성: {r['integrity']}")
        elif a.cmd == "list-backups":
            for b in bk.list_backups(conn):
                print(f"{b['file']}\t{b['size_bytes']} bytes\t{b['modified_at']}")
        elif a.cmd == "restore":
            if not a.yes and input(f"{a.file} 로 복원합니다. 계속할까요? (yes/no) ") != "yes":
                print("취소"); return 1
            r = bk.restore_backup(conn, a.file)
            print(f"복원 완료. 이전 DB 보존: {r['previous_db_saved_as']}\n건수: {r['counts']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
