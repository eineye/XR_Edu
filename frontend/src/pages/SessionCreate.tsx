import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'
import { api } from '../api'
import { useApi } from '../live'
import { Button, Card, KV, PageHeader, cx, useToast } from '../components/ui'
import ParticipantEditor, { participantIssues, type Participant } from '../components/ParticipantEditor'
import { ClassFields, ContentPicker, InstitutionFields, emptySession, toPayload, type SessionFields } from '../components/SessionForm'
import { today } from '../format'

const STEPS = ['기관·학교 및 교육 날짜', '학년·학급·회차', '콘텐츠 선택', '참여 학생 익명 코드', 'HMD 배정', '최종 확인']

export default function SessionCreate() {
  const nav = useNavigate()
  const toast = useToast()
  const [step, setStep] = useState(0)
  const [f, setF] = useState<SessionFields>(emptySession(today()))
  const [parts, setParts] = useState<Participant[]>([])
  const [busy, setBusy] = useState(false)
  const contents = useApi<any>('/api/v1/contents', undefined, false)
  const devices = useApi<any>('/api/v1/devices')
  const devList = devices.data?.items ?? []
  const busyDevices = devList.filter((d: any) => d.assignment?.status === 'running').map((d: any) => d.device_id)
  const content = contents.data?.items?.find((c: any) => c.content_id === f.content_id)

  const canNext = [
    !!f.institution_name.trim() && !!f.session_date,
    true,
    !!f.content_id,
    parts.length > 0 && participantIssues(parts).length === 0,
    participantIssues(parts).length === 0,
    true,
  ][step]

  const submit = async () => {
    setBusy(true)
    try {
      const r = await api('/api/v1/sessions', { method: 'POST', body: { ...toPayload(f), participants: parts } })
      toast.success(`세션 ${r.session_code} 생성 완료`)
      nav(`/sessions/${r.id}`)
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }

  return (
    <div>
      <PageHeader title="교육 세션 생성" />
      <ol className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-6" aria-label="진행 단계">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button disabled={i > step} onClick={() => setStep(i)} aria-current={i === step ? 'step' : undefined}
              className={cx('flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left text-xs', i === step ? 'border-blue-600 bg-blue-50 font-semibold text-blue-900' : i < step ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-slate-200 bg-white text-slate-500')}>
              <span className={cx('grid size-5 shrink-0 place-items-center rounded-full text-[11px]', i < step ? 'bg-emerald-600 text-white' : i === step ? 'bg-blue-700 text-white' : 'bg-slate-200')}>{i < step ? <Check className="size-3" /> : i + 1}</span>{s}
            </button>
          </li>
        ))}
      </ol>
      <Card title={`${step + 1}. ${STEPS[step]}`}>
        {step === 0 && <InstitutionFields f={f} set={setF} />}
        {step === 1 && <ClassFields f={f} set={setF} />}
        {step === 2 && <ContentPicker f={f} set={setF} contents={contents.data?.items ?? []} />}
        {(step === 3 || step === 4) && (
          <>
            {step === 4 && <p className="mb-3 text-sm text-slate-600">[HMD 자동 배정] 또는 학생별 HMD를 직접 선택하세요. 한 장비는 한 학생에게만 배정됩니다. HMD 없이 저장하고 나중에 배정할 수도 있습니다.</p>}
            <ParticipantEditor value={parts} onChange={setParts} devices={devList} expected={f.expected_students ? Number(f.expected_students) : null} busyDevices={busyDevices} />
          </>
        )}
        {step === 5 && (
          <div className="space-y-4">
            <KV items={[
              ['기관', `${f.institution_name}${f.institution_code ? ` (${f.institution_code})` : ''}`], ['교육 날짜', `${f.session_date} ${f.scheduled_start_at}`],
              ['학년·학급·회차', [f.grade && `${f.grade}학년`, f.class_group && `${f.class_group}반`, f.session_no && `${f.session_no}회차`].filter(Boolean).join(' ') || '-'],
              ['교육 주제', f.topic || '-'], ['콘텐츠', content ? `${content.title} (v${content.version})` : '-'], ['담당 강사', f.instructor || '-'],
              ['참여 학생', `${parts.length}명${f.expected_students ? ` (예정 ${f.expected_students}명)` : ''}`], ['HMD 배정', `${parts.filter((p) => p.device_id).length}대`],
              ['메모', f.memo || '-'],
            ]} />
            {f.expected_students && Number(f.expected_students) !== parts.length && <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">참여 예정 학생 수와 등록 학생 수가 다릅니다.</p>}
            {parts.some((p) => !p.device_id) && <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">HMD가 배정되지 않은 학생이 있습니다. 세션 시작 전까지 배정하세요.</p>}
            <p className="text-sm text-slate-600">세션은 '작성 중' 상태로 생성됩니다. 세션 상세 화면에서 '준비 완료' 또는 '세션 시작'을 진행하세요.</p>
          </div>
        )}
        <div className="mt-6 flex justify-between border-t border-slate-100 pt-4">
          <Button onClick={() => (step === 0 ? nav('/sessions') : setStep(step - 1))}>{step === 0 ? '취소' : '이전'}</Button>
          {step < 5 ? <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>다음</Button>
            : <Button variant="primary" loading={busy} onClick={submit}>세션 생성</Button>}
        </div>
      </Card>
    </div>
  )
}
