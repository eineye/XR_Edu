import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { useApi } from '../live'
import { Async, Battery, Button, Card, DemoBadge, Empty, Field, HealthBadge, KV, PageHeader, Pill, SessionBadge, Tabs, VerifyNeeded, useConfirm, useToast } from '../components/ui'
import { APP_STATUS, fmtAgo, fmtTime } from '../format'

export default function DeviceDetail() {
  const { id } = useParams()
  const st = useApi<any>(`/api/v1/devices/${id}`)
  const nav = useNavigate()
  return (
    <div>
      <button onClick={() => nav('/devices')} className="mb-2 inline-flex items-center gap-1 text-sm text-blue-800 hover:underline"><ArrowLeft className="size-4" />장비 목록</button>
      <Async state={st}>{(d) => <Detail d={d} reload={st.reload} />}</Async>
    </div>
  )
}

function Detail({ d, reload }: { d: any; reload: () => void }) {
  const { can } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const [tab, setTab] = useState('info')
  const [edit, setEdit] = useState({ device_name: d.device_name ?? '', model: d.model, notes: d.notes ?? '' })
  useEffect(() => setEdit({ device_name: d.device_name ?? '', model: d.model, notes: d.notes ?? '' }), [d.device_id]) // eslint-disable-line
  const editable = can('admin', 'operator')
  const demo = useApi<any>('/api/v1/demo/status')
  const demoOffline = demo.data?.offline?.includes(d.device_id)
  const toggleNet = async () => {
    try {
      await api('/api/v1/demo/network', { method: 'POST', body: { device_ids: [d.device_id], offline: !demoOffline } })
      toast.info(demoOffline ? `${d.device_id} Wi-Fi 복구 — 다음 heartbeat 때 미전송 결과가 재전송됩니다` : `${d.device_id} Wi-Fi 단절 — 교육은 계속되고 결과는 HMD에 쌓입니다`)
      demo.reload()
    } catch (e) { toast.error(e) }
  }

  const save = async () => {
    try { await api(`/api/v1/devices/${d.device_id}`, { method: 'PATCH', body: edit }); toast.success('저장했습니다'); reload() } catch (e) { toast.error(e) }
  }
  const toggleActive = async () => {
    const ok = await confirm({ title: d.active ? '장비 비활성화' : '장비 활성화', message: d.active ? `${d.device_id}를 비활성화하면 세션 배정·heartbeat 수신이 중지됩니다. 데이터는 삭제되지 않습니다.` : `${d.device_id}를 다시 활성화합니다.`, danger: !!d.active, confirmText: d.active ? '비활성화' : '활성화' })
    if (!ok) return
    try { await api(`/api/v1/devices/${d.device_id}`, { method: 'PATCH', body: { active: !d.active } }); toast.success('변경했습니다'); reload() } catch (e) { toast.error(e) }
  }
  const resync = async () => {
    try {
      const r = await api(`/api/v1/devices/${d.device_id}/resync`, { method: 'POST' })
      toast.info(r.already_pending ? '이미 재전송 요청이 대기 중입니다' : '재전송 요청을 등록했습니다. HMD의 다음 heartbeat 때 전달됩니다.')
      reload()
    } catch (e) { toast.error(e) }
  }

  return (
    <>
      <PageHeader title={`${d.device_id}${d.device_name ? ` · ${d.device_name}` : ''}`}
        desc={<span className="inline-flex flex-wrap items-center gap-2"><HealthBadge health={d.health} />{d.health_reasons.join(' / ')}{d.is_simulated ? <DemoBadge label="가상 HMD" /> : null}</span>}
        actions={editable && <>
          {demo.data?.enabled && d.is_simulated ? (
            <Button variant={demoOffline ? 'success' : 'secondary'} icon={demoOffline ? <Wifi className="size-4" /> : <WifiOff className="size-4" />} onClick={toggleNet}>
              {demoOffline ? '[데모] Wi-Fi 복구' : '[데모] Wi-Fi 단절'}
            </Button>
          ) : null}
          <Button icon={<RefreshCw className="size-4" />} onClick={resync}>미전송 결과 재전송 요청</Button>
          <Button variant={d.active ? 'danger' : 'success'} onClick={toggleActive}>{d.active ? '비활성화' : '활성화'}</Button>
        </>} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'info', label: '기본 정보' }, { key: 'comm', label: '통신 이력' }, { key: 'sessions', label: `세션 참여 이력 (${d.sessions.length})` }, { key: 'sync', label: '동기화' }, { key: 'contents', label: '설치 콘텐츠' },
      ]} />
      {tab === 'info' && (
        <div className="grid gap-4 xl:grid-cols-3">
          <Card title="장비 상태" className="xl:col-span-2">
            <KV items={[
              ['연결 상태', d.connection_status === 'online' ? '온라인' : d.connection_status === 'offline' ? '오프라인 (마지막 통신 기준)' : '확인 불가'],
              ['마지막 heartbeat', d.last_seen_at ? `${fmtTime(d.last_seen_at)} (${fmtAgo(d.last_seen_at)})` : '기록 없음'],
              ['앱 상태', d.connection_status === 'online' ? APP_STATUS[d.app_status] : `확인 불가 (마지막 보고: ${APP_STATUS[d.app_status]})`],
              ['배터리', <Battery level={d.battery_level} />],
              ['저장공간', d.storage_available === null ? <span className="inline-flex items-center gap-2 text-slate-500">확인 불가 <VerifyNeeded /></span> : `${d.storage_available} MB`],
              ['최근 오류 코드', d.last_error_code ? `${d.last_error_code} (${fmtTime(d.last_error_at)})` : '없음'],
              ['앱 버전', d.app_version], ['콘텐츠 버전', d.content_version],
              ['현재 배정', d.assignment ? <Link className="text-blue-800 underline" to={`/sessions/${d.assignment.session_pk}`}>{d.assignment.session_code} · {d.assignment.student_code}</Link> : '없음'],
              ['마지막 동기화', fmtTime(d.last_sync_at)],
              ['등록일', fmtTime(d.created_at)], ['활성', d.active ? '예' : '아니오 (비활성)'],
            ]} />
          </Card>
          <Card title="장비 정보 수정">
            <div className="space-y-3">
              <Field label="별칭"><input className="input" disabled={!editable} value={edit.device_name} onChange={(e) => setEdit({ ...edit, device_name: e.target.value })} /></Field>
              <Field label="모델명"><input className="input" disabled={!editable} value={edit.model} onChange={(e) => setEdit({ ...edit, model: e.target.value })} /></Field>
              <Field label="비고"><textarea className="input" rows={3} disabled={!editable} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
              {editable && <Button variant="primary" onClick={save}>저장</Button>}
            </div>
          </Card>
        </div>
      )}
      {tab === 'comm' && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="최근 heartbeat (30건)">
            {d.heartbeats.length === 0 ? <Empty text="수신 기록 없음" /> : (
              <table className="min-w-full"><thead><tr><th className="th">수신 시각</th><th className="th">앱</th><th className="th">배터리</th><th className="th">미전송</th></tr></thead>
                <tbody>{d.heartbeats.map((h: any, i: number) => { const p = JSON.parse(h.payload_json || '{}'); return (
                  <tr key={i}><td className="td">{fmtTime(h.received_at)}</td><td className="td">{APP_STATUS[p.app_status] ?? '-'}</td><td className="td"><Battery level={p.battery_level} /></td><td className="td">{p.pending_count ?? '미보고'}</td></tr>) })}</tbody></table>
            )}
          </Card>
          <Card title="최근 이벤트">
            {d.events.length === 0 ? <Empty text="이벤트 없음" /> : (
              <ul className="divide-y divide-slate-100 text-sm">{d.events.map((e: any) => (
                <li key={e.event_id} className="flex gap-2 py-1.5"><Pill tone={e.event_type === 'app.error' ? 'red' : 'blue'}>{e.event_type}</Pill><span className="flex-1 truncate text-slate-600">{e.session_id}</span><span className="text-xs text-slate-500">{fmtTime(e.occurred_at)}</span></li>
              ))}</ul>
            )}
          </Card>
        </div>
      )}
      {tab === 'sessions' && (
        <Card>
          {d.sessions.length === 0 ? <Empty text="참여 이력 없음" /> : (
            <table className="min-w-full"><thead><tr><th className="th">세션</th><th className="th">기관</th><th className="th">교육일</th><th className="th">학생</th><th className="th">결과</th><th className="th">상태</th></tr></thead>
              <tbody>{d.sessions.map((s: any) => (
                <tr key={s.id}><td className="td"><Link className="text-blue-800 underline" to={`/sessions/${s.id}`}>{s.session_code}</Link></td><td className="td">{s.institution_name}</td><td className="td">{s.session_date}</td><td className="td">{s.student_code}</td><td className="td">{s.result_count}건</td><td className="td"><SessionBadge status={s.status} /></td></tr>
              ))}</tbody></table>
          )}
        </Card>
      )}
      {tab === 'sync' && (
        <Card title="결과 동기화">
          <KV items={[
            ['HMD 미전송(보고)', d.reported_pending_count ?? '미보고'], ['HMD 전송 완료(보고)', d.reported_sent_total ?? '미보고'],
            ['서버 수신 결과', `${d.received_result_total}건`],
            ['건수 비교', d.reported_sent_total === null ? '확인 불가' : d.reported_sent_total === d.received_result_total ? '일치' : <span className="font-semibold text-amber-700">불일치 (HMD {d.reported_sent_total} / 서버 {d.received_result_total})</span>],
          ]} />
          <h3 className="mt-4 mb-2 text-sm font-semibold">업로드 이력</h3>
          {d.sync_logs.length === 0 ? <Empty text="업로드 이력 없음" /> : (
            <table className="min-w-full"><thead><tr><th className="th">시각</th><th className="th">세션</th><th className="th">전송</th><th className="th">저장</th><th className="th">중복</th><th className="th">거부</th></tr></thead>
              <tbody>{d.sync_logs.map((l: any) => <tr key={l.id}><td className="td">{fmtTime(l.created_at)}</td><td className="td">{l.session_id}</td><td className="td">{l.received_count}</td><td className="td">{l.accepted_count}</td><td className="td">{l.duplicate_count}</td><td className="td">{l.rejected_count ? <span className="font-semibold text-red-700">{l.rejected_count}</span> : 0}</td></tr>)}</tbody></table>
          )}
          <h3 className="mt-4 mb-2 text-sm font-semibold">장비 명령</h3>
          {d.pending_commands.length === 0 ? <p className="text-sm text-slate-500">없음</p> : (
            <ul className="text-sm">{d.pending_commands.map((c: any) => <li key={c.id}>{fmtTime(c.created_at)} · {c.command === 'resync' ? '재전송 요청' : c.command} · {c.status === 'pending' ? '전달 대기' : `전달됨 (${fmtTime(c.delivered_at)})`}</li>)}</ul>
          )}
        </Card>
      )}
      {tab === 'contents' && (
        <Card title="설치 콘텐츠 (HMD 보고 / 배포 계획)">
          {d.installs.length === 0 ? <Empty text="보고된 설치 정보가 없습니다" /> : (
            <table className="min-w-full"><thead><tr><th className="th">콘텐츠</th><th className="th">버전</th><th className="th">상태</th><th className="th">출처</th><th className="th">갱신</th></tr></thead>
              <tbody>{d.installs.map((i: any) => <tr key={i.content_id}><td className="td">{i.content_id}</td><td className="td">{i.version}</td><td className="td">{{ installed: '설치됨', planned: '설치 예정', failed: '실패', unknown: '확인 불가' }[i.status as string]}</td><td className="td">{i.source === 'reported' ? 'HMD 보고' : '관리자 계획'}</td><td className="td">{fmtTime(i.updated_at)}</td></tr>)}</tbody></table>
          )}
        </Card>
      )}
    </>
  )
}
