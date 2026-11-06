import { useNavigate } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, CheckCircle2, CloudOff, Glasses, Wifi, WifiOff, XCircle } from 'lucide-react'
import { useApi, useLive } from '../live'
import { Async, Battery, Card, DemoBadge, Empty, HealthBadge, PageHeader, ProgressBar, StatCard, cx } from '../components/ui'
import { fmtAgo, fmtTime } from '../format'

export default function Dashboard() {
  const nav = useNavigate()
  const live = useLive()
  const st = useApi<any>('/api/v1/dashboard/summary')
  return (
    <div>
      <PageHeader title="대시보드" desc={st.data && <>데이터 기준 {fmtTime(st.data.data_as_of)} · 마지막 HMD 통신 {fmtAgo(st.data.last_heartbeat_at)} · 실시간 {live.wsConnected ? 'WebSocket' : 'REST 10초 갱신'}</>} />
      <Async state={st}>
        {(d) => (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
              <StatCard label="전체 장비" value={d.devices.total} icon={<Glasses className="size-4" />} onClick={() => nav('/devices')} />
              <StatCard label="연결" value={d.devices.online} tone="green" icon={<Wifi className="size-4" />} onClick={() => nav('/devices?health=normal,warning,error')} />
              <StatCard label="오프라인" value={d.devices.offline + d.devices.unknown} tone="gray" sub={d.devices.unknown ? `통신 기록 없음 ${d.devices.unknown}` : undefined} icon={<WifiOff className="size-4" />} onClick={() => nav('/devices?health=offline,unknown')} />
              <StatCard label="주의" value={d.devices.warning} tone="amber" icon={<AlertTriangle className="size-4" />} onClick={() => nav('/devices?health=warning')} />
              <StatCard label="오류" value={d.devices.error} tone="red" icon={<XCircle className="size-4" />} onClick={() => nav('/devices?health=error')} />
              <StatCard label="진행 중 세션" value={d.running_sessions.length} tone="blue" icon={<CheckCircle2 className="size-4" />} onClick={() => nav('/sessions?status=running')} />
              <StatCard label="미동기화 결과" value={d.unsynced.pending_total} tone={d.unsynced.pending_total ? 'amber' : 'slate'} icon={<CloudOff className="size-4" />}
                sub={<>HMD 보고 기준{d.unsynced.devices_unknown ? ` · 미보고 ${d.unsynced.devices_unknown}대` : ''}{d.unsynced.rejected_24h ? ` · 거부 ${d.unsynced.rejected_24h}` : ''}</>}
                onClick={() => nav('/results?tab=unsynced')} />
            </div>

            <Card title="장비 상태 현황" actions={d.demo.simulated_devices > 0 && <DemoBadge label="가상 HMD 데이터 포함" />}>
              {d.device_tiles.length === 0 ? <Empty text="등록된 장비가 없습니다" action={<button className="text-sm text-blue-700 underline" onClick={() => nav('/devices')}>장비 등록하기</button>} /> : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-10">
                  {d.device_tiles.map((t: any) => (
                    <button key={t.device_id} onClick={() => nav(`/devices/${t.device_id}`)} title={t.reasons.join(' / ') || '정상'}
                      className={cx('rounded-md border p-2 text-left text-xs transition hover:shadow',
                        { normal: 'border-emerald-200 bg-emerald-50/50', warning: 'border-amber-300 bg-amber-50', error: 'border-red-300 bg-red-50', offline: 'border-slate-300 bg-slate-100', unknown: 'border-dashed border-slate-300 bg-white' }[t.health as string])}>
                      <div className="flex items-center justify-between font-semibold text-slate-800">{t.device_id}{t.is_simulated ? <span className="text-[10px] text-violet-700">가상</span> : null}</div>
                      <div className="mt-1"><HealthBadge health={t.health} /></div>
                      <div className="mt-1 flex justify-between text-slate-600"><Battery level={t.battery_level} /><span>{fmtAgo(t.last_seen_at)}</span></div>
                    </button>
                  ))}
                </div>
              )}
            </Card>

            <div className="grid gap-4 xl:grid-cols-2">
              <Card title="현재 교육 세션">
                {d.running_sessions.length === 0 ? <Empty text="진행 중인 세션이 없습니다" /> : (
                  <ul className="space-y-3">
                    {d.running_sessions.map((s: any) => (
                      <li key={s.id}>
                        <button className="w-full rounded-md border border-slate-200 p-3 text-left hover:border-blue-400" onClick={() => nav(`/live?session=${s.id}`)}>
                          <div className="flex flex-wrap justify-between gap-2 text-sm">
                            <b>{s.institution_name} {s.grade && `${s.grade}학년`} {s.class_group && `${s.class_group}반`} {s.session_no && `${s.session_no}회차`}</b>
                            <span className="text-slate-500">{s.session_code}</span>
                          </div>
                          <div className="mt-1 text-sm text-slate-600">{s.content_title} · 참여 {s.participants}명 · 완료 {s.completed}명 · 시작 {fmtTime(s.started_at, false)}</div>
                          <div className="mt-2"><ProgressBar value={s.progress} /></div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="최근 알림">
                {d.alerts.length === 0 ? <Empty text="알림이 없습니다" /> : (
                  <ul className="divide-y divide-slate-100">
                    {d.alerts.map((a: any, i: number) => (
                      <li key={i} className="flex items-start gap-2 py-2 text-sm">
                        <HealthBadge health={a.level} />
                        <button className="font-medium text-blue-800 hover:underline" onClick={() => a.device_id && nav(`/devices/${a.device_id}`)}>{a.device_id}</button>
                        <span className="flex-1 text-slate-700">{a.message}</span>
                        <span className="whitespace-nowrap text-xs text-slate-500">{fmtAgo(a.at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <div className="grid gap-4 xl:grid-cols-3">
              <Card title="최근 7일 미션 정답률" className="xl:col-span-2">
                {d.mission_accuracy.length === 0 ? <Empty text="수신된 학습 결과가 없습니다" /> : (
                  <div className="h-72" role="img" aria-label="미션별 정답률 막대 그래프">
                    <ResponsiveContainer>
                      <BarChart data={d.mission_accuracy.map((m: any) => ({ ...m, acc: m.accuracy === null ? 0 : Math.round(m.accuracy * 1000) / 10 }))}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="mission_id" tick={{ fontSize: 11 }} interval={0} angle={-25} textAnchor="end" height={70} />
                        <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 11 }} />
                        <Tooltip formatter={(v: any) => [`${v}%`, '정답률']} />
                        <Bar dataKey="acc" fill="#1d4ed8" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Card>
              <Card title="최근 수신 결과">
                {d.recent_results.length === 0 ? <Empty /> : (
                  <ul className="divide-y divide-slate-100 text-sm">
                    {d.recent_results.map((r: any) => (
                      <li key={r.result_id} className="flex items-center gap-2 py-1.5">
                        <span className={cx('w-5 text-center font-bold', r.is_correct ? 'text-emerald-700' : 'text-red-700')} aria-label={r.is_correct ? '정답' : '오답'}>{r.is_correct ? 'O' : 'X'}</span>
                        <span className="w-14 text-slate-600">{r.student_code}</span>
                        <span className="flex-1 truncate">{r.mission_id}</span>
                        <span className="text-xs text-slate-500">{fmtAgo(r.received_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        )}
      </Async>
    </div>
  )
}
