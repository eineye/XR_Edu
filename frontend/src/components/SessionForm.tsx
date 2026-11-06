import { Field } from './ui'

export interface SessionFields {
  institution_name: string; institution_code: string; session_date: string; grade: string; class_group: string
  session_no: string; topic: string; content_id: string; scheduled_start_at: string; instructor: string
  expected_students: string; memo: string
}

export const emptySession = (date: string): SessionFields => ({
  institution_name: '', institution_code: '', session_date: date, grade: '', class_group: '', session_no: '1', topic: '',
  content_id: '', scheduled_start_at: '', instructor: '', expected_students: '', memo: '',
})

export function toPayload(f: SessionFields) {
  const n = (v: string) => (v === '' ? null : Number(v))
  const s = (v: string) => (v.trim() === '' ? null : v.trim())
  return {
    institution_name: f.institution_name.trim(), institution_code: s(f.institution_code), session_date: f.session_date,
    grade: s(f.grade), class_group: s(f.class_group), session_no: n(f.session_no), topic: s(f.topic), content_id: s(f.content_id),
    scheduled_start_at: s(f.scheduled_start_at), instructor: s(f.instructor), expected_students: n(f.expected_students), memo: s(f.memo),
  }
}

export function fromSession(s: any): SessionFields {
  const v = (x: unknown) => (x === null || x === undefined ? '' : String(x))
  return {
    institution_name: v(s.institution_name), institution_code: v(s.institution_code), session_date: v(s.session_date), grade: v(s.grade),
    class_group: v(s.class_group), session_no: v(s.session_no), topic: v(s.topic), content_id: v(s.content_id),
    scheduled_start_at: v(s.scheduled_start_at), instructor: v(s.instructor), expected_students: v(s.expected_students), memo: v(s.memo),
  }
}

type Set = (f: SessionFields) => void

export function InstitutionFields({ f, set, disabled }: { f: SessionFields; set: Set; disabled?: boolean }) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Field label="학교/기관명" required className="md:col-span-2"><input className="input" disabled={disabled} value={f.institution_name} onChange={(e) => set({ ...f, institution_name: e.target.value })} /></Field>
      <Field label="기관 코드"><input className="input" disabled={disabled} value={f.institution_code} onChange={(e) => set({ ...f, institution_code: e.target.value })} /></Field>
      <Field label="교육 날짜" required><input type="date" className="input" disabled={disabled} value={f.session_date} onChange={(e) => set({ ...f, session_date: e.target.value })} /></Field>
      <Field label="시작 예정 시각"><input type="time" className="input" disabled={disabled} value={f.scheduled_start_at} onChange={(e) => set({ ...f, scheduled_start_at: e.target.value })} /></Field>
    </div>
  )
}

export function ClassFields({ f, set, disabled, memoEditable }: { f: SessionFields; set: Set; disabled?: boolean; memoEditable?: boolean }) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Field label="학년"><input className="input" disabled={disabled} value={f.grade} onChange={(e) => set({ ...f, grade: e.target.value })} placeholder="예: 5" /></Field>
      <Field label="학급"><input className="input" disabled={disabled} value={f.class_group} onChange={(e) => set({ ...f, class_group: e.target.value })} placeholder="예: 2" /></Field>
      <Field label="회차"><input type="number" min={1} className="input" disabled={disabled} value={f.session_no} onChange={(e) => set({ ...f, session_no: e.target.value })} /></Field>
      <Field label="교육 주제" className="md:col-span-2"><input className="input" disabled={disabled} value={f.topic} onChange={(e) => set({ ...f, topic: e.target.value })} /></Field>
      <Field label="참여 학생 수"><input type="number" min={0} className="input" disabled={disabled} value={f.expected_students} onChange={(e) => set({ ...f, expected_students: e.target.value })} /></Field>
      <Field label="담당 강사"><input className="input" disabled={disabled && !memoEditable} value={f.instructor} onChange={(e) => set({ ...f, instructor: e.target.value })} /></Field>
      <Field label="세션 메모" className="md:col-span-2"><textarea className="input" rows={2} disabled={disabled && !memoEditable} value={f.memo} onChange={(e) => set({ ...f, memo: e.target.value })} /></Field>
    </div>
  )
}

export function ContentPicker({ f, set, contents, disabled }: { f: SessionFields; set: Set; contents: any[]; disabled?: boolean }) {
  const active = contents.filter((c) => c.active || c.content_id === f.content_id)
  if (active.length === 0) return <p className="text-sm text-amber-800">등록된 콘텐츠가 없습니다. [콘텐츠 관리]에서 먼저 등록하세요.</p>
  return (
    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="콘텐츠 선택">
      {active.map((c) => (
        <label key={c.content_id} className={`flex cursor-pointer gap-3 rounded-md border p-3 ${f.content_id === c.content_id ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-200' : 'border-slate-200 hover:border-slate-400'} ${disabled ? 'cursor-not-allowed opacity-70' : ''}`}>
          <input type="radio" name="content" className="mt-1" disabled={disabled} checked={f.content_id === c.content_id} onChange={() => set({ ...f, content_id: c.content_id })} />
          <div>
            <div className="font-medium">{c.title}</div>
            <div className="text-xs text-slate-500">{c.content_id} · {c.category_label} · v{c.version} · 설치 {c.installed_current_count}/{c.total_devices}대</div>
          </div>
        </label>
      ))}
    </div>
  )
}
