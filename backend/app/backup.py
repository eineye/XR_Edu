"""DB 백업·무결성 확인·복원."""
from __future__ import annotations

import hashlib
import os
import sqlite3
from datetime import datetime
from pathlib import Path

from .config import config
from .db import connect, get_settings
from .timeutil import local_tz, now_iso

TABLES = ("devices", "sessions", "participants", "contents", "mission_results", "device_events", "admin_users")


def backup_dir(conn: sqlite3.Connection) -> Path:
    s = get_settings(conn)
    p = Path(str(s["backup_dir"])) if s["backup_dir"] else config.default_backup_dir
    p.mkdir(parents=True, exist_ok=True)
    return p


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _restrict(path: Path) -> None:
    try:
        os.chmod(path, 0o600)  # 백업 파일 접근 권한 제한 (Windows 에서는 무시될 수 있음)
    except OSError:
        pass


def _record(conn, action, trigger, path, size, sha, result, message):
    conn.execute(
        "INSERT INTO backup_history(action, trigger, file_path, size_bytes, sha256, result, message, created_at)"
        " VALUES (?,?,?,?,?,?,?,?)", (action, trigger, str(path) if path else None, size, sha, result, message, now_iso()))
    conn.commit()


def inspect_db(path: Path) -> dict:
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        integrity = c.execute("PRAGMA integrity_check").fetchone()[0]
        counts = {}
        for t in TABLES:
            try:
                counts[t] = c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            except sqlite3.Error:
                counts[t] = None
        return {"integrity": integrity, "counts": counts}
    finally:
        c.close()


def create_backup(conn: sqlite3.Connection, trigger: str = "manual") -> dict:
    bdir = backup_dir(conn)
    stamp = datetime.now(local_tz()).strftime("%Y%m%d_%H%M%S")
    path = bdir / f"mr_edu_{stamp}_{trigger}.db"
    n = 1
    while path.exists():
        path = bdir / f"mr_edu_{stamp}_{trigger}_{n}.db"; n += 1
    dst = sqlite3.connect(path)
    try:
        conn.backup(dst)
    finally:
        dst.close()
    _restrict(path)
    sha = sha256_of(path)
    Path(str(path) + ".sha256").write_text(f"{sha}  {path.name}\n", encoding="utf-8")
    info = inspect_db(path)
    ok = info["integrity"] == "ok"
    _record(conn, "backup", trigger, path, path.stat().st_size, sha, "success" if ok else "failed",
            None if ok else f"integrity_check: {info['integrity']}")
    return {"file": path.name, "path": str(path), "size_bytes": path.stat().st_size, "sha256": sha, **info}


def list_backups(conn: sqlite3.Connection) -> list[dict]:
    bdir = backup_dir(conn)
    out = []
    for p in sorted(bdir.glob("*.db"), key=lambda x: x.stat().st_mtime, reverse=True):
        sha_file = Path(str(p) + ".sha256")
        out.append({
            "file": p.name, "path": str(p), "size_bytes": p.stat().st_size,
            "modified_at": datetime.fromtimestamp(p.stat().st_mtime, local_tz()).isoformat(timespec="seconds"),
            "has_checksum": sha_file.exists(),
        })
    return out


def resolve_backup(conn: sqlite3.Connection, file_name: str) -> Path:
    bdir = backup_dir(conn).resolve()
    p = (bdir / file_name).resolve()
    if p.parent != bdir or p.suffix != ".db" or not p.exists():
        raise FileNotFoundError(file_name)
    return p


def verify_backup(conn: sqlite3.Connection, file_name: str, record: bool = True) -> dict:
    p = resolve_backup(conn, file_name)
    sha = sha256_of(p)
    sha_file = Path(str(p) + ".sha256")
    expected = sha_file.read_text(encoding="utf-8").split()[0] if sha_file.exists() else None
    info = inspect_db(p)
    checksum_ok = None if expected is None else (expected == sha)
    ok = info["integrity"] == "ok" and checksum_ok is not False
    if record:
        _record(conn, "verify", "manual", p, p.stat().st_size, sha, "success" if ok else "failed",
                f"integrity={info['integrity']}, checksum={'없음' if checksum_ok is None else checksum_ok}")
    return {"file": p.name, "ok": ok, "sha256": sha, "expected_sha256": expected, "checksum_ok": checksum_ok, **info}


def restore_backup(conn: sqlite3.Connection, file_name: str) -> dict:
    """복원 전: 무결성 확인 → 현재 DB를 pre_restore 백업으로 별도 보존 → 복원."""
    check = verify_backup(conn, file_name, record=False)
    if not check["ok"]:
        raise ValueError("백업 파일 무결성 확인에 실패하여 복원을 중단했습니다")
    pre = create_backup(conn, "pre_restore")
    src = sqlite3.connect(f"file:{resolve_backup(conn, file_name)}?mode=ro", uri=True)
    try:
        src.backup(conn)
    finally:
        src.close()
    after = inspect_db(config.db_file)
    _record(conn, "restore", "manual", resolve_backup(conn, file_name), None, check["sha256"], "success",
            f"이전 DB 보존: {pre['file']}")
    return {"restored_from": file_name, "previous_db_saved_as": pre["file"], "counts": after["counts"],
            "integrity": after["integrity"]}


def prune_auto_backups(conn: sqlite3.Connection, keep: int) -> int:
    files = sorted(backup_dir(conn).glob("*_auto*.db"), key=lambda x: x.stat().st_mtime, reverse=True)
    removed = 0
    for p in files[keep:]:
        p.unlink(missing_ok=True)
        Path(str(p) + ".sha256").unlink(missing_ok=True)
        removed += 1
    return removed


def has_auto_backup_today(conn: sqlite3.Connection) -> bool:
    today = datetime.now(local_tz()).strftime("%Y%m%d")
    return any(backup_dir(conn).glob(f"mr_edu_{today}_*_auto*.db"))
