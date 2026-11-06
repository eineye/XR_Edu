import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Ban, CheckCircle2, Copy, FileText, Play, Activity, Save } from 'lucide-react'
import { api, ApiError } from '../api'
import { useAuth } from '../auth'
import { useApi } from '../live'
import { Async, Button, Card, HealthBadge, Modal, PageHeader, SessionBadge, Tabs, useConfirm, useToast } from '../components/ui'
import ParticipantEditor, { participantIssues, type Participant } from '../components/ParticipantEditor'
import { ClassFields, ContentPicker, InstitutionFields, fromSession, toPayload, type SessionFields } from '../components/SessionForm'
import { fmtTime } from '../format'

export default function SessionDetail() {
  const { id } = useParams()
  const st = useApi<any>(`/api/v1/sessions/${id}`, undefined, false)
  const nav = useNavigate()
  return (
    <div>
      <button onClick={() => nav('/sessions')} className="mb-2 inline-flex items-center gap-1 text-sm text-blue-800 hover:underline"><ArrowLeft className="size-4" />세션 목록</button>
      <Async state={st}>{(s) => <Detail s={s} reload={st.reload} setS={st.setData} />}</Async>
    </div>
  )
}

function Detail({ s, reload, setS }: { s: any; reload: () => void; setS: (v: any) => void }) {
  const { can } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const nav = useNavigate()
  const op = can('admin', 'operator')
  const editable = op && ['draft', 'ready'].includes(s.status)
  const partsEditable = op && ['draft', 'ready', 'running'].includes(s.status)
  const [tab, setTab] = useState('participants')
  const [f, setF] = useState<SessionFields>(fromSession(s))
  const [parts, setParts] = useState<Participant[]>(s.participants.map((p: any) => ({ student_code: p.student_code, device_id: p.device_id })))
  const [issues, setIssues] = useState<any[] | null>(null)
  const contents = useApi<any>('/api/v1/contents', undefined, false)
  const devices = useApi<any>('/api/v1/devices')
  useEffect(() => {
    setF(fromSession(s))
    setParts(s.participants.map((p: any) => ({ student_code: p.student_code, device_id: p.device_id })))
  }, [s])
  const busyDevices = (devices.data?.items ?? []).filter((d: any) => d.assignment?.status === 'running' && d.assignment.session_pk !== s.id).map((d: any) => d.device_id)
  const dirtyParts = JSON.stringify(parts) !== JSON.stringify(s.participants.map((p: any) => ({ student_code: p.student_code, device_id: p.device_id })))

  const run = async (fn: () => Promise<any>, ok: string) => {
    try { const r = await fn(); if (r?.id) setS(r); else reload(); toast.success(ok); return r } catch (e) { toast.error(e) }
  }
  const saveInfo = () => run(() => api(`/api/v1/sessions/${s.id}`, { method: 'PATCH', body: editable ? toPayload(f) : { memo: f.memo || null, instructor: f.instructor || null } }), '세션 정보를 저장했습니다')
  const saveParts = () => run(() => api(`/api/v1/sessions/${s.id}/participants`, { method: 'PUT', body: { participants: parts } }), '학생·HMD 배정을 저장했습니다')
  const start = async () => {
    if (dirtyParts) return toast.error('저장하지 않은 배정 변경이 있습니다. 먼저 저장하세요.')
    if (await confirm({ title: '세션 시작', message: `${s.session_code} 세션을 시작합니다. 배정된 HMD에서 콘텐츠를 실행하세요.`, confirmText: '시작' }))
      run(() => api(`/api/v1/sessions/${s.id}/start`, { method: 'POST' }), '세션을 시작했습니다')
  }
  const complete = async (force = false) => {
    try {
      const r = await api(`/api/v1/sessions/${s.id}/complete`, { method: 'POST', body: { force } })
      setS(r); setIssues(null)
      toast.success(r.sync_issues?.length ? `세션을 종료했습니다. 미확인 항목 ${r.sync_issues.length}건은 HMD 연결 시 계속 수신됩니다.` : '세션을 종료했습니다')
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.detail as any)?.issues) setIssues((e.detail as any).issues)
      else toast.error(e)
    }
  }
  const askComplete = async () => {
    if (await confirm({ title: '세션 종료', message: 'HMD 결과 업로드 상태를 확인한 뒤 세션을 종료합니다.', confirmText: '확인 후 종료' })) complete(false)
  }
  const cancel = async () => {
    if (await confirm({ title: '세션 취소', message: '세션을 취소합니다. 취소된 세션은 다시 시작할 수 없습니다(복제는 가능).', danger: true, confirmText: '세션 취소' }))
      run(() => api(`/api/v1/sessions/${s.id}/cancel`, { method: 'POST' }), '세션을 취소했습니다')
  }
  const clone = async () => {
    const r = await run(() => api(`/api/v1/sessions/${s.id}/clone`, { method: 'POST' }), '세션을 복제했습니다')
    if (r?.id) nav(`/sessions/${r.id}`)
  }

  return (
    <>
      <PageHeader title={`${s.institution_name} · ${s.session_date}`}
        desc={<span className="inline-flex flex-wrap items-center gap-2"><SessionBadge status={s.status} /><span className="font-mono text-xs">{s.session_code}</span>
          {s.started_at && <span>시작 {fmtTime(s.started_at)}</span>}{s.ended_at && <span>종료 {fmtTime(s.ended_at)}</span>}</span>}
        actions={<>
          {['running', 'completed'].includes(s.status) && <Button icon={<Activity className="size-4" />} onClick={() => nav(`/live?session=${s.id}`)}>진행 현황</Button>}
          <Button icon={<FileText className="size-4" />} onClick={() => nav(`/reports?session=${s.id}`)}>결과 보고서</Button>
          {op && <Button icon={<Copy className="size-4" />} onClick={clone}>복제</Button>}
          {op && s.status === 'draft' && <Button onClick={() => run(() => api(`/api/v1/sessions/${s.id}/ready`, { method: 'POST' }), '준비 완료로 변경했습니다')}>준비 완료</Button>}
          {op && editable && <Button variant="danger" icon={<Ban className="size-4" />} onClick={cancel}>취소</Button>}
          {op && editable && <Button variant="primary" icon={<Play className="size-4" />} onClick={start}>세션 시작</Button>}
          {op && s.status === 'running' && <Button variant="success" icon={<CheckCircle2 className="size-4" />} onClick={askComplete}>세션 종료</Button>}
        </>} />
      {s.warnings.length > 0 && ['draft', 'ready'].includes(s.status) && (
        <ul className="mb-4 list-inside list-disc rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{s.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul>
      )}
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'participants', label: `학생·HMD 배정 (${s.participant_count})` }, { key: 'info', label: '세션 정보' }, { key: 'content', label: '콘텐츠' }]} />
      {tab === 'participants' && (
        <Card title="학생·HMD 배정" actions={partsEditable && <>
          {editable && <Button size="sm" onClick={() => run(() => api(`/api/v1/sessions/${s.id}/auto-assign`, { method: 'POST' }).then((r) => r.session), '서버 기준으로 자동 배정했습니다')}>서버 자동 배정</Button>}
          <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} disabled={!dirtyParts || participantIssues(parts).length > 0} onClick={saveParts}>배정 저장</Button>
        </>}>
          {s.status === 'running' && <p className="mb-3 text-sm text-slate-600">진행 중에도 HMD 교체 배정이 가능합니다. 결과가 수신된 학생은 제외할 수 없습니다.</p>}
          <ParticipantEditor value={parts} onChange={setParts} devices={devices.data?.items ?? []} expected={s.expected_students} readOnly={!partsEditable} busyDevices={busyDevices} />
          {!partsEditable && s.participants.length > 0 && (
            <p className="mt-2 text-sm text-slate-600">학생별 결과 수: {s.participants.map((p: any) => `${p.student_code} ${p.result_count}건`).join(', ')}</p>
          )}
        </Card>
      )}
      {tab === 'info' && (
        <Card title="세션 정보" actions={op && <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} onClick={saveInfo}>저장</Button>}>
          {!editable && <p className="mb-3 text-sm text-slate-600">진행 중·완료된 세션은 담당 강사와 메모만 수정할 수 있습니다.</p>}
          <div className="space-y-4"><InstitutionFields f={f} set={setF} disabled={!editable} /><ClassFields f={f} set={setF} disabled={!editable} memoEditable={op} /></div>
        </Card>
      )}
      {tab === 'content' && (
        <Card title="콘텐츠" actions={editable && <Button size="sm" variant="primary" onClick={saveInfo}>저장</Button>}>
          <ContentPicker f={f} set={setF} contents={contents.data?.items ?? []} disabled={!editable} />
        </Card>
      )}

      <Modal open={!!issues} title="세션 종료 전 확인" onClose={() => setIssues(null)} wide footer={<>
        <Button onClick={() => setIssues(null)}>돌아가기</Button>
        <Button variant="danger" onClick={() => complete(true)}>확인했으며 종료</Button>
      </>}>
        <p className="mb-3 text-sm text-slate-700">아래 장비의 결과 업로드가 확인되지 않았습니다. 종료해도 HMD·서버의 데이터는 삭제되지 않으며, 이후 HMD가 연결되면 미전송 결과는 계속 수신됩니다.</p>
        <table className="min-w-full"><thead><tr><th className="th">HMD</th><th className="th">학생</th><th className="th">내용</th></tr></thead>
          <tbody>{issues?.map((i, k) => <tr key={k}><td className="td"><Link className="text-blue-800 underline" to={`/devices/${i.device_id}`}>{i.device_id}</Link></td><td className="td">{i.student_code}</td><td className="td"><span className="inline-flex items-center gap-2">{i.type === 'offline' ? <HealthBadge health="offline" /> : i.type === 'pending' ? <HealthBadge health="warning" /> : null}{i.message}</span></td></tr>)}</tbody></table>
      </Modal>
    </>
  )
}
