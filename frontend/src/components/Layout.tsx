import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  Activity, BarChart3, ClipboardList, Database, FileText, Glasses, LayoutDashboard, LogOut, Menu, Package, Settings,
  ShieldCheck, Users, Wifi, WifiOff, Server, ServerOff, KeyRound,
} from 'lucide-react'
import { useAuth, type Role } from '../auth'
import { useLive } from '../live'
import { useApi } from '../live'
import { fmtAgo, fmtTime } from '../format'
import { cx, DemoBadge } from './ui'
import ChangePasswordModal from './ChangePasswordModal'

const NAV: { to: string; label: string; icon: React.ElementType; roles?: Role[] }[] = [
  { to: '/', label: '대시보드', icon: LayoutDashboard },
  { to: '/devices', label: '장비 관리', icon: Glasses },
  { to: '/sessions', label: '교육 세션 관리', icon: ClipboardList },
  { to: '/live', label: '실시간 진행 현황', icon: Activity },
  { to: '/results', label: '학습 결과 관리', icon: BarChart3 },
  { to: '/contents', label: '콘텐츠 관리', icon: Package },
  { to: '/reports', label: '보고서', icon: FileText },
  { to: '/settings', label: '네트워크·시스템 설정', icon: Settings },
  { to: '/users', label: '사용자·권한 관리', icon: Users, roles: ['admin'] },
  { to: '/logs', label: '시스템 로그·백업', icon: Database, roles: ['admin'] },
]

export default function Layout() {
  const { user, logout, can } = useAuth()
  const live = useLive()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const [pwOpen, setPwOpen] = useState(() => !!user?.must_change_password && sessionStorage.getItem('mredu.pwLater') !== '1')
  const closePw = () => { setPwOpen(false); if (user?.must_change_password) sessionStorage.setItem('mredu.pwLater', '1') }
  const { data: running } = useApi<{ items: { id: number; session_code: string; institution_name: string }[] }>('/api/v1/sessions', { status: 'running' })
  const { data: summary } = useApi<{ demo: { simulated_devices: number } }>('/api/v1/dashboard/summary')
  const cur = running?.items?.[0]
  const disconnected = live.serverOk === false || !live.browserOnline

  return (
    <div className="min-h-screen lg:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-2">본문으로 건너뛰기</a>
      {/* 사이드바 */}
      <aside className={cx('fixed inset-y-0 left-0 z-40 w-60 shrink-0 bg-slate-900 text-slate-100 transition-transform lg:static lg:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')}>
        <div className="flex h-14 items-center gap-2 border-b border-slate-800 px-4">
          <div className="grid size-8 place-items-center rounded-md bg-blue-600 text-sm font-bold">MR</div>
          <div className="leading-tight"><div className="font-bold">MR EDU MOBILE</div><div className="text-xs text-slate-400">2.0 관리자</div></div>
        </div>
        <nav className="space-y-0.5 p-2" aria-label="주 메뉴">
          {NAV.filter((n) => !n.roles || can(...n.roles)).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={() => setOpen(false)}
              className={({ isActive }) => cx('flex items-center gap-2.5 rounded-md px-3 py-2 text-sm', isActive ? 'bg-blue-700 font-semibold text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white')}>
              <n.icon className="size-4" aria-hidden />{n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setOpen(false)} />}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 상단바: 운영 장소·세션·서버 상태 */}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4">
          <button className="rounded p-1.5 hover:bg-slate-100 lg:hidden" onClick={() => setOpen(true)} aria-label="메뉴 열기"><Menu className="size-5" /></button>
          <div className="min-w-0 flex-1 truncate text-sm">
            {cur ? (
              <button className="truncate text-left" onClick={() => nav(`/live?session=${cur.id}`)}>
                <span className="text-slate-500">진행 중 세션 </span><b>{cur.institution_name}</b> <span className="text-slate-500">· {cur.session_code}</span>
                {running!.items.length > 1 && <span className="ml-1 text-slate-500">외 {running!.items.length - 1}건</span>}
              </button>
            ) : <span className="text-slate-500">진행 중인 세션 없음</span>}
          </div>
          {!!summary?.demo?.simulated_devices && <DemoBadge label={`데모 모드 · 가상 HMD ${summary.demo.simulated_devices}대`} />}
          <div className="hidden items-center gap-3 text-xs md:flex">
            <span className={cx('inline-flex items-center gap-1', live.serverOk === false ? 'text-red-700' : 'text-emerald-700')} title={`마지막 응답 ${fmtTime(live.lastServerContact)}`}>
              {live.serverOk === false ? <ServerOff className="size-4" aria-hidden /> : <Server className="size-4" aria-hidden />}
              서버: {live.serverOk === null ? '확인 중' : live.serverOk ? '정상' : '응답 없음'}
            </span>
            <span className={cx('inline-flex items-center gap-1', live.wsConnected ? 'text-emerald-700' : 'text-amber-700')}>
              {live.wsConnected ? <Wifi className="size-4" aria-hidden /> : <WifiOff className="size-4" aria-hidden />}
              실시간: {live.wsConnected ? '연결됨' : '재연결 중(10초 갱신)'}
            </span>
          </div>
          <div className="flex items-center gap-1 border-l border-slate-200 pl-3 text-sm">
            <ShieldCheck className="size-4 text-slate-500" aria-hidden />
            <span className="hidden sm:inline">{user?.display_name || user?.username}</span>
            <span className="text-xs text-slate-500">({user?.role_label})</span>
            <button className="ml-1 rounded p-1.5 hover:bg-slate-100" title="비밀번호 변경" aria-label="비밀번호 변경" onClick={() => setPwOpen(true)}><KeyRound className="size-4" /></button>
            <button className="rounded p-1.5 hover:bg-slate-100" title="로그아웃" aria-label="로그아웃" onClick={logout}><LogOut className="size-4" /></button>
          </div>
        </header>
        {disconnected && (
          <div role="alert" className="flex items-center gap-2 bg-red-700 px-4 py-2 text-sm text-white">
            <WifiOff className="size-4" aria-hidden />
            {!live.browserOnline ? '이 PC의 네트워크 연결이 끊겼습니다.' : '관리자 서버(로컬 API)에 연결할 수 없습니다.'}
            <span className="opacity-90">화면은 마지막으로 받은 데이터입니다 (마지막 통신 {fmtAgo(live.lastServerContact)}). HMD 교육은 계속 진행되며 결과는 HMD에 보관됩니다.</span>
          </div>
        )}
        <main id="main" className="mx-auto w-full max-w-[1600px] flex-1 p-4 lg:p-6"><Outlet /></main>
      </div>
      <ChangePasswordModal open={pwOpen} forced={!!user?.must_change_password} onClose={closePw} />
    </div>
  )
}
