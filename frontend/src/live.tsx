// 실시간 상태 갱신: WebSocket 우선, 끊기면 REST polling 으로 대체하고 재연결 시도
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, wsUrl } from './api'
import { useAuth } from './auth'

export interface LiveEvent {
  type: string
  data: Record<string, unknown>
  server_time: string
}

interface LiveCtx {
  tick: number // 데이터 재조회 신호
  wsConnected: boolean
  serverOk: boolean | null
  browserOnline: boolean
  lastServerContact: string | null
  lastEvent: LiveEvent | null
  events: LiveEvent[]
  bump: () => void
}

const Ctx = createContext<LiveCtx>(null as unknown as LiveCtx)
const POLL_MS = 10_000

export function LiveProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [tick, setTick] = useState(0)
  const [wsConnected, setWs] = useState(false)
  const [serverOk, setServerOk] = useState<boolean | null>(null)
  const [browserOnline, setOnline] = useState(navigator.onLine)
  const [lastServerContact, setLastContact] = useState<string | null>(null)
  const [lastEvent, setLastEvent] = useState<LiveEvent | null>(null)
  const [events, setEvents] = useState<LiveEvent[]>([])
  const pendingBump = useRef<number | null>(null)

  const bump = useCallback(() => setTick((t) => t + 1), [])
  // 이벤트가 몰려도 1초에 한 번만 재조회
  const throttledBump = useCallback(() => {
    if (pendingBump.current !== null) return
    pendingBump.current = window.setTimeout(() => {
      pendingBump.current = null
      setTick((t) => t + 1)
    }, 1000)
  }, [])

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  // 서버 상태 확인
  useEffect(() => {
    let alive = true
    const check = async () => {
      try {
        const r = await api<{ status: string; server_time: string }>('/health')
        if (!alive) return
        setServerOk((prev) => {
          if (prev === false) setTick((t) => t + 1) // 복구 시 최신 상태 재조회
          return r.status === 'ok'
        })
        setLastContact(r.server_time)
      } catch (e) {
        if (alive) setServerOk(e instanceof ApiError && e.status === 503 ? false : false)
      }
    }
    check()
    const id = window.setInterval(check, 5000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  // WebSocket
  useEffect(() => {
    if (!user) return
    let ws: WebSocket | null = null
    let retry = 1000
    let timer: number | undefined
    let ping: number | undefined
    let stopped = false
    const connect = () => {
      ws = new WebSocket(wsUrl())
      ws.onopen = () => {
        setWs(true)
        retry = 1000
        setTick((t) => t + 1)
        ping = window.setInterval(() => ws?.readyState === 1 && ws.send('ping'), 25_000)
      }
      ws.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data) as LiveEvent
          setLastContact(ev.server_time)
          if (ev.type === 'hello' || ev.type === 'pong') return
          setLastEvent(ev)
          if (ev.type !== 'device.heartbeat') setEvents((list) => [ev, ...list].slice(0, 50))
          throttledBump()
        } catch {
          /* ignore */
        }
      }
      ws.onclose = () => {
        setWs(false)
        clearInterval(ping)
        if (!stopped) {
          timer = window.setTimeout(connect, retry)
          retry = Math.min(retry * 2, 30_000)
        }
      }
      ws.onerror = () => ws?.close()
    }
    connect()
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(ping)
      ws?.close()
    }
  }, [user, throttledBump])

  // WebSocket 이 끊긴 동안 polling
  useEffect(() => {
    if (wsConnected || !user) return
    const id = window.setInterval(() => setTick((t) => t + 1), POLL_MS)
    return () => clearInterval(id)
  }, [wsConnected, user])

  return (
    <Ctx.Provider value={{ tick, wsConnected, serverOk, browserOnline, lastServerContact, lastEvent, events, bump }}>
      {children}
    </Ctx.Provider>
  )
}

export const useLive = () => useContext(Ctx)

/** API 조회 훅. live=true 면 실시간 신호(tick)에 따라 자동 재조회. */
export function useApi<T = any>(path: string | null, query?: Record<string, unknown>, live = true) {
  const { tick } = useLive()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const qkey = JSON.stringify(query ?? {})
  const reload = useCallback(() => setReloadKey((k) => k + 1), [])
  useEffect(() => {
    if (!path) { setLoading(false); return }
    let alive = true
    api<T>(path, { query: query })
      .then((d) => {
        if (!alive) return
        setData(d)
        setError(null)
      })
      .catch((e: ApiError) => alive && setError(e))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, qkey, reloadKey, live ? tick : 0])
  // 경로/필터가 바뀌면 로딩 표시
  useEffect(() => { setLoading(true) }, [path, qkey])
  return { data, error, loading: loading && !data, refreshing: loading, reload, setData }
}
