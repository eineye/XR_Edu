import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, BatteryLow, CheckCircle2, ChevronLeft, ChevronRight, CircleHelp,
  FlaskConical, Inbox, Loader2, Lock, PauseCircle, PlayCircle, Search, WifiOff, X, XCircle, Ban, Clock, CircleDot,
} from 'lucide-react'
import type { ApiError } from '../api'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

// ---------- 버튼 ----------
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success'
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-blue-700 text-white hover:bg-blue-800 disabled:bg-blue-300',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-300',
  ghost: 'text-slate-700 hover:bg-slate-200 disabled:text-slate-400',
}
export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className, ...p }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      {...p}
      disabled={p.disabled || loading}
      className={cx('inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm', VARIANTS[variant], className)}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  )
}

// ---------- 레이아웃 ----------
export function Card({ title, actions, children, className, bodyClass }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <h2 className="text-base font-semibold text-slate-800">{title}</h2>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={cx('p-4', bodyClass)}>{children}</div>
    </section>
  )
}

export function PageHeader({ title, desc, actions }: { title: string; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-slate-900">{title}</h1>
        {desc && <p className="mt-1 text-sm text-slate-600">{desc}</p>}
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  )
}

export function StatCard({ label, value, sub, tone = 'slate', icon, onClick }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'slate' | 'green' | 'amber' | 'red' | 'blue' | 'gray'; icon?: ReactNode; onClick?: () => void }) {
  const tones = { slate: 'text-slate-900', green: 'text-emerald-700', amber: 'text-amber-700', red: 'text-red-700', blue: 'text-blue-700', gray: 'text-slate-500' }
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp onClick={onClick} className={cx('rounded-lg border border-slate-200 bg-white p-4 text-left shadow-sm', onClick && 'transition hover:border-blue-400 hover:shadow')}>
      <div className="flex items-center gap-1.5 text-sm text-slate-600">{icon}{label}</div>
      <div className={cx('mt-1 text-2xl font-bold tabular-nums', tones[tone])}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </Comp>
  )
}

// ---------- 상태 배지 (색 + 아이콘 + 텍스트) ----------
const HEALTH: Record<string, { label: string; cls: string; icon: ReactNode }> = {
  normal: { label: '정상', cls: 'bg-emerald-50 text-emerald-800 border-emerald-300', icon: <CheckCircle2 className="size-3.5" aria-hidden /> },
  warning: { label: '주의', cls: 'bg-amber-50 text-amber-800 border-amber-300', icon: <AlertTriangle className="size-3.5" aria-hidden /> },
  offline: { label: '오프라인', cls: 'bg-slate-100 text-slate-700 border-slate-300', icon: <WifiOff className="size-3.5" aria-hidden /> },
  error: { label: '오류', cls: 'bg-red-50 text-red-800 border-red-300', icon: <XCircle className="size-3.5" aria-hidden /> },
  unknown: { label: '확인 불가', cls: 'bg-slate-50 text-slate-600 border-slate-300 border-dashed', icon: <CircleHelp className="size-3.5" aria-hidden /> },
  inactive: { label: '비활성', cls: 'bg-slate-50 text-slate-500 border-slate-200', icon: <Ban className="size-3.5" aria-hidden /> },
}
export function HealthBadge({ health, title }: { health: string; title?: string }) {
  const h = HEALTH[health] ?? HEALTH.unknown
  return <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium', h.cls)}>{h.icon}{h.label}</span>
}

const SESSION: Record<string, { label: string; cls: string; icon: ReactNode }> = {
  draft: { label: '작성 중', cls: 'bg-slate-50 text-slate-700 border-slate-300', icon: <CircleDot className="size-3.5" aria-hidden /> },
  ready: { label: '준비 완료', cls: 'bg-sky-50 text-sky-800 border-sky-300', icon: <Clock className="size-3.5" aria-hidden /> },
  running: { label: '진행 중', cls: 'bg-blue-50 text-blue-800 border-blue-300', icon: <PlayCircle className="size-3.5" aria-hidden /> },
  completed: { label: '완료', cls: 'bg-emerald-50 text-emerald-800 border-emerald-300', icon: <CheckCircle2 className="size-3.5" aria-hidden /> },
  cancelled: { label: '취소', cls: 'bg-slate-100 text-slate-500 border-slate-300', icon: <Ban className="size-3.5" aria-hidden /> },
}
export function SessionBadge({ status }: { status: string }) {
  const s = SESSION[status] ?? SESSION.draft
  return <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium', s.cls)}>{s.icon}{s.label}</span>
}

const LIVE: Record<string, { label: string; cls: string; icon: ReactNode }> = {
  waiting: { label: '대기', cls: 'bg-slate-50 text-slate-700 border-slate-300', icon: <PauseCircle className="size-3.5" aria-hidden /> },
  in_progress: { label: '진행 중', cls: 'bg-blue-50 text-blue-800 border-blue-300', icon: <PlayCircle className="size-3.5" aria-hidden /> },
  completed: { label: '완료', cls: 'bg-emerald-50 text-emerald-800 border-emerald-300', icon: <CheckCircle2 className="size-3.5" aria-hidden /> },
  offline: { label: '오프라인', cls: 'bg-slate-100 text-slate-700 border-slate-300', icon: <WifiOff className="size-3.5" aria-hidden /> },
  error: { label: '오류', cls: 'bg-red-50 text-red-800 border-red-300', icon: <XCircle className="size-3.5" aria-hidden /> },
  unassigned: { label: 'HMD 미배정', cls: 'bg-amber-50 text-amber-800 border-amber-300', icon: <AlertTriangle className="size-3.5" aria-hidden /> },
}
export function LiveBadge({ state }: { state: string }) {
  const s = LIVE[state] ?? LIVE.waiting
  return <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium', s.cls)}>{s.icon}{s.label}</span>
}

export function Battery({ level, threshold = 20 }: { level: number | null | undefined; threshold?: number }) {
  if (level === null || level === undefined) return <span className="text-xs text-slate-500" title="기기에서 배터리 정보를 제공하지 않음">확인 불가</span>
  const low = level <= threshold
  return (
    <span className={cx('inline-flex items-center gap-1 tabular-nums', low ? 'font-semibold text-amber-700' : 'text-slate-800')}>
      {low && <BatteryLow className="size-4" aria-label="배터리 부족" />}{level}%
    </span>
  )
}

export function DemoBadge({ label = '데모 모드' }: { label?: string }) {
  return <span className="inline-flex items-center gap-1 rounded border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-[11px] font-semibold text-violet-800"><FlaskConical className="size-3" aria-hidden />{label}</span>
}

export function VerifyNeeded({ children = '기기 연동 검증 필요' }: { children?: ReactNode }) {
  return <span className="inline-flex items-center gap-1 rounded border border-orange-300 bg-orange-50 px-1.5 py-0.5 text-[11px] font-semibold text-orange-800"><AlertTriangle className="size-3" aria-hidden />{children}</span>
}

export function Pill({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'green' | 'red' | 'amber' | 'blue' }) {
  const t = { slate: 'bg-slate-100 text-slate-700', green: 'bg-emerald-100 text-emerald-800', red: 'bg-red-100 text-red-800', amber: 'bg-amber-100 text-amber-800', blue: 'bg-blue-100 text-blue-800' }
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium', t[tone])}>{children}</span>
}

// ---------- 상태 화면 ----------
export function Loading({ text = '불러오는 중…' }: { text?: string }) {
  return <div role="status" className="flex items-center justify-center gap-2 py-12 text-slate-500"><Loader2 className="size-5 animate-spin" aria-hidden />{text}</div>
}
export function Empty({ text = '표시할 데이터가 없습니다', action }: { text?: ReactNode; action?: ReactNode }) {
  return <div className="flex flex-col items-center justify-center gap-2 py-12 text-slate-500"><Inbox className="size-8" aria-hidden /><div className="text-sm">{text}</div>{action}</div>
}
export function ErrorState({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  const status = (error as ApiError | null)?.status
  if (status === 403) return <Forbidden />
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-2 py-12 text-red-700">
      <XCircle className="size-8" aria-hidden />
      <div className="text-sm">{error?.message ?? '오류가 발생했습니다'}</div>
      {onRetry && <Button size="sm" onClick={onRetry}>다시 시도</Button>}
    </div>
  )
}
export function Forbidden() {
  return <div className="flex flex-col items-center justify-center gap-2 py-16 text-slate-600"><Lock className="size-8" aria-hidden /><div className="font-medium">권한이 없습니다</div><div className="text-sm">이 메뉴는 상위 권한 관리자만 사용할 수 있습니다.</div></div>
}
/** 로딩/오류/빈 데이터 공통 처리 */
export function Async<T>({ state, empty, children }: { state: { data: T | null; error: ApiError | null; loading: boolean; reload: () => void }; empty?: (d: T) => boolean; children: (d: T) => ReactNode }) {
  if (state.loading) return <Loading />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.reload} />
  if (!state.data) return <Empty />
  if (empty && empty(state.data)) return <Empty />
  return <>{children(state.data)}</>
}

// ---------- 모달 / 확인 ----------
export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); prev?.focus() }
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 pt-[6vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" className={cx('w-full rounded-lg bg-white shadow-xl outline-none', wide ? 'max-w-4xl' : 'max-w-lg')}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="text-base font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="닫기"><X className="size-5" /></button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

interface ConfirmOpts { title: string; message: ReactNode; confirmText?: string; danger?: boolean; requireText?: string }
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false)
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null)
  const [typed, setTyped] = useState('')
  const resolver = useRef<(v: boolean) => void>(undefined)
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((res) => { resolver.current = res; setTyped(''); setOpts(o) }), [])
  const close = (v: boolean) => { resolver.current?.(v); setOpts(null) }
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal open={!!opts} title={opts?.title} onClose={() => close(false)} footer={<>
        <Button onClick={() => close(false)}>취소</Button>
        <Button variant={opts?.danger ? 'danger' : 'primary'} disabled={!!opts?.requireText && typed !== opts.requireText} onClick={() => close(true)}>{opts?.confirmText ?? '확인'}</Button>
      </>}>
        <div className="space-y-3 text-sm text-slate-700">
          <div>{opts?.message}</div>
          {opts?.requireText && (
            <div>
              <label className="label">확인을 위해 <b className="text-red-700">{opts.requireText}</b> 를 입력하세요</label>
              <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </div>
          )}
        </div>
      </Modal>
    </ConfirmCtx.Provider>
  )
}
export const useConfirm = () => useContext(ConfirmCtx)

// ---------- 토스트 ----------
interface Toast { id: number; kind: 'success' | 'error' | 'info'; text: string }
const ToastCtx = createContext<{ push: (kind: Toast['kind'], text: string) => void }>({ push: () => {} })
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([])
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random()
    setList((l) => [...l, { id, kind, text }])
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500)
  }, [])
  const styles = { success: 'border-emerald-400 bg-emerald-50 text-emerald-900', error: 'border-red-400 bg-red-50 text-red-900', info: 'border-blue-400 bg-blue-50 text-blue-900' }
  const icons = { success: <CheckCircle2 className="size-4 shrink-0" />, error: <XCircle className="size-4 shrink-0" />, info: <CircleHelp className="size-4 shrink-0" /> }
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="fixed right-4 bottom-4 z-[60] flex w-96 max-w-[90vw] flex-col gap-2" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} className={cx('flex items-start gap-2 rounded-md border px-3 py-2 text-sm shadow', styles[t.kind])}>
            {icons[t.kind]}<span className="whitespace-pre-line">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
export function useToast() {
  const { push } = useContext(ToastCtx)
  return useMemo(() => ({
    success: (t: string) => push('success', t),
    error: (e: unknown) => push('error', e instanceof Error ? e.message : String(e)),
    info: (t: string) => push('info', t),
  }), [push])
}

// ---------- 폼 ----------
export function Field({ label, children, hint, required, className }: { label: string; children: ReactNode; hint?: ReactNode; required?: boolean; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="label">{label}{required && <span className="text-red-600" aria-label="필수"> *</span>}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  )
}

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: ReactNode }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div role="tablist" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)}
          className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', value === t.key ? 'border-blue-700 text-blue-800' : 'border-transparent text-slate-600 hover:text-slate-900')}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ---------- 표 ----------
export interface Column<T> {
  key: string
  label: ReactNode
  render?: (row: T) => ReactNode
  sortValue?: (row: T) => string | number | null | undefined
  className?: string
  sortable?: boolean
}

export function Pager({ page, pages, total, onPage, pageSize, onPageSize }: { page: number; pages: number; total: number; onPage: (p: number) => void; pageSize: number; onPageSize?: (n: number) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-3 text-sm text-slate-600">
      <span>총 {total.toLocaleString()}건</span>
      <div className="flex items-center gap-2">
        {onPageSize && (
          <select className="input w-auto py-1" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} aria-label="페이지당 행 수">
            {[10, 20, 50, 100].map((n) => <option key={n} value={n}>{n}개씩</option>)}
          </select>
        )}
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="이전 페이지"><ChevronLeft className="size-4" /></Button>
        <span className="tabular-nums">{page} / {Math.max(1, pages)}</span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="다음 페이지"><ChevronRight className="size-4" /></Button>
      </div>
    </div>
  )
}

/** 클라이언트 측 검색·정렬·페이지네이션 표. 필터 UI는 toolbar 로 주입 */
export function DataTable<T>({ rows, columns, rowKey, search, toolbar, pageSize: initialSize = 20, onRowClick, emptyText, initialSort }:
  { rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string | number; search?: (r: T) => string; toolbar?: ReactNode; pageSize?: number; onRowClick?: (r: T) => void; emptyText?: ReactNode; initialSort?: { key: string; dir: 'asc' | 'desc' } }) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(initialSize)
  const filtered = useMemo(() => {
    let r = rows
    if (q && search) {
      const ql = q.toLowerCase()
      r = r.filter((x) => search(x).toLowerCase().includes(ql))
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key)
      const val = col?.sortValue ?? ((x: T) => (x as Record<string, unknown>)[sort.key] as string | number | null)
      r = [...r].sort((a, b) => {
        const va = val(a), vb = val(b)
        if (va === vb) return 0
        if (va === null || va === undefined) return 1
        if (vb === null || vb === undefined) return -1
        const c = va < vb ? -1 : 1
        return sort.dir === 'asc' ? c : -c
      })
    }
    return r
  }, [rows, q, search, sort, columns])
  const pages = Math.max(1, Math.ceil(filtered.length / size))
  useEffect(() => { if (page > pages) setPage(1) }, [pages, page])
  const view = filtered.slice((page - 1) * size, page * size)
  return (
    <div>
      {(search || toolbar) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {search && (
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-400" aria-hidden />
              <input className="input pl-8" placeholder="검색" value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} aria-label="검색" />
            </div>
          )}
          {toolbar}
        </div>
      )}
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="min-w-full">
          <thead>
            <tr>
              {columns.map((c) => {
                const sortable = c.sortable !== false
                const active = sort?.key === c.key
                return (
                  <th key={c.key} className={cx('th', c.className)} aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {sortable ? (
                      <button className="inline-flex items-center gap-1 hover:text-slate-900" onClick={() => setSort(active && sort!.dir === 'desc' ? null : { key: c.key, dir: active ? 'desc' : 'asc' })}>
                        {c.label}
                        {active ? (sort!.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : <ArrowUpDown className="size-3 opacity-40" />}
                      </button>
                    ) : c.label}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {view.length === 0 ? (
              <tr><td colSpan={columns.length}><Empty text={emptyText ?? (q ? '검색 결과가 없습니다' : '표시할 데이터가 없습니다')} /></td></tr>
            ) : view.map((r) => (
              <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined}
                onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(r) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                className={cx(onRowClick && 'cursor-pointer hover:bg-blue-50 focus:bg-blue-50')}>
                {columns.map((c) => <td key={c.key} className={cx('td', c.className)}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '-')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={pages} total={filtered.length} onPage={setPage} pageSize={size} onPageSize={(n) => { setSize(n); setPage(1) }} />
    </div>
  )
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.map(([k, v], i) => (
        <div key={i} className="flex gap-2 border-b border-slate-100 py-1">
          <dt className="w-32 shrink-0 text-slate-500">{k}</dt>
          <dd className="min-w-0 break-all text-slate-900">{v ?? '-'}</dd>
        </div>
      ))}
    </dl>
  )
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const v = Math.max(0, Math.min(1, value || 0))
  return (
    <div className="flex items-center gap-2" aria-label={label ?? '진행률'} role="progressbar" aria-valuenow={Math.round(v * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${v * 100}%` }} /></div>
      <span className="w-10 text-right text-xs tabular-nums text-slate-600">{Math.round(v * 100)}%</span>
    </div>
  )
}
