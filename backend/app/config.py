"""서버 환경설정.

우선순위: 환경변수(MR_EDU_*) > backend/config.json > 기본값.
IP·포트·DB 경로 등은 모두 여기서 변경할 수 있다.
"""
from __future__ import annotations

import json
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BACKEND_DIR.parent


def _resolve(p: str) -> Path:
    path = Path(p)
    return path if path.is_absolute() else (BACKEND_DIR / path).resolve()


@dataclass
class AppConfig:
    host: str = "0.0.0.0"
    port: int = 8000
    # 관리자 화면·HMD에 안내할 서버 주소 (예: 192.168.50.10). 비우면 자동 감지
    public_host: str = ""
    db_path: str = "data/mr_edu.db"
    backup_dir: str = "data/backups"
    secret_key: str = ""
    cors_origins: list[str] = field(default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"])
    frontend_dist: str = "../frontend/dist"
    # 화면·보고서 표기용 시간대 (UTC 기준 오프셋, 한국 = 9)
    utc_offset_hours: int = 9

    @property
    def db_file(self) -> Path:
        return _resolve(self.db_path)

    @property
    def default_backup_dir(self) -> Path:
        return _resolve(self.backup_dir)

    @property
    def frontend_dir(self) -> Path:
        return _resolve(self.frontend_dist)


def load_config() -> AppConfig:
    cfg = AppConfig()
    cfg_file = Path(os.environ.get("MR_EDU_CONFIG", BACKEND_DIR / "config.json"))
    if cfg_file.exists():
        data = json.loads(cfg_file.read_text(encoding="utf-8"))
        for k, v in data.items():
            if hasattr(cfg, k):
                setattr(cfg, k, v)
    env_map = {
        "MR_EDU_HOST": ("host", str),
        "MR_EDU_PORT": ("port", int),
        "MR_EDU_PUBLIC_HOST": ("public_host", str),
        "MR_EDU_DB_PATH": ("db_path", str),
        "MR_EDU_BACKUP_DIR": ("backup_dir", str),
        "MR_EDU_SECRET_KEY": ("secret_key", str),
        "MR_EDU_FRONTEND_DIST": ("frontend_dist", str),
    }
    for env, (attr, typ) in env_map.items():
        if env in os.environ:
            setattr(cfg, attr, typ(os.environ[env]))
    if os.environ.get("MR_EDU_CORS_ORIGINS"):
        cfg.cors_origins = [o.strip() for o in os.environ["MR_EDU_CORS_ORIGINS"].split(",") if o.strip()]

    if not cfg.secret_key:
        key_file = cfg.db_file.parent / "secret.key"
        key_file.parent.mkdir(parents=True, exist_ok=True)
        if key_file.exists():
            cfg.secret_key = key_file.read_text().strip()
        else:
            cfg.secret_key = secrets.token_urlsafe(48)
            key_file.write_text(cfg.secret_key)
            try:
                os.chmod(key_file, 0o600)
            except OSError:
                pass
    return cfg


config = load_config()
