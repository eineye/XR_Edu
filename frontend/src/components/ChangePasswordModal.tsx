import { useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { Button, Field, Modal, useToast } from './ui'

export default function ChangePasswordModal({ open, forced, onClose }: { open: boolean; forced: boolean; onClose: () => void }) {
  const { refresh } = useAuth()
  const toast = useToast()
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const submit = async () => {
    setErr('')
    if (pw !== pw2) return setErr('새 비밀번호가 일치하지 않습니다')
    if (pw.length < 8) return setErr('비밀번호는 8자 이상이어야 합니다')
    setBusy(true)
    try {
      await api('/api/v1/auth/change-password', { method: 'POST', body: { current_password: cur, new_password: pw } })
      toast.success('비밀번호를 변경했습니다')
      setCur(''); setPw(''); setPw2('')
      await refresh()
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} title="비밀번호 변경" onClose={onClose} footer={<>
      <Button onClick={onClose}>{forced ? '나중에' : '취소'}</Button>
      <Button variant="primary" loading={busy} onClick={submit}>변경</Button>
    </>}>
      {forced && <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-900">초기 비밀번호를 사용 중입니다. 보안을 위해 비밀번호를 변경하세요.</p>}
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <Field label="현재 비밀번호"><input type="password" className="input" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="새 비밀번호" hint="8자 이상, 영문과 숫자 포함"><input type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
        <Field label="새 비밀번호 확인"><input type="password" className="input" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Field>
        {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  )
}
