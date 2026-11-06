export function fmtTime(iso?: string | null, withDate = true): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return withDate ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}` : t
}

export function fmtAgo(iso?: string | null): string {
  if (!iso) return '기록 없음'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 5) return '방금'
  if (s < 60) return `${s}초 전`
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  return `${Math.floor(s / 86400)}일 전`
}

export const pct = (v?: number | null, digits = 1) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(digits)}%`)
export const num = (v?: number | null, digits = 1) => (v === null || v === undefined ? '-' : Number(v).toFixed(digits).replace(/\.0+$/, ''))
export const bytes = (v?: number | null) => {
  if (v === null || v === undefined) return '-'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = v
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`
}
export const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const ROLE_LABEL: Record<string, string> = { admin: '시스템 관리자', operator: '교육 운영자', viewer: '조회 전용' }
export const SESSION_STATUS: Record<string, string> = { draft: '작성 중', ready: '준비 완료', running: '진행 중', completed: '완료', cancelled: '취소' }
export const APP_STATUS: Record<string, string> = { running: '실행 중', idle: '대기', error: '오류', unknown: '확인 불가' }
export const CATEGORY: Record<string, string> = { career: '진로', safety: '안전', environment: '환경' }
