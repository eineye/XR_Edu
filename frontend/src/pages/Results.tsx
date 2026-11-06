import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Download, RefreshCw } from 'lucide-react'
import { api, download } from '../api'
import { useAuth } from '../auth'
import { useApi } from '../live'
import { Async, Button, Card, DataTable, Empty, Field, KV, Modal, PageHeader, Pager, Pill, StatCard, Tabs, Loading, ErrorState, useToast, type Column } from '../components/ui'
import { fmtAgo, fmtTime, num, pct } from '../format'

const FKEYS = ['session_id', 'content_id', 'institution', 'grade', 'class_group', 'date_from', 'date_to'] as const

export default function Results() {
  const [sp, setSp] = useSearchParams()
  const tab = sp.get('tab') ?? 'list'
  const filters: Record<string, string> = Object.fromEntries(FKEYS.map((k) => [k, sp.get(k) ?? '']))
  const setFilter = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n) }
  const sessions = useApi<any>('/api/v1/sessions', undefined, false)
  const contents = useApi<any>('/api/v1/contents', undefined, false)
  const toast = useToast()
  const exp = (fmt: string) => download('/api/v1/reports/results_raw', { ...filters, format: fmt }, `results.${fmt}`).catch(toast.error)

  return (
    <div>
      <PageHeader title="학습 결과 관리" desc="HMD에서 업로드되어 서버가 ACK한 결과입니다. 관리자 보정은 원본을 덮어쓰지 않고 이력으로 남습니다."
        actions={<>
          <Button icon={<Download className="size-4" />} onClick={() => exp('csv')}>CSV</Button>
          <Button icon={<Download className="size-4" />} onClick={() => exp('xlsx')}>Excel</Button>
          <Button icon={<Download className="size-4" />} onClick={() => exp('pdf')}>PDF</Button>
        </>} />
      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <Field label="세션"><select className="input" value={filters.session_id} onChange={(e) => setFilter('session_id', e.target.value)}>
            <option value="">전체</option>{sessions.data?.items?.map((s: any) => <option key={s.id} value={s.session_code}>{s.session_date} {s.institution_name} ({s.session_code.slice(-3)})</option>)}</select></Field>
          <Field label="콘텐츠"><select className="input" value={filters.content_id} onChange={(e) => setFilter('content_id', e.target.value)}>
            <option value="">전체</option>{contents.data?.items?.map((c: any) => <option key={c.content_id} value={c.content_id}>{c.title}</option>)}</select></Field>
          <Field label="학교·기관"><input className="input" value={filters.institution} onChange={(e) => setFilter('institution', e.target.value)} /></Field>
          <Field label="학년"><input className="input" value={filters.grade} onChange={(e) => setFilter('grade', e.target.value)} /></Field>
          <Field label="학급"><input className="input" value={filters.class_group} onChange={(e) => setFilter('class_group', e.target.value)} /></Field>
          <Field label="기간 시작"><input type="date" className="input" value={filters.date_from} onChange={(e) => setFilter('date_from', e.target.value)} /></Field>
          <Field label="기간 끝"><input type="date" className="input" value={filters.date_to} onChange={(e) => setFilter('date_to', e.target.value)} /></Field>
        </div>
      </Card>
      <Tabs value={tab} onChange={(t) => setFilter('tab', t === 'list' ? '' : t)} tabs={[{ key: 'list', label: '결과 목록' }, { key: 'stats', label: '통계' }, { key: 'students', label: '학생별 결과' }, { key: 'unsynced', label: '미동기화 결과' }]} />
      {tab === 'list' && <ResultList filters={filters} />}
      {tab === 'stats' && <Stats filters={filters} />}
      {tab === 'students' && <Students filters={filters} sessions={sessions.data?.items ?? []} setFilter={setFilter} />}
      {tab === 'unsynced' && <Unsynced />}
    </div>
  )
}

function ResultList({ filters, student }: { filters: Record<string, string>; student?: string }) {
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(50)
  const [q, setQ] = useState('')
  const [correct, setCorrect] = useState('')
  const [sort, setSort] = useState('occurred_at')
  const [detail, setDetail] = useState<string | null>(null)
  const st = useApi<any>('/api/v1/results', { ...filters, student_code: student, q, is_correct: correct, sort, order: 'desc', limit: size, offset: (page - 1) * size })
  return (
    <Card>
      <div className="mb-3 flex flex-wrap gap-2">
        <input className="input max-w-xs" placeholder="학생·미션·HMD·event_id 검색" value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} aria-label="결과 검색" />
        <select className="input w-auto" value={correct} onChange={(e) => { setCorrect(e.target.value); setPage(1) }} aria-label="정답 필터"><option value="">정답·오답 전체</option><option value="true">정답</option><option value="false">오답</option></select>
        <select className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="정렬"><option value="occurred_at">발생 시각순</option><option value="received_at">수신 시각순</option><option value="score">점수순</option><option value="student_code">학생순</option><option value="mission_id">미션순</option></select>
      </div>
      {st.loading ? <Loading /> : st.error && !st.data ? <ErrorState error={st.error} onRetry={st.reload} /> : (
        <>
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <table className="min-w-full">
              <thead><tr>{['발생 시각', '세션', 'HMD', '학생', '콘텐츠', '미션', '답안', '정답', '점수', '시도', '수행(초)', '상태'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
              <tbody>
                {st.data.items.length === 0 ? <tr><td colSpan={12}><Empty text="조건에 맞는 결과가 없습니다" /></td></tr> : st.data.items.map((r: any) => (
                  <tr key={r.result_id} tabIndex={0} className="cursor-pointer hover:bg-blue-50" onClick={() => setDetail(r.result_id)} onKeyDown={(e) => e.key === 'Enter' && setDetail(r.result_id)}>
                    <td className="td whitespace-nowrap">{fmtTime(r.occurred_at)}</td><td className="td font-mono text-xs">{r.session_id}</td><td className="td">{r.device_id}</td>
                    <td className="td font-mono">{r.student_code}</td><td className="td">{r.content_id}</td><td className="td">{r.mission_id}</td>
                    <td className="td font-mono text-xs">{r.answer_json ?? '-'}</td>
                    <td className="td">{r.eff_is_correct === null ? '-' : r.eff_is_correct ? <Pill tone="green">O 정답</Pill> : <Pill tone="red">X 오답</Pill>}</td>
                    <td className="td tabular-nums">{num(r.eff_score)}</td><td className="td">{r.attempt_count ?? '-'}</td><td className="td">{num(r.duration_seconds)}</td>
                    <td className="td">{r.sync_status === 'corrected' ? <Pill tone="amber">보정됨</Pill> : <Pill>수신</Pill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pages={Math.ceil(st.data.total / size)} total={st.data.total} onPage={setPage} pageSize={size} onPageSize={(n) => { setSize(n); setPage(1) }} />
        </>
      )}
      <ResultDetail id={detail} onClose={() => setDetail(null)} onChanged={st.reload} />
    </Card>
  )
}

function ResultDetail({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const st = useApi<any>(id ? `/api/v1/results/${encodeURIComponent(id)}` : null, undefined, false)
  const { can } = useAuth()
  const toast = useToast()
  const [corr, setCorr] = useState({ is_correct: '', score: '', reason: '' })
  const save = async () => {
    try {
      await api(`/api/v1/results/${encodeURIComponent(id!)}/corrections`, { method: 'POST', body: { is_correct: corr.is_correct === '' ? null : corr.is_correct === 'true', score: corr.score === '' ? null : Number(corr.score), reason: corr.reason } })
      toast.success('보정 기록을 저장했습니다 (원본 유지)')
      setCorr({ is_correct: '', score: '', reason: '' })
      st.reload(); onChanged()
    } catch (e) { toast.error(e) }
  }
  return (
    <Modal open={!!id} title="결과 상세 · 원본 데이터" onClose={onClose} wide>
      <Async state={st}>{(r) => (
        <div className="space-y-4">
          <KV items={[
            ['result_id', <span className="font-mono text-xs">{r.result_id}</span>], ['event_id', <span className="font-mono text-xs">{r.event_id}</span>],
            ['세션', `${r.session_id} (${r.institution_name ?? '-'})`], ['HMD', r.device_id], ['학생 코드', r.student_code],
            ['콘텐츠', `${r.content_id} v${r.content_version ?? '-'}`], ['미션', r.mission_id],
            ['정답(원본)', r.is_correct === null ? '-' : r.is_correct ? 'O' : 'X'], ['점수(원본)', num(r.score)],
            ['정답(적용)', r.eff_is_correct === null ? '-' : r.eff_is_correct ? 'O' : 'X'], ['점수(적용)', num(r.eff_score)],
            ['시도 횟수', r.attempt_count], ['수행 시간', `${num(r.duration_seconds)}초`],
            ['시작', fmtTime(r.started_at)], ['완료', fmtTime(r.completed_at)], ['발생', fmtTime(r.occurred_at)], ['서버 수신', fmtTime(r.received_at)],
          ]} />
          <div><div className="label">답안 원본(JSON)</div><pre className="overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">{JSON.stringify(r.answer, null, 2)}</pre></div>
          <div>
            <div className="label">보정 이력</div>
            {r.corrections.length === 0 ? <p className="text-sm text-slate-500">없음</p> : (
              <ul className="text-sm">{r.corrections.map((c: any) => <li key={c.id}>{fmtTime(c.created_at)} · {c.username ?? '-'} · {c.field === 'is_correct' ? '정답 여부' : '점수'} {c.old_value} → {c.new_value} · 사유: {c.reason}</li>)}</ul>
            )}
          </div>
          {can('admin', 'operator') && (
            <div className="rounded-md border border-slate-200 p-3">
              <div className="mb-2 text-sm font-semibold">관리자 보정 (원본 이벤트는 유지)</div>
              <div className="grid gap-3 md:grid-cols-4">
                <Field label="정답 여부"><select className="input" value={corr.is_correct} onChange={(e) => setCorr({ ...corr, is_correct: e.target.value })}><option value="">변경 안 함</option><option value="true">정답</option><option value="false">오답</option></select></Field>
                <Field label="점수"><input type="number" className="input" value={corr.score} onChange={(e) => setCorr({ ...corr, score: e.target.value })} placeholder="변경 안 함" /></Field>
                <Field label="사유" required className="md:col-span-2"><input className="input" value={corr.reason} onChange={(e) => setCorr({ ...corr, reason: e.target.value })} /></Field>
              </div>
              <Button className="mt-3" variant="primary" disabled={corr.reason.trim().length < 2 || (corr.is_correct === '' && corr.score === '')} onClick={save}>보정 저장</Button>
            </div>
          )}
        </div>
      )}</Async>
    </Modal>
  )
}

function Stats({ filters }: { filters: Record<string, string> }) {
  const st = useApi<any>('/api/v1/results/stats', filters)
  return (
    <Async state={st}>{(d) => {
      const o = d.overall
      if (!o.result_count) return <Card><Empty text="조건에 맞는 결과가 없습니다" /></Card>
      const chart = d.by_mission.map((m: any) => ({ name: m.mission_id, acc: m.accuracy === null ? 0 : Math.round(m.accuracy * 1000) / 10, dur: Math.round(m.avg_duration ?? 0) }))
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatCard label="결과 수" value={o.result_count.toLocaleString()} />
            <StatCard label="학습자 수" value={o.student_count} />
            <StatCard label="평균 점수" value={num(o.avg_score)} tone="blue" />
            <StatCard label="전체 정답률" value={pct(o.accuracy)} tone="green" />
            <StatCard label="평균 수행 시간" value={`${num(o.avg_duration)}초`} />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="미션별 정답률">
              <div className="h-80" role="img" aria-label="미션별 정답률 그래프"><ResponsiveContainer><BarChart data={chart}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" tick={{ fontSize: 11 }} angle={-25} textAnchor="end" height={70} interval={0} /><YAxis unit="%" domain={[0, 100]} /><Tooltip formatter={(v: any) => [`${v}%`, '정답률']} /><Bar dataKey="acc" fill="#1d4ed8" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div>
            </Card>
            <Card title="미션별 평균 수행 시간">
              <div className="h-80" role="img" aria-label="미션별 평균 수행 시간 그래프"><ResponsiveContainer><BarChart data={chart}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" tick={{ fontSize: 11 }} angle={-25} textAnchor="end" height={70} interval={0} /><YAxis unit="초" /><Tooltip formatter={(v: any) => [`${v}초`, '평균 수행 시간']} /><Bar dataKey="dur" fill="#0f766e" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div>
            </Card>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="콘텐츠별 평균 점수">
              <table className="min-w-full"><thead><tr><th className="th">콘텐츠</th><th className="th">학습자</th><th className="th">결과</th><th className="th">평균 점수</th><th className="th">정답률</th><th className="th">평균 시간</th></tr></thead>
                <tbody>{d.by_content.map((c: any) => <tr key={c.content_id}><td className="td">{c.title ?? c.content_id}</td><td className="td">{c.student_count}</td><td className="td">{c.result_count}</td><td className="td">{num(c.avg_score)}</td><td className="td">{pct(c.accuracy)}</td><td className="td">{num(c.avg_duration)}초</td></tr>)}</tbody></table>
            </Card>
            <Card title="오답 유형 (선택 답안별)">
              {d.wrong_answers.length === 0 ? <Empty text="오답 없음" /> : (
                <table className="min-w-full"><thead><tr><th className="th">미션</th><th className="th">선택 답안</th><th className="th">횟수</th></tr></thead>
                  <tbody>{d.wrong_answers.map((w: any, i: number) => <tr key={i}><td className="td">{w.mission_id}</td><td className="td font-mono">{w.answer ?? '-'}</td><td className="td">{w.count}</td></tr>)}</tbody></table>
              )}
            </Card>
          </div>
          <Card title="미션별 상세">
            <table className="min-w-full"><thead><tr>{['콘텐츠', '미션', '응답', '정답', '정답률', '평균 점수', '평균 시도', '평균 시간'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
              <tbody>{d.by_mission.map((m: any) => <tr key={m.content_id + m.mission_id}><td className="td">{m.content_id}</td><td className="td">{m.mission_id}</td><td className="td">{m.attempts}</td><td className="td">{m.correct}</td><td className="td">{pct(m.accuracy)}{m.accuracy !== null && m.accuracy < 0.6 && <Pill tone="amber">재학습 권장</Pill>}</td><td className="td">{num(m.avg_score)}</td><td className="td">{num(m.avg_attempts, 2)}</td><td className="td">{num(m.avg_duration)}초</td></tr>)}</tbody></table>
          </Card>
        </div>
      )
    }}</Async>
  )
}

function Students({ filters, sessions, setFilter }: { filters: Record<string, string>; sessions: any[]; setFilter: (k: string, v: string) => void }) {
  const sess = sessions.find((s) => s.session_code === filters.session_id)
  const st = useApi<any>(sess ? `/api/v1/reports/session/${sess.id}` : null)
  const [student, setStudent] = useState<string | null>(null)
  if (!sess) return (
    <Card><Empty text="학생별 결과는 세션 단위로 조회합니다. 위 필터에서 세션을 선택하세요." action={
      <select className="input w-auto" value="" onChange={(e) => setFilter('session_id', e.target.value)}><option value="">세션 선택</option>{sessions.map((s) => <option key={s.id} value={s.session_code}>{s.session_date} {s.institution_name} ({s.session_code})</option>)}</select>} /></Card>
  )
  const cols: Column<any>[] = [
    { key: 'student_code', label: '학생 코드', render: (r) => <span className="font-mono">{r.student_code}</span> },
    { key: 'device_id', label: 'HMD' }, { key: 'result_count', label: '결과 수' },
    { key: 'avg_score', label: '평균 점수', render: (r) => num(r.avg_score) },
    { key: 'accuracy_pct', label: '정답률', render: (r) => (r.accuracy_pct === null ? '-' : `${r.accuracy_pct}%`) },
    { key: 'total_duration', label: '총 수행시간', render: (r) => `${num(r.total_duration)}초` },
    { key: 'state', label: '진행', render: (r) => (r.result_count === 0 ? <Pill tone="amber">미완료·결과 없음</Pill> : r.state) },
  ]
  return (
    <Async state={st}>{(d) => {
      const rows = d.tables[1].rows
      const incomplete = rows.filter((r: any) => r.state !== '완료')
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="참여 인원" value={d.summary.participants} />
            <StatCard label="완료율" value={d.summary.participants ? `${Math.round((d.summary.completed / d.summary.participants) * 100)}%` : '-'} tone="green" sub={`완료 ${d.summary.completed}명`} />
            <StatCard label="평균 점수" value={num(d.summary.avg_score)} tone="blue" />
            <StatCard label="미완료 학생" value={incomplete.length} tone={incomplete.length ? 'amber' : 'slate'} />
          </div>
          <Card title="학생별 결과 (행을 누르면 상세)">
            <DataTable rows={rows} columns={cols} rowKey={(r) => r.student_code} search={(r) => `${r.student_code} ${r.device_id}`} onRowClick={(r) => setStudent(r.student_code)} pageSize={50} />
          </Card>
          <Modal open={!!student} title={`학생 ${student} 상세 결과`} onClose={() => setStudent(null)} wide>
            {student && <ResultList filters={{ session_id: filters.session_id }} student={student} />}
          </Modal>
        </div>
      )
    }}</Async>
  )
}

function Unsynced() {
  const st = useApi<any>('/api/v1/results/unsynced')
  const { can } = useAuth()
  const toast = useToast()
  const resync = async (id: string) => {
    try { const r = await api(`/api/v1/devices/${id}/resync`, { method: 'POST' }); toast.info(r.already_pending ? `${id}: 이미 재전송 요청 대기 중` : `${id}: 재전송 요청 등록 (다음 heartbeat 때 전달)`) } catch (e) { toast.error(e) }
  }
  return (
    <Async state={st}>{(d) => (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <StatCard label="HMD 미전송 결과 (보고 기준)" value={d.pending_total} tone={d.pending_total ? 'amber' : 'slate'} />
          <StatCard label="미전송 건수 미보고 장비" value={d.devices_unknown} tone="gray" sub="오프라인이거나 아직 보고하지 않음" />
          <StatCard label="서버 거부 결과" value={d.rejections.length} tone={d.rejections.length ? 'red' : 'slate'} />
        </div>
        <Card title="장비별 전송·수신 건수 비교">
          <DataTable rows={d.devices} rowKey={(r: any) => r.device_id} pageSize={20} columns={[
            { key: 'device_id', label: 'HMD' },
            { key: 'reported_pending_count', label: 'HMD 미전송', render: (r: any) => r.reported_pending_count === null ? <span className="text-slate-500">미보고</span> : r.reported_pending_count > 0 ? <b className="text-amber-700">{r.reported_pending_count}</b> : 0 },
            { key: 'reported_sent_total', label: 'HMD 전송 완료', render: (r: any) => r.reported_sent_total ?? '미보고' },
            { key: 'received_total', label: '서버 수신' },
            { key: 'mismatch', label: '비교', render: (r: any) => r.mismatch === null ? '확인 불가' : r.mismatch ? <Pill tone="amber">불일치</Pill> : <Pill tone="green">일치</Pill> },
            { key: 'rejected_total', label: '거부', render: (r: any) => r.rejected_total ? <b className="text-red-700">{r.rejected_total}</b> : 0 },
            { key: 'last_sync_at', label: '마지막 동기화', render: (r: any) => (r.last_sync_at ? fmtAgo(r.last_sync_at) : '-') },
            { key: 'act', label: '', sortable: false, render: (r: any) => can('admin', 'operator') && <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={(e) => { e.stopPropagation(); resync(r.device_id) }}>재전송 요청</Button> },
          ]} />
        </Card>
        <Card title="동기화 실패(서버 거부) 데이터">
          <DataTable rows={d.rejections} rowKey={(r: any) => r.id} search={(r: any) => `${r.device_id} ${r.session_id} ${r.event_id} ${r.reason}`} columns={[
            { key: 'received_at', label: '수신 시각', render: (r: any) => fmtTime(r.received_at) },
            { key: 'device_id', label: 'HMD' }, { key: 'session_id', label: '세션', render: (r: any) => <span className="font-mono text-xs">{r.session_id}</span> },
            { key: 'event_id', label: 'event_id', render: (r: any) => <span className="font-mono text-xs">{r.event_id ?? '-'}</span> },
            { key: 'reason', label: '사유', render: (r: any) => <span className="text-red-800">{r.reason}</span> },
          ]} emptyText="거부된 결과가 없습니다" />
          <p className="mt-2 text-xs text-slate-500">거부된 결과는 HMD에도 'rejected' 상태로 보존됩니다. 원인(세션 미등록 학생 등)을 해결한 뒤 HMD에서 재전송하세요.</p>
        </Card>
      </div>
    )}</Async>
  )
}
