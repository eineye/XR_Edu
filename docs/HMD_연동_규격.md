# HMD 앱 ↔ 관리자 서버 연동 규격 (v1.0)

HMD(Meta Quest 3) 앱 개발자를 위한 규격입니다. 참조 구현은 `simulator/hmd_simulator.py` 입니다.

## 1. 기본 원칙
1. 콘텐츠 실행과 미션 수행은 서버 연결과 **무관하게** HMD 단독으로 완료할 수 있어야 한다.
2. 미션 결과는 발생 **즉시 HMD 로컬 DB에 `pending`으로 저장**한다.
3. HMD는 WebSocket을 쓰지 않아도 된다. **REST heartbeat + 업로드만으로** 모든 기능이 동작한다.
4. 서버 ACK의 `accepted` 또는 `duplicates`에 포함된 항목만 `synced`로 바꾼다. 응답을 받지 못하면 그대로 `pending`.
5. 재전송할 때는 **같은 `event_id`·`result_id`** 를 사용한다(새로 만들지 않는다).
6. 앱을 다시 실행해도 pending 큐를 복원한다. 사용자가 결과를 임의 삭제할 수 없게 한다.
7. 기기에서 확인할 수 없는 값(배터리, 저장공간 등)은 `null`로 보낸다. **추정값 금지.**

## 2. 공통
- 기본 주소: `http://<관리자PC IP>:8000` (관리자 화면 [네트워크·시스템 설정]에 표시)
- 모든 HMD 요청 헤더: `X-Device-Key: <장비 키>`, `Content-Type: application/json`
- 시각: ISO 8601 + 시간대 (예: `2026-11-06T10:30:00+09:00`). 서버는 UTC로 변환 저장.
- 장비 ID(`HMD-01` 등)는 관리자 화면에 먼저 등록되어 있어야 한다(미등록 → 404, 비활성 → 403).

| 상태 코드 | 의미 | HMD 처리 |
|---|---|---|
| 200 | 처리됨 (부분 성공 포함) | ACK 내용대로 상태 갱신 |
| 401 | 장비 키 오류 | 재시도 중단, 화면에 설정 오류 표시 |
| 404/403 | 미등록·비활성 장비 | 재시도 중단, 관리자에게 알림 |
| 422 | 요청 형식 오류(배치 전체) | 앱 버그. 로그 남기고 재시도 간격 최대 |
| 503 / 연결 실패 / 타임아웃 | 서버 저장 실패·미연결 | pending 유지, 백오프 재시도 |

## 3. API

### 3.1 서버 상태 확인 — `GET /health`
인증 불필요. `{"status":"ok","db":"ok","server_time":"..."}`. 업로드 전 연결 확인에 사용.

### 3.2 상태 보고 — `POST /api/v1/devices/heartbeat`
주기: 응답의 `heartbeat_interval_sec`(기본 30초).
```json
{
  "device_id": "HMD-01",
  "app_version": "1.0.0",
  "content_version": "2026.11",
  "app_status": "running",          // running | idle | error | unknown
  "battery_level": 82,              // 0~100, 모르면 null
  "storage_available": null,        // MB, 모르면 null
  "error_code": null,               // 최근 오류 코드
  "pending_count": 3,               // 로컬 미전송 결과 수
  "sent_total": 120,                // ACK 받은 누적 결과 수 (서버 수신 건수와 비교용)
  "session_id": "SESSION-20261106-001",
  "installed_contents": [{"content_id": "SAFETY-01", "version": "1.0.0"}],
  "occurred_at": "2026-11-06T10:30:00+09:00"
}
```
응답:
```json
{
  "success": true,
  "server_time": "...",
  "heartbeat_interval_sec": 30,
  "sync": {"batch_size": 50, "retry_base_sec": 5, "retry_max_sec": 300},
  "commands": [{"id": 3, "command": "resync", "payload": {}}]
}
```
- `commands`의 `resync`: 관리자가 재전송을 요청함 → 백오프를 무시하고 pending을 즉시 업로드.
- heartbeat가 실패하다가 **성공하면 연결 복구로 보고 즉시 pending을 업로드**한다(백오프 대기 해제).

### 3.3 배정 정보 — `GET /api/v1/devices/{device_id}/assignment`
수업 전에 받아 로컬에 저장해 두고, 서버가 끊겨도 저장된 정보로 교육을 진행한다.
```json
{"assigned": true, "session_id": "SESSION-20261106-001", "session_status": "running",
 "student_code": "S001", "content": {"content_id": "SAFETY-01", "title": "...", "version": "1.0.0"},
 "institution_name": "...", "session_date": "2026-11-06"}
```

### 3.4 진행 이벤트 — `POST /api/v1/events`
관리자 [실시간 진행 현황]에 사용. 결과와 동일하게 로컬 큐 → ACK 방식 권장.
```json
{"device_id": "HMD-01", "events": [
  {"event_id": "HMD-01-evt-uuid", "event_type": "mission.started", "session_id": "SESSION-20261106-001",
   "student_code": "S001", "content_id": "SAFETY-01", "mission_id": "FORKLIFT-HAZARD-01",
   "step": "1/4", "progress": 0.0, "occurred_at": "2026-11-06T10:05:00+09:00"}
]}
```
`event_type`: `session.joined`, `mission.started`, `mission.progress`, `mission.completed`, `session.finished`, `app.error`(`error_code`, `message`), `app.status`.
`progress`는 0~1. 늦게 도착한 과거 이벤트는 최신 진행 상태를 덮어쓰지 않는다(`occurred_at` 비교).

### 3.5 결과 일괄 업로드 — `POST /api/v1/results/batch`
세션별로 묶어 `batch_size` 이하로 전송.
```json
{
  "device_id": "HMD-01",
  "session_id": "SESSION-20261106-001",
  "results": [{
    "result_id": "res-unique-001", "event_id": "evt-unique-001",
    "student_code": "S001", "content_id": "SAFETY-01", "content_version": "1.0.0",
    "mission_id": "FORKLIFT-HAZARD-01", "answer": "B", "is_correct": true, "score": 100,
    "attempt_count": 1, "duration_seconds": 42,
    "started_at": "2026-11-06T10:27:28+09:00", "completed_at": "2026-11-06T10:28:10+09:00",
    "occurred_at": "2026-11-06T10:28:10+09:00"
  }]
}
```
필수: `result_id`, `event_id`, `student_code`, `content_id`, `mission_id`, `occurred_at`. `answer`는 문자열·배열·객체 모두 가능(JSON 그대로 보관).

ACK (서버 commit 이후에만 반환):
```json
{"success": true, "accepted": ["evt-unique-001"], "duplicates": [], 
 "rejected": [{"event_id": "evt-x", "result_id": "res-x", "reason": "세션에 등록되지 않은 학생 코드: S999"}],
 "server_time": "..."}
```
| 목록 | 의미 | HMD 처리 |
|---|---|---|
| `accepted` | 이번에 저장됨 | `synced` |
| `duplicates` | 이미 저장되어 있음 (이전 ACK 유실 등) | `synced` |
| `rejected` | 저장 불가 (사유 포함) | `rejected`로 보존(삭제 금지). 관리자 조치 후 재전송 가능 |

거부 사유 예: 입력 검증 실패, 존재하지 않는 세션, 작성 중·취소된 세션, 세션에 없는 학생 코드, `result_id`/`event_id` 충돌.

## 4. 재시도 정책
- 실패 시 대기: `retry_base_sec`부터 2배씩 증가, 최대 `retry_max_sec` (±20% 무작위 지연으로 20대 동시 재접속 분산)
- heartbeat 성공(연결 복구) 또는 `resync` 명령 수신 시 즉시 재시도
- 성공하면 대기 시간 초기화

## 5. 로컬 저장 권장 스키마 (HMD)
```sql
CREATE TABLE outbox (
  event_id TEXT PRIMARY KEY, kind TEXT,           -- 'result' | 'event'
  session_id TEXT, payload TEXT,                  -- 전송할 JSON 그대로
  status TEXT DEFAULT 'pending',                  -- pending | synced | rejected
  reject_reason TEXT, attempts INTEGER DEFAULT 0, created_at TEXT, synced_at TEXT
);
```
