import { useMemo, useRef, useState } from 'react'
import { AlertTriangle, Upload, Wand2, Trash2, Shuffle } from 'lucide-react'
import { Button, HealthBadge, cx } from './ui'

export interface Participant { student_code: string; device_id: string | null }
const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/

/** "S001, S002" 처럼 나열하거나, 줄마다 "S001,HMD-01" (두 번째 값이 등록된 장비 ID일 때만 배정으로 해석) */
export function parseCodes(text: string, deviceIds: Set<string> = new Set()): Participant[] {
  const out: Participant[] = []
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(/[,\t;]/).map((c) => c.trim().replace(/^"|"$/g, '')).filter(Boolean)
    if (!cells.length || /^(student_code|학생|학생코드|학생 코드)$/i.test(cells[0])) continue
    if (cells.length === 2 && deviceIds.has(cells[1])) out.push({ student_code: cells[0], device_id: cells[1] })
    else for (const c of line.split(/[\s,;\t]+/).filter(Boolean)) out.push({ student_code: c.replace(/^"|"$/g, ''), device_id: null })
  }
  return out
}

export function participantIssues(list: Participant[]): string[] {
  const issues: string[] = []
  const codes = new Map<string, number>()
  const devs = new Map<string, number>()
  for (const p of list) {
    codes.set(p.student_code, (codes.get(p.student_code) ?? 0) + 1)
    if (p.device_id) devs.set(p.device_id, (devs.get(p.device_id) ?? 0) + 1)
    if (!CODE_RE.test(p.student_code)) issues.push(`잘못된 학생 코드: "${p.student_code}" (영문·숫자·-·_ 만, 실명 입력 금지)`)
  }
  for (const [c, n] of codes) if (n > 1) issues.push(`학생 코드 중복: ${c}`)
  for (const [d, n] of devs) if (n > 1) issues.push(`HMD 중복 배정: ${d}`)
  return issues
}

export default function ParticipantEditor({ value, onChange, devices, expected, readOnly, busyDevices = [] }:
  { value: Participant[]; onChange: (v: Participant[]) => void; devices: any[]; expected?: number | null; readOnly?: boolean; busyDevices?: string[] }) {
  const [text, setText] = useState('')
  const [genCount, setGenCount] = useState(expected || 20)
  const fileRef = useRef<HTMLInputElement>(null)
  const issues = useMemo(() => participantIssues(value), [value])
  const used = new Set(value.map((p) => p.device_id).filter(Boolean))
  const devMap = Object.fromEntries(devices.map((d) => [d.device_id, d]))
  const deviceIds = new Set<string>(devices.map((d) => d.device_id))
  const usable = devices.filter((d) => d.active && !busyDevices.includes(d.device_id))
  const assigned = value.filter((p) => p.device_id).length

  const add = (list: Participant[]) => {
    const existing = new Set(value.map((p) => p.student_code))
    onChange([...value, ...list.filter((p) => !existing.has(p.student_code))])
  }
  const autoAssign = () => {
    const rank: Record<string, number> = { normal: 0, warning: 1, unknown: 2, offline: 3, error: 4 }
    const pool = usable.filter((d) => !used.has(d.device_id)).sort((a, b) => (rank[a.health] ?? 5) - (rank[b.health] ?? 5) || a.device_id.localeCompare(b.device_id)).map((d) => d.device_id)
    onChange(value.map((p) => (p.device_id || pool.length === 0 ? p : { ...p, device_id: pool.shift()! })))
  }
  const onFile = async (f: File) => {
    const t = await f.text()
    add(parseCodes(t.replace(/^﻿/, ''), deviceIds))
  }

  return (
    <div className="space-y-3">
      {!readOnly && (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-md border border-slate-200 p-3">
            <label className="label" htmlFor="pe-codes">익명 학생 코드 입력</label>
            <textarea id="pe-codes" className="input font-mono" rows={3} placeholder={'S001, S002, S003 …  또는 줄마다 "S001,HMD-01"'} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => { add(parseCodes(text, deviceIds)); setText('') }}>추가</Button>
              <Button size="sm" icon={<Upload className="size-3.5" />} onClick={() => fileRef.current?.click()}>CSV 업로드</Button>
              <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
            </div>
            <p className="mt-1 text-xs text-slate-500">CSV 형식: student_code[,device_id]. 학생 실명은 입력하지 마세요.</p>
          </div>
          <div className="rounded-md border border-slate-200 p-3">
            <div className="label">코드 자동 생성 · HMD 배정</div>
            <div className="flex flex-wrap items-center gap-2">
              <input type="number" min={1} max={200} className="input w-24" value={genCount} onChange={(e) => setGenCount(Number(e.target.value))} aria-label="생성할 학생 수" />
              <Button size="sm" icon={<Wand2 className="size-3.5" />} onClick={() => add(Array.from({ length: genCount }, (_, i) => ({ student_code: `S${String(i + 1).padStart(3, '0')}`, device_id: null })))}>S001~ 생성</Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" icon={<Shuffle className="size-3.5" />} disabled={!value.length} onClick={autoAssign}>HMD 자동 배정</Button>
              <Button size="sm" disabled={!assigned} onClick={() => onChange(value.map((p) => ({ ...p, device_id: null })))}>배정 해제</Button>
              <Button size="sm" variant="ghost" disabled={!value.length} onClick={() => onChange([])}>전체 삭제</Button>
            </div>
            <p className="mt-1 text-xs text-slate-500">자동 배정은 정상 상태 장비부터 ID 순으로 배정합니다. 다른 진행 중 세션의 장비는 제외됩니다.</p>
          </div>
        </div>
      )}

      <div className={cx('flex flex-wrap items-center gap-3 rounded-md px-3 py-2 text-sm', (expected && expected !== value.length) || assigned < value.length ? 'bg-amber-50 text-amber-900' : 'bg-slate-50 text-slate-700')}>
        <span>학생 <b>{value.length}</b>명{expected ? ` / 예정 ${expected}명` : ''}</span>
        <span>HMD 배정 <b>{assigned}</b>대</span>
        <span>사용 가능 장비 {usable.length}대</span>
        {!!expected && expected !== value.length && <span className="inline-flex items-center gap-1"><AlertTriangle className="size-4" />참여 예정 학생 수와 등록 학생 수가 다릅니다</span>}
        {assigned < value.length && <span className="inline-flex items-center gap-1"><AlertTriangle className="size-4" />HMD 미배정 {value.length - assigned}명</span>}
      </div>
      {issues.length > 0 && <ul role="alert" className="list-inside list-disc rounded-md bg-red-50 p-3 text-sm text-red-800">{issues.map((i) => <li key={i}>{i}</li>)}</ul>}

      {value.length > 0 && (
        <div className="max-h-[420px] overflow-auto rounded-md border border-slate-200">
          <table className="min-w-full">
            <thead className="sticky top-0"><tr><th className="th w-12">#</th><th className="th">학생 코드</th><th className="th">HMD</th><th className="th">장비 상태</th>{!readOnly && <th className="th w-12" />}</tr></thead>
            <tbody>
              {value.map((p, i) => (
                <tr key={p.student_code + i}>
                  <td className="td text-slate-500">{i + 1}</td>
                  <td className="td font-mono">{p.student_code}</td>
                  <td className="td">
                    {readOnly ? (p.device_id ?? '-') : (
                      <select className="input w-40 py-1" value={p.device_id ?? ''} aria-label={`${p.student_code} HMD`}
                        onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, device_id: e.target.value || null } : x)))}>
                        <option value="">미배정</option>
                        {devices.filter((d) => d.active).map((d) => (
                          <option key={d.device_id} value={d.device_id} disabled={(used.has(d.device_id) && d.device_id !== p.device_id) || busyDevices.includes(d.device_id)}>
                            {d.device_id}{busyDevices.includes(d.device_id) ? ' (다른 세션 진행 중)' : used.has(d.device_id) && d.device_id !== p.device_id ? ' (배정됨)' : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="td">{p.device_id && devMap[p.device_id] ? <HealthBadge health={devMap[p.device_id].health} /> : '-'}</td>
                  {!readOnly && <td className="td"><button className="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-700" aria-label={`${p.student_code} 삭제`} onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
