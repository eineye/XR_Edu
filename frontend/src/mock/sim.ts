// 정적 웹 데모용 가상 HMD 20대 (simulator/hmd_simulator.py 의 브라우저 버전).
// 결과는 HMD 로컬 큐(outbox)에 먼저 저장 → 서버 ACK 를 받은 것만 synced → 실패 시 백오프 재시도.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ApiError } from '../api'
import * as srv from './server'
import { MISSIONS, nowIso, uuid, type Row } from './store'

const NO_BATTERY = new Set(['HMD-05', 'HMD-06'])
const DROP_RATE = 0.05
let timer: number | undefined

class NetworkDown extends Error {}

function state(id: string): Row {
  const db = srv.db
  if (!db.hmd[id]) db.hmd[id] = { outbox: [], assignment: null, mission: {}, battery: NO_BATTERY.has(id) ? null : 60 + Math.floor(Math.random() * 40), backoff: 0, next_sync: 0, sent_total: 0, last_hb: 0, last_assign: 0, interval: 30, batch: 50, retry_base: 5, retry_max: 300 }
  return db.hmd[id]
}

function call<T>(id: string, fn: () => T): T {
  if (srv.demoState.offline.has(id) || Math.random() < DROP_RATE) throw new NetworkDown()
  return fn()
}

function fail(h: Row) {
  h.backoff = Math.min(h.retry_max, Math.max(h.retry_base, h.backoff * 2 || h.retry_base))
  h.next_sync = Date.now() + (h.backoff * 1000 * (0.8 + Math.random() * 0.4)) / srv.demoState.speed
}

function heartbeat(id: string, h: Row) {
  if (h.battery !== null && Math.random() < 0.15) h.battery = Math.max(5, h.battery - 1)
  const res = call(id, () => srv.hmdHeartbeat({
    device_id: id, app_version: '1.0.0', content_version: '2026.11', app_status: h.mission?.running ? 'running' : 'idle',
    battery_level: h.battery, storage_available: null,
    pending_count: h.outbox.filter((o: Row) => o.kind === 'result' && o.status === 'pending').length,
    sent_total: h.sent_total,
    session_id: h.assignment?.session_id ?? null,
    installed_contents: Object.keys(MISSIONS).map((c) => ({ content_id: c, version: '1.0.0' })), simulated: true, occurred_at: nowIso(),
  }))
  if (h.backoff > 0) { h.backoff = 0; h.next_sync = 0 } // 연결 복구 감지 → 즉시 재전송
  h.interval = res.heartbeat_interval_sec
  Object.assign(h, { batch: res.sync.batch_size, retry_base: res.sync.retry_base_sec, retry_max: res.sync.retry_max_sec })
  if (res.commands.some((c: Row) => c.command === 'resync')) { h.backoff = 0; h.next_sync = 0 }
}

function refreshAssignment(id: string, h: Row) {
  const a = call(id, () => srv.hmdAssignment(id))
  const next = a.assigned ? a : null
  if ((next?.session_id ?? null) !== (h.assignment?.session_id ?? null)) h.mission = {}
  h.assignment = next
}

function enqueue(h: Row, kind: 'result' | 'event', payload: Row) {
  h.outbox.push({ event_id: payload.event_id, kind, session_id: h.assignment.session_id, payload, status: 'pending', reason: null })
  // 저장 공간 절약: 전송 완료(synced) 항목은 최근 30개만 남긴다 (누적 건수는 sent_total 로 유지)
  const synced = h.outbox.filter((o: Row) => o.status === 'synced')
  if (synced.length > 30) { const drop = new Set(synced.slice(0, synced.length - 30)); h.outbox = h.outbox.filter((o: Row) => !drop.has(o)) }
}

function event(id: string, h: Row, type: string, extra: Row = {}) {
  enqueue(h, 'event', { event_id: `${id}-evt-${uuid()}`, event_type: type, session_id: h.assignment.session_id, student_code: h.assignment.student_code, content_id: h.assignment.content?.content_id, occurred_at: nowIso(), ...extra })
}

function stepContent(id: string, h: Row) {
  const a = h.assignment
  if (!a || a.session_status !== 'running') { h.mission.running = false; return }
  const missions = MISSIONS[a.content?.content_id] ?? ['MISSION-01', 'MISSION-02', 'MISSION-03']
  const st = h.mission
  if (st.finished) { st.running = false; return }
  st.running = true
  if (!st.joined) { event(id, h, 'session.joined', { progress: 0 }); Object.assign(st, { joined: true, idx: 0, started: null }) }
  const i = st.idx
  if (i >= missions.length) { event(id, h, 'session.finished', { progress: 1 }); st.finished = true; st.running = false }
  else if (!st.started) {
    st.started = nowIso(); st.due = Date.now() + ((8 + Math.random() * 17) * 1000) / srv.demoState.speed
    event(id, h, 'mission.started', { mission_id: missions[i], step: `${i + 1}/${missions.length}`, progress: Math.round((i / missions.length) * 1000) / 1000 })
  } else if (Date.now() >= st.due) {
    const correct = Math.random() < 0.7
    enqueue(h, 'result', {
      result_id: `${id}-res-${uuid()}`, event_id: `${id}-evt-${uuid()}`, student_code: a.student_code, content_id: a.content?.content_id ?? 'UNKNOWN',
      content_version: a.content?.version ?? null, mission_id: missions[i], answer: correct ? 'B' : ['A', 'C', 'D'][Math.floor(Math.random() * 3)],
      is_correct: correct, score: correct ? 100 : [0, 30, 50][Math.floor(Math.random() * 3)], attempt_count: correct ? 1 : 1 + Math.floor(Math.random() * 3),
      duration_seconds: 15 + Math.floor(Math.random() * 75), started_at: st.started, completed_at: nowIso(), occurred_at: nowIso(),
    })
    st.idx = i + 1; st.started = null
    event(id, h, 'mission.completed', { mission_id: missions[i], step: `${i + 1}/${missions.length}`, progress: Math.round(((i + 1) / missions.length) * 1000) / 1000 })
  }
}

function sync(id: string, h: Row) {
  if (Date.now() < h.next_sync) return
  for (const kind of ['event', 'result'] as const) {
    for (;;) {
      const pending = h.outbox.filter((o: Row) => o.kind === kind && o.status === 'pending').slice(0, h.batch)
      if (!pending.length) break
      const bySession = new Map<string, Row[]>()
      for (const o of pending) { if (!bySession.has(o.session_id)) bySession.set(o.session_id, []); bySession.get(o.session_id)!.push(o) }
      for (const [sid, items] of bySession) {
        let ack: Row
        try {
          ack = call(id, () => (kind === 'event'
            ? srv.hmdEvents({ device_id: id, events: items.map((o) => o.payload) })
            : srv.hmdResults({ device_id: id, session_id: sid, results: items.map((o) => o.payload) })))
        } catch (e) {
          if (e instanceof NetworkDown || e instanceof ApiError) { fail(h); return }
          throw e
        }
        const ok = new Set([...ack.accepted, ...ack.duplicates])
        for (const o of items) {
          if (ok.has(o.event_id) && o.status === 'pending') { o.status = 'synced'; if (kind === 'result') h.sent_total += 1 }
          const rej = ack.rejected.find((r: Row) => r.event_id === o.event_id)
          if (rej) { o.status = 'rejected'; o.reason = rej.reason }
        }
        if (items.every((o) => o.status === 'pending')) { fail(h); return }
      }
    }
  }
  h.backoff = 0
}

function tick() {
  const speed = srv.demoState.speed
  const now = Date.now()
  for (const d of srv.db.devices) {
    if (!d.is_simulated || !d.active) continue
    const id = d.device_id
    const h = state(id)
    try {
      if (now - h.last_hb >= (h.interval * 1000) / speed) { h.last_hb = now; heartbeat(id, h) }
    } catch { /* 단절 중: heartbeat 실패 */ }
    try {
      if (now - h.last_assign >= 10000 / speed) { h.last_assign = now; refreshAssignment(id, h) }
    } catch { /* 단절 중에는 마지막으로 받은 배정으로 계속 교육 */ }
    stepContent(id, h)
    sync(id, h)
  }
  srv.persist()
}

export function startSimulator() {
  if (timer) return
  // 첫 화면에서 바로 장비가 보이도록 초기 heartbeat 를 분산 없이 한 번 실행
  for (const d of srv.db.devices) if (d.is_simulated) state(d.device_id).last_hb = 0
  tick()
  timer = window.setInterval(tick, 1000)
}
