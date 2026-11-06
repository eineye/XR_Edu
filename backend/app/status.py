"""장비 상태 판정 규칙 (설정값 기반)."""
from __future__ import annotations

from .timeutil import seconds_since

STATUS_LABELS = {
    "normal": "정상",
    "warning": "주의",
    "offline": "오프라인",
    "error": "오류",
    "unknown": "확인 불가",
    "inactive": "비활성",
}


def connection_of(device: dict, settings: dict) -> str:
    age = seconds_since(device.get("last_seen_at"))
    if age is None:
        return "unknown"
    return "offline" if age > settings["offline_threshold_sec"] else "online"


def evaluate_device(device: dict, settings: dict) -> dict:
    """장비 행에 판정 결과(health, reasons, connection_status)를 덧붙여 반환."""
    d = dict(device)
    reasons: list[str] = []
    age = seconds_since(d.get("last_seen_at"))
    conn_status = connection_of(d, settings)
    d["connection_status"] = conn_status
    d["seconds_since_seen"] = None if age is None else int(age)

    if not d.get("active", 1):
        health = "inactive"
        reasons.append("비활성화된 장비")
    elif conn_status == "unknown":
        health = "unknown"
        reasons.append("통신 기록 없음")
    elif conn_status == "offline":
        health = "offline"
        reasons.append(f"마지막 통신 {int(age // 60)}분 {int(age % 60)}초 전 (기준 시각 이후 미수신)")
    else:
        error_age = seconds_since(d.get("last_error_at"))
        recent_error = error_age is not None and error_age <= settings["error_hold_sec"]
        if d.get("app_status") == "error" or recent_error:
            health = "error"
            reasons.append(f"앱 오류 보고{(' (' + d['last_error_code'] + ')') if d.get('last_error_code') else ''}")
        else:
            health = "normal"
            battery = d.get("battery_level")
            # 배터리 값을 받지 못한 장비는 저배터리로 분류하지 않는다
            if battery is not None and battery <= settings["battery_warning_pct"]:
                health = "warning"
                reasons.append(f"배터리 {battery}% (임계치 {settings['battery_warning_pct']}%)")
            if age is not None and age > settings["delay_threshold_sec"]:
                health = "warning"
                reasons.append(f"통신 지연 {int(age)}초")
    d["health"] = health
    d["health_label"] = STATUS_LABELS[health]
    d["health_reasons"] = reasons
    return d
