// 관리자 API 클라이언트. 토큰은 sessionStorage 에 보관(브라우저 종료 시 로그아웃).
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''
/** GitHub Pages 등 정적 웹 데모 빌드 (서버 없이 브라우저 내장 데모 서버 사용) */
export const STATIC_DEMO = import.meta.env.VITE_DEMO_STATIC === '1'
const mock = () => import('./mock/server')

export class ApiError extends Error {
  status: number
  detail: unknown
  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

const TOKEN_KEY = 'mredu.token'
export const tokenStore = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: (t: string) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
}

let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

function messageOf(detail: unknown, fallback: string): string {
  if (typeof detail === 'string') return detail
  if (detail && typeof detail === 'object' && 'message' in detail) return String((detail as { message: unknown }).message)
  return fallback
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}): Promise<T> {
  let url = API_BASE + path
  if (opts.query) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
    const s = qs.toString()
    if (s) url += (url.includes('?') ? '&' : '?') + s
  }
  if (STATIC_DEMO) {
    const m = await mock()
    try {
      return (await m.handle(opts.method ?? 'GET', url, opts.body)) as T
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && path !== '/api/v1/auth/login') onUnauthorized?.()
      throw e
    }
  }
  const headers: Record<string, string> = {}
  const token = tokenStore.get()
  if (token) headers.Authorization = `Bearer ${token}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(url, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  } catch {
    throw new ApiError(0, '관리자 서버에 연결할 수 없습니다. 서버 실행 상태와 네트워크를 확인하세요.')
  }
  const ct = res.headers.get('content-type') ?? ''
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : null
  if (!res.ok) {
    const detail = data?.detail
    if (res.status === 401 && path !== '/api/v1/auth/login') onUnauthorized?.()
    throw new ApiError(res.status, messageOf(detail, `요청 실패 (${res.status})`), detail)
  }
  return data as T
}

/** 파일 다운로드 (CSV/XLSX/PDF). 인증 헤더가 필요하므로 fetch → blob 사용 */
export async function download(path: string, query: Record<string, unknown>, fallbackName: string) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
  if (STATIC_DEMO) return downloadStatic(path, query, fallbackName)
  const res = await fetch(`${API_BASE}${path}${qs.toString() ? '?' + qs : ''}`, {
    headers: { Authorization: `Bearer ${tokenStore.get() ?? ''}` },
  }).catch(() => {
    throw new ApiError(0, '관리자 서버에 연결할 수 없습니다')
  })
  if (!res.ok) {
    const j = await res.json().catch(() => null)
    throw new ApiError(res.status, messageOf(j?.detail, '내보내기에 실패했습니다'))
  }
  const blob = await res.blob()
  const cd = res.headers.get('content-disposition') ?? ''
  const m = /filename\*=UTF-8''([^;]+)/.exec(cd)
  const name = m ? decodeURIComponent(m[1]) : fallbackName
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export function wsUrl(): string {
  const base = API_BASE || window.location.origin
  return base.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(tokenStore.get() ?? '')}`
}

/** 정적 웹 데모: CSV 는 브라우저에서 생성, XLSX·PDF 는 실제 서버에서만 지원 */
async function downloadStatic(path: string, query: Record<string, unknown>, fallbackName: string) {
  const fmt = path.endsWith('.csv') ? 'csv' : String(query.format ?? 'csv')
  if (fmt !== 'csv') throw new ApiError(400, `웹 데모에서는 CSV만 내려받을 수 있습니다. ${fmt.toUpperCase()}는 관리자 서버를 실행하면 지원됩니다.`)
  const m = await mock()
  const rest = Object.fromEntries(Object.entries(query).filter(([k]) => k !== 'format'))
  let rep: any
  if (path.endsWith('/devices/export.csv')) {
    const d = await api<any>('/api/v1/devices')
    rep = { title: '장비 목록', meta: [], tables: [{ title: '장비', columns: [['device_id', '장비 ID'], ['device_name', '별칭'], ['model', '모델'], ['health_label', '상태'], ['connection_status', '연결'], ['app_status', '앱 상태'], ['battery_level', '배터리(%)'], ['app_version', '앱 버전'], ['content_version', '콘텐츠 버전'], ['last_seen_at', '마지막 통신']], rows: d.items }] }
  } else {
    rep = await api<any>(path, { query: rest })
  }
  const blob = new Blob([m.reportToCsv(rep)], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = fallbackName.replace(/\.(xlsx|pdf)$/, '.csv')
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
