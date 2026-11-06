# MR EDU MOBILE 2.0 관리자 시스템

학교 방문형 MR 교육(Meta Quest 3 최대 20대)을 위한 **관리자 웹앱**입니다.
관리자 PC 한 대에서 로컬 서버와 SQLite DB를 실행하고, 같은 내부 Wi-Fi에 접속한 HMD 앱이 REST API로 상태와 학습 결과를 보냅니다. **인터넷 없이** 동작합니다.

- 장비 상태 확인, 교육 세션 운영, 학습 결과 수집, 오프라인 동기화에 집중
- HMD 교육은 서버·Wi-Fi 장애와 무관하게 계속 진행되며, 결과는 HMD에 먼저 저장 → 연결 복구 후 자동 재전송 → **ACK 받은 것만 synced**, 서버는 `event_id` 기준으로 중복 저장 방지
- 실제 Quest 없이 시험할 수 있는 **가상 HMD 20대 시뮬레이터** 포함 (화면에 `데모 모드 · 가상 HMD`로 표시)

---

## 1. 구성

```
backend/            FastAPI + SQLite 로컬 API 서버 (빌드된 화면도 같은 포트로 제공)
  app/main.py         진입점, WebSocket(/ws), 오프라인 감지·자동 백업 백그라운드 작업
  app/routers/        auth, users, devices, sessions, sync(HMD 업로드), results, contents,
                      dashboard, reports, settings, logs(백업 포함)
  app/db.py           스키마·기본 설정       app/backup.py   백업·무결성·복원
  app/cli.py          관리 명령               tests/          자동화 테스트(pytest)
frontend/           React + TypeScript + Tailwind + Recharts 관리자 화면
simulator/          가상 HMD 시뮬레이터 (HMD 연동 규격의 참조 구현)
scripts/            실행·오프라인 설치 스크립트
docs/HMD_연동_규격.md  HMD 앱 개발자를 위한 API·동기화 규격
```

| 영역 | 기술 |
|---|---|
| 프론트엔드 | React 19, TypeScript, Tailwind CSS 4, Recharts, Vite |
| 백엔드 | Python 3.10+, FastAPI, Uvicorn, SQLite(WAL) |
| 실시간 | WebSocket (끊기면 화면이 10초 REST polling 으로 자동 전환) |
| 보고서 | CSV(엑셀 호환 BOM), XLSX(openpyxl), PDF(reportlab, 한글 CID 폰트 내장) |

외부 CDN·클라우드 의존성은 없습니다. 기술 스택은 설계서 권장안을 그대로 따랐으며, DB 접근은 의존성을 줄이기 위해 ORM 없이 표준 `sqlite3`로 구현했습니다.

---

## 2. 설치·실행

### 2.1 요구 사항
- Python 3.10 이상 (Windows 관리자 PC 권장: Python 3.12)
- 화면을 직접 빌드할 때만 Node.js 20 이상 (빌드 결과 `frontend/dist`만 있으면 관리자 PC에는 Node 불필요)

### 2.2 인터넷이 되는 PC에서 처음 설치
```bash
python -m venv .venv
# Windows: .venv\Scripts\activate    /  Linux·macOS: source .venv/bin/activate
pip install -r backend/requirements.txt
cd frontend && npm install && npm run build && cd ..
cd backend
python -m app.cli init-db              # DB 생성 + 기본 관리자 생성
python -m app.cli seed-devices --count 20   # HMD-01 ~ HMD-20 등록
python -m app.cli seed-demo            # (선택) 데모 콘텐츠 3종 등록
python -m app.main                     # 서버 실행 (0.0.0.0:8000)
```
브라우저에서 `http://localhost:8000` 접속 → **admin / admin1234** 로 로그인 → 비밀번호 변경 안내에 따라 변경합니다.

Windows에서는 `scripts\start_server.bat`, Linux/macOS에서는 `scripts/start_server.sh`로 실행할 수 있습니다.

### 2.3 인터넷이 없는 관리자 PC에 설치 (오프라인 설치)
1. 인터넷이 되는 PC에서 패키지 준비
   ```bash
   # 관리자 PC가 Windows 64bit + Python 3.12 인 경우
   PLATFORM=win_amd64 PYVER=312 ./scripts/prepare_offline_package.sh
   ```
   → `wheels/` (Python 패키지)와 `frontend/dist/` (빌드된 화면)가 만들어집니다.
2. 프로젝트 폴더 전체를 USB 등으로 관리자 PC에 복사
3. 관리자 PC에서 `scripts\install_offline.bat` 실행 (가상환경 생성 → wheels에서 설치 → DB 초기화 → 장비 20대 등록)
4. `scripts\start_server.bat` 실행

### 2.4 개발 모드 (화면 수정 시)
```bash
cd backend && python -m app.main          # API :8000
cd frontend && npm run dev                # 화면 :5173 (API는 자동 프록시)
```

### 2.5 서버 주소·포트 설정
`backend/config.json` (없으면 기본값) 또는 환경변수로 변경합니다.

```json
{
  "host": "0.0.0.0",
  "port": 8000,
  "public_host": "192.168.50.10",
  "db_path": "data/mr_edu.db",
  "backup_dir": "data/backups",
  "utc_offset_hours": 9
}
```
환경변수: `MR_EDU_PORT`, `MR_EDU_HOST`, `MR_EDU_PUBLIC_HOST`, `MR_EDU_DB_PATH`, `MR_EDU_BACKUP_DIR`, `MR_EDU_SECRET_KEY`, `MR_EDU_CORS_ORIGINS`.
`public_host`는 화면의 [네트워크·시스템 설정]에 표시되는 HMD 접속 주소이며, 비우면 자동 감지합니다.

### 2.6 현장 네트워크 권장 구성
- 전용 Wi-Fi 6 AP/공유기, 예: `192.168.50.0/24`
- 관리자 PC는 AP에 **유선 LAN** 연결, 고정 IP(예: `192.168.50.10`) 지정
- HMD 앱에는 `http://192.168.50.10:8000` 과 장비 키(아래 2.7)를 설정
- **관리자 API는 내부 네트워크에서만 접근**하도록 Windows 방화벽에서 TCP 8000 인바운드를 해당 서브넷(192.168.50.0/24)으로만 허용하세요. 이 시스템은 네트워크 인터페이스·방화벽을 자동으로 변경하지 않습니다.

### 2.7 HMD 장비 키
HMD → 서버 요청은 `X-Device-Key` 헤더로 검증합니다. 키는 DB 초기화 시 무작위 생성됩니다.
```bash
cd backend && python -m app.cli device-key
```
화면 [네트워크·시스템 설정]에서 확인·재발급할 수 있습니다(시스템 관리자). HMD 앱 연동 규격은 [`docs/HMD_연동_규격.md`](docs/HMD_연동_규격.md)를 참고하세요.

---

## 3. 가상 HMD 시뮬레이터

```bash
# 서버 실행 후, 다른 터미널에서
KEY=$(cd backend && python -m app.cli device-key)
python simulator/hmd_simulator.py --key "$KEY" --devices 20
```
| 옵션 | 설명 |
|---|---|
| `--server` | 서버 주소 (기본 `http://127.0.0.1:8000`) |
| `--speed 4` | 시간 배속 (미션 진행·heartbeat 를 빠르게) |
| `--drop-rate 0.2` | 요청 20%를 실패시켜 불안정한 Wi-Fi 모사 |
| `--no-battery HMD-05,HMD-06` | 배터리 미지원 장비 모사 (화면에 `확인 불가` 표시, 저배터리로 분류하지 않음) |
| `--reset` | 시뮬레이터 로컬 DB 초기화 |

각 가상 HMD는 `simulator/data/HMD-xx.db`에 로컬 큐를 두고, 배정된 세션이 **진행 중**이면 미션을 수행하며 결과를 먼저 로컬에 저장한 뒤 업로드합니다.

**Wi-Fi 단절·복구 시험**: 실행 중에 `simulator/data/offline.txt` 파일에 장비 ID(줄 단위, 전체는 `ALL`)를 적으면 해당 HMD가 서버와 통신하지 못합니다. 이 동안에도 교육은 계속되고 결과는 pending 으로 쌓입니다. 파일 내용을 지우면 연결 복구가 감지되어 즉시 재전송됩니다. 시뮬레이터를 껐다 켜도(앱 재실행) 큐가 복원됩니다.

### 데모 시나리오
1. 서버 실행 → 로그인 → [교육 세션 관리] → **세션 생성** (기관 → 학년·학급 → 콘텐츠 → 학생 코드 `S001~` 생성 → HMD 자동 배정 → 생성)
2. 세션 상세에서 **세션 시작**
3. 시뮬레이터 실행 → [대시보드]·[실시간 진행 현황]에서 진행률이 갱신되는 것 확인
4. `offline.txt`에 `HMD-03` 기록 → 대시보드에서 HMD-03 이 **오프라인(마지막 통신 기준)** 으로 바뀜 → 파일 비우기 → 결과 자동 동기화
5. [학습 결과 관리] 통계·학생별 결과·미동기화 확인 → 세션 종료 → [보고서]에서 PDF/XLSX 출력

---

## 3-1. 웹 주소로 데모 실행 (실제 HMD·로컬 설치 없이)

**데모 모드**(`MR_EDU_DEMO=1`)로 실행하면 서버가 시작될 때 다음을 자동으로 합니다.
- 장비 20대, 데모 콘텐츠 3종, 진행 중인 데모 세션 1개 등록
- 가상 HMD 20대를 서버 안에서 실행

그래서 웹 주소만 있으면 바로 시험할 수 있습니다.
- 로그인 화면에 데모 계정(`admin / admin1234`)과 [자동 입력] 버튼이 표시됩니다.
- [장비 관리]와 장비 상세 화면의 **[데모] Wi-Fi 단절/복구** 버튼으로 단절·복구를 시험할 수 있습니다.
- 새 세션을 만들어 시작하면 가상 HMD가 그 세션의 미션을 수행합니다.

### GitHub Pages 웹 데모 (서버 없이 브라우저만으로)
주소: **https://eineye.github.io/XR_Edu/**

`main`에 push하면 `.github/workflows/pages.yml`이 정적 데모를 빌드해 자동 배포합니다.
- 실제 백엔드 대신 **브라우저 안에 들어 있는 데모 서버**(`frontend/src/mock/`)가 같은 API 응답을 흉내 냅니다.
- 가상 HMD 20대도 브라우저 안에서 동작합니다.
- 장비 상태 판정, ACK 기반 동기화, `event_id` 중복 방지 규칙은 실제 서버와 같게 구현했습니다.
- 데이터는 그 브라우저의 localStorage에만 저장됩니다. 사람마다·기기마다 데이터가 따로입니다.
- 가상 HMD는 데모 탭이 열려 있는 동안만 동작합니다.
- CSV만 내려받을 수 있습니다. XLSX·PDF는 실제 서버에서만 지원합니다.
- 백업은 브라우저 저장소에 최근 5개만 보관합니다.
- 화면 흐름을 보여 주고 시연하는 용도입니다. 실제 서버·DB 검증은 위 Render/Docker 데모나 로컬 설치로 해야 합니다.

직접 빌드: `cd frontend && VITE_DEMO_STATIC=1 npx vite build --outDir dist-pages` → `dist-pages/`를 아무 정적 호스팅에 올리면 됩니다.

### Render 무료 배포 (권장)
1. https://render.com 가입 → **New + → Blueprint** → 이 GitHub 저장소 선택
2. 저장소의 `render.yaml`대로 Docker 이미지가 빌드·배포되고 `https://mr-edu-demo-xxxx.onrender.com` 같은 주소가 생깁니다.
3. 무료 플랜 주의사항
   - 15분간 접속이 없으면 서버가 잠들고, 다시 접속하면 30초~1분 뒤에 깨어납니다.
   - 서버를 재배포하거나 재시작하면 데이터가 초기화됩니다(데모 데이터는 자동으로 다시 만들어짐).

### Docker로 직접 실행
```bash
docker build -t mr-edu .
docker run -p 8000:8000 -e MR_EDU_DEMO=1 mr-edu
```
`PORT` 환경변수를 지정하면 그 포트로 실행됩니다(Railway, Fly.io 등 다른 호스팅도 같은 방식).

> 데모 모드는 시험용입니다. 공개 주소에서는 누구나 기본 계정으로 로그인할 수 있으므로 **실제 학생 데이터를 넣지 마세요.** 현장 운영 시에는 `MR_EDU_DEMO`를 설정하지 않습니다.

---

## 4. 백업·복원·DB 관리

| 작업 | 화면 | 명령 |
|---|---|---|
| DB 생성/스키마 적용 (기존 데이터 유지) | – | `python -m app.cli init-db` |
| 수동 백업 | [시스템 로그·백업] → 수동 백업 | `python -m app.cli backup` |
| 백업 목록 | 같은 화면 | `python -m app.cli list-backups` |
| 무결성 확인 | 백업 행의 **무결성 확인** | – |
| 복원 | 백업 행의 **복원** (확인 문구 입력 필요) | `python -m app.cli restore <파일명>` |
| 관리자 비밀번호 분실·잠금 해제 | – | `python -m app.cli reset-password admin` |

- 백업은 SQLite Online Backup API로 서버 실행 중에도 일관된 사본을 만들고, `파일.db.sha256` 체크섬과 `PRAGMA integrity_check` 결과를 기록합니다.
- **자동 백업**: 설정한 시각(기본 18시) 이후 하루 한 번, 최근 N개(기본 30) 보관.
- **복원 절차**: ① 백업 파일 SQLite 무결성 + SHA-256 확인(불일치 시 중단) → ② 현재 DB를 `..._pre_restore.db`로 별도 보존 → ③ 복원 → ④ 복원 후 데이터 건수 표시.
- 복원 후 백업 시점 이후에 수신했던 결과는 HMD에서 재전송하면 됩니다(같은 `event_id`라 중복 없이 저장됨). 장비 상세의 **미전송 결과 재전송 요청**을 사용하세요.
- 백업 파일 권한은 소유자 전용(0600)으로 설정합니다. Windows에서는 백업 폴더를 관리자 계정만 접근 가능한 위치로 지정하세요.
- DB를 완전히 새로 시작하려면 서버를 끄고 `backend/data/` 폴더를 다른 곳으로 옮긴 뒤 `init-db`를 실행합니다(삭제 대신 보관 권장).

---

## 5. 기능 요약 (메뉴별)

| 메뉴 | 주요 기능 |
|---|---|
| 대시보드 | 전체/연결/오프라인/주의/오류 장비 수, 진행 중 세션·진행률, 미동기화 건수(HMD 보고 기준), 장비 타일, 최근 알림, 최근 7일 미션 정답률. 카드 클릭 시 필터된 목록으로 이동 |
| 장비 관리 | 등록·일괄 등록·수정·비활성화, 검색·상태 필터·정렬·페이지, CSV 내보내기, 장비 상세(통신 이력·세션 참여 이력·동기화 건수 비교·설치 콘텐츠), 재전송 요청 |
| 교육 세션 관리 | 6단계 생성 마법사, 익명 학생 코드 입력/CSV 업로드/자동 생성, HMD 자동·수동 배정(중복 배정 방지, 다른 진행 중 세션 장비 제외), 학생 수 불일치 경고, 수정·복제·취소·시작·종료, 종료 전 업로드 확인 |
| 실시간 진행 현황 | 미션 이벤트 기반 장비별 진행 단계·진행률·마지막 보고·업로드 상태, 카드/표 전환 (화면 스트리밍 없음) |
| 학습 결과 관리 | 기간·학교·학년·학급·콘텐츠·세션 검색, 결과 원본 조회, 관리자 보정(원본 유지 + 보정 이력), 미션별 정답률·평균 수행 시간·오답 유형·콘텐츠별 평균, 학생별 결과·미완료 학생, 미동기화(HMD 미전송·서버 거부) 및 재전송 요청, CSV/Excel/PDF |
| 콘텐츠 관리 | 메타데이터·버전 관리, 활성/비활성, 장비별 설치 버전(HMD 보고), 배포 작업 + 체크리스트 기록 |
| 보고서 | 세션 보고서 + 수업 운영 요약·학급별 성과·학생별 결과·콘텐츠 효과·미션 정답률·장비 장애 이력, 미리보기 후 CSV/XLSX/PDF |
| 네트워크·시스템 설정 | 서버 IP·포트·HMD 접속 주소, heartbeat 주기·오프라인 판정·지연·배터리 임계치, 동기화 재시도 정책, 백업 경로·자동 백업·로그/결과 보관 기간, 로그인 보안, 장비 키, API 연결 테스트, 서버 상태 |
| 사용자·권한 관리 | 시스템 관리자 / 교육 운영자 / 조회 전용, 계정 추가·권한 변경·비활성화·비밀번호 초기화·잠금 해제 (마지막 관리자 보호) |
| 시스템 로그·백업 | API 오류, heartbeat 수신, 관리자 작업(감사), 결과 업로드·ACK, 장비 이벤트, 결과 거부, 백업 이력 / 백업·무결성 확인·복원 |

### 장비 상태 판정 (설정에서 기준 변경)
| 상태 | 조건 |
|---|---|
| 정상 | 기준 시간 내 heartbeat 수신, 오류 없음 |
| 주의 | 배터리 ≤ 임계치(**배터리 값을 받은 경우에만**) 또는 heartbeat 지연 |
| 오프라인 | 오프라인 판정 시간 동안 heartbeat 미수신 — "마지막 통신 기준"으로 표시, 오류로 단정하지 않음 |
| 오류 | HMD 앱이 오류 상태/오류 이벤트 보고 (일정 시간 유지) |
| 확인 불가 | 통신 기록 없음 |

### 권한
| 기능 | 시스템 관리자 | 교육 운영자 | 조회 전용 |
|---|:-:|:-:|:-:|
| 대시보드·진행 현황·결과·보고서 조회 | ✓ | ✓ | ✓ |
| 장비·세션·콘텐츠·결과 보정 | ✓ | ✓ | – |
| 설정 변경·사용자 관리·로그·백업/복원 | ✓ | – | – |

---

## 6. 보안·개인정보
- 비밀번호는 PBKDF2-SHA256(무작위 salt, 240,000회)로 저장하며 평문을 저장·기록하지 않습니다.
- 로그인 실패 5회 시 10분 잠금, 토큰 만료(기본 8시간), 비밀번호 정책(8자 이상, 영문+숫자), 초기 비밀번호 변경 안내.
- 감사 로그·API 오류 로그에서 비밀번호·장비 키 등 민감 값은 `***`로 가립니다. 요청 본문은 로그에 남기지 않습니다.
- 학생 실명·얼굴·음성은 수집하지 않습니다. 학생 코드는 영문·숫자·`-`·`_`만 허용되어 한글 이름 입력이 차단됩니다.
- HMD 요청은 장비 키 + 등록된 장비 ID 로 검증합니다(미등록·비활성 장비 거부).
- 데이터 삭제보다 비활성화를 우선합니다. 결과 보관 기간(기본 무기한)이 지난 데이터 삭제는 관리자 API(`POST /api/v1/results/purge-expired`, 미리보기 후 `confirm`)로만 수행합니다.

---

## 7. 테스트

```bash
pip install -r backend/requirements-dev.txt
cd backend && python -m pytest -q
cd frontend && npx tsc --noEmit -p .
```

자동화 테스트(34개) 범위:

| 설계서 테스트 항목 | 자동화 테스트 |
|---|---|
| 20대 heartbeat | `test_heartbeat_20_devices` — 20대 전송 후 대시보드 20대 정상 |
| 세션 배정 | `test_assign_20_no_duplicates`, `test_duplicate_device_and_student_rejected`, `test_device_conflict_between_running_sessions` |
| 결과 업로드 | `test_upload_and_ack`, `test_stats_and_correction` |
| 중복 업로드 | `test_duplicate_upload_is_idempotent` (5회 반복 전송 → 1건), `test_lost_ack_no_duplicates` (저장 후 ACK 유실 → 재전송 → duplicates) |
| 부분 실패 | `test_partial_failure` (시각 형식 오류·미등록 학생·필수값 누락·ID 충돌 → 정상 1건 저장 + 4건 사유 반환) |
| Wi-Fi 단절 / 연결 복구 | `test_wifi_outage_then_recovery`, `test_reconnect_resets_backoff` |
| 앱 재실행 | `test_queue_survives_app_restart` |
| 서버 재시작·데이터 보존 | `test_data_survives_restart` |
| 백업·복원 | `test_backup_verify_restore`, `test_tampered_backup_detected` (변조 백업 복원 차단) |
| 권한·보안 | `test_roles`, `test_login_lockout`, `test_password_not_plaintext_and_change`, `test_last_admin_protected`, `test_heartbeat_requires_device_key` |

또한 실제 서버 + 시뮬레이터 20대(요청 10% 실패, 배터리 미지원 2대, 1대 단절 후 복구 및 시뮬레이터 재시작) 환경에서 브라우저로 전체 화면을 점검했으며, 최종적으로 HMD 20대의 synced 결과 합계와 서버 저장 건수가 일치(80 = 80)함을 확인했습니다.

**아직 수행하지 않은 시험** (현장에서 필요): 실제 Wi-Fi AP 환경의 20대 동시 접속, 관리자 PC 재부팅 후 자동 실행, Quest 3 실기기 3대 → 5대 → 20대 확장 시험.

---

## 8. Phase별 구현 현황

| Phase | 내용 | 상태 |
|---|---|---|
| 1 | 프로젝트 기반, 로그인, 공통 레이아웃, SQLite, 서버 상태 | 완료 |
| 2 | 장비 CRUD, heartbeat API, 상태 판정, 20대 시뮬레이터, 대시보드 | 완료 |
| 3 | 세션 CRUD, 익명 학생 코드, HMD 배정, 상태 변경 | 완료 |
| 4 | 이벤트 수신, batch 업로드, ACK, 중복 방지, 결과 조회·통계·차트 | 완료 |
| 5 | WebSocket + polling 대체, 오프라인 표시, 미동기화 건수, 재전송 요청, 장애 로그 | 완료 |
| 6 | 콘텐츠 메타데이터, 보고서 내보내기, 백업·복원, 설치·실행 스크립트, 매뉴얼 | 완료 (원격 설치 제외) |

### 기기 연동 검증 필요 항목 (구현 완료로 간주하지 않음)
화면에도 `기기 연동 검증 필요`로 표시됩니다.
- **배터리·저장공간·앱 상태 조회**: Quest 3 실제 SDK/권한으로 어떤 값을 얻을 수 있는지 미검증. 서버는 HMD가 보낸 값만 표시하고, `null`이면 `확인 불가`로 표시합니다. 저장공간은 시뮬레이터에서도 `null`로 보냅니다.
- **콘텐츠 원격 설치·업데이트**: 지원하지 않습니다. Meta Quest 공식 배포 도구(MDM, 개발자 모드 등)와 운영 정책 검증 후 별도 구현해야 합니다. 현재는 버전·설치 현황(HMD 보고)·배포 체크리스트만 관리합니다.
- **HMD 앱 백그라운드 동작**: 앱이 종료되거나 Quest가 절전에 들어가면 heartbeat가 멈춥니다. 서버는 마지막 수신 상태 기준으로 오프라인 표시만 합니다.
- **HMD 측 결과 삭제 방지**: 시뮬레이터는 결과를 삭제하지 않지만, 실제 앱의 로컬 저장소 보호(앱 데이터 삭제 시 손실 등)는 HMD 앱에서 구현·검증해야 합니다.

### 다음 단계 제안
1. Quest 3 실기기에서 HMD 앱 프로토타입이 `docs/HMD_연동_규격.md`대로 동작하는지 검증 (3대 → 5대 → 20대)
2. 실제 AP 환경에서 20대 동시 heartbeat·업로드 부하 및 단절/복구 시험
3. 관리자 PC 부팅 시 서버 자동 실행(Windows 작업 스케줄러 또는 서비스 등록) 구성
4. 필요 시 데스크톱 패키징(예: PyInstaller로 서버 단일 실행 파일화)
5. 이후 확장: 콘텐츠 원격 배포, 다수 거점 통합 관리(PostgreSQL), 기관별 계정, 고급 학습 분석
