import { useState } from 'react'
import { DatabaseBackup, ShieldCheck, RotateCcw } from 'lucide-react'
import { api } from '../api'
import { useApi } from '../live'
import { Async, Button, Card, Empty, KV, Modal, PageHeader, Pager, Pill, Tabs, useConfirm, useToast } from '../components/ui'
import { bytes, fmtTime } from '../format'

const KINDS: [string, string][] = [['backup', '백업·복원'], ['api_errors', 'API 오류'], ['heartbeats', 'heartbeat 수신'], ['audit', '관리자 작업'], ['sync', '결과 업로드·ACK'], ['events', '장비 이벤트'], ['rejections', '결과 거부'], ['backups', '백업 이력']]

const COLS: Record<string, [string, string][]> = {
  api_errors: [['created_at', '시각'], ['method', '메서드'], ['path', '경로'], ['status_code', '코드'], ['message', '내용'], ['client', '요청 IP']],
  heartbeats: [['received_at', '수신'], ['device_id', '장비'], ['payload_json', '내용']],
  audit: [['created_at', '시각'], ['username', '관리자'], ['action', '작업'], ['target_type', '대상'], ['target_id', '대상 ID'], ['detail_json', '상세']],
  sync: [['created_at', '시각'], ['device_id', '장비'], ['session_id', '세션'], ['received_count', '전송'], ['accepted_count', '저장'], ['duplicate_count', '중복'], ['rejected_count', '거부']],
  events: [['received_at', '수신'], ['occurred_at', '발생'], ['device_id', '장비'], ['event_type', '유형'], ['session_id', '세션'], ['payload_json', '내용']],
  rejections: [['received_at', '수신'], ['device_id', '장비'], ['session_id', '세션'], ['event_id', 'event_id'], ['reason', '사유']],
  backups: [['created_at', '시각'], ['action', '작업'], ['trigger', '구분'], ['file_path', '파일'], ['size_bytes', '크기'], ['result', '결과'], ['message', '메시지']],
}

export default function Logs() {
  const [kind, setKind] = useState('backup')
  return (
    <div>
      <PageHeader title="시스템 로그·백업" desc="로그에는 비밀번호 등 민감정보를 기록하지 않습니다. 보관 기간은 설정에서 변경합니다." />
      <Tabs value={kind} onChange={setKind} tabs={KINDS.map(([k, l]) => ({ key: k, label: l }))} />
      {kind === 'backup' ? <Backup /> : <LogTable kind={kind} />}
    </div>
  )
}

function LogTable({ kind }: { kind: string }) {
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(50)
  const [q, setQ] = useState('')
  const st = useApi<any>(`/api/v1/logs/${kind}`, { q, limit: size, offset: (page - 1) * size })
  const cols = COLS[kind]
  return (
    <Card>
      <input className="input mb-3 max-w-xs" placeholder="검색" value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} aria-label="로그 검색" />
      <Async state={st}>{(d) => (
        <>
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <table className="min-w-full"><thead><tr>{cols.map(([k, l]) => <th key={k} className="th">{l}</th>)}</tr></thead>
              <tbody>{d.items.length === 0 ? <tr><td colSpan={cols.length}><Empty /></td></tr> : d.items.map((r: any) => (
                <tr key={r.id}>{cols.map(([k]) => <td key={k} className="td max-w-md truncate" title={String(r[k] ?? '')}>{k.endsWith('_at') ? fmtTime(r[k]) : k === 'size_bytes' ? bytes(r[k]) : String(r[k] ?? '-')}</td>)}</tr>
              ))}</tbody></table>
          </div>
          <Pager page={page} pages={Math.ceil(d.total / size)} total={d.total} onPage={setPage} pageSize={size} onPageSize={(n) => { setSize(n); setPage(1) }} />
        </>
      )}</Async>
    </Card>
  )
}

function Backup() {
  const st = useApi<any>('/api/v1/backups', undefined, false)
  const toast = useToast()
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const [verify, setVerify] = useState<any | null>(null)
  const make = async () => {
    setBusy(true)
    try { const r = await api('/api/v1/backups', { method: 'POST' }); toast.success(`백업 완료: ${r.file}\n무결성: ${r.integrity}`); st.reload() } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  const doVerify = async (file: string) => { try { setVerify(await api('/api/v1/backups/verify', { method: 'POST', body: { file } })) } catch (e) { toast.error(e) } }
  const restore = async (file: string) => {
    if (!(await confirm({ title: 'DB 복원', danger: true, confirmText: '복원', requireText: '복원',
      message: <>선택한 백업 <b>{file}</b> 으로 DB를 복원합니다. 복원 전 무결성을 확인하고, 현재 DB는 <b>pre_restore</b> 백업으로 별도 보존합니다. 백업 이후 수신된 결과는 복원된 DB에 없으므로, HMD에서 재전송(중복 없이 저장)이 필요할 수 있습니다.</> }))) return
    setBusy(true)
    try { const r = await api('/api/v1/backups/restore', { method: 'POST', body: { file, confirm: true } }); toast.success(`복원 완료. 이전 DB: ${r.previous_db_saved_as}`); st.reload() } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  return (
    <Card title="DB 백업" actions={<Button variant="primary" loading={busy} icon={<DatabaseBackup className="size-4" />} onClick={make}>수동 백업</Button>}>
      <Async state={st}>{(d) => (
        <>
          <p className="mb-3 text-sm text-slate-600">백업 경로: <span className="font-mono">{d.dir}</span> · 자동 백업은 설정의 시각 이후 하루 한 번 실행됩니다.</p>
          {d.items.length === 0 ? <Empty text="백업 파일이 없습니다" /> : (
            <table className="min-w-full"><thead><tr><th className="th">파일</th><th className="th">크기</th><th className="th">생성</th><th className="th">체크섬</th><th className="th" /></tr></thead>
              <tbody>{d.items.map((b: any) => (
                <tr key={b.file}><td className="td font-mono text-xs">{b.file}{b.file.includes('pre_restore') && <Pill tone="amber">복원 전 보존</Pill>}{b.file.includes('_auto') && <Pill tone="blue">자동</Pill>}</td><td className="td">{bytes(b.size_bytes)}</td><td className="td">{fmtTime(b.modified_at)}</td><td className="td">{b.has_checksum ? 'SHA-256' : '-'}</td>
                  <td className="td"><div className="flex gap-1"><Button size="sm" icon={<ShieldCheck className="size-3.5" />} onClick={() => doVerify(b.file)}>무결성 확인</Button><Button size="sm" variant="danger" icon={<RotateCcw className="size-3.5" />} onClick={() => restore(b.file)}>복원</Button></div></td></tr>
              ))}</tbody></table>
          )}
        </>
      )}</Async>
      <Modal open={!!verify} title="백업 무결성 확인" onClose={() => setVerify(null)}>
        {verify && <KV items={[
          ['파일', verify.file], ['결과', verify.ok ? <Pill tone="green">정상</Pill> : <Pill tone="red">이상</Pill>],
          ['SQLite 검사', verify.integrity], ['체크섬', verify.checksum_ok === null ? '체크섬 파일 없음' : verify.checksum_ok ? '일치' : '불일치 (파일 변조·손상 의심)'],
          ['SHA-256', <span className="font-mono text-[11px]">{verify.sha256}</span>],
          ...Object.entries(verify.counts).map(([k, v]) => [k, String(v)] as [string, string]),
        ]} />}
      </Modal>
    </Card>
  )
}
