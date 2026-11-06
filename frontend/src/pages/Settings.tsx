import { useEffect, useState } from 'react'
import { Eye, EyeOff, PlugZap, RefreshCw, Save } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { useApi } from '../live'
import { Async, Button, Card, Field, KV, PageHeader, Pill, useConfirm, useToast } from '../components/ui'
import { bytes, fmtTime } from '../format'

const GROUPS: [string, string[]][] = [
  ['장비 상태 판정', ['heartbeat_interval_sec', 'offline_threshold_sec', 'delay_threshold_sec', 'battery_warning_pct', 'error_hold_sec']],
  ['동기화 재시도 정책 (HMD에 heartbeat 응답으로 전달)', ['sync_batch_size', 'sync_retry_base_sec', 'sync_retry_max_sec']],
  ['백업·로그·데이터 보관', ['backup_dir', 'auto_backup_enabled', 'auto_backup_hour', 'backup_keep_count', 'log_retention_days', 'result_retention_days']],
  ['보안', ['token_expire_minutes', 'login_max_failures', 'login_lock_minutes', 'require_device_key']],
]

export default function SettingsPage() {
  const st = useApi<any>('/api/v1/settings', undefined, false)
  const sys = useApi<any>('/api/v1/settings/system-status', undefined, false)
  const { can } = useAuth()
  const admin = can('admin')
  const toast = useToast()
  const confirm = useConfirm()
  const [vals, setVals] = useState<Record<string, any>>({})
  const [showKey, setShowKey] = useState(false)
  const [test, setTest] = useState<string | null>(null)
  useEffect(() => { if (st.data) setVals(st.data.values) }, [st.data])

  const save = async () => {
    const changed = Object.fromEntries(Object.entries(vals).filter(([k, v]) => k in (st.data?.descriptions ?? {}) && v !== st.data.values[k]))
    if (!Object.keys(changed).length) return toast.info('변경된 항목이 없습니다')
    try { await api('/api/v1/settings', { method: 'PATCH', body: { values: changed } }); toast.success('설정을 저장했습니다'); st.reload() } catch (e) { toast.error(e) }
  }
  const regenKey = async () => {
    if (!(await confirm({ title: '장비 키 재발급', message: '새 장비 키를 발급하면 모든 HMD 앱에 새 키를 입력해야 통신할 수 있습니다. 계속할까요?', danger: true, confirmText: '재발급', requireText: '재발급' }))) return
    const arr = new Uint8Array(24); crypto.getRandomValues(arr)
    const key = btoa(String.fromCharCode(...arr)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!)
    try { await api('/api/v1/settings', { method: 'PATCH', body: { values: { device_api_key: key } } }); toast.success('장비 키를 재발급했습니다'); st.reload() } catch (e) { toast.error(e) }
  }
  const runTest = async () => {
    setTest('확인 중…')
    const t0 = performance.now()
    try {
      const r = await api('/health')
      setTest(`정상 · 응답 ${Math.round(performance.now() - t0)}ms · DB ${r.db} · 서버 시각 ${fmtTime(r.server_time)}`)
      sys.reload()
    } catch (e) { setTest(`실패: ${(e as Error).message}`) }
  }

  return (
    <div>
      <PageHeader title="네트워크·시스템 설정" desc={admin ? '설정 변경은 시스템 관리자만 가능합니다. 네트워크 인터페이스·방화벽은 이 화면에서 변경하지 않습니다.' : '조회 전용입니다. 변경은 시스템 관리자에게 요청하세요.'}
        actions={admin && <Button variant="primary" icon={<Save className="size-4" />} onClick={save}>설정 저장</Button>} />
      <Async state={st}>{(d) => (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="관리자 PC 서버" actions={<Button size="sm" icon={<PlugZap className="size-3.5" />} onClick={runTest}>API 연결 테스트</Button>}>
            <KV items={[
              ['HMD 접속 주소', <b className="font-mono">{d.server.api_base}</b>], ['서버 IP', d.server.public_host], ['포트', d.server.port],
              ['감지된 IP', d.server.local_ips.join(', ')], ['바인딩', `${d.server.bind_host}:${d.server.port}`], ['DB 파일', <span className="font-mono text-xs">{d.server.db_path}</span>],
            ]} />
            {test && <p className="mt-3 rounded bg-slate-50 p-2 text-sm" role="status">{test}</p>}
            <p className="mt-3 text-xs text-slate-500">IP·포트는 backend/config.json 또는 환경변수(MR_EDU_PORT, MR_EDU_PUBLIC_HOST)로 변경합니다. HMD 앱에는 위 접속 주소와 장비 키를 설정하세요.</p>
          </Card>
          <Card title="HMD 연동 · 장비 키">
            <KV items={[
              ['장비 키(X-Device-Key)', <span className="inline-flex items-center gap-2 font-mono text-xs">{admin ? (showKey ? d.values.device_api_key : '••••••••••••••••') : '조회 권한 없음'}
                {admin && <button className="rounded p-1 hover:bg-slate-100" onClick={() => setShowKey(!showKey)} aria-label={showKey ? '키 숨기기' : '키 보기'}>{showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>}</span>],
              ['키 검증', d.values.require_device_key ? <Pill tone="green">사용</Pill> : <Pill tone="red">해제 (개발용)</Pill>],
            ]} />
            {admin && <Button className="mt-3" size="sm" variant="danger" icon={<RefreshCw className="size-3.5" />} onClick={regenKey}>장비 키 재발급</Button>}
          </Card>
          {GROUPS.map(([title, keys]) => (
            <Card key={title} title={title}>
              <div className="grid gap-3 md:grid-cols-2">
                {keys.map((k) => {
                  const v = vals[k]
                  const lim = d.limits[k]
                  return (
                    <Field key={k} label={d.descriptions[k]} hint={k === 'backup_dir' ? `현재 적용: ${d.values.backup_dir_effective}` : lim ? `${lim[0]} ~ ${lim[1]}` : undefined}>
                      {typeof d.values[k] === 'boolean' ? (
                        <label className="inline-flex items-center gap-2 py-2 text-sm"><input type="checkbox" disabled={!admin} checked={!!v} onChange={(e) => setVals({ ...vals, [k]: e.target.checked })} />사용</label>
                      ) : typeof d.values[k] === 'number' ? (
                        <input type="number" className="input" disabled={!admin} min={lim?.[0]} max={lim?.[1]} value={v ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value === '' ? '' : Number(e.target.value) })} />
                      ) : (
                        <input className="input" disabled={!admin} value={v ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />
                      )}
                    </Field>
                  )
                })}
              </div>
            </Card>
          ))}
          <Card title="서버 상태" actions={<Button size="sm" onClick={sys.reload}>새로고침</Button>}>
            <Async state={sys}>{(s) => (
              <KV items={[
                ['버전', s.version], ['Python', s.python], ['플랫폼', s.platform],
                ['DB 무결성', s.db.quick_check === 'ok' ? <Pill tone="green">정상</Pill> : <Pill tone="red">{s.db.quick_check}</Pill>],
                ['DB 크기', bytes(s.db.size_bytes)], ['DB 응답', `${s.db.latency_ms} ms`],
                ['디스크 여유', s.disk ? `${bytes(s.disk.free)} / ${bytes(s.disk.total)}` : '확인 불가'],
                ['실시간 접속 화면', `${s.websocket_clients}개`], ['서버 시각', fmtTime(s.server_time)],
                ['데이터 건수', Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(', ')],
              ]} />
            )}</Async>
          </Card>
        </div>
      )}</Async>
    </div>
  )
}
