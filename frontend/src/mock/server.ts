// 정적 웹 데모용 가짜 API 서버. backend/app/routers/* 와 같은 경로·응답 형식을 브라우저 안에서 흉내 낸다.
// 실제 운영에서는 사용되지 않는다 (VITE_DEMO_STATIC=1 빌드에서만 활성화).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ApiError } from '../api'
import { DEFAULT_SETTINGS, MISSIONS, type DB, type Row, BACKUP_KEY, STORAGE_KEY, demoHash, load, nextId, nowIso, save, seed, uuid } from './store'

export let db: DB = load()
let saveTimer: number | undefined
export function persist() {
  // 최대 1.5초에 한 번 저장 (자주 호출돼도 저장이 밀리지 않도록 throttle)
  if (saveTimer !== undefined) return
  saveTimer = window.setTimeout(() => { saveTimer = undefined; save(db) }, 1500)
}
window.addEventListener('beforeunload', () => save(db))

// ---------- 실시간 이벤트 (WebSocket 대체) ----------
type Listener = (ev: { type: string; data: Row; server_time: string }) => void
const listeners = new Set<Listener>()
export const bus = {
  on: (fn: Listener) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  emit: (type: string, data: Row = {}) => listeners.forEach((fn) => fn({ type, data, server_time: nowIso() })),
}

// ---------- 공통 ----------
const LABELS = { normal: '정상', warning: '주의', offline: '오프라인', error: '오류', unknown: '확인 불가', inactive: '비활성' } as const
export const SESSION_LABEL: Record<string, string> = { draft: '작성 중', ready: '준비 완료', running: '진행 중', completed: '완료', cancelled: '취소' }
const ROLE_LABELS: Record<string, string> = { admin: '시스템 관리자', operator: '교육 운영자', viewer: '조회 전용' }
const CATEGORY_LABELS: Record<string, string> = { career: '진로', safety: '안전', environment: '환경' }
const STUDENT_RE = /^[A-Za-z0-9_-]{1,32}$/
const DEVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/

const err = (status: number, message: string, detail?: unknown) => new ApiError(status, message, detail ?? message)
const secondsSince = (iso?: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 1000 : null)
const avg = (vals: (number | null | undefined)[]) => {
  const v = vals.filter((x): x is number => x !== null && x !== undefined)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
const r1 = (v: number | null, n = 1) => (v === null ? null : Math.round(v * 10 ** n) / 10 ** n)
const pct = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 10)
const effC = (r: Row) => (r.corrected_is_correct ?? r.is_correct) as number | null
const effS = (r: Row) => (r.corrected_score ?? r.score) as number | null

function audit(user: Row | null, action: string, target_type?: string, target_id?: any, detail?: Row) {
  const clean = detail ? JSON.parse(JSON.stringify(detail, (k, v) => (/password|device_api_key/.test(k) ? '***' : v))) : null
  db.audit.push({ id: nextId(db, 'audit'), admin_user_id: user?.id ?? null, action, target_type: target_type ?? null, target_id: target_id === undefined || target_id === null ? null : String(target_id), detail_json: clean ? JSON.stringify(clean) : null, created_at: nowIso() })
}

// ---------- 장비 상태 판정 (backend/app/status.py 와 동일 규칙) ----------
export function evaluate(d: Row): Row {
  const s = db.settings
  const age = secondsSince(d.last_seen_at)
  const conn = age === null ? 'unknown' : age > s.offline_threshold_sec ? 'offline' : 'online'
  const reasons: string[] = []
  let health: keyof typeof LABELS
  if (!d.active) { health = 'inactive'; reasons.push('비활성화된 장비') }
  else if (conn === 'unknown') { health = 'unknown'; reasons.push('통신 기록 없음') }
  else if (conn === 'offline') { health = 'offline'; reasons.push(`마지막 통신 ${Math.floor(age! / 60)}분 ${Math.floor(age! % 60)}초 전 (기준 시각 이후 미수신)`) }
  else {
    const ea = secondsSince(d.last_error_at)
    if (d.app_status === 'error' || (ea !== null && ea <= s.error_hold_sec)) { health = 'error'; reasons.push(`앱 오류 보고${d.last_error_code ? ` (${d.last_error_code})` : ''}`) }
    else {
      health = 'normal'
      if (d.battery_level !== null && d.battery_level <= s.battery_warning_pct) { health = 'warning'; reasons.push(`배터리 ${d.battery_level}% (임계치 ${s.battery_warning_pct}%)`) }
      if (age! > s.delay_threshold_sec) { health = 'warning'; reasons.push(`통신 지연 ${Math.floor(age!)}초`) }
    }
  }
  return { ...d, connection_status: conn, seconds_since_seen: age === null ? null : Math.floor(age), health, health_label: LABELS[health], health_reasons: reasons }
}

function sessionById(id: number) {
  const s = db.sessions.find((x) => x.id === Number(id) && !x.deleted)
  if (!s) throw err(404, '세션을 찾을 수 없습니다')
  return s
}
const sessionByCode = (code: string) => db.sessions.find((x) => x.session_code === code && !x.deleted)
function deviceById(id: string) {
  const d = db.devices.find((x) => x.device_id === id)
  if (!d) throw err(404, `등록되지 않은 장비입니다: ${id}`)
  return d
}
const partsOf = (sid: number) => db.participants.filter((p) => p.session_id === sid)
const resultsOf = (code: string) => db.results.filter((r) => r.session_id === code)
const contentTitle = (cid?: string | null) => db.contents.find((c) => c.content_id === cid)?.title ?? null

export function currentAssignments(): Record<string, Row> {
  const out: Record<string, Row> = {}
  const ss = db.sessions.filter((s) => !s.deleted && (s.status === 'ready' || s.status === 'running'))
    .sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || a.session_date.localeCompare(b.session_date))
  for (const s of ss) for (const p of partsOf(s.id)) if (p.device_id && !out[p.device_id])
    out[p.device_id] = { device_id: p.device_id, student_code: p.student_code, session_pk: s.id, session_code: s.session_code, status: s.status, content_id: s.content_id }
  return out
}

function devicesEvaluated(includeInactive = true): Row[] {
  const a = currentAssignments()
  return db.devices.filter((d) => includeInactive || d.active).sort((x, y) => x.device_id.localeCompare(y.device_id))
    .map((d) => ({ ...evaluate(d), assignment: a[d.device_id] ?? null }))
}

// ---------- 결과 필터·통계 (backend/app/analytics.py) ----------
function filterResults(f: Row): Row[] {
  return db.results.filter((r) => {
    const s = sessionByCode(r.session_id) ?? ({} as Row)
    if (f.session_id && r.session_id !== f.session_id) return false
    for (const k of ['device_id', 'student_code', 'content_id', 'mission_id']) if (f[k] && r[k] !== f[k]) return false
    if (f.grade && s.grade !== f.grade) return false
    if (f.class_group && s.class_group !== f.class_group) return false
    if (f.institution && !(s.institution_name ?? '').includes(f.institution)) return false
    if (f.date_from && (s.session_date ?? '') < f.date_from) return false
    if (f.date_to && (s.session_date ?? '') > f.date_to) return false
    if (f.is_correct === 'true' && effC(r) !== 1) return false
    if (f.is_correct === 'false' && effC(r) !== 0) return false
    if (f.q && ![r.student_code, r.mission_id, r.device_id, r.event_id].some((x) => String(x).includes(f.q))) return false
    return true
  })
}

function decorate(r: Row): Row {
  const s = sessionByCode(r.session_id) ?? ({} as Row)
  return { ...r, eff_is_correct: effC(r), eff_score: effS(r), institution_name: s.institution_name, grade: s.grade, class_group: s.class_group, session_no: s.session_no, session_date: s.session_date, session_pk: s.id, content_title: contentTitle(r.content_id) }
}

function groupBy<T>(arr: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const x of arr) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k)!.push(x) }
  return m
}
const acc = (rs: Row[]) => avg(rs.map(effC).filter((x) => x !== null))

function stats(f: Row) {
  const rs = filterResults(f)
  const by_mission = [...groupBy(rs, (r) => `${r.content_id}|${r.mission_id}`).values()].map((g) => ({
    mission_id: g[0].mission_id, content_id: g[0].content_id, attempts: g.length, correct: g.filter((r) => effC(r) === 1).length,
    accuracy: acc(g), avg_score: avg(g.map(effS)), avg_duration: avg(g.map((r) => r.duration_seconds)), avg_attempts: avg(g.map((r) => r.attempt_count)),
  })).sort((a, b) => (a.content_id + a.mission_id).localeCompare(b.content_id + b.mission_id))
  const by_content = [...groupBy(rs, (r) => r.content_id).values()].map((g) => ({
    content_id: g[0].content_id, title: contentTitle(g[0].content_id), result_count: g.length, student_count: new Set(g.map((r) => `${r.session_id}|${r.student_code}`)).size,
    avg_score: avg(g.map(effS)), accuracy: acc(g), avg_duration: avg(g.map((r) => r.duration_seconds)),
  }))
  const wrong = [...groupBy(rs.filter((r) => effC(r) === 0), (r) => `${r.mission_id}|${r.answer_json}`).values()]
    .map((g) => ({ mission_id: g[0].mission_id, answer: g[0].answer_json, count: g.length })).sort((a, b) => b.count - a.count).slice(0, 20)
  return {
    overall: { result_count: rs.length, student_count: new Set(rs.map((r) => `${r.session_id}|${r.student_code}`)).size, avg_score: avg(rs.map(effS)), avg_duration: avg(rs.map((r) => r.duration_seconds)), accuracy: acc(rs) },
    by_mission, by_content, wrong_answers: wrong,
  }
}

// ---------- 세션 ----------
function sessionSummary(s: Row): Row {
  const parts = partsOf(s.id)
  return {
    ...s, status_label: SESSION_LABEL[s.status], participant_count: parts.length, assigned_count: parts.filter((p) => p.device_id).length,
    result_count: resultsOf(s.session_code).length, completed_students: db.progress.filter((g) => g.session_id === s.session_code && g.state === 'completed').length,
    content_title: contentTitle(s.content_id),
  }
}
function sessionWarnings(s: Row) {
  const parts = partsOf(s.id); const assigned = parts.filter((p) => p.device_id).length
  const w: string[] = []
  if (s.expected_students !== null && s.expected_students !== undefined && s.expected_students !== parts.length) w.push(`참여 예정 학생 수(${s.expected_students}명)와 등록 학생 수(${parts.length}명)가 다릅니다`)
  if (assigned < parts.length) w.push(`HMD 미배정 학생 ${parts.length - assigned}명`)
  if (!parts.length) w.push('등록된 학생이 없습니다')
  if (!s.content_id) w.push('콘텐츠가 선택되지 않았습니다')
  return w
}
function sessionDetail(id: number) {
  const s = sessionById(id)
  const rs = resultsOf(s.session_code)
  return {
    ...sessionSummary(s), warnings: sessionWarnings(s),
    participants: partsOf(s.id).sort((a, b) => a.student_code.localeCompare(b.student_code)).map((p) => ({ id: p.id, student_code: p.student_code, device_id: p.device_id, result_count: rs.filter((r) => r.student_code === p.student_code).length })),
  }
}
function validateParticipants(list: Row[]) {
  const codes = new Set<string>(); const devs = new Set<string>()
  for (const p of list) {
    const code = String(p.student_code ?? '').trim()
    if (!STUDENT_RE.test(code)) throw err(422, `입력값 오류 — 익명 학생 코드는 영문·숫자·-·_ 1~32자만 가능합니다 (실명 입력 금지): '${code}'`)
    if (codes.has(code)) throw err(400, `학생 코드가 중복되었습니다: ${code}`)
    codes.add(code)
    if (p.device_id) {
      if (devs.has(p.device_id)) throw err(400, `한 장비를 두 학생에게 배정할 수 없습니다: ${p.device_id}`)
      devs.add(p.device_id)
      const d = db.devices.find((x) => x.device_id === p.device_id)
      if (!d) throw err(400, `등록되지 않은 장비입니다: ${p.device_id}`)
      if (!d.active) throw err(400, `비활성화된 장비입니다: ${p.device_id}`)
    }
  }
}
function replaceParticipants(sid: number, list: Row[]) {
  validateParticipants(list)
  db.participants = db.participants.filter((p) => p.session_id !== sid)
  const now = nowIso()
  for (const p of list) db.participants.push({ id: nextId(db, 'participants'), session_id: sid, student_code: String(p.student_code).trim(), device_id: p.device_id || null, created_at: now })
}
function checkContent(cid?: string | null) {
  if (!cid) return
  const c = db.contents.find((x) => x.content_id === cid)
  if (!c) throw err(400, `등록되지 않은 콘텐츠입니다: ${cid}`)
  if (!c.active) throw err(400, `비활성화된 콘텐츠입니다: ${cid}`)
}
function nextCode(date: string) {
  const prefix = `SESSION-${date.replace(/-/g, '')}-`
  const nums = db.sessions.filter((s) => s.session_code.startsWith(prefix)).map((s) => Number(s.session_code.slice(prefix.length))).filter((n) => !isNaN(n))
  return `${prefix}${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`
}
const busyDevices = (exclude: number) => new Set(db.sessions.filter((s) => s.status === 'running' && !s.deleted && s.id !== exclude).flatMap((s) => partsOf(s.id).map((p) => p.device_id).filter(Boolean)))

function syncCheck(s: Row) {
  const issues: Row[] = []
  for (const p of partsOf(s.id)) {
    if (!p.device_id) continue
    const d = db.devices.find((x) => x.device_id === p.device_id)!
    const ev = evaluate(d)
    const cnt = resultsOf(s.session_code).filter((r) => r.student_code === p.student_code).length
    if (d.reported_pending_count) issues.push({ device_id: p.device_id, student_code: p.student_code, type: 'pending', message: `HMD 미전송 결과 ${d.reported_pending_count}건 (HMD 보고 기준)` })
    if (ev.connection_status !== 'online') issues.push({ device_id: p.device_id, student_code: p.student_code, type: 'offline', message: '오프라인 — HMD에 남은 결과를 확인할 수 없음' })
    if (!cnt) issues.push({ device_id: p.device_id, student_code: p.student_code, type: 'no_result', message: '수신된 결과 없음' })
  }
  return { ok: !issues.length, issues }
}

function progress(id: number) {
  const s = sessionById(id)
  const items = partsOf(s.id).sort((a, b) => (a.device_id ? 0 : 1) - (b.device_id ? 0 : 1) || String(a.device_id).localeCompare(String(b.device_id))).map((p) => {
    const d = p.device_id ? db.devices.find((x) => x.device_id === p.device_id) : null
    const ev = d ? evaluate(d) : null
    const g = db.progress.find((x) => x.session_id === s.session_code && x.device_id === p.device_id)
    const rs = resultsOf(s.session_code).filter((r) => r.student_code === p.student_code)
    let live = 'waiting'
    if (!ev) live = 'unassigned'
    else if (ev.health === 'offline' || ev.health === 'unknown') live = 'offline'
    else if (ev.health === 'error' || g?.state === 'error') live = 'error'
    else if (g?.state === 'completed') live = 'completed'
    else if (g?.state === 'in_progress') live = 'in_progress'
    const pending = d?.reported_pending_count ?? null
    return {
      student_code: p.student_code, device_id: p.device_id, health: ev?.health ?? null, health_label: ev?.health_label ?? '미배정', battery_level: d?.battery_level ?? null,
      live_state: live, mission_id: g?.mission_id ?? null, step: g?.step ?? null, progress: g?.progress ?? null, last_report_at: g?.last_report_at ?? d?.last_seen_at ?? null,
      result_count: rs.length, last_result_at: rs.length ? rs[rs.length - 1].received_at : null, pending_count: pending,
      upload_state: pending === null ? 'unknown' : pending > 0 ? 'pending' : 'synced',
    }
  })
  const counts: Record<string, number> = {}
  for (const i of items) counts[i.live_state] = (counts[i.live_state] ?? 0) + 1
  const vals = items.map((i) => i.progress ?? (i.live_state === 'completed' ? 1 : 0))
  return { session: { ...s, status_label: SESSION_LABEL[s.status], content_title: contentTitle(s.content_id) }, items, summary: { total: items.length, counts, overall_progress: items.length ? vals.reduce((a, b) => a + b, 0) / items.length : 0 }, server_time: nowIso() }
}

// ---------- 보고서 ----------
function studentsOf(s: Row) {
  return partsOf(s.id).sort((a, b) => a.student_code.localeCompare(b.student_code)).map((p) => {
    const rs = resultsOf(s.session_code).filter((r) => r.student_code === p.student_code)
    const st = db.progress.find((g) => g.session_id === s.session_code && g.device_id === p.device_id)?.state ?? null
    return { student_code: p.student_code, device_id: p.device_id, result_count: rs.length, avg_score: avg(rs.map(effS)), accuracy: acc(rs), total_duration: rs.length ? rs.reduce((a, r) => a + (r.duration_seconds ?? 0), 0) : null, progress_state: st }
  })
}
function sessionReport(id: number) {
  const s = sessionById(id)
  const c = db.contents.find((x) => x.content_id === s.content_id)
  const st = stats({ session_id: s.session_code })
  const students = studentsOf(s)
  const completed = students.filter((x) => x.progress_state === 'completed').length
  const withResults = students.filter((x) => x.result_count > 0).length
  const missions = st.by_mission.map((m) => ({ ...m, accuracy_pct: pct(m.accuracy), avg_score: r1(m.avg_score), avg_duration: r1(m.avg_duration), avg_attempts: r1(m.avg_attempts, 2) }))
  const relearn = missions.filter((m) => m.accuracy !== null && m.accuracy < 0.6)
  const check = ['running', 'completed'].includes(s.status) ? syncCheck(s) : { issues: [] as Row[] }
  const rej = db.rejections.filter((x) => x.session_id === s.session_code).length
  const notes = check.issues.map((i) => `${i.device_id} (${i.student_code}): ${i.message}`)
  if (rej) notes.push(`서버가 거부한 결과 ${rej}건`)
  const gc = [s.grade && `${s.grade}학년`, s.class_group && `${s.class_group}반`, s.session_no && `${s.session_no}회차`].filter(Boolean).join(' ') || '-'
  const o = st.overall
  return {
    title: `수업 운영 보고서 — ${s.institution_name} ${s.session_date}`, session: { ...s, status_label: SESSION_LABEL[s.status] },
    summary: { participants: students.length, completed, with_results: withResults, avg_score: r1(o.avg_score), accuracy_pct: pct(o.accuracy), avg_duration: r1(o.avg_duration), result_count: o.result_count },
    relearn, notes,
    meta: [['기관명', s.institution_name], ['교육일', s.session_date], ['학년·학급·회차', gc], ['교육 콘텐츠', c ? `${c.title} (v${c.version})` : (s.content_id ?? '-')],
      ['담당 강사', s.instructor || '-'], ['세션 코드', s.session_code], ['세션 상태', SESSION_LABEL[s.status]], ['참여 인원', students.length], ['완료 인원', completed],
      ['결과 수신 인원', withResults], ['평균 점수', r1(o.avg_score)], ['전체 정답률(%)', pct(o.accuracy)],
      ['재학습 권장 항목', relearn.map((m) => m.mission_id).join(', ') || '없음'], ['장비·동기화 특이사항', notes.join(' / ') || '없음'], ['보고서 생성 시각', new Date().toLocaleString('ko-KR')]],
    tables: [
      { title: '미션별 정답률', columns: [['mission_id', '미션'], ['attempts', '응답 수'], ['correct', '정답 수'], ['accuracy_pct', '정답률(%)'], ['avg_score', '평균 점수'], ['avg_attempts', '평균 시도'], ['avg_duration', '평균 수행시간(초)']], rows: missions },
      { title: '학생별 수행 결과', columns: [['student_code', '학생 코드'], ['device_id', 'HMD'], ['result_count', '결과 수'], ['avg_score', '평균 점수'], ['accuracy_pct', '정답률(%)'], ['total_duration', '총 수행시간(초)'], ['state', '진행 상태']],
        rows: students.map((x) => ({ ...x, avg_score: r1(x.avg_score), accuracy_pct: pct(x.accuracy), total_duration: r1(x.total_duration), state: ({ completed: '완료', in_progress: '진행 중', waiting: '대기', error: '오류' } as Row)[x.progress_state ?? ''] ?? '미보고' })) },
      { title: '오답 유형', columns: [['mission_id', '미션'], ['answer', '선택 답안'], ['count', '횟수']], rows: st.wrong_answers },
    ],
  }
}
const REPORT_TYPES: Record<string, string> = { operations: '수업 운영 요약', class_performance: '학급별 학습 성과', students: '학생별 수행 결과', content_effect: '콘텐츠별 효과 분석', mission_accuracy: '미션별 정답률', device_incidents: '장비 운영·장애 이력', results_raw: '학습 결과 원본' }
function genericReport(type: string, f: Row) {
  if (!REPORT_TYPES[type]) throw err(404, '알 수 없는 보고서 종류입니다')
  const title = REPORT_TYPES[type]
  const meta = [['기간', `${f.date_from || '처음'} ~ ${f.date_to || '현재'}`], ['기관', f.institution || '전체'], ['콘텐츠', f.content_id || '전체'], ['생성 시각', new Date().toLocaleString('ko-KR')]]
  const rs = filterResults(f)
  let columns: string[][] = []; let rows: Row[] = []
  if (type === 'operations') {
    rows = db.sessions.filter((s) => !s.deleted && (!f.date_from || s.session_date >= f.date_from) && (!f.date_to || s.session_date <= f.date_to) && (!f.content_id || s.content_id === f.content_id) && (!f.institution || s.institution_name.includes(f.institution)))
      .map((s) => { const r = resultsOf(s.session_code); return { session_code: s.session_code, session_date: s.session_date, institution_name: s.institution_name, grade: s.grade, class_group: s.class_group, session_no: s.session_no, content_id: s.content_id, instructor: s.instructor, status: SESSION_LABEL[s.status], participants: partsOf(s.id).length, completed: db.progress.filter((g) => g.session_id === s.session_code && g.state === 'completed').length, students_with_results: new Set(r.map((x) => x.student_code)).size, avg_score: r1(avg(r.map(effS))), accuracy_pct: pct(acc(r)) } })
    columns = [['session_code', '세션 코드'], ['session_date', '교육일'], ['institution_name', '기관'], ['grade', '학년'], ['class_group', '학급'], ['session_no', '회차'], ['content_id', '콘텐츠'], ['instructor', '강사'], ['status', '상태'], ['participants', '참여'], ['completed', '완료'], ['students_with_results', '결과 수신 인원'], ['avg_score', '평균 점수'], ['accuracy_pct', '정답률(%)']]
  } else if (type === 'class_performance') {
    rows = [...groupBy(rs, (r) => { const s = sessionByCode(r.session_id) ?? {}; return `${s.institution_name}|${s.grade}|${s.class_group}` }).values()].map((g) => { const s = sessionByCode(g[0].session_id) ?? {}; return { institution_name: s.institution_name, grade: s.grade, class_group: s.class_group, sessions: new Set(g.map((r) => r.session_id)).size, students: new Set(g.map((r) => `${r.session_id}|${r.student_code}`)).size, results: g.length, avg_score: r1(avg(g.map(effS))), accuracy_pct: pct(acc(g)), avg_duration: r1(avg(g.map((r) => r.duration_seconds))) } })
    columns = [['institution_name', '기관'], ['grade', '학년'], ['class_group', '학급'], ['sessions', '세션 수'], ['students', '학생 수'], ['results', '결과 수'], ['avg_score', '평균 점수'], ['accuracy_pct', '정답률(%)'], ['avg_duration', '평균 수행시간(초)']]
  } else if (type === 'students') {
    rows = [...groupBy(rs, (r) => `${r.session_id}|${r.student_code}`).values()].map((g) => { const s = sessionByCode(g[0].session_id) ?? {}; return { session_id: g[0].session_id, session_date: s.session_date, institution_name: s.institution_name, student_code: g[0].student_code, device_id: g[0].device_id, results: g.length, avg_score: r1(avg(g.map(effS))), accuracy_pct: pct(acc(g)), total_duration: r1(g.reduce((a, r) => a + (r.duration_seconds ?? 0), 0)) } })
    columns = [['session_id', '세션'], ['session_date', '교육일'], ['institution_name', '기관'], ['student_code', '학생 코드'], ['device_id', 'HMD'], ['results', '결과 수'], ['avg_score', '평균 점수'], ['accuracy_pct', '정답률(%)'], ['total_duration', '총 수행시간(초)']]
  } else if (type === 'content_effect') {
    rows = stats(f).by_content.map((c) => ({ ...c, avg_score: r1(c.avg_score), accuracy_pct: pct(c.accuracy), avg_duration: r1(c.avg_duration) }))
    columns = [['content_id', '콘텐츠 ID'], ['title', '콘텐츠명'], ['student_count', '학습자 수'], ['result_count', '결과 수'], ['avg_score', '평균 점수'], ['accuracy_pct', '정답률(%)'], ['avg_duration', '평균 수행시간(초)']]
  } else if (type === 'mission_accuracy') {
    rows = stats(f).by_mission.map((m) => ({ ...m, accuracy_pct: pct(m.accuracy), avg_score: r1(m.avg_score), avg_duration: r1(m.avg_duration), relearn: m.accuracy !== null && m.accuracy < 0.6 ? '권장' : '' }))
    columns = [['content_id', '콘텐츠'], ['mission_id', '미션'], ['attempts', '응답 수'], ['correct', '정답 수'], ['accuracy_pct', '정답률(%)'], ['avg_score', '평균 점수'], ['avg_duration', '평균 수행시간(초)'], ['relearn', '재학습']]
  } else if (type === 'device_incidents') {
    const devRows = db.devices.map((d) => ({ device_id: d.device_id, model: d.model, app_version: d.app_version, last_seen_at: d.last_seen_at ? new Date(d.last_seen_at).toLocaleString('ko-KR') : '', last_error_code: d.last_error_code, errors: db.events.filter((e) => e.device_id === d.device_id && e.event_type === 'app.error').length, rejections: db.rejections.filter((x) => x.device_id === d.device_id).length, uploads: db.sync_logs.filter((l) => l.device_id === d.device_id).length }))
    rows = [...db.events.filter((e) => e.event_type === 'app.error').map((e) => ({ at: e.occurred_at, device_id: e.device_id, type: '앱 오류', session_id: e.session_id, detail: e.payload_json })),
      ...db.rejections.map((x) => ({ at: x.received_at, device_id: x.device_id, type: '결과 거부', session_id: x.session_id, detail: x.reason }))].sort((a, b) => b.at.localeCompare(a.at))
    return { title, meta, tables: [
      { title: '장비별 현황', columns: [['device_id', '장비'], ['model', '모델'], ['app_version', '앱 버전'], ['last_seen_at', '마지막 통신'], ['last_error_code', '최근 오류'], ['errors', '오류 수'], ['rejections', '결과 거부'], ['uploads', '업로드 횟수']], rows: devRows },
      { title: '장애 이력', columns: [['at', '시각'], ['device_id', '장비'], ['type', '유형'], ['session_id', '세션'], ['detail', '내용']], rows }] }
  } else {
    rows = rs.map((r) => ({ ...decorate(r), eff_is_correct: ({ 1: 'O', 0: 'X' } as Row)[effC(r) ?? -1] ?? '' }))
    columns = [['result_id', 'result_id'], ['event_id', 'event_id'], ['session_id', '세션'], ['device_id', 'HMD'], ['student_code', '학생 코드'], ['content_id', '콘텐츠'], ['mission_id', '미션'], ['answer_json', '답안'], ['eff_is_correct', '정답'], ['eff_score', '점수'], ['attempt_count', '시도'], ['duration_seconds', '수행시간(초)'], ['occurred_at', '발생 시각'], ['received_at', '수신 시각'], ['sync_status', '상태']]
  }
  return { title, meta, tables: [{ title, columns, rows }] }
}

export function reportToCsv(rep: Row): string {
  const esc = (v: any) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const lines = [esc(rep.title)]
  for (const [l, v] of rep.meta ?? []) lines.push(`${esc(l)},${esc(v)}`)
  for (const t of rep.tables) {
    lines.push('', esc(t.title), t.columns.map((c: string[]) => esc(c[1])).join(','))
    for (const r of t.rows) lines.push(t.columns.map((c: string[]) => esc(r[c[0]])).join(','))
  }
  return '﻿' + lines.join('\r\n')
}

// ---------- HMD 수신 (backend/app/routers/sync.py, devices.heartbeat) ----------
export function hmdHeartbeat(body: Row) {
  const d = deviceById(body.device_id)
  if (!d.active) throw err(403, '비활성화된 장비입니다')
  const was = evaluate(d).connection_status
  const now = nowIso()
  const prevApp = d.app_status
  Object.assign(d, {
    app_version: body.app_version ?? d.app_version, content_version: body.content_version ?? d.content_version, app_status: body.app_status ?? 'unknown',
    battery_level: body.battery_level ?? null, storage_available: body.storage_available ?? null, last_seen_at: now, connection_status: 'online',
    last_error_code: body.error_code ?? d.last_error_code, last_error_at: body.error_code || body.app_status === 'error' ? now : d.last_error_at,
    reported_pending_count: body.pending_count ?? null, reported_sent_total: body.sent_total ?? null, is_simulated: body.simulated ? 1 : 0, updated_at: now,
  })
  for (const ic of body.installed_contents ?? []) {
    const ex = db.content_installs.find((i) => i.device_id === d.device_id && i.content_id === ic.content_id)
    if (ex) Object.assign(ex, { version: ic.version, source: 'reported', status: 'installed', updated_at: now })
    else db.content_installs.push({ device_id: d.device_id, content_id: ic.content_id, version: ic.version, source: 'reported', status: 'installed', updated_at: now })
  }
  db.heartbeats.push({ id: nextId(db, 'heartbeats'), device_id: d.device_id, payload_json: JSON.stringify(body), received_at: now })
  const cmds = db.commands.filter((c) => c.device_id === d.device_id && c.status === 'pending')
  cmds.forEach((c) => { c.status = 'delivered'; c.delivered_at = now })
  if (was !== 'online') bus.emit('device.connected', { device_id: d.device_id })
  if (prevApp !== d.app_status) bus.emit('device.app_status_changed', { device_id: d.device_id })
  bus.emit('device.heartbeat', { device_id: d.device_id })
  const s = db.settings
  return { success: true, server_time: now, heartbeat_interval_sec: s.heartbeat_interval_sec, sync: { batch_size: s.sync_batch_size, retry_base_sec: s.sync_retry_base_sec, retry_max_sec: s.sync_retry_max_sec }, commands: cmds.map((c) => ({ id: c.id, command: c.command, payload: {} })) }
}

export function hmdAssignment(deviceId: string) {
  deviceById(deviceId)
  const a = currentAssignments()[deviceId]
  if (!a) return { assigned: false }
  const s = sessionById(a.session_pk)
  const c = db.contents.find((x) => x.content_id === s.content_id)
  return { assigned: true, session_id: s.session_code, session_status: s.status, student_code: a.student_code, content: c ? { content_id: c.content_id, title: c.title, version: c.version } : null, institution_name: s.institution_name, session_date: s.session_date }
}

export function hmdResults(body: Row) {
  const now = nowIso()
  deviceById(body.device_id)
  const s = sessionByCode(body.session_id)
  const students = new Set(s ? partsOf(s.id).map((p) => p.student_code) : [])
  const accepted: string[] = []; const duplicates: string[] = []; const rejected: Row[] = []
  const reject = (raw: Row, reason: string) => {
    rejected.push({ event_id: raw.event_id ?? null, result_id: raw.result_id ?? null, reason })
    db.rejections.push({ id: nextId(db, 'rejections'), device_id: body.device_id, session_id: body.session_id, event_id: raw.event_id ?? null, result_id: raw.result_id ?? null, reason, payload_json: JSON.stringify(raw).slice(0, 2000), received_at: now })
  }
  for (const raw of body.results as Row[]) {
    const missing = ['result_id', 'event_id', 'student_code', 'content_id', 'mission_id', 'occurred_at'].filter((k) => !raw[k])
    if (missing.length) { reject(raw, `입력 검증 실패: ${missing.join(', ')} 누락`); continue }
    if (isNaN(new Date(raw.occurred_at).getTime())) { reject(raw, '입력 검증 실패: occurred_at: ISO 8601 형식의 시각이 아닙니다'); continue }
    const ex = db.results.filter((r) => r.event_id === raw.event_id || r.result_id === raw.result_id)
    if (ex.length) {
      if (ex.some((r) => r.event_id === raw.event_id && r.result_id === raw.result_id)) duplicates.push(raw.event_id)
      else reject(raw, 'result_id 또는 event_id 가 다른 결과와 충돌합니다')
      continue
    }
    if (!s) { reject(raw, `존재하지 않는 세션: ${body.session_id}`); continue }
    if (s.status === 'draft' || s.status === 'cancelled') { reject(raw, `결과를 받을 수 없는 세션 상태: ${s.status}`); continue }
    if (!students.has(raw.student_code)) { reject(raw, `세션에 등록되지 않은 학생 코드: ${raw.student_code}`); continue }
    db.results.push({
      id: nextId(db, 'results'), result_id: raw.result_id, event_id: raw.event_id, session_id: body.session_id, device_id: body.device_id, student_code: raw.student_code,
      content_id: raw.content_id, content_version: raw.content_version ?? null, mission_id: raw.mission_id, answer_json: raw.answer === undefined || raw.answer === null ? null : JSON.stringify(raw.answer),
      is_correct: raw.is_correct === undefined || raw.is_correct === null ? null : raw.is_correct ? 1 : 0, score: raw.score ?? null, attempt_count: raw.attempt_count ?? null,
      duration_seconds: raw.duration_seconds ?? null, started_at: raw.started_at ?? null, completed_at: raw.completed_at ?? null, occurred_at: new Date(raw.occurred_at).toISOString().replace('.000Z', '+00:00'),
      received_at: now, sync_status: 'synced', corrected_is_correct: null, corrected_score: null,
    })
    accepted.push(raw.event_id)
  }
  const dev = deviceById(body.device_id)
  dev.last_sync_at = now
  db.sync_logs.push({ id: nextId(db, 'sync_logs'), device_id: body.device_id, session_id: body.session_id, received_count: body.results.length, accepted_count: accepted.length, duplicate_count: duplicates.length, rejected_count: rejected.length, created_at: now })
  if (accepted.length) bus.emit('result.received', { device_id: body.device_id, count: accepted.length })
  if (rejected.length) bus.emit('result.sync_error', { device_id: body.device_id, count: rejected.length })
  persist()
  return { success: true, accepted, duplicates, rejected, server_time: now }
}

const PROGRESS_STATE: Record<string, string> = { 'session.joined': 'waiting', 'mission.started': 'in_progress', 'mission.progress': 'in_progress', 'mission.completed': 'in_progress', 'session.finished': 'completed', 'app.error': 'error' }
export function hmdEvents(body: Row) {
  const now = nowIso()
  deviceById(body.device_id)
  const accepted: string[] = []; const duplicates: string[] = []; const rejected: Row[] = []
  for (const ev of body.events as Row[]) {
    if (!ev.event_id || !PROGRESS_STATE[ev.event_type] && ev.event_type !== 'app.status') { rejected.push({ event_id: ev.event_id ?? null, reason: '입력 검증 실패: event_type' }); continue }
    if (db.events.some((e) => e.event_id === ev.event_id)) { duplicates.push(ev.event_id); continue }
    const { event_id, event_type, occurred_at, ...rest } = ev
    db.events.push({ id: nextId(db, 'events'), event_id, device_id: body.device_id, event_type, session_id: ev.session_id ?? null, payload_json: JSON.stringify(rest), occurred_at, received_at: now })
    accepted.push(event_id)
    if (event_type === 'app.error') { const d = deviceById(body.device_id); d.last_error_code = ev.error_code ?? 'APP_ERROR'; d.last_error_at = now }
    if (ev.session_id && PROGRESS_STATE[event_type]) {
      const g = db.progress.find((x) => x.session_id === ev.session_id && x.device_id === body.device_id)
      const progressVal = event_type === 'session.finished' ? 1 : ev.progress ?? null
      if (!g) db.progress.push({ session_id: ev.session_id, device_id: body.device_id, student_code: ev.student_code ?? null, content_id: ev.content_id ?? null, mission_id: ev.mission_id ?? null, step: ev.step ?? null, progress: progressVal, state: PROGRESS_STATE[event_type], last_report_at: occurred_at })
      else if (occurred_at >= g.last_report_at) Object.assign(g, { student_code: ev.student_code ?? g.student_code, content_id: ev.content_id ?? g.content_id, mission_id: ev.mission_id ?? g.mission_id, step: ev.step ?? g.step, progress: progressVal ?? g.progress, state: PROGRESS_STATE[event_type], last_report_at: occurred_at })
      bus.emit('session.progress', { session_id: ev.session_id, device_id: body.device_id })
    }
  }
  persist()
  return { success: true, accepted, duplicates, rejected, server_time: now }
}

// ---------- 데모 네트워크 제어 ----------
export const demoState = { offline: new Set<string>(), speed: 1.5 }

// ---------- 라우터 ----------
type Ctx = { user: Row | null; q: Row; body: Row }
type Handler = (m: RegExpMatchArray, c: Ctx) => any
const routes: [string, RegExp, Handler, ('any' | 'op' | 'admin' | 'public')?][] = []
const route = (method: string, pattern: string, h: Handler, auth: 'any' | 'op' | 'admin' | 'public' = 'any') =>
  routes.push([method, new RegExp('^' + pattern.replace(/\{[a-z_]+\}/g, '([^/]+)') + '$'), h, auth])

const TOKEN_KEY = 'mredu.token'

route('GET', '/health', () => ({ status: 'ok', db: 'ok', version: '1.0.0-web-demo', server_time: nowIso(), demo: true, static_demo: true }), 'public')

// 인증
route('POST', '/api/v1/auth/login', (_m, { body }) => {
  const u = db.users.find((x) => x.username === body.username)
  if (!u) throw err(401, '아이디 또는 비밀번호가 올바르지 않습니다')
  if (!u.active) throw err(403, '비활성화된 계정입니다. 시스템 관리자에게 문의하세요')
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw err(423, '로그인 실패 횟수 초과로 잠긴 계정입니다. 잠시 후 다시 시도하세요')
  if (u.password_hash !== demoHash(body.password ?? '')) {
    u.failed_attempts += 1
    if (u.failed_attempts >= db.settings.login_max_failures) {
      u.locked_until = new Date(Date.now() + db.settings.login_lock_minutes * 60000).toISOString(); u.failed_attempts = 0; persist()
      throw err(423, `로그인 ${db.settings.login_max_failures}회 실패로 ${db.settings.login_lock_minutes}분간 잠깁니다`)
    }
    persist(); throw err(401, '아이디 또는 비밀번호가 올바르지 않습니다')
  }
  Object.assign(u, { failed_attempts: 0, locked_until: null, last_login_at: nowIso() })
  audit(u, 'auth.login', 'admin_user', u.id); persist()
  return { access_token: `demo.${u.id}.${uuid()}`, token_type: 'bearer', expires_in: 28800, user: { id: u.id, username: u.username, display_name: u.display_name, role: u.role, role_label: ROLE_LABELS[u.role], must_change_password: !!u.must_change_password } }
}, 'public')
route('GET', '/api/v1/auth/me', (_m, { user }) => ({ ...publicUser(user!), must_change_password: !!user!.must_change_password }))
route('POST', '/api/v1/auth/change-password', (_m, { user, body }) => {
  if (user!.password_hash !== demoHash(body.current_password ?? '')) throw err(400, '현재 비밀번호가 올바르지 않습니다')
  checkPw(body.new_password)
  if (body.current_password === body.new_password) throw err(400, '새 비밀번호가 현재 비밀번호와 같습니다')
  user!.password_hash = demoHash(body.new_password); user!.must_change_password = 0
  audit(user, 'auth.password_changed', 'admin_user', user!.id); persist()
  return { success: true }
})
function checkPw(pw?: string) {
  if (!pw || pw.length < 8) throw err(400, '비밀번호는 8자 이상이어야 합니다')
  if (/^\d+$/.test(pw) || /^[A-Za-z]+$/.test(pw)) throw err(400, '비밀번호는 영문과 숫자를 함께 포함해야 합니다')
}
const publicUser = (u: Row) => { const { password_hash: _p, ...rest } = u; return { ...rest, role_label: ROLE_LABELS[u.role] } }

// 사용자
route('GET', '/api/v1/users', () => ({ items: db.users.map(publicUser), roles: ROLE_LABELS }), 'admin')
route('POST', '/api/v1/users', (_m, { user, body }) => {
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(body.username ?? '')) throw err(422, '입력값 오류 — 아이디는 영문·숫자·_.- 3~32자')
  checkPw(body.password)
  if (db.users.some((u) => u.username === body.username)) throw err(409, '이미 존재하는 아이디입니다')
  const u = { id: nextId(db, 'users'), username: body.username, display_name: body.display_name ?? null, password_hash: demoHash(body.password), role: body.role, active: 1, failed_attempts: 0, locked_until: null, must_change_password: 1, created_at: nowIso(), last_login_at: null }
  db.users.push(u); audit(user, 'user.create', 'admin_user', u.id, { username: u.username, role: u.role }); persist()
  return publicUser(u)
}, 'admin')
route('PATCH', '/api/v1/users/{id}', (m, { user, body }) => {
  const u = db.users.find((x) => x.id === Number(m[1]))
  if (!u) throw err(404, '사용자를 찾을 수 없습니다')
  const demoting = (body.role && body.role !== 'admin') || body.active === false
  if (u.role === 'admin' && demoting && !db.users.some((x) => x.id !== u.id && x.role === 'admin' && x.active)) throw err(400, '마지막 시스템 관리자는 권한 변경·비활성화할 수 없습니다')
  if (body.display_name !== undefined && body.display_name !== null) u.display_name = body.display_name
  if (body.role) u.role = body.role
  if (body.active !== undefined && body.active !== null) u.active = body.active ? 1 : 0
  if (body.reset_password) { checkPw(body.reset_password); u.password_hash = demoHash(body.reset_password); u.must_change_password = 1 }
  if (body.unlock) { u.failed_attempts = 0; u.locked_until = null }
  audit(user, 'user.update', 'admin_user', u.id, body); persist()
  return publicUser(u)
}, 'admin')

// 장비
route('GET', '/api/v1/devices', (_m, { q }) => {
  let items = devicesEvaluated(q.include_inactive !== 'false')
  if (q.q) items = items.filter((d) => d.device_id.toLowerCase().includes(q.q.toLowerCase()) || (d.device_name ?? '').toLowerCase().includes(q.q.toLowerCase()))
  if (q.health) { const w = new Set(String(q.health).split(',')); items = items.filter((d) => w.has(d.health)) }
  return { items, server_time: nowIso() }
})
route('POST', '/api/v1/devices', (_m, { user, body }) => {
  const id = String(body.device_id ?? '').trim()
  if (!DEVICE_RE.test(id)) throw err(422, '입력값 오류 — 장비 ID는 영문·숫자·-·_ 2~32자여야 합니다 (예: HMD-01)')
  if (db.devices.some((d) => d.device_id === id)) throw err(409, `이미 등록된 장비 ID입니다: ${id}`)
  const now = nowIso()
  const d = { id: nextId(db, 'devices'), device_id: id, device_name: body.device_name ?? null, model: body.model || 'Meta Quest 3', app_version: null, content_version: null, last_seen_at: null, last_sync_at: null, connection_status: 'unknown', app_status: 'unknown', battery_level: null, storage_available: null, last_error_code: null, last_error_at: null, reported_pending_count: null, reported_sent_total: null, is_simulated: 0, active: 1, notes: body.notes ?? null, created_at: now, updated_at: now }
  db.devices.push(d); audit(user, 'device.create', 'device', id, body); persist()
  return d
}, 'op')
route('POST', '/api/v1/devices/bulk', (_m, { user, body }) => {
  const created: string[] = []; const skipped: string[] = []
  const last = body.start + body.count - 1; const w = Math.max(2, String(last).length); const now = nowIso()
  for (let n = body.start; n <= last; n++) {
    const id = `${body.prefix}${String(n).padStart(w, '0')}`
    if (db.devices.some((d) => d.device_id === id)) { skipped.push(id); continue }
    db.devices.push({ id: nextId(db, 'devices'), device_id: id, device_name: null, model: body.model || 'Meta Quest 3', app_version: null, content_version: null, last_seen_at: null, last_sync_at: null, connection_status: 'unknown', app_status: 'unknown', battery_level: null, storage_available: null, last_error_code: null, last_error_at: null, reported_pending_count: null, reported_sent_total: null, is_simulated: 0, active: 1, notes: null, created_at: now, updated_at: now })
    created.push(id)
  }
  audit(user, 'device.bulk_create', 'device', null, { created, skipped }); persist()
  return { created, skipped }
}, 'op')
route('GET', '/api/v1/devices/{id}', (m) => {
  const id = decodeURIComponent(m[1])
  const d = { ...evaluate(deviceById(id)), assignment: currentAssignments()[id] ?? null } as Row
  d.heartbeats = db.heartbeats.filter((h) => h.device_id === id).slice(-30).reverse()
  d.events = db.events.filter((e) => e.device_id === id).slice(-30).reverse()
  d.sessions = db.participants.filter((p) => p.device_id === id).map((p) => { const s = db.sessions.find((x) => x.id === p.session_id)!; return { id: s.id, session_code: s.session_code, institution_name: s.institution_name, session_date: s.session_date, status: s.status, student_code: p.student_code, result_count: db.results.filter((r) => r.session_id === s.session_code && r.device_id === id).length } }).reverse()
  d.sync_logs = db.sync_logs.filter((l) => l.device_id === id).slice(-20).reverse()
  d.installs = db.content_installs.filter((i) => i.device_id === id)
  d.received_result_total = db.results.filter((r) => r.device_id === id).length
  d.pending_commands = db.commands.filter((c) => c.device_id === id).slice(-10).reverse()
  return d
})
route('PATCH', '/api/v1/devices/{id}', (m, { user, body }) => {
  const d = deviceById(decodeURIComponent(m[1]))
  for (const k of ['device_name', 'model', 'notes']) if (body[k] !== undefined) d[k] = body[k]
  if (body.active !== undefined) d.active = body.active ? 1 : 0
  d.updated_at = nowIso(); audit(user, 'device.update', 'device', d.device_id, body); persist()
  return d
}, 'op')
route('POST', '/api/v1/devices/{id}/resync', (m, { user }) => {
  const d = deviceById(decodeURIComponent(m[1]))
  const ex = db.commands.find((c) => c.device_id === d.device_id && c.command === 'resync' && c.status === 'pending')
  if (ex) return { success: true, command_id: ex.id, already_pending: true }
  const c = { id: nextId(db, 'commands'), device_id: d.device_id, command: 'resync', payload_json: '{}', status: 'pending', created_at: nowIso(), delivered_at: null }
  db.commands.push(c); audit(user, 'device.resync_requested', 'device', d.device_id); persist()
  return { success: true, command_id: c.id, already_pending: false }
}, 'op')

// 세션
route('GET', '/api/v1/sessions', (_m, { q }) => {
  let items = db.sessions.filter((s) => !s.deleted)
  if (q.status) { const st = new Set(String(q.status).split(',')); items = items.filter((s) => st.has(s.status)) }
  if (q.q) items = items.filter((s) => [s.institution_name, s.session_code, s.topic, s.instructor].some((x) => (x ?? '').includes(q.q)))
  if (q.date_from) items = items.filter((s) => s.session_date >= q.date_from)
  if (q.date_to) items = items.filter((s) => s.session_date <= q.date_to)
  items = [...items].sort((a, b) => b.session_date.localeCompare(a.session_date) || b.id - a.id)
  return { items: items.map(sessionSummary), status_labels: SESSION_LABEL }
})
const SESSION_FIELDS = ['institution_name', 'institution_code', 'session_date', 'grade', 'class_group', 'session_no', 'topic', 'content_id', 'scheduled_start_at', 'instructor', 'expected_students', 'memo']
route('POST', '/api/v1/sessions', (_m, { user, body }) => {
  if (!body.institution_name?.trim()) throw err(422, '입력값 오류 — 기관명은 필수입니다')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.session_date ?? '')) throw err(422, '입력값 오류 — 교육 날짜는 YYYY-MM-DD 형식이어야 합니다')
  checkContent(body.content_id)
  validateParticipants(body.participants ?? [])
  const now = nowIso(); const id = nextId(db, 'sessions')
  const s: Row = { id, session_code: nextCode(body.session_date), status: 'draft', started_at: null, ended_at: null, deleted: 0, created_at: now, updated_at: now }
  for (const k of SESSION_FIELDS) s[k] = body[k] ?? null
  db.sessions.push(s); replaceParticipants(id, body.participants ?? [])
  audit(user, 'session.create', 'session', s.session_code, { participants: (body.participants ?? []).length }); persist()
  return sessionDetail(id)
}, 'op')
route('GET', '/api/v1/sessions/{id}', (m) => sessionDetail(Number(m[1])))
route('PATCH', '/api/v1/sessions/{id}', (m, { user, body }) => {
  const s = sessionById(Number(m[1]))
  const keys = Object.keys(body).filter((k) => SESSION_FIELDS.includes(k))
  if (!['draft', 'ready'].includes(s.status) && keys.some((k) => !['memo', 'instructor'].includes(k))) throw err(409, `'${SESSION_LABEL[s.status]}' 상태의 세션은 메모·담당 강사만 수정할 수 있습니다`)
  if ('content_id' in body) checkContent(body.content_id)
  if (body.institution_name === '') throw err(400, '기관명은 비울 수 없습니다')
  for (const k of keys) s[k] = body[k]
  s.updated_at = nowIso(); audit(user, 'session.update', 'session', s.session_code, body); persist()
  return sessionDetail(s.id)
}, 'op')
route('PUT', '/api/v1/sessions/{id}/participants', (m, { user, body }) => {
  const s = sessionById(Number(m[1]))
  if (!['draft', 'ready', 'running'].includes(s.status)) throw err(409, '완료·취소된 세션의 배정은 변경할 수 없습니다')
  if (s.status === 'running') {
    const keep = new Set((body.participants as Row[]).map((p) => p.student_code))
    const missing = [...new Set(resultsOf(s.session_code).map((r) => r.student_code))].filter((c) => !keep.has(c))
    if (missing.length) throw err(409, `결과가 수신된 학생은 제외할 수 없습니다: ${missing.sort().join(', ')}`)
  }
  replaceParticipants(s.id, body.participants); audit(user, 'session.participants', 'session', s.session_code); persist()
  bus.emit('session.progress', { session_id: s.session_code })
  return sessionDetail(s.id)
}, 'op')
route('POST', '/api/v1/sessions/{id}/auto-assign', (m, { user }) => {
  const s = sessionById(Number(m[1]))
  if (!['draft', 'ready'].includes(s.status)) throw err(409, '작성 중·준비 완료 상태에서만 자동 배정할 수 있습니다')
  const parts = partsOf(s.id).sort((a, b) => a.student_code.localeCompare(b.student_code))
  const used = new Set([...parts.map((p) => p.device_id).filter(Boolean), ...busyDevices(s.id)])
  const rank: Row = { normal: 0, warning: 1, unknown: 2, offline: 3, error: 4 }
  const pool = db.devices.filter((d) => d.active).map(evaluate).sort((a, b) => (rank[a.health] ?? 5) - (rank[b.health] ?? 5) || a.device_id.localeCompare(b.device_id)).map((d) => d.device_id).filter((d) => !used.has(d))
  const assigned: Row[] = []
  for (const p of parts) if (!p.device_id && pool.length) { p.device_id = pool.shift(); assigned.push({ student_code: p.student_code, device_id: p.device_id }) }
  audit(user, 'session.auto_assign', 'session', s.session_code, { assigned: assigned.length }); persist()
  return { assigned, unassigned_count: parts.filter((p) => !p.device_id).length, session: sessionDetail(s.id) }
}, 'op')
function transition(user: Row | null, s: Row, to: string) {
  audit(user, `session.${to}`, 'session', s.session_code, { from: s.status })
  s.status = to; s.updated_at = nowIso(); persist()
}
route('POST', '/api/v1/sessions/{id}/ready', (m, { user }) => {
  const s = sessionById(Number(m[1]))
  if (s.status !== 'draft') throw err(409, '작성 중 상태의 세션만 준비 완료로 변경할 수 있습니다')
  if (!s.content_id) throw err(400, '콘텐츠를 먼저 선택하세요')
  if (!partsOf(s.id).length) throw err(400, '참여 학생을 먼저 등록하세요')
  transition(user, s, 'ready'); return sessionDetail(s.id)
}, 'op')
route('POST', '/api/v1/sessions/{id}/start', (m, { user }) => {
  const s = sessionById(Number(m[1]))
  if (!['draft', 'ready'].includes(s.status)) throw err(409, `'${SESSION_LABEL[s.status]}' 상태의 세션은 시작할 수 없습니다`)
  if (!s.content_id) throw err(400, '콘텐츠를 먼저 선택하세요')
  const mine = new Set(partsOf(s.id).map((p) => p.device_id).filter(Boolean))
  if (!mine.size) throw err(400, 'HMD가 배정된 학생이 없습니다')
  const busy = busyDevices(s.id); const conflict = [...mine].filter((d) => busy.has(d))
  if (conflict.length) throw err(409, `다른 진행 중 세션에 배정된 장비가 있습니다: ${conflict.sort().join(', ')}`)
  s.started_at = nowIso(); transition(user, s, 'running'); bus.emit('session.started', { id: s.id })
  return sessionDetail(s.id)
}, 'op')
route('GET', '/api/v1/sessions/{id}/sync-check', (m) => syncCheck(sessionById(Number(m[1]))))
route('POST', '/api/v1/sessions/{id}/complete', (m, { user, body }) => {
  const s = sessionById(Number(m[1]))
  if (s.status !== 'running') throw err(409, '진행 중인 세션만 종료할 수 있습니다')
  const check = syncCheck(s)
  if (!check.ok && !body?.force) { const message = '미동기화 결과 또는 확인 불가 장비가 있습니다. 확인 후 강제 종료를 선택하세요.'; throw err(409, message, { message, issues: check.issues }) }
  s.ended_at = nowIso(); transition(user, s, 'completed'); bus.emit('session.completed', { id: s.id })
  return { ...sessionDetail(s.id), sync_issues: check.issues }
}, 'op')
route('POST', '/api/v1/sessions/{id}/cancel', (m, { user }) => {
  const s = sessionById(Number(m[1]))
  if (!['draft', 'ready'].includes(s.status)) throw err(409, '작성 중·준비 완료 상태의 세션만 취소할 수 있습니다')
  transition(user, s, 'cancelled'); return sessionDetail(s.id)
}, 'op')
route('POST', '/api/v1/sessions/{id}/clone', (m, { user }) => {
  const s = sessionById(Number(m[1]))
  const date = [s.session_date, new Date().toISOString().slice(0, 10)].sort()[1]
  const now = nowIso(); const id = nextId(db, 'sessions')
  const n: Row = { ...s, id, session_code: nextCode(date), session_date: date, status: 'draft', started_at: null, ended_at: null, created_at: now, updated_at: now }
  db.sessions.push(n)
  for (const p of partsOf(s.id)) db.participants.push({ ...p, id: nextId(db, 'participants'), session_id: id, created_at: now })
  audit(user, 'session.clone', 'session', n.session_code, { from: s.session_code }); persist()
  return sessionDetail(id)
}, 'op')
route('GET', '/api/v1/sessions/{id}/progress', (m) => progress(Number(m[1])))

// 결과
const SORT: Row = { occurred_at: (r: Row) => r.occurred_at, received_at: (r: Row) => r.received_at, score: (r: Row) => effS(r) ?? -1, student_code: (r: Row) => r.student_code, mission_id: (r: Row) => r.mission_id, device_id: (r: Row) => r.device_id }
route('GET', '/api/v1/results', (_m, { q }) => {
  const key = SORT[q.sort] ?? SORT.occurred_at
  const dir = q.order === 'asc' ? 1 : -1
  const rs = filterResults(q).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : b.id - a.id) * dir)
  const limit = Number(q.limit ?? 50); const offset = Number(q.offset ?? 0)
  return { items: rs.slice(offset, offset + limit).map(decorate), total: rs.length, limit, offset }
})
route('GET', '/api/v1/results/stats', (_m, { q }) => stats(q))
route('GET', '/api/v1/results/unsynced', () => {
  const devices = db.devices.filter((d) => d.active).sort((a, b) => a.device_id.localeCompare(b.device_id)).map((d) => {
    const received = db.results.filter((r) => r.device_id === d.device_id).length
    return { device_id: d.device_id, reported_pending_count: d.reported_pending_count, reported_sent_total: d.reported_sent_total, last_sync_at: d.last_sync_at, last_seen_at: d.last_seen_at, received_total: received, rejected_total: db.rejections.filter((x) => x.device_id === d.device_id).length, mismatch: d.reported_sent_total === null ? null : d.reported_sent_total !== received }
  })
  return { pending_total: devices.reduce((a, d) => a + (d.reported_pending_count ?? 0), 0), devices_unknown: devices.filter((d) => d.reported_pending_count === null).length, devices, rejections: [...db.rejections].reverse().slice(0, 200) }
})
route('GET', '/api/v1/results/{id}', (m) => {
  const r = db.results.find((x) => x.result_id === decodeURIComponent(m[1]))
  if (!r) throw err(404, '결과를 찾을 수 없습니다')
  return { ...decorate(r), answer: r.answer_json ? JSON.parse(r.answer_json) : null, corrections: db.corrections.filter((c) => c.result_id === r.result_id).map((c) => ({ ...c, username: db.users.find((u) => u.id === c.admin_user_id)?.username })) }
})
route('POST', '/api/v1/results/{id}/corrections', (m, { user, body }) => {
  const r = db.results.find((x) => x.result_id === decodeURIComponent(m[1]))
  if (!r) throw err(404, '결과를 찾을 수 없습니다')
  if (!body.reason || body.reason.length < 2) throw err(422, '입력값 오류 — 사유를 입력하세요')
  if (body.is_correct === null && body.score === null) throw err(400, '보정할 값(정답 여부 또는 점수)을 입력하세요')
  const now = nowIso()
  if (body.is_correct !== null && body.is_correct !== undefined) {
    db.corrections.push({ id: nextId(db, 'corrections'), result_id: r.result_id, field: 'is_correct', old_value: String(effC(r)), new_value: String(body.is_correct ? 1 : 0), reason: body.reason, admin_user_id: user!.id, created_at: now })
    r.corrected_is_correct = body.is_correct ? 1 : 0; r.sync_status = 'corrected'
  }
  if (body.score !== null && body.score !== undefined) {
    db.corrections.push({ id: nextId(db, 'corrections'), result_id: r.result_id, field: 'score', old_value: String(effS(r)), new_value: String(body.score), reason: body.reason, admin_user_id: user!.id, created_at: now })
    r.corrected_score = body.score; r.sync_status = 'corrected'
  }
  audit(user, 'result.correct', 'mission_result', r.result_id, body); persist()
  return { ...decorate(r), answer: r.answer_json ? JSON.parse(r.answer_json) : null, corrections: db.corrections.filter((c) => c.result_id === r.result_id).map((c) => ({ ...c, username: db.users.find((u) => u.id === c.admin_user_id)?.username })) }
}, 'op')

// 콘텐츠
const DEFAULT_CHECKLIST = ['패키지(APK) 버전 및 서명 확인', '대상 HMD 충전 및 Wi-Fi 연결 확인', 'Meta Quest 개발자 모드/MDM 등 공식 배포 경로로 설치', 'HMD에서 콘텐츠 실행 확인', 'HMD heartbeat 로 보고된 설치 버전 확인']
const contentById = (id: string) => { const c = db.contents.find((x) => x.content_id === id); if (!c) throw err(404, '콘텐츠를 찾을 수 없습니다'); return c }
function contentDetail(id: string) {
  const c = contentById(id)
  return {
    ...c, category_label: CATEGORY_LABELS[c.category], versions: db.content_versions.filter((v) => v.content_id === id).reverse(),
    installs: [...db.devices].sort((a, b) => a.device_id.localeCompare(b.device_id)).map((d) => { const i = db.content_installs.find((x) => x.device_id === d.device_id && x.content_id === id); return { device_id: d.device_id, device_name: d.device_name, active: d.active, version: i?.version ?? null, status: i?.status ?? null, source: i?.source ?? null, updated_at: i?.updated_at ?? null } }),
    deploy_jobs: db.deploy_jobs.filter((j) => j.content_id === id).reverse(), remote_install_supported: false,
  }
}
route('GET', '/api/v1/contents', (_m, { q }) => {
  const total = db.devices.filter((d) => d.active).length
  const items = db.contents.filter((c) => q.active_only !== 'true' || c.active).sort((a, b) => a.content_id.localeCompare(b.content_id)).map((c) => ({
    ...c, category_label: CATEGORY_LABELS[c.category], total_devices: total, result_count: db.results.filter((r) => r.content_id === c.content_id).length,
    installed_count: db.content_installs.filter((i) => i.content_id === c.content_id && i.status === 'installed').length,
    installed_current_count: db.content_installs.filter((i) => i.content_id === c.content_id && i.status === 'installed' && i.version === c.version).length,
  }))
  return { items, categories: CATEGORY_LABELS }
})
route('POST', '/api/v1/contents', (_m, { user, body }) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/.test(body.content_id ?? '')) throw err(422, '입력값 오류 — 콘텐츠 ID는 영문·숫자·-·_·. 2~64자여야 합니다 (예: SAFETY-01)')
  if (db.contents.some((c) => c.content_id === body.content_id)) throw err(409, `이미 등록된 콘텐츠 ID입니다: ${body.content_id}`)
  const now = nowIso()
  const c: Row = { id: nextId(db, 'contents'), ...body, active: 1, created_at: now, updated_at: now }
  db.contents.push(c)
  db.content_versions.push({ id: nextId(db, 'content_versions'), content_id: c.content_id, version: c.version, package_name: c.package_name, package_size: c.package_size, release_notes: '최초 등록', created_at: now })
  audit(user, 'content.create', 'content', c.content_id, body); persist()
  return c
}, 'op')
route('GET', '/api/v1/contents/{id}', (m) => contentDetail(decodeURIComponent(m[1])))
route('PATCH', '/api/v1/contents/{id}', (m, { user, body }) => {
  const c = contentById(decodeURIComponent(m[1]))
  for (const k of ['title', 'category', 'description', 'supported_models']) if (body[k] !== undefined) c[k] = body[k]
  if (body.active !== undefined) c.active = body.active ? 1 : 0
  c.updated_at = nowIso(); audit(user, 'content.update', 'content', c.content_id, body); persist()
  return contentDetail(c.content_id)
}, 'op')
route('POST', '/api/v1/contents/{id}/versions', (m, { user, body }) => {
  const c = contentById(decodeURIComponent(m[1]))
  if (db.content_versions.some((v) => v.content_id === c.content_id && v.version === body.version)) throw err(409, `이미 등록된 버전입니다: ${body.version}`)
  const now = nowIso()
  db.content_versions.push({ id: nextId(db, 'content_versions'), content_id: c.content_id, version: body.version, package_name: body.package_name ?? null, package_size: body.package_size ?? null, release_notes: body.release_notes ?? null, created_at: now })
  if (body.make_current !== false) { c.version = body.version; if (body.package_name) c.package_name = body.package_name; c.updated_at = now }
  audit(user, 'content.version_add', 'content', c.content_id, body); persist()
  return contentDetail(c.content_id)
}, 'op')
route('POST', '/api/v1/contents/{id}/deploy-jobs', (m, { user, body }) => {
  const c = contentById(decodeURIComponent(m[1]))
  if (!db.content_versions.some((v) => v.content_id === c.content_id && v.version === body.version)) throw err(400, `등록되지 않은 버전입니다: ${body.version}`)
  const now = nowIso(); const id = nextId(db, 'deploy_jobs')
  db.deploy_jobs.push({ id, content_id: c.content_id, version: body.version, target_devices: body.target_devices, checklist: DEFAULT_CHECKLIST.map((item) => ({ item, done: false })), status: 'planned', memo: body.memo ?? null, created_by: user!.id, created_at: now, updated_at: now })
  for (const d of body.target_devices as string[]) {
    const i = db.content_installs.find((x) => x.device_id === d && x.content_id === c.content_id)
    if (!i) db.content_installs.push({ device_id: d, content_id: c.content_id, version: body.version, source: 'manual', status: 'planned', updated_at: now })
    else if (!(i.version === body.version && i.status === 'installed')) Object.assign(i, { status: 'planned', updated_at: now })
  }
  audit(user, 'content.deploy_job_create', 'content', c.content_id, body); persist()
  return { id }
}, 'op')
route('PATCH', '/api/v1/contents/deploy-jobs/{id}', (m, { user, body }) => {
  const j = db.deploy_jobs.find((x) => x.id === Number(m[1]))
  if (!j) throw err(404, '배포 작업을 찾을 수 없습니다')
  if (body.status) j.status = body.status
  if (body.checklist) j.checklist = body.checklist
  if (body.memo !== undefined) j.memo = body.memo
  j.updated_at = nowIso(); audit(user, 'content.deploy_job_update', 'deploy_job', j.id, body); persist()
  return { success: true }
}, 'op')

// 대시보드
route('GET', '/api/v1/dashboard/summary', () => {
  const devices = devicesEvaluated(false)
  const counts: Row = { normal: 0, warning: 0, offline: 0, error: 0, unknown: 0 }
  devices.forEach((d) => { counts[d.health] = (counts[d.health] ?? 0) + 1 })
  const running = db.sessions.filter((s) => s.status === 'running' && !s.deleted).map((s) => {
    const total = partsOf(s.id).length
    const g = db.progress.filter((x) => x.session_id === s.session_code)
    const sum = g.reduce((a, x) => a + (x.state === 'completed' ? 1 : x.progress ?? 0), 0)
    return { id: s.id, session_code: s.session_code, institution_name: s.institution_name, grade: s.grade, class_group: s.class_group, session_no: s.session_no, content_title: contentTitle(s.content_id) ?? s.content_id, started_at: s.started_at, participants: total, completed: g.filter((x) => x.state === 'completed').length, progress: total ? sum / total : 0, status_label: '진행 중' }
  })
  const alerts: Row[] = devices.filter((d) => ['warning', 'offline', 'error'].includes(d.health) || (d.health === 'unknown' && d.assignment)).map((d) => ({ level: d.health, device_id: d.device_id, message: d.health_reasons.join(' / '), at: d.last_seen_at }))
  for (const r of [...db.rejections].reverse().slice(0, 5)) alerts.push({ level: 'warning', device_id: r.device_id, message: `결과 거부: ${r.reason}`, at: r.received_at })
  const order: Row = { error: 0, offline: 1, unknown: 1, warning: 2 }
  alerts.sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3))
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString()
  const recent = [...groupBy(db.results.filter((r) => r.received_at >= weekAgo), (r) => `${r.content_id}|${r.mission_id}`).values()].map((g) => ({ mission_id: g[0].mission_id, content_id: g[0].content_id, attempts: g.length, accuracy: acc(g), avg_score: avg(g.map(effS)) })).slice(0, 20)
  const dayAgo = new Date(Date.now() - 86400000).toISOString()
  return {
    devices: { total: devices.length, online: devices.filter((d) => d.connection_status === 'online').length, ...counts },
    device_tiles: devices.map((d) => ({ device_id: d.device_id, device_name: d.device_name, health: d.health, health_label: d.health_label, battery_level: d.battery_level, app_status: d.app_status, last_seen_at: d.last_seen_at, is_simulated: d.is_simulated, reasons: d.health_reasons })),
    running_sessions: running,
    unsynced: { pending_total: devices.reduce((a, d) => a + (d.reported_pending_count ?? 0), 0), devices_unknown: devices.filter((d) => d.reported_pending_count === null).length, rejected_24h: db.rejections.filter((r) => r.received_at >= dayAgo).length },
    alerts: alerts.slice(0, 15), mission_accuracy: recent,
    recent_results: [...db.results].reverse().slice(0, 8).map((r) => ({ result_id: r.result_id, session_id: r.session_id, device_id: r.device_id, student_code: r.student_code, mission_id: r.mission_id, is_correct: effC(r), score: effS(r), received_at: r.received_at })),
    demo: { simulated_devices: devices.filter((d) => d.is_simulated).length }, data_as_of: nowIso(),
    last_heartbeat_at: devices.map((d) => d.last_seen_at).filter(Boolean).sort().pop() ?? null,
  }
})

// 보고서
route('GET', '/api/v1/reports/types', () => REPORT_TYPES)
route('GET', '/api/v1/reports/session/{id}', (m) => sessionReport(Number(m[1])))
route('GET', '/api/v1/reports/{type}', (m, { q }) => genericReport(m[1], q))

// 설정
const LIMITS: Row = { heartbeat_interval_sec: [5, 600], offline_threshold_sec: [15, 3600], delay_threshold_sec: [10, 3600], battery_warning_pct: [1, 99], error_hold_sec: [0, 86400], sync_batch_size: [1, 500], sync_retry_base_sec: [1, 600], sync_retry_max_sec: [5, 3600], auto_backup_hour: [0, 23], backup_keep_count: [1, 365], log_retention_days: [1, 3650], result_retention_days: [0, 36500], token_expire_minutes: [10, 1440], login_max_failures: [3, 20], login_lock_minutes: [1, 1440] }
route('GET', '/api/v1/settings', (_m, { user }) => ({
  values: { ...db.settings, device_api_key: user!.role === 'admin' ? db.settings.device_api_key : '********', backup_dir_effective: '브라우저 저장소 (웹 데모)' },
  descriptions: Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([k, v]) => [k, v[1]])), limits: LIMITS,
  server: { bind_host: '브라우저', port: 0, public_host: location.host, local_ips: ['웹 데모 — 실제 서버 없음'], api_base: `${location.origin}${location.pathname} (브라우저 내장 데모 서버)`, db_path: 'localStorage' },
}))
route('PATCH', '/api/v1/settings', (_m, { user, body }) => {
  const changes: Row = {}
  for (const [k, raw] of Object.entries(body.values as Row)) {
    if (!(k in DEFAULT_SETTINGS)) throw err(400, `알 수 없는 설정 항목: ${k}`)
    const def = DEFAULT_SETTINGS[k][0]
    const v = typeof def === 'boolean' ? !!raw : typeof def === 'number' ? Number(raw) : String(raw ?? '').trim()
    if (typeof def === 'number' && isNaN(v as number)) throw err(400, `${k}: 올바른 값이 아닙니다`)
    if (LIMITS[k] && ((v as number) < LIMITS[k][0] || (v as number) > LIMITS[k][1])) throw err(400, `${DEFAULT_SETTINGS[k][1]}: ${LIMITS[k][0]}~${LIMITS[k][1]} 범위로 입력하세요`)
    if (k === 'device_api_key' && String(v).length < 12) throw err(400, '장비 키는 12자 이상이어야 합니다')
    if (v !== db.settings[k]) changes[k] = v
  }
  const merged = { ...db.settings, ...changes }
  if (merged.offline_threshold_sec <= merged.heartbeat_interval_sec) throw err(400, '오프라인 판정 시간은 heartbeat 주기보다 길어야 합니다')
  if (merged.sync_retry_max_sec < merged.sync_retry_base_sec) throw err(400, '재시도 최대 대기는 최초 대기보다 커야 합니다')
  Object.assign(db.settings, changes)
  if (Object.keys(changes).length) audit(user, 'settings.update', 'system_settings', null, changes)
  persist()
  return { values: db.settings, changed: Object.keys(changes) }
}, 'admin')
route('GET', '/api/v1/settings/system-status', () => {
  const size = new Blob([localStorage.getItem(STORAGE_KEY) ?? '']).size
  return {
    version: '1.0.0-web-demo', python: '해당 없음 (브라우저)', platform: navigator.userAgent.slice(0, 80),
    db: { path: 'localStorage', size_bytes: size, quick_check: 'ok', latency_ms: 0 }, disk: null, websocket_clients: 1, server_time: nowIso(),
    counts: { devices: db.devices.length, sessions: db.sessions.length, participants: db.participants.length, contents: db.contents.length, mission_results: db.results.length, device_events: db.events.length, heartbeat_logs: db.heartbeats.length },
  }
})

// 로그
const LOG_TABLE: Row = { api_errors: 'api_errors', heartbeats: 'heartbeats', audit: 'audit', sync: 'sync_logs', events: 'events', rejections: 'rejections', backups: 'backup_history' }
route('GET', '/api/v1/logs/{kind}', (m, { q }) => {
  const t = LOG_TABLE[m[1]]
  if (!t) throw err(404, '알 수 없는 로그 종류입니다')
  let rows = [...((db as any)[t] as Row[])].reverse()
  if (t === 'audit') rows = rows.map((r) => ({ ...r, username: db.users.find((u) => u.id === r.admin_user_id)?.username ?? null }))
  if (q.q) rows = rows.filter((r) => JSON.stringify(r).includes(q.q))
  const limit = Number(q.limit ?? 50); const offset = Number(q.offset ?? 0)
  return { items: rows.slice(offset, offset + limit), total: rows.length }
}, 'admin')

// 백업 (브라우저 저장소에 스냅샷 보관)
async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
const loadBackups = (): Row[] => { try { return JSON.parse(localStorage.getItem(BACKUP_KEY) ?? '[]') } catch { return [] } }
const saveBackups = (b: Row[]) => { try { localStorage.setItem(BACKUP_KEY, JSON.stringify(b.slice(-5))) } catch { throw err(507, '브라우저 저장 공간이 부족합니다. 오래된 백업을 정리하세요') } }
const counts = (d: DB) => ({ devices: d.devices.length, sessions: d.sessions.length, participants: d.participants.length, contents: d.contents.length, mission_results: d.results.length, device_events: d.events.length, admin_users: d.users.length })
async function makeBackup(trigger: string) {
  const { hmd: _h, ...data } = db
  const text = JSON.stringify(data)
  const hash = await sha256(text)
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d{6})/, '$1_$2')
  const file = `mr_edu_${stamp}_${trigger}.json`
  const list = loadBackups(); list.push({ file, text, sha256: hash, created_at: nowIso() }); saveBackups(list)
  db.backup_history.push({ id: nextId(db, 'backup_history'), action: 'backup', trigger, file_path: file, size_bytes: text.length, sha256: hash, result: 'success', message: null, created_at: nowIso() })
  return { file, path: file, size_bytes: text.length, sha256: hash, integrity: 'ok', counts: counts(data as DB) }
}
route('GET', '/api/v1/backups', () => ({ dir: '브라우저 저장소 (최근 5개 보관)', items: loadBackups().reverse().map((b) => ({ file: b.file, path: b.file, size_bytes: b.text.length, modified_at: b.created_at, has_checksum: true })) }), 'admin')
route('POST', '/api/v1/backups', async (_m, { user }) => { const r = await makeBackup('manual'); audit(user, 'backup.create', 'backup', r.file); persist(); return r }, 'admin')
route('POST', '/api/v1/backups/verify', async (_m, { body }) => {
  const b = loadBackups().find((x) => x.file === body.file)
  if (!b) throw err(404, '백업 파일을 찾을 수 없습니다')
  const hash = await sha256(b.text)
  let parsed: DB | null = null; try { parsed = JSON.parse(b.text) } catch { /* 손상 */ }
  const ok = hash === b.sha256 && !!parsed
  db.backup_history.push({ id: nextId(db, 'backup_history'), action: 'verify', trigger: 'manual', file_path: b.file, size_bytes: b.text.length, sha256: hash, result: ok ? 'success' : 'failed', message: null, created_at: nowIso() }); persist()
  return { file: b.file, ok, sha256: hash, expected_sha256: b.sha256, checksum_ok: hash === b.sha256, integrity: parsed ? 'ok' : '손상됨', counts: parsed ? counts(parsed) : {} }
}, 'admin')
route('POST', '/api/v1/backups/restore', async (_m, { user, body }) => {
  if (!body.confirm) throw err(400, '복원하려면 confirm=true 로 확인해야 합니다')
  const b = loadBackups().find((x) => x.file === body.file)
  if (!b) throw err(404, '백업 파일을 찾을 수 없습니다')
  if ((await sha256(b.text)) !== b.sha256) throw err(400, '백업 파일 무결성 확인에 실패하여 복원을 중단했습니다')
  const pre = await makeBackup('pre_restore')
  const restored = JSON.parse(b.text) as DB
  const history = db.backup_history
  db = { ...restored, hmd: db.hmd, backup_history: history }
  db.backup_history.push({ id: nextId(db, 'backup_history'), action: 'restore', trigger: 'manual', file_path: b.file, size_bytes: b.text.length, sha256: b.sha256, result: 'success', message: `이전 DB 보존: ${pre.file}`, created_at: nowIso() })
  audit(user, 'backup.restore', 'backup', b.file); save(db)
  return { restored_from: b.file, previous_db_saved_as: pre.file, counts: counts(db), integrity: 'ok' }
}, 'admin')

// 데모 제어
route('GET', '/api/v1/demo/status', () => ({ enabled: true, static: true, offline: [...demoState.offline].sort(), speed: demoState.speed }))
route('POST', '/api/v1/demo/network', (_m, { body }) => {
  for (const d of body.device_ids as string[]) body.offline ? demoState.offline.add(d) : demoState.offline.delete(d)
  return { offline: [...demoState.offline].sort() }
}, 'op')
route('POST', '/api/v1/demo/reset', () => {
  db = seed(); save(db); localStorage.removeItem(BACKUP_KEY); demoState.offline.clear()
  return { success: true }
}, 'op')

// ---------- 진입점 ----------
export async function handle(method: string, url: string, body?: unknown): Promise<any> {
  const u = new URL(url, location.origin)
  const path = u.pathname.replace(/^.*?(\/api\/v1\/|\/health$)/, (_x, g) => g)
  const q = Object.fromEntries(u.searchParams.entries())
  const token = sessionStorage.getItem(TOKEN_KEY)
  const uid = token?.startsWith('demo.') ? Number(token.split('.')[1]) : null
  const user = uid ? db.users.find((x) => x.id === uid && x.active) ?? null : null
  for (const [m, re, h, auth] of routes) {
    if (m !== method) continue
    const match = path.match(re)
    if (!match) continue
    try {
      if (auth !== 'public') {
        if (!user) throw err(401, '로그인이 필요합니다')
        if (auth === 'op' && !['admin', 'operator'].includes(user.role)) throw err(403, '이 작업을 수행할 권한이 없습니다')
        if (auth === 'admin' && user.role !== 'admin') throw err(403, '이 작업을 수행할 권한이 없습니다')
      }
      const res = await h(match, { user, q, body: (body ?? {}) as Row })
      return JSON.parse(JSON.stringify(res)) // 호출자가 내부 객체를 직접 수정하지 않도록 복사
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status !== 401 && path.startsWith('/api')) {
        db.api_errors.push({ id: nextId(db, 'api_errors'), method, path, status_code: e.status, message: e.message, client: 'browser', created_at: nowIso() }); persist()
      }
      throw e
    }
  }
  throw err(404, `Not Found: ${method} ${path}`)
}

export function resetToSeed() { db = seed(); save(db) }
export { MISSIONS }
