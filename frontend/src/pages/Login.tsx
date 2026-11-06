import { useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { useLive } from '../live'
import { Button } from '../components/ui'
import { ServerOff } from 'lucide-react'

export default function Login() {
  const { login, expired } = useAuth()
  const { serverOk } = useLive()
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [demo, setDemo] = useState(false)
  useEffect(() => { api('/health').then((r) => setDemo(!!r.demo)).catch(() => {}) }, [])
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      await login(u, p)
    } catch (ex) {
      setErr((ex as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid min-h-screen place-items-center bg-slate-900 p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl bg-white p-8 shadow-xl">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 grid size-12 place-items-center rounded-lg bg-blue-700 text-lg font-bold text-white">MR</div>
          <h1 className="text-xl font-bold">MR EDU MOBILE 2.0</h1>
          <p className="text-sm text-slate-600">관리자 시스템 로그인</p>
        </div>
        {serverOk === false && <p role="alert" className="mb-3 flex items-center gap-2 rounded bg-red-50 p-2 text-sm text-red-800"><ServerOff className="size-4" />관리자 서버에 연결할 수 없습니다</p>}
        {expired && <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-900">로그인 세션이 만료되었습니다. 다시 로그인하세요.</p>}
        <label className="label" htmlFor="u">아이디</label>
        <input id="u" className="input mb-3" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" autoFocus required />
        <label className="label" htmlFor="p">비밀번호</label>
        <input id="p" type="password" className="input mb-4" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" required />
        {demo && (
          <div className="mb-3 rounded border border-violet-300 bg-violet-50 p-2 text-sm text-violet-900">
            <b>웹 데모 모드</b> · 가상 HMD 20대가 실행 중입니다.<br />데모 계정: <span className="font-mono">admin / admin1234</span>
            <button type="button" className="ml-2 underline" onClick={() => { setU('admin'); setP('admin1234') }}>자동 입력</button>
          </div>
        )}
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>로그인</Button>
        <p className="mt-4 text-center text-xs text-slate-500">인터넷 연결 없이 로컬 네트워크에서 동작합니다</p>
      </form>
    </div>
  )
}
