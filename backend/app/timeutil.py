"""시간 처리 규칙: DB에는 항상 UTC ISO 8601(+00:00)로 저장한다.

HMD가 보낸 시각은 시간대 정보를 포함해야 하며(예: +09:00), 시간대가 없으면
설정된 현장 시간대(utc_offset_hours)로 간주한 뒤 UTC로 변환한다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .config import config


def local_tz() -> timezone:
    return timezone(timedelta(hours=config.utc_offset_hours))


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def now_iso() -> str:
    return now_utc().isoformat()


def parse_iso(value: str) -> datetime:
    """ISO 8601 문자열을 aware datetime 으로 변환. 실패 시 ValueError."""
    if not isinstance(value, str) or not value:
        raise ValueError("시각 값이 비어 있습니다")
    v = value.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=local_tz())
    return dt


def to_utc_iso(value: str) -> str:
    return parse_iso(value).astimezone(timezone.utc).replace(microsecond=0).isoformat()


def to_local_str(value: str | None, fmt: str = "%Y-%m-%d %H:%M:%S") -> str:
    if not value:
        return ""
    try:
        return parse_iso(value).astimezone(local_tz()).strftime(fmt)
    except ValueError:
        return value


def seconds_since(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return (now_utc() - parse_iso(value)).total_seconds()
    except ValueError:
        return None


def local_today() -> str:
    return datetime.now(local_tz()).strftime("%Y-%m-%d")
