import { useState } from 'react'
import { Plus } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { useApi } from '../live'
import { Async, Button, Card, DataTable, Field, Modal, PageHeader, Pill, useConfirm, useToast, type Column } from '../components/ui'
import { ROLE_LABEL, fmtTime } from '../format'

export default function UsersPage() {
  const st = useApi<any>('/api/v1/users', undefined, false)
  const { user: me } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  const [edit, setEdit] = useState<any | null>(null)
  const patch = async (id: number, body: any, ok: string) => { try { await api(`/api/v1/users/${id}`, { method: 'PATCH', body }); toast.success(ok); st.reload() } catch (e) { toast.error(e) } }
  const cols: Column<any>[] = [
    { key: 'username', label: '아이디', render: (u) => <b>{u.username}{u.id === me?.id && <span className="ml-1 text-xs text-blue-700">(나)</span>}</b> },
    { key: 'display_name', label: '이름', render: (u) => u.display_name || '-' },
    { key: 'role', label: '권한', render: (u) => u.role_label },
    { key: 'active', label: '상태', render: (u) => <span className="inline-flex gap-1">{u.active ? <Pill tone="green">활성</Pill> : <Pill>비활성</Pill>}{u.locked_until && new Date(u.locked_until) > new Date() && <Pill tone="red">잠김</Pill>}{u.must_change_password ? <Pill tone="amber">비밀번호 변경 필요</Pill> : null}</span> },
    { key: 'last_login_at', label: '마지막 로그인', render: (u) => fmtTime(u.last_login_at) },
    { key: 'created_at', label: '생성일', render: (u) => fmtTime(u.created_at).slice(0, 10) },
    { key: 'act', label: '', sortable: false, render: (u) => (
      <div className="flex gap-1">
        <Button size="sm" onClick={() => setEdit(u)}>수정</Button>
        {u.locked_until && <Button size="sm" onClick={() => patch(u.id, { unlock: true }, '잠금을 해제했습니다')}>잠금 해제</Button>}
        <Button size="sm" variant={u.active ? 'danger' : 'success'} disabled={u.id === me?.id} onClick={async () => {
          if (await confirm({ title: u.active ? '계정 비활성화' : '계정 활성화', message: `${u.username} 계정을 ${u.active ? '비활성화' : '활성화'}합니다.`, danger: !!u.active })) patch(u.id, { active: !u.active }, '변경했습니다')
        }}>{u.active ? '비활성화' : '활성화'}</Button>
      </div>
    ) },
  ]
  return (
    <div>
      <PageHeader title="사용자·권한 관리" desc="시스템 관리자: 모든 메뉴·설정 / 교육 운영자: 장비·세션·결과 관리 / 조회 전용: 대시보드·보고서 등 조회"
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>사용자 추가</Button>} />
      <Card><Async state={st}>{(d) => <DataTable rows={d.items} columns={cols} rowKey={(r) => r.id} search={(r) => `${r.username} ${r.display_name ?? ''}`} />}</Async></Card>
      <UserModal open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); st.reload() }} />
      <EditModal u={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); st.reload() }} />
    </div>
  )
}

function UserModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const init = { username: '', display_name: '', password: '', role: 'operator' }
  const [f, setF] = useState(init)
  const save = async () => { try { await api('/api/v1/users', { method: 'POST', body: { ...f, display_name: f.display_name || null } }); toast.success('사용자를 추가했습니다. 최초 로그인 시 비밀번호 변경이 요구됩니다.'); setF(init); onDone() } catch (e) { toast.error(e) } }
  return (
    <Modal open={open} title="사용자 추가" onClose={onClose} footer={<><Button onClick={onClose}>취소</Button><Button variant="primary" disabled={!f.username || f.password.length < 8} onClick={save}>추가</Button></>}>
      <div className="space-y-3">
        <Field label="아이디" required hint="영문·숫자·_.- 3~32자"><input className="input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" /></Field>
        <Field label="이름"><input className="input" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
        <Field label="초기 비밀번호" required hint="8자 이상, 영문과 숫자 포함"><input type="password" className="input" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
        <Field label="권한"><select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      </div>
    </Modal>
  )
}

function EditModal({ u, onClose, onDone }: { u: any | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({ display_name: '', role: '', reset_password: '' })
  const [last, setLast] = useState<number | null>(null)
  if (u && last !== u.id) { setLast(u.id); setF({ display_name: u.display_name ?? '', role: u.role, reset_password: '' }) }
  const save = async () => {
    try {
      await api(`/api/v1/users/${u.id}`, { method: 'PATCH', body: { display_name: f.display_name, role: f.role, reset_password: f.reset_password || null } })
      toast.success('저장했습니다'); setLast(null); onDone()
    } catch (e) { toast.error(e) }
  }
  return (
    <Modal open={!!u} title={`사용자 수정 · ${u?.username ?? ''}`} onClose={() => { setLast(null); onClose() }} footer={<><Button onClick={onClose}>취소</Button><Button variant="primary" onClick={save}>저장</Button></>}>
      <div className="space-y-3">
        <Field label="이름"><input className="input" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
        <Field label="권한"><select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="비밀번호 초기화" hint="입력 시 새 비밀번호로 변경되며 다음 로그인 때 변경이 요구됩니다"><input type="password" className="input" value={f.reset_password} onChange={(e) => setF({ ...f, reset_password: e.target.value })} autoComplete="new-password" /></Field>
      </div>
    </Modal>
  )
}
