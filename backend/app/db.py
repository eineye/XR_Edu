"""SQLite 연결·스키마·기본 데이터."""
from __future__ import annotations

import secrets
import sqlite3
from contextlib import contextmanager
from typing import Iterator

from .config import config
from .timeutil import now_iso

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL UNIQUE,
    device_name TEXT,
    model TEXT NOT NULL DEFAULT 'Meta Quest 3',
    app_version TEXT,
    content_version TEXT,
    last_seen_at TEXT,
    last_sync_at TEXT,
    connection_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (connection_status IN ('online','offline','unknown')),
    app_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (app_status IN ('running','idle','error','unknown')),
    battery_level INTEGER,
    storage_available INTEGER,
    last_error_code TEXT,
    last_error_at TEXT,
    reported_pending_count INTEGER,
    reported_sent_total INTEGER,
    is_simulated INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('career','safety','environment')),
    description TEXT,
    version TEXT NOT NULL,
    package_name TEXT,
    package_size INTEGER,
    supported_models TEXT NOT NULL DEFAULT 'Meta Quest 3',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id TEXT NOT NULL REFERENCES contents(content_id) ON UPDATE CASCADE,
    version TEXT NOT NULL,
    package_name TEXT,
    package_size INTEGER,
    release_notes TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (content_id, version)
);

CREATE TABLE IF NOT EXISTS content_installs (
    device_id TEXT NOT NULL REFERENCES devices(device_id),
    content_id TEXT NOT NULL,
    version TEXT,
    source TEXT NOT NULL DEFAULT 'reported' CHECK (source IN ('reported','manual')),
    status TEXT NOT NULL DEFAULT 'installed'
        CHECK (status IN ('installed','planned','failed','unknown')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (device_id, content_id)
);

CREATE TABLE IF NOT EXISTS deploy_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id TEXT NOT NULL REFERENCES contents(content_id),
    version TEXT NOT NULL,
    target_devices_json TEXT NOT NULL DEFAULT '[]',
    checklist_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned','in_progress','done','cancelled')),
    memo TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_code TEXT NOT NULL UNIQUE,
    institution_name TEXT NOT NULL,
    institution_code TEXT,
    grade TEXT,
    class_group TEXT,
    session_no INTEGER,
    session_date TEXT NOT NULL,
    topic TEXT,
    content_id TEXT REFERENCES contents(content_id),
    scheduled_start_at TEXT,
    instructor TEXT,
    expected_students INTEGER,
    memo TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','ready','running','completed','cancelled')),
    started_at TEXT,
    ended_at TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(session_date);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    student_code TEXT NOT NULL,
    device_id TEXT REFERENCES devices(device_id),
    created_at TEXT NOT NULL,
    UNIQUE (session_id, student_code),
    UNIQUE (session_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_device ON participants(device_id);

CREATE TABLE IF NOT EXISTS mission_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    result_id TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES sessions(session_code),
    device_id TEXT NOT NULL REFERENCES devices(device_id),
    student_code TEXT NOT NULL,
    content_id TEXT NOT NULL,
    content_version TEXT,
    mission_id TEXT NOT NULL,
    answer_json TEXT,
    is_correct INTEGER,
    score REAL,
    attempt_count INTEGER,
    duration_seconds REAL,
    started_at TEXT,
    completed_at TEXT,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced','corrected')),
    corrected_is_correct INTEGER,
    corrected_score REAL
);
CREATE INDEX IF NOT EXISTS idx_results_session ON mission_results(session_id);
CREATE INDEX IF NOT EXISTS idx_results_device ON mission_results(device_id);
CREATE INDEX IF NOT EXISTS idx_results_student ON mission_results(session_id, student_code);
CREATE INDEX IF NOT EXISTS idx_results_content ON mission_results(content_id);
CREATE INDEX IF NOT EXISTS idx_results_mission ON mission_results(mission_id);
CREATE INDEX IF NOT EXISTS idx_results_occurred ON mission_results(occurred_at);

CREATE TABLE IF NOT EXISTS result_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    result_id TEXT NOT NULL REFERENCES mission_results(result_id),
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    reason TEXT NOT NULL,
    admin_user_id INTEGER,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS result_rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    session_id TEXT,
    event_id TEXT,
    result_id TEXT,
    reason TEXT NOT NULL,
    payload_json TEXT,
    received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rejections_received ON result_rejections(received_at);

CREATE TABLE IF NOT EXISTS sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    session_id TEXT,
    received_count INTEGER NOT NULL,
    accepted_count INTEGER NOT NULL,
    duplicate_count INTEGER NOT NULL,
    rejected_count INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_logs_created ON sync_logs(created_at);

CREATE TABLE IF NOT EXISTS device_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    session_id TEXT,
    payload_json TEXT,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_device ON device_events(device_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON device_events(event_type, received_at);

CREATE TABLE IF NOT EXISTS device_progress (
    session_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    student_code TEXT,
    content_id TEXT,
    mission_id TEXT,
    step TEXT,
    progress REAL,
    state TEXT NOT NULL DEFAULT 'in_progress'
        CHECK (state IN ('waiting','in_progress','completed','error')),
    last_report_at TEXT NOT NULL,
    PRIMARY KEY (session_id, device_id)
);

CREATE TABLE IF NOT EXISTS heartbeat_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    payload_json TEXT,
    received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_heartbeat_device ON heartbeat_logs(device_id, received_at);

CREATE TABLE IF NOT EXISTS device_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    command TEXT NOT NULL,
    payload_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','cancelled')),
    created_at TEXT NOT NULL,
    delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
    active INTEGER NOT NULL DEFAULT 1,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_user_id INTEGER,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    detail_json TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS api_error_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT,
    path TEXT,
    status_code INTEGER,
    message TEXT,
    client TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_errors_created ON api_error_logs(created_at);

CREATE TABLE IF NOT EXISTS backup_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL CHECK (action IN ('backup','restore','verify')),
    trigger TEXT NOT NULL,
    file_path TEXT,
    size_bytes INTEGER,
    sha256 TEXT,
    result TEXT NOT NULL,
    message TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL
);
"""

# key: (기본값, 타입, 설명)
DEFAULT_SETTINGS: dict[str, tuple[object, type, str]] = {
    "heartbeat_interval_sec": (30, int, "HMD heartbeat 전송 주기(초)"),
    "offline_threshold_sec": (90, int, "이 시간 동안 heartbeat 미수신 시 오프라인 판정(초)"),
    "delay_threshold_sec": (60, int, "이 시간 이상 heartbeat 지연 시 '주의' 판정(초)"),
    "battery_warning_pct": (20, int, "배터리 주의 임계치(%)"),
    "error_hold_sec": (300, int, "오류 이벤트 보고 후 '오류' 상태 유지 시간(초)"),
    "sync_batch_size": (50, int, "HMD 결과 업로드 batch 크기"),
    "sync_retry_base_sec": (5, int, "동기화 재시도 최초 대기(초)"),
    "sync_retry_max_sec": (300, int, "동기화 재시도 최대 대기(초)"),
    "backup_dir": ("", str, "백업 경로 (비우면 기본 경로)"),
    "auto_backup_enabled": (True, bool, "날짜별 자동 백업 사용"),
    "auto_backup_hour": (18, int, "자동 백업 시각(시, 0~23)"),
    "backup_keep_count": (30, int, "자동 백업 보관 개수"),
    "log_retention_days": (90, int, "로그 보관 기간(일)"),
    "result_retention_days": (0, int, "학습 결과 보관 기간(일, 0=무기한)"),
    "token_expire_minutes": (480, int, "관리자 로그인 유지 시간(분)"),
    "login_max_failures": (5, int, "로그인 실패 허용 횟수"),
    "login_lock_minutes": (10, int, "로그인 잠금 시간(분)"),
    "require_device_key": (True, bool, "HMD 요청 시 장비 키(X-Device-Key) 검증"),
    "device_api_key": ("", str, "HMD 공용 장비 키"),
}


def connect(path: str | None = None) -> sqlite3.Connection:
    db_file = path or str(config.db_file)
    conn = sqlite3.connect(db_file, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def get_db() -> Iterator[sqlite3.Connection]:
    """FastAPI dependency."""
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def db_session() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    config.db_file.parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        now = now_iso()
        for key, (default, typ, _desc) in DEFAULT_SETTINGS.items():
            value = default
            if key == "device_api_key":
                value = secrets.token_urlsafe(24)
            conn.execute(
                "INSERT OR IGNORE INTO system_settings(key, value, updated_at) VALUES (?,?,?)",
                (key, encode_setting(value), now),
            )
        if conn.execute("SELECT COUNT(*) FROM admin_users").fetchone()[0] == 0:
            from .security import hash_password

            conn.execute(
                "INSERT INTO admin_users(username, display_name, password_hash, role, must_change_password, created_at)"
                " VALUES (?,?,?,?,1,?)",
                ("admin", "시스템 관리자", hash_password("admin1234"), "admin", now),
            )
        conn.commit()
    finally:
        conn.close()


def encode_setting(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def decode_setting(key: str, raw: str | None) -> object:
    default, typ, _ = DEFAULT_SETTINGS.get(key, (raw, str, ""))
    if raw is None:
        return default
    if typ is bool:
        return raw.lower() in ("1", "true", "yes", "on")
    if typ is int:
        try:
            return int(raw)
        except ValueError:
            return default
    return raw


def get_settings(conn: sqlite3.Connection) -> dict[str, object]:
    rows = conn.execute("SELECT key, value FROM system_settings").fetchall()
    stored = {r["key"]: r["value"] for r in rows}
    return {k: decode_setting(k, stored.get(k)) for k in DEFAULT_SETTINGS}


def rows_to_dicts(rows) -> list[dict]:
    return [dict(r) for r in rows]
