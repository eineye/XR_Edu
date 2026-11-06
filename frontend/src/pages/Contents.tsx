import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { useApi } from '../live'
import { Async, Button, Card, DataTable, Empty, Field, KV, Modal, PageHeader, Pill, Tabs, VerifyNeeded, useConfirm, useToast, type Column } from '../components/ui'
import { CATEGORY, bytes, fmtTime } from '../format'

export default function Contents() {
  const st = useApi<any>('/api/v1/contents', undefined, false)
  const { can } = useAuth()
  const [newOpen, setNewOpen] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [cat, setCat] = useState('')
  const cols: Column<any>[] = [
    { key: 'content_id', label: '콘텐츠 ID', render: (c) => <span className="font-mono text-xs">{c.content_id}</span> },
    { key: 'title', label: '콘텐츠명' },
    { key: 'category', label: '분야', render: (c) => c.category_label },
    { key: 'version', label: '버전' },
    { key: 'package_name', label: '패키지', render: (c) => c.package_name || '-' },
    { key: 'package_size', label: '크기', render: (c) => bytes(c.package_size) },
    { key: 'installed_current_count', label: '설치 현황(현 버전)', render: (c) => `${c.installed_current_count} / ${c.total_devices}대` },
    { key: 'result_count', label: '결과', render: (c) => `${c.result_count}건` },
    { key: 'active', label: '상태', render: (c) => (c.active ? <Pill tone="green">활성</Pill> : <Pill>비활성</Pill>) },
    { key: 'created_at', label: '등록일', render: (c) => fmtTime(c.created_at).slice(0, 10) },
  ]
  return (
    <div>
      <PageHeader title="콘텐츠 관리" desc={<span className="inline-flex flex-wrap items-center gap-2">콘텐츠 메타데이터·버전·설치 현황·배포 체크리스트를 관리합니다. <VerifyNeeded>원격 설치: 기기 연동 검증 필요</VerifyNeeded></span>}
        actions={can('admin', 'operator') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setNewOpen(true)}>콘텐츠 등록</Button>} />
      <Card>
        <Async state={st}>{(d) => (
          <DataTable rows={d.items.filter((c: any) => !cat || c.category === cat)} columns={cols} rowKey={(r) => r.content_id} search={(r) => `${r.content_id} ${r.title} ${r.description ?? ''}`} onRowClick={(r) => setSel(r.content_id)}
            emptyText="등록된 콘텐츠가 없습니다"
            toolbar={<select className="input w-auto" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="분야 필터"><option value="">전체 분야</option>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>} />
        )}</Async>
      </Card>
      <NewContent open={newOpen} onClose={() => setNewOpen(false)} onDone={() => { setNewOpen(false); st.reload() }} />
      <ContentDetail id={sel} onClose={() => setSel(null)} onChanged={st.reload} />
    </div>
  )
}

function NewContent({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const init = { content_id: '', title: '', category: 'safety', description: '', version: '1.0.0', package_name: '', package_size: '', supported_models: 'Meta Quest 3' }
  const [f, setF] = useState(init)
  const save = async () => {
    try {
      await api('/api/v1/contents', { method: 'POST', body: { ...f, package_size: f.package_size ? Number(f.package_size) : null, description: f.description || null, package_name: f.package_name || null } })
      toast.success('콘텐츠를 등록했습니다'); setF(init); onDone()
    } catch (e) { toast.error(e) }
  }
  return (
    <Modal open={open} title="콘텐츠 등록" onClose={onClose} footer={<><Button onClick={onClose}>취소</Button><Button variant="primary" disabled={!f.content_id || !f.title || !f.version} onClick={save}>등록</Button></>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="콘텐츠 ID" required hint="예: SAFETY-01 (HMD 결과의 content_id와 같아야 함)"><input className="input" value={f.content_id} onChange={(e) => setF({ ...f, content_id: e.target.value })} /></Field>
        <Field label="교육 분야" required><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="콘텐츠명" required className="md:col-span-2"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="설명" className="md:col-span-2"><textarea className="input" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="버전" required><input className="input" value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} /></Field>
        <Field label="지원 HMD 모델"><input className="input" value={f.supported_models} onChange={(e) => setF({ ...f, supported_models: e.target.value })} /></Field>
        <Field label="패키지 파일명"><input className="input" value={f.package_name} onChange={(e) => setF({ ...f, package_name: e.target.value })} placeholder="com.example.app.apk" /></Field>
        <Field label="파일 크기(바이트)"><input type="number" className="input" value={f.package_size} onChange={(e) => setF({ ...f, package_size: e.target.value })} /></Field>
      </div>
    </Modal>
  )
}

function ContentDetail({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const st = useApi<any>(id ? `/api/v1/contents/${id}` : null, undefined, false)
  const { can } = useAuth()
  const op = can('admin', 'operator')
  const toast = useToast()
  const confirm = useConfirm()
  const nav = useNavigate()
  const [tab, setTab] = useState('info')
  const [ver, setVer] = useState({ version: '', package_name: '', release_notes: '' })
  const [targets, setTargets] = useState<string[]>([])
  const [depVer, setDepVer] = useState('')
  const act = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast.success(ok); st.reload(); onChanged() } catch (e) { toast.error(e) } }
  return (
    <Modal open={!!id} title="콘텐츠 상세" onClose={onClose} wide>
      <Async state={st}>{(c) => (
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div><b>{c.title}</b> <span className="text-sm text-slate-500">{c.content_id} · v{c.version}</span></div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => nav(`/results?tab=stats&content_id=${c.content_id}`)}>학습 결과 보기</Button>
              {op && <Button size="sm" variant={c.active ? 'danger' : 'success'} onClick={async () => {
                if (await confirm({ title: c.active ? '콘텐츠 비활성화' : '콘텐츠 활성화', message: c.active ? '비활성 콘텐츠는 새 세션에서 선택할 수 없습니다. 기존 결과는 유지됩니다.' : '콘텐츠를 다시 활성화합니다.', danger: !!c.active }))
                  act(() => api(`/api/v1/contents/${c.content_id}`, { method: 'PATCH', body: { active: !c.active } }), '변경했습니다')
              }}>{c.active ? '비활성화' : '활성화'}</Button>}
            </div>
          </div>
          <Tabs value={tab} onChange={setTab} tabs={[{ key: 'info', label: '정보' }, { key: 'versions', label: `버전 (${c.versions.length})` }, { key: 'installs', label: '장비별 설치 버전' }, { key: 'deploy', label: `배포 작업 (${c.deploy_jobs.length})` }]} />
          {tab === 'info' && <KV items={[['분야', c.category_label], ['설명', c.description], ['현재 버전', c.version], ['패키지', c.package_name], ['크기', bytes(c.package_size)], ['지원 모델', c.supported_models], ['등록일', fmtTime(c.created_at)], ['원격 설치', <VerifyNeeded />]]} />}
          {tab === 'versions' && (
            <div className="space-y-3">
              {op && (
                <div className="grid gap-2 rounded-md border border-slate-200 p-3 md:grid-cols-4">
                  <input className="input" placeholder="새 버전 (예: 1.1.0)" value={ver.version} onChange={(e) => setVer({ ...ver, version: e.target.value })} aria-label="새 버전" />
                  <input className="input" placeholder="패키지 파일명" value={ver.package_name} onChange={(e) => setVer({ ...ver, package_name: e.target.value })} aria-label="패키지 파일명" />
                  <input className="input" placeholder="변경 내용" value={ver.release_notes} onChange={(e) => setVer({ ...ver, release_notes: e.target.value })} aria-label="변경 내용" />
                  <Button variant="primary" disabled={!ver.version} onClick={() => act(() => api(`/api/v1/contents/${c.content_id}/versions`, { method: 'POST', body: { ...ver, package_name: ver.package_name || null, make_current: true } }).then(() => setVer({ version: '', package_name: '', release_notes: '' })), '버전을 추가했습니다')}>버전 추가(현재 버전으로)</Button>
                </div>
              )}
              <table className="min-w-full"><thead><tr><th className="th">버전</th><th className="th">패키지</th><th className="th">변경 내용</th><th className="th">등록</th></tr></thead>
                <tbody>{c.versions.map((v: any) => <tr key={v.id}><td className="td">{v.version}{v.version === c.version && <Pill tone="blue">현재</Pill>}</td><td className="td">{v.package_name ?? '-'}</td><td className="td">{v.release_notes ?? '-'}</td><td className="td">{fmtTime(v.created_at)}</td></tr>)}</tbody></table>
            </div>
          )}
          {tab === 'installs' && (
            <table className="min-w-full"><thead><tr><th className="th">HMD</th><th className="th">설치 버전</th><th className="th">상태</th><th className="th">출처</th><th className="th">갱신</th></tr></thead>
              <tbody>{c.installs.map((i: any) => (
                <tr key={i.device_id}><td className="td">{i.device_id}</td>
                  <td className="td">{i.version ?? '-'}{i.version && i.version !== c.version && <Pill tone="amber">구버전</Pill>}</td>
                  <td className="td">{i.status ? { installed: '설치됨', planned: '설치 예정', failed: '실패', unknown: '확인 불가' }[i.status as string] : <span className="text-slate-500">보고 없음</span>}</td>
                  <td className="td">{i.source === 'reported' ? 'HMD 보고' : i.source === 'manual' ? '관리자 계획' : '-'}</td><td className="td">{fmtTime(i.updated_at)}</td></tr>
              ))}</tbody></table>
          )}
          {tab === 'deploy' && (
            <div className="space-y-3">
              <p className="rounded bg-orange-50 p-2 text-sm text-orange-900">초기 버전은 원격 패키지 설치를 지원하지 않습니다. Meta Quest 공식 배포·개발자 도구로 설치한 뒤 체크리스트로 기록하고, 실제 설치 버전은 HMD heartbeat 보고로 확인합니다.</p>
              {op && (
                <div className="rounded-md border border-slate-200 p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <select className="input w-auto" value={depVer} onChange={(e) => setDepVer(e.target.value)} aria-label="배포 버전"><option value="">배포 버전 선택</option>{c.versions.map((v: any) => <option key={v.id} value={v.version}>{v.version}</option>)}</select>
                    <Button size="sm" onClick={() => setTargets(c.installs.filter((i: any) => i.active).map((i: any) => i.device_id))}>전체 선택</Button>
                    <Button size="sm" onClick={() => setTargets(c.installs.filter((i: any) => i.active && i.version !== (depVer || c.version)).map((i: any) => i.device_id))}>미설치·구버전만</Button>
                    <Button size="sm" variant="primary" disabled={!depVer || !targets.length} onClick={() => act(() => api(`/api/v1/contents/${c.content_id}/deploy-jobs`, { method: 'POST', body: { version: depVer, target_devices: targets } }).then(() => setTargets([])), '배포 작업을 만들었습니다')}>배포 작업 생성 ({targets.length}대)</Button>
                  </div>
                  <div className="flex flex-wrap gap-2">{c.installs.filter((i: any) => i.active).map((i: any) => (
                    <label key={i.device_id} className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs"><input type="checkbox" checked={targets.includes(i.device_id)} onChange={(e) => setTargets(e.target.checked ? [...targets, i.device_id] : targets.filter((t) => t !== i.device_id))} />{i.device_id}</label>
                  ))}</div>
                </div>
              )}
              {c.deploy_jobs.length === 0 ? <Empty text="배포 작업 이력이 없습니다" /> : c.deploy_jobs.map((j: any) => (
                <div key={j.id} className="rounded-md border border-slate-200 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span><b>#{j.id} v{j.version}</b> · 대상 {j.target_devices.length}대 · {fmtTime(j.created_at)}</span>
                    <select className="input w-auto py-1" disabled={!op} value={j.status} aria-label="배포 상태" onChange={(e) => act(() => api(`/api/v1/contents/deploy-jobs/${j.id}`, { method: 'PATCH', body: { status: e.target.value } }), '상태를 변경했습니다')}>
                      <option value="planned">계획</option><option value="in_progress">진행 중</option><option value="done">완료</option><option value="cancelled">취소</option>
                    </select>
                  </div>
                  <ul className="space-y-1">{j.checklist.map((it: any, k: number) => (
                    <li key={k}><label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" disabled={!op} checked={it.done} onChange={() => act(() => api(`/api/v1/contents/deploy-jobs/${j.id}`, { method: 'PATCH', body: { checklist: j.checklist.map((x: any, m: number) => (m === k ? { ...x, done: !x.done } : x)) } }), '체크리스트를 저장했습니다')} />{it.item}</label></li>
                  ))}</ul>
                  <div className="mt-1 text-xs text-slate-500">대상: {j.target_devices.join(', ')}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}</Async>
    </Modal>
  )
}
