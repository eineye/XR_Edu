import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { LayoutGrid, List } from 'lucide-react'
import { useApi, useLive } from '../live'
import { Async, Battery, Card, DataTable, Empty, HealthBadge, LiveBadge, PageHeader, ProgressBar, StatCard, cx, type Column } from '../components/ui'
import { fmtAgo, fmtTime } from '../format'

const UPLOAD: Record<string, [string, string]> = { synced: ['전송 완료', 'text-emerald-700'], pending: ['미전송 있음', 'text-amber-700 font-semibold'], unknown: ['확인 불가', 'text-slate-500'] }

export default function Live() {
  const [sp, setSp] = useSearchParams()
  const sessions = useApi<any>('/api/v1/sessions', { status: 'running,ready,completed' })
  const list = sessions.data?.items ?? []
  const sid = sp.get('session') ?? ''
  useEffect(() => {
    if (!sid && list.length) {
      const running = list.find((s: any) => s.status === 'running') ?? list[0]
      setSp({ session: String(running.id) }, { replace: true })
    }
  }, [sid, list, setSp])
  return (
    <div>
      <PageHeader title="실시간 진행 현황" desc="HMD가 보낸 미션 이벤트 기반 진행 상태입니다 (화면 스트리밍 미포함)."
        actions={<select className="input w-auto min-w-72" value={sid} onChange={(e) => setSp({ session: e.target.value })} aria-label="세션 선택">
          {list.length === 0 && <option value="">세션 없음</option>}
          {list.map((s: any) => <option key={s.id} value={s.id}>[{s.status_label}] {s.session_date} {s.institution_name} · {s.session_code}</option>)}
        </select>} />
      {sessions.loading ? null : !sid ? <Card><Empty text="진행 중이거나 준비된 세션이 없습니다" /></Card> : <Progress id={sid} />}
    </div>
  )
}

function Progress({ id }: { id: string }) {
  const st = useApi<any>(`/api/v1/sessions/${id}/progress`)
  const { wsConnected } = useLive()
  const nav = useNavigate()
  const [view, setView] = useState<'card' | 'table'>('card')
  const cols: Column<any>[] = [
    { key: 'device_id', label: 'HMD', render: (r) => <b>{r.device_id ?? '-'}</b> },
    { key: 'student_code', label: '학생 코드' },
    { key: 'live_state', label: '상태', render: (r) => <LiveBadge state={r.live_state} /> },
    { key: 'mission_id', label: '미션 단계', render: (r) => r.mission_id ? `${r.mission_id}${r.step ? ` (${r.step})` : ''}` : '-' },
    { key: 'progress', label: '진행률', render: (r) => <div className="w-32"><ProgressBar value={r.live_state === 'completed' ? 1 : r.progress ?? 0} /></div> },
    { key: 'last_report_at', label: '마지막 보고', render: (r) => r.last_report_at ? `${fmtTime(r.last_report_at, false)} (${fmtAgo(r.last_report_at)})` : '-' },
    { key: 'result_count', label: '수신 결과', render: (r) => `${r.result_count}건` },
    { key: 'upload_state', label: '업로드', render: (r) => <span className={UPLOAD[r.upload_state][1]}>{UPLOAD[r.upload_state][0]}{r.pending_count ? ` (${r.pending_count})` : ''}</span> },
    { key: 'battery_level', label: '배터리', render: (r) => <Battery level={r.battery_level} /> },
  ]
  return (
    <Async state={st}>
      {(d) => {
        const c = d.summary.counts
        return (
          <div className="space-y-4">
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-semibold">{d.session.institution_name} {d.session.grade && `${d.session.grade}학년`} {d.session.class_group && `${d.session.class_group}반`} · {d.session.content_title ?? d.session.content_id}</div>
                  <div className="text-sm text-slate-600">{d.session.status_label} · 기준 시각 {fmtTime(d.server_time, false)} · {wsConnected ? '실시간 갱신' : '10초마다 갱신'}</div>
                </div>
                <div className="w-full max-w-md"><div className="mb-1 text-sm text-slate-600">전체 세션 진행률</div><ProgressBar value={d.summary.overall_progress} /></div>
              </div>
            </Card>
            <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
              <StatCard label="참여" value={d.summary.total} />
              <StatCard label="진행 중" value={c.in_progress ?? 0} tone="blue" />
              <StatCard label="완료" value={c.completed ?? 0} tone="green" />
              <StatCard label="대기" value={c.waiting ?? 0} tone="gray" />
              <StatCard label="오프라인" value={c.offline ?? 0} tone="gray" />
              <StatCard label="오류·미배정" value={(c.error ?? 0) + (c.unassigned ?? 0)} tone="red" />
            </div>
            <Card title="장비별 진행" actions={
              <div className="flex rounded-md border border-slate-300" role="group" aria-label="보기 방식">
                <button className={cx('px-2 py-1', view === 'card' && 'bg-slate-200')} onClick={() => setView('card')} aria-pressed={view === 'card'} aria-label="카드 보기"><LayoutGrid className="size-4" /></button>
                <button className={cx('px-2 py-1', view === 'table' && 'bg-slate-200')} onClick={() => setView('table')} aria-pressed={view === 'table'} aria-label="표 보기"><List className="size-4" /></button>
              </div>}>
              {d.items.length === 0 ? <Empty text="참여 학생이 없습니다" /> : view === 'table' ? (
                <DataTable rows={d.items} columns={cols} rowKey={(r) => r.student_code} search={(r) => `${r.device_id} ${r.student_code}`} pageSize={50} onRowClick={(r) => r.device_id && nav(`/devices/${r.device_id}`)} />
              ) : (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
                  {d.items.map((r: any) => (
                    <button key={r.student_code} onClick={() => r.device_id && nav(`/devices/${r.device_id}`)}
                      className={cx('rounded-md border p-3 text-left text-sm hover:shadow', { completed: 'border-emerald-300 bg-emerald-50/60', in_progress: 'border-blue-300 bg-blue-50/50', error: 'border-red-300 bg-red-50', offline: 'border-slate-300 bg-slate-100', unassigned: 'border-amber-300 bg-amber-50', waiting: 'border-slate-200 bg-white' }[r.live_state as string])}>
                      <div className="flex items-center justify-between"><b>{r.device_id ?? '미배정'}</b><span className="font-mono text-xs">{r.student_code}</span></div>
                      <div className="mt-1 flex items-center gap-1"><LiveBadge state={r.live_state} />{r.health && r.health !== 'normal' && <HealthBadge health={r.health} />}</div>
                      <div className="mt-2 truncate text-xs text-slate-600">{r.mission_id ? `${r.mission_id} ${r.step ?? ''}` : '미션 보고 없음'}</div>
                      <div className="mt-1"><ProgressBar value={r.live_state === 'completed' ? 1 : r.progress ?? 0} /></div>
                      <div className="mt-1 flex justify-between text-xs text-slate-500"><span>결과 {r.result_count}건 · <span className={UPLOAD[r.upload_state][1]}>{UPLOAD[r.upload_state][0]}</span></span><span>{fmtAgo(r.last_report_at)}</span></div>
                    </button>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )
      }}
    </Async>
  )
}
