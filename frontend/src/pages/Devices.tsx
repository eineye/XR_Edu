import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Download, Plus, ListPlus, Wifi, WifiOff } from 'lucide-react'
import { api, download } from '../api'
import { useAuth } from '../auth'
import { useApi } from '../live'
import { Async, Battery, Button, Card, DataTable, DemoBadge, Field, HealthBadge, Modal, PageHeader, useConfirm, useToast, type Column } from '../components/ui'
import { APP_STATUS, fmtAgo, fmtTime } from '../format'

const HEALTH_OPTS = [
  ['', '전체 상태'], ['normal', '정상'], ['warning', '주의'], ['offline,unknown', '오프라인·확인 불가'], ['error', '오류'], ['inactive', '비활성'],
]

export default function Devices() {
  const nav = useNavigate()
  const { can } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const [sp, setSp] = useSearchParams()
  const health = sp.get('health') ?? ''
  const st = useApi<any>('/api/v1/devices', { health })
  const settings = useApi<any>('/api/v1/settings', undefined, false)
  const [openNew, setOpenNew] = useState(false)
  const [openBulk, setOpenBulk] = useState(false)
  const threshold = settings.data?.values?.battery_warning_pct ?? 20
  const demo = useApi<any>('/api/v1/demo/status')
  const demoNet = async (offline: boolean) => {
    const ids = ['HMD-03', 'HMD-07', 'HMD-12']
    try {
      await api('/api/v1/demo/network', { method: 'POST', body: { device_ids: offline ? ids : demo.data.offline, offline } })
      toast.info(offline ? `${ids.join(', ')} Wi-Fi 단절 (오프라인 판정까지 설정된 시간이 걸립니다)` : 'Wi-Fi 복구 — 미전송 결과가 자동 재전송됩니다')
      demo.reload()
    } catch (e) { toast.error(e) }
  }

  const columns: Column<any>[] = [
    { key: 'device_id', label: 'ID', render: (d) => <span className="font-semibold">{d.device_id}{d.is_simulated ? <span className="ml-1 text-[10px] text-violet-700">가상</span> : null}</span> },
    { key: 'device_name', label: '별칭', render: (d) => d.device_name || '-' },
    { key: 'health', label: '상태', render: (d) => <HealthBadge health={d.health} title={d.health_reasons.join(' / ')} /> },
    { key: 'battery_level', label: '배터리', render: (d) => <Battery level={d.battery_level} threshold={threshold} /> },
    { key: 'app_status', label: '앱 상태', render: (d) => (d.connection_status === 'online' ? APP_STATUS[d.app_status] : <span className="text-slate-500">확인 불가</span>) },
    { key: 'content_version', label: '콘텐츠 버전', render: (d) => d.content_version || '-' },
    { key: 'app_version', label: '앱 버전', render: (d) => d.app_version || '-' },
    { key: 'last_seen_at', label: '마지막 통신', render: (d) => <span title={fmtTime(d.last_seen_at)}>{d.last_seen_at ? `${fmtTime(d.last_seen_at, false)} (${fmtAgo(d.last_seen_at)})` : '기록 없음'}</span> },
    { key: 'assignment', label: '배정 세션', sortValue: (d) => d.assignment?.session_code, render: (d) => d.assignment ? `${d.assignment.session_code} · ${d.assignment.student_code}` : '-' },
    { key: 'last_error_code', label: '최근 오류', render: (d) => d.last_error_code || '-' },
  ]

  return (
    <div>
      <PageHeader title="장비 관리" desc="HMD 상태는 HMD가 보낸 heartbeat 기준이며, 기기에서 제공하지 않는 값은 '확인 불가'로 표시합니다."
        actions={<>
          <Button icon={<Download className="size-4" />} onClick={() => download('/api/v1/devices/export.csv', {}, 'devices.csv').catch(toast.error)}>CSV 내보내기</Button>
          {can('admin', 'operator') && <>
            <Button icon={<ListPlus className="size-4" />} onClick={() => setOpenBulk(true)}>일괄 등록</Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpenNew(true)}>장비 등록</Button>
          </>}
        </>} />
      {demo.data?.enabled && can('admin', 'operator') && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-violet-300 bg-violet-50 px-3 py-2 text-sm text-violet-900">
          <DemoBadge label="웹 데모" />
          Wi-Fi 단절·복구 시험: 현재 단절 {demo.data.offline.length ? demo.data.offline.join(', ') : '없음'}
          <Button size="sm" icon={<WifiOff className="size-3.5" />} onClick={() => demoNet(true)}>HMD-03·07·12 단절</Button>
          <Button size="sm" variant="success" icon={<Wifi className="size-3.5" />} disabled={!demo.data.offline.length} onClick={() => demoNet(false)}>전체 복구</Button>
          <span className="text-xs">장비 상세 화면에서 개별 장비도 끊을 수 있습니다.</span>
          {demo.data.static && <>
            <span className="text-xs">· 데이터는 이 브라우저에만 저장되며, 이 탭이 열려 있는 동안 가상 HMD가 동작합니다.</span>
            <Button size="sm" variant="ghost" onClick={async () => {
              if (!(await confirm({ title: '데모 데이터 초기화', message: '이 브라우저의 데모 데이터(세션·결과·설정·백업)를 지우고 처음 상태로 되돌립니다.', danger: true, confirmText: '초기화' }))) return
              try { await api('/api/v1/demo/reset', { method: 'POST' }); location.reload() } catch (e) { toast.error(e) }
            }}>데모 데이터 초기화</Button>
          </>}
        </div>
      )}
      <Card>
        <Async state={st}>
          {(d) => (
            <DataTable rows={d.items} columns={columns} rowKey={(r) => r.device_id}
              search={(r) => `${r.device_id} ${r.device_name ?? ''} ${r.notes ?? ''}`}
              onRowClick={(r) => nav(`/devices/${r.device_id}`)}
              emptyText={health ? '해당 상태의 장비가 없습니다' : '등록된 장비가 없습니다. [일괄 등록]으로 HMD-01~20을 등록하세요.'}
              toolbar={<>
                <select className="input w-auto" value={health} onChange={(e) => { const v = e.target.value; setSp(v ? { health: v } : {}) }} aria-label="상태 필터">
                  {HEALTH_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {d.items.some((x: any) => x.is_simulated) && <DemoBadge label="가상 HMD(시뮬레이터) 포함" />}
                <span className="text-xs text-slate-500">기준: 오프라인 {settings.data?.values?.offline_threshold_sec ?? '-'}초 · 지연 {settings.data?.values?.delay_threshold_sec ?? '-'}초 · 배터리 {threshold}% (설정에서 변경)</span>
              </>} />
          )}
        </Async>
      </Card>
      <NewDeviceModal open={openNew} onClose={() => setOpenNew(false)} onDone={() => { st.reload(); setOpenNew(false) }} />
      <BulkModal open={openBulk} onClose={() => setOpenBulk(false)} onDone={() => { st.reload(); setOpenBulk(false) }} />
    </div>
  )
}

function NewDeviceModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({ device_id: '', device_name: '', model: 'Meta Quest 3', notes: '' })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await api('/api/v1/devices', { method: 'POST', body: { ...f, device_name: f.device_name || null, notes: f.notes || null } })
      toast.success(`${f.device_id} 등록 완료`)
      setF({ device_id: '', device_name: '', model: 'Meta Quest 3', notes: '' })
      onDone()
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} title="장비 등록" onClose={onClose} footer={<><Button onClick={onClose}>취소</Button><Button variant="primary" loading={busy} disabled={!f.device_id} onClick={save}>등록</Button></>}>
      <div className="space-y-3">
        <Field label="장비 ID" required hint="예: HMD-01 (HMD 앱에 설정된 ID와 같아야 합니다)"><input className="input" value={f.device_id} onChange={(e) => setF({ ...f, device_id: e.target.value })} autoFocus /></Field>
        <Field label="별칭"><input className="input" value={f.device_name} onChange={(e) => setF({ ...f, device_name: e.target.value })} /></Field>
        <Field label="모델명"><input className="input" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
        <Field label="비고"><textarea className="input" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
    </Modal>
  )
}

function BulkModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({ prefix: 'HMD-', start: 1, count: 20 })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      const r = await api('/api/v1/devices/bulk', { method: 'POST', body: f })
      toast.success(`${r.created.length}대 등록${r.skipped.length ? `, ${r.skipped.length}대는 이미 등록되어 건너뜀` : ''}`)
      onDone()
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  const last = f.start + f.count - 1
  const w = Math.max(2, String(last).length)
  return (
    <Modal open={open} title="장비 일괄 등록" onClose={onClose} footer={<><Button onClick={onClose}>취소</Button><Button variant="primary" loading={busy} onClick={save}>등록</Button></>}>
      <div className="grid grid-cols-3 gap-3">
        <Field label="접두어"><input className="input" value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value })} /></Field>
        <Field label="시작 번호"><input type="number" min={1} className="input" value={f.start} onChange={(e) => setF({ ...f, start: Number(e.target.value) })} /></Field>
        <Field label="대수"><input type="number" min={1} max={100} className="input" value={f.count} onChange={(e) => setF({ ...f, count: Number(e.target.value) })} /></Field>
      </div>
      <p className="mt-3 text-sm text-slate-600">{f.prefix}{String(f.start).padStart(w, '0')} ~ {f.prefix}{String(last).padStart(w, '0')} 를 등록합니다. 이미 있는 ID는 건너뜁니다.</p>
    </Modal>
  )
}
