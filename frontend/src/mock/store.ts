// 정적 웹 데모(GitHub Pages)용 브라우저 내장 데이터 저장소.
// 실제 서버(backend/)의 SQLite 스키마를 단순화해 localStorage 에 보관한다.
/* eslint-disable @typescript-eslint/no-explicit-any */

export const STORAGE_KEY = 'mredu.static-demo.v1'
export const BACKUP_KEY = 'mredu.static-demo.backups.v1'

export type Row = Record<string, any>

export interface DB {
  seq: Record<string, number>
  users: Row[]
  devices: Row[]
  contents: Row[]
  content_versions: Row[]
  content_installs: Row[]
  deploy_jobs: Row[]
  sessions: Row[]
  participants: Row[]
  results: Row[]
  corrections: Row[]
  rejections: Row[]
  sync_logs: Row[]
  events: Row[]
  progress: Row[]
  heartbeats: Row[]
  commands: Row[]
  audit: Row[]
  api_errors: Row[]
  backup_history: Row[]
  settings: Record<string, any>
  hmd: Record<string, Row> // 가상 HMD 로컬 상태 (outbox, 배정, 미션 진행)
}

export const DEFAULT_SETTINGS: Record<string, [any, string]> = {
  heartbeat_interval_sec: [30, 'HMD heartbeat 전송 주기(초)'],
  offline_threshold_sec: [90, '이 시간 동안 heartbeat 미수신 시 오프라인 판정(초)'],
  delay_threshold_sec: [60, "이 시간 이상 heartbeat 지연 시 '주의' 판정(초)"],
  battery_warning_pct: [20, '배터리 주의 임계치(%)'],
  error_hold_sec: [300, "오류 이벤트 보고 후 '오류' 상태 유지 시간(초)"],
  sync_batch_size: [50, 'HMD 결과 업로드 batch 크기'],
  sync_retry_base_sec: [5, '동기화 재시도 최초 대기(초)'],
  sync_retry_max_sec: [300, '동기화 재시도 최대 대기(초)'],
  backup_dir: ['', '백업 경로 (비우면 기본 경로)'],
  auto_backup_enabled: [true, '날짜별 자동 백업 사용'],
  auto_backup_hour: [18, '자동 백업 시각(시, 0~23)'],
  backup_keep_count: [30, '자동 백업 보관 개수'],
  log_retention_days: [90, '로그 보관 기간(일)'],
  result_retention_days: [0, '학습 결과 보관 기간(일, 0=무기한)'],
  token_expire_minutes: [480, '관리자 로그인 유지 시간(분)'],
  login_max_failures: [5, '로그인 실패 허용 횟수'],
  login_lock_minutes: [10, '로그인 잠금 시간(분)'],
  require_device_key: [true, 'HMD 요청 시 장비 키(X-Device-Key) 검증'],
  device_api_key: ['', 'HMD 공용 장비 키'],
}

export const DEMO_CONTENTS: [string, string, string, string, string[]][] = [
  ['SAFETY-01', '산업 현장 안전 — 지게차 위험 요소 찾기', 'safety', '1.0.0', ['FORKLIFT-HAZARD-01', 'FORKLIFT-HAZARD-02', 'PPE-CHECK-01', 'EVAC-ROUTE-01']],
  ['CAREER-01', '미래 직업 체험 — 드론 정비사', 'career', '1.0.0', ['DRONE-PARTS-01', 'DRONE-PARTS-02', 'DRONE-FLIGHT-01']],
  ['ENV-01', '환경 — 분리배출 미션', 'environment', '1.0.0', ['RECYCLE-01', 'RECYCLE-02', 'RECYCLE-03', 'RECYCLE-04', 'RECYCLE-05']],
]
export const MISSIONS: Record<string, string[]> = Object.fromEntries(DEMO_CONTENTS.map((c) => [c[0], c[4]]))

export const nowIso = () => new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', '+00:00')
export const todayLocal = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)

/** 데모 전용 비밀번호 해시 (브라우저 안에서만 쓰이는 데모 데이터) */
export function demoHash(pw: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < pw.length; i++) { h ^= pw.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return `demo-fnv1a$${(h >>> 0).toString(16)}`
}

export function nextId(db: DB, table: string): number {
  db.seq[table] = (db.seq[table] ?? 0) + 1
  return db.seq[table]
}

export function seed(): DB {
  const now = nowIso()
  const db: DB = {
    seq: {}, users: [], devices: [], contents: [], content_versions: [], content_installs: [], deploy_jobs: [],
    sessions: [], participants: [], results: [], corrections: [], rejections: [], sync_logs: [], events: [],
    progress: [], heartbeats: [], commands: [], audit: [], api_errors: [], backup_history: [], settings: {}, hmd: {},
  }
  for (const [k, [v]] of Object.entries(DEFAULT_SETTINGS)) db.settings[k] = v
  db.settings.device_api_key = uuid().replace(/-/g, '').slice(0, 32)
  // 웹 데모는 단절·복구가 화면에 빨리 보이도록 판정 시간을 짧게 둔다 (설정 화면에서 변경 가능)
  Object.assign(db.settings, { heartbeat_interval_sec: 15, delay_threshold_sec: 20, offline_threshold_sec: 30 })
  db.users.push({ id: nextId(db, 'users'), username: 'admin', display_name: '시스템 관리자', password_hash: demoHash('admin1234'), role: 'admin', active: 1, failed_attempts: 0, locked_until: null, must_change_password: 0, created_at: now, last_login_at: null })
  for (let i = 1; i <= 20; i++) {
    db.devices.push({
      id: nextId(db, 'devices'), device_id: `HMD-${String(i).padStart(2, '0')}`, device_name: null, model: 'Meta Quest 3', app_version: null,
      content_version: null, last_seen_at: null, last_sync_at: null, connection_status: 'unknown', app_status: 'unknown', battery_level: null,
      storage_available: null, last_error_code: null, last_error_at: null, reported_pending_count: null, reported_sent_total: null,
      is_simulated: 1, active: 1, notes: null, created_at: now, updated_at: now,
    })
  }
  for (const [cid, title, cat, ver, missions] of DEMO_CONTENTS) {
    db.contents.push({ id: nextId(db, 'contents'), content_id: cid, title, category: cat, description: `[데모] 미션: ${missions.join(', ')}`, version: ver, package_name: `com.mredu.${cid.toLowerCase()}.apk`, package_size: null, supported_models: 'Meta Quest 3', active: 1, created_at: now, updated_at: now })
    db.content_versions.push({ id: nextId(db, 'content_versions'), content_id: cid, version: ver, package_name: null, package_size: null, release_notes: '[데모] 최초 등록', created_at: now })
  }
  const today = todayLocal()
  const sid = nextId(db, 'sessions')
  db.sessions.push({
    id: sid, session_code: `SESSION-${today.replace(/-/g, '')}-001`, institution_name: '[데모] 한빛초등학교', institution_code: null, grade: '5', class_group: '2', session_no: 1,
    session_date: today, topic: '산업 안전 체험', content_id: 'SAFETY-01', scheduled_start_at: null, instructor: '데모 강사', expected_students: 20,
    memo: '웹 데모용으로 자동 생성된 세션입니다', status: 'running', started_at: now, ended_at: null, deleted: 0, created_at: now, updated_at: now,
  })
  for (let i = 1; i <= 20; i++) db.participants.push({ id: nextId(db, 'participants'), session_id: sid, student_code: `S${String(i).padStart(3, '0')}`, device_id: `HMD-${String(i).padStart(2, '0')}`, created_at: now })
  return db
}

const LOG_CAPS: Record<string, number> = { heartbeats: 600, events: 1500, sync_logs: 400, audit: 400, api_errors: 200, rejections: 300 }

export function trim(db: DB) {
  for (const [k, cap] of Object.entries(LOG_CAPS)) {
    const arr = (db as any)[k] as Row[]
    if (arr.length > cap) arr.splice(0, arr.length - cap)
  }
}

export function load(): DB {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as DB
  } catch { /* 저장소 사용 불가 → 새 데이터 */ }
  return seed()
}

export function save(db: DB) {
  trim(db)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  } catch {
    // 용량 초과 시 로그를 더 줄여 재시도
    db.heartbeats.splice(0, db.heartbeats.length - 100)
    db.events.splice(0, db.events.length - 300)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)) } catch { /* 저장 실패해도 메모리에서는 계속 동작 */ }
  }
}
