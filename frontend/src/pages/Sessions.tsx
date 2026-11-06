import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { useAuth } from '../auth'
import { useApi } from '../live'
import { Async, Button, Card, DataTable, PageHeader, SessionBadge, type Column } from '../components/ui'
import { SESSION_STATUS } from '../format'

export default function Sessions() {
  const nav = useNavigate()
  const { can } = useAuth()
  const [sp, setSp] = useSearchParams()
  const q = { status: sp.get('status') ?? '', date_from: sp.get('date_from') ?? '', date_to: sp.get('date_to') ?? '' }
  const st = useApi<any>('/api/v1/sessions', q)
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n) }
  const cols: Column<any>[] = [
    { key: 'session_date', label: '교육일' },
    { key: 'session_code', label: '세션 코드', render: (s) => <span className="font-mono text-xs">{s.session_code}</span> },
    { key: 'institution_name', label: '기관' },
    { key: 'grade', label: '학년·학급·회차', render: (s) => [s.grade && `${s.grade}학년`, s.class_group && `${s.class_group}반`, s.session_no && `${s.session_no}회차`].filter(Boolean).join(' ') || '-' },
    { key: 'content_title', label: '콘텐츠', render: (s) => s.content_title ?? s.content_id ?? <span className="text-amber-700">미선택</span> },
    { key: 'instructor', label: '강사', render: (s) => s.instructor || '-' },
    { key: 'participant_count', label: '학생/배정', render: (s) => `${s.participant_count} / ${s.assigned_count}` },
    { key: 'result_count', label: '결과', render: (s) => `${s.result_count}건` },
    { key: 'status', label: '상태', render: (s) => <SessionBadge status={s.status} /> },
  ]
  return (
    <div>
      <PageHeader title="교육 세션 관리" desc="학교·학급·회차 단위로 세션을 만들고 익명 학생 코드와 HMD를 배정합니다."
        actions={can('admin', 'operator') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav('/sessions/new')}>세션 생성</Button>} />
      <Card>
        <Async state={st}>
          {(d) => (
            <DataTable rows={d.items} columns={cols} rowKey={(r) => r.id} onRowClick={(r) => nav(`/sessions/${r.id}`)}
              search={(r) => `${r.session_code} ${r.institution_name} ${r.topic ?? ''} ${r.instructor ?? ''}`}
              emptyText="세션이 없습니다"
              toolbar={<>
                <select className="input w-auto" value={q.status} onChange={(e) => set('status', e.target.value)} aria-label="상태 필터">
                  <option value="">전체 상태</option>
                  {Object.entries(SESSION_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <input type="date" className="input w-auto" value={q.date_from} onChange={(e) => set('date_from', e.target.value)} aria-label="시작일" />
                <span className="text-slate-500">~</span>
                <input type="date" className="input w-auto" value={q.date_to} onChange={(e) => set('date_to', e.target.value)} aria-label="종료일" />
              </>} />
          )}
        </Async>
      </Card>
    </div>
  )
}
