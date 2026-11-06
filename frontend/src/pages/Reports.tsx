import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Download } from 'lucide-react'
import { download } from '../api'
import { useApi } from '../live'
import { Async, Button, Card, Empty, Field, KV, PageHeader, Pill, cx, useToast } from '../components/ui'

const TYPES: [string, string, string][] = [
  ['session', '세션 보고서', '수업 1회의 기관·학급·참여·완료·평균·미션 정답률·재학습 권장·특이사항'],
  ['operations', '수업 운영 요약', '기간 내 세션별 운영 현황'],
  ['class_performance', '학급별 학습 성과', '기관·학년·학급별 평균 점수·정답률'],
  ['students', '학생별 수행 결과', '세션·학생 코드별 결과 요약'],
  ['content_effect', '콘텐츠별 효과 분석', '콘텐츠별 학습자 수·평균 점수·정답률'],
  ['mission_accuracy', '미션별 정답률', '미션별 정답률과 재학습 권장 여부'],
  ['device_incidents', '장비 운영·장애 이력', '장비별 오류·결과 거부 이력'],
]

export default function Reports() {
  const [sp] = useSearchParams()
  const [type, setType] = useState('session')
  const [sessionId, setSessionId] = useState(sp.get('session') ?? '')
  const [f, setF] = useState({ date_from: '', date_to: '', institution: '', content_id: '' })
  const sessions = useApi<any>('/api/v1/sessions', undefined, false)
  const contents = useApi<any>('/api/v1/contents', undefined, false)
  const toast = useToast()
  const path = type === 'session' ? (sessionId ? `/api/v1/reports/session/${sessionId}` : null) : `/api/v1/reports/${type}`
  const preview = useApi<any>(path, type === 'session' ? undefined : f, false)
  const exp = (fmt: string) => path && download(path, { ...(type === 'session' ? {} : f), format: fmt }, `report.${fmt}`).catch(toast.error)

  return (
    <div>
      <PageHeader title="보고서" desc="보고서를 미리 보고 CSV·XLSX·PDF로 내보냅니다." actions={<>
        <Button icon={<Download className="size-4" />} disabled={!path} onClick={() => exp('csv')}>CSV</Button>
        <Button icon={<Download className="size-4" />} disabled={!path} onClick={() => exp('xlsx')}>XLSX</Button>
        <Button variant="primary" icon={<Download className="size-4" />} disabled={!path} onClick={() => exp('pdf')}>PDF</Button>
      </>} />
      <div className="grid gap-4 xl:grid-cols-[280px_1fr]">
        <Card title="보고서 종류" bodyClass="p-2">
          <ul className="space-y-1">{TYPES.map(([k, l, d]) => (
            <li key={k}><button onClick={() => setType(k)} aria-pressed={type === k} className={cx('w-full rounded-md px-3 py-2 text-left', type === k ? 'bg-blue-50 ring-2 ring-blue-300' : 'hover:bg-slate-50')}>
              <div className="text-sm font-medium">{l}</div><div className="text-xs text-slate-500">{d}</div></button></li>
          ))}</ul>
        </Card>
        <div className="space-y-4">
          <Card>
            {type === 'session' ? (
              <Field label="세션 선택"><select className="input" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                <option value="">세션을 선택하세요</option>
                {sessions.data?.items?.map((s: any) => <option key={s.id} value={s.id}>[{s.status_label}] {s.session_date} {s.institution_name} {s.grade && `${s.grade}학년`} {s.class_group && `${s.class_group}반`} · {s.session_code}</option>)}
              </select></Field>
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field label="기간 시작"><input type="date" className="input" value={f.date_from} onChange={(e) => setF({ ...f, date_from: e.target.value })} /></Field>
                <Field label="기간 끝"><input type="date" className="input" value={f.date_to} onChange={(e) => setF({ ...f, date_to: e.target.value })} /></Field>
                <Field label="기관"><input className="input" value={f.institution} onChange={(e) => setF({ ...f, institution: e.target.value })} /></Field>
                <Field label="콘텐츠"><select className="input" value={f.content_id} onChange={(e) => setF({ ...f, content_id: e.target.value })}><option value="">전체</option>{contents.data?.items?.map((c: any) => <option key={c.content_id} value={c.content_id}>{c.title}</option>)}</select></Field>
              </div>
            )}
          </Card>
          {!path ? <Card><Empty text="세션을 선택하면 미리보기가 표시됩니다" /></Card> : (
            <Async state={preview}>{(r) => (
              <Card title={r.title}>
                <KV items={r.meta.map(([k, v]: [string, unknown]) => [k, v === null || v === undefined || v === '' ? '-' : String(v)])} />
                {r.relearn && r.relearn.length > 0 && <div className="mt-3 flex flex-wrap gap-1 text-sm">재학습 권장: {r.relearn.map((m: any) => <Pill key={m.mission_id} tone="amber">{m.mission_id} ({m.accuracy_pct}%)</Pill>)}</div>}
                {r.tables.map((t: any) => (
                  <div key={t.title} className="mt-5">
                    <h3 className="mb-2 text-sm font-semibold">{t.title} <span className="font-normal text-slate-500">({t.rows.length}건{t.rows.length > 200 ? ', 미리보기 200건' : ''})</span></h3>
                    {t.rows.length === 0 ? <p className="text-sm text-slate-500">데이터 없음</p> : (
                      <div className="max-h-[480px] overflow-auto rounded-md border border-slate-200">
                        <table className="min-w-full"><thead className="sticky top-0"><tr>{t.columns.map(([k, l]: string[]) => <th key={k} className="th">{l}</th>)}</tr></thead>
                          <tbody>{t.rows.slice(0, 200).map((row: any, i: number) => <tr key={i}>{t.columns.map(([k]: string[]) => <td key={k} className="td">{row[k] === null || row[k] === undefined ? '-' : String(row[k])}</td>)}</tr>)}</tbody></table>
                      </div>
                    )}
                  </div>
                ))}
              </Card>
            )}</Async>
          )}
        </div>
      </div>
    </div>
  )
}
