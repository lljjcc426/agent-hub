import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ChatSessions } from '../../src/chat.ts'
import { ContextWindow } from '../ui/agent-decisions.tsx'
import { InspectorCard } from '../ui/layout.tsx'
import { SelectField } from '../ui/controls.tsx'
import { lastRead, rememberRead } from './last-read.ts'

type Usage = ReturnType<ChatSessions['contextUsage']>
type TeamUsage = ReturnType<ChatSessions['teamContext']>
type Localize = (en: string, zh: string) => string
type LoadUsage = (id: string, signal: AbortSignal) => Promise<Usage>
const readings = 'roppo.chat.context-usage'

function measured(data?: Usage): data is Usage {
  return !!data && (data.inputTokens != null || data.capacity != null || !!data.composition || !!data.budget)
}

function previous(data?: Usage): Usage | undefined {
  return measured(data) ? {...data, previous: true} : undefined
}

export function useCurrentContext(conversationId: string | null, turnId: string | undefined,
  model: string | undefined, backend: string | undefined, callId: string | undefined,
  usageRevision: number | undefined, watch: boolean, load: LoadUsage, refresh = 0): CurrentContext {
  const revision = JSON.stringify([turnId, backend, model, callId, usageRevision])
  const saved = useMemo(() => conversationId ? lastRead<Usage>(readings, conversationId) : undefined, [conversationId])
  const [snapshot, setSnapshot] = useState<{ id: string; revision: string; data?: Usage; failed?: boolean }>()
  useEffect(() => {
    if (!conversationId) return
    const id = conversationId
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function read() {
      let refreshIn = watch ? 4000 : 0
      try {
        const data = await load(id, controller.signal)
        if (controller.signal.aborted) return
        if (measured(data)) {
          // Preserve aggregate counts across reloads. File names come from the live detail response.
          rememberRead(readings, id, {...data, composition: data.composition ? {...data.composition, files: []} : null})
          setSnapshot({ id, revision, data })
        } else {
          setSnapshot(last => ({ id, revision, data: previous(last?.id === id ? last.data : undefined) ?? previous(saved) ?? data }))
        }
      } catch {
        if (controller.signal.aborted) return
        setSnapshot(last => ({id, revision, failed: true,
          data: previous(last?.id === id ? last.data : undefined) ?? previous(saved)}))
        refreshIn = 8000
      }
      if (refreshIn && !controller.signal.aborted) timer = setTimeout(read, refreshIn)
    }
    void read()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [revision, conversationId, watch, load, refresh, saved])
  if (!conversationId) return { empty: true }
  if (snapshot?.id !== conversationId) return {data: previous(saved)}
  return snapshot.revision !== revision && measured(snapshot.data)
    ? { ...snapshot, data: previous(snapshot.data) } : snapshot
}

export type CurrentContext = { data?: Usage; failed?: boolean; empty?: boolean }

export function ContextCard({ current, L, focusOnReveal, onClose, loadTeam, teamRevision, workerLabel, taskLabel }: {
  current: CurrentContext
  L: Localize
  focusOnReveal: boolean
  onClose: () => void
  loadTeam?: (signal: AbortSignal) => Promise<TeamUsage>
  teamRevision?: string
  workerLabel?: (id: string) => string | undefined
  taskLabel?: (id: string) => string | undefined
}) {
  const usage = current.data
  const [team, setTeam] = useState<TeamUsage>([])
  const [teamFailed, setTeamFailed] = useState(false)
  const [agent, setAgent] = useState('')
  useEffect(() => {
    if (!loadTeam) return
    const controller = new AbortController()
    loadTeam(controller.signal).then(rows => {
      if (controller.signal.aborted) return
      setTeam(rows)
      setTeamFailed(false)
    }, () => {
      if (!controller.signal.aborted) setTeamFailed(true)
    })
    return () => controller.abort()
  }, [loadTeam, teamRevision])
  const workers = team.filter(row => row.role === 'worker' && row.workerId)
  const workerIds = [...new Set(workers.map(row => row.workerId!))]
  const selectedWorker = workerIds.includes(agent) ? agent : ''
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (focusOnReveal) closeButton.current?.focus({ preventScroll: true })
  }, [focusOnReveal])
  const modelWindow = L('Model window', '模型窗口')
  const hostBudget = L('Host context budget', '宿主上下文预算')
  const count = usage?.inputTokens
  const budget = usage?.budget
  const composition = usage?.composition
  const breakdown = L('Chat input composition', '对话输入构成')
  const units = L('bytes','字节')
  let status = ''
  if (current.failed) status = usage
    ? L('Couldn’t refresh usage', '暂时无法刷新用量')
    : L('Usage unavailable', '暂时无法读取用量')
  else if (count == null && (composition || usage?.capacity != null)) status = L('Model token count not reported yet', '模型尚未上报 token 数')
  else if (current.empty || (usage && count == null && !budget)) status = L('No usage reported yet', '暂无用量记录')
  else if (!usage) status = L('Loading…', '读取中…')

  return (
    <InspectorCard title={L('Context usage', '上下文用量')} action={
      <button type="button" ref={closeButton} className="rp-icon-button" onClick={onClose}
        aria-label={L('Close context usage', '关闭上下文用量')}><X size={15} /></button>
    }>
      {!!workerIds.length && <label className="context-agent-select">
        <span>{L('Agent', '智能体')}</span>
        <SelectField label={L('Agent', '智能体')} value={selectedWorker} onChange={event => setAgent(event.currentTarget.value)}>
          <option value="">Router</option>
          {workerIds.map(id => <option key={id} value={id}>{workerLabel?.(id) ?? id}</option>)}
        </SelectField>
      </label>}
      {teamFailed && <p className="usage-note" role="status">{L('Could not refresh Worker usage.', '暂时无法刷新 Worker 用量。')}</p>}
      {selectedWorker ? workers.filter(row => row.workerId === selectedWorker).map(row => {
        const title = (row.ticketId && taskLabel?.(row.ticketId)) || modelWindow
        return <section className="usage-section" aria-label={title} key={row.activity}>
          <h4>{title}</h4>
          {row.inputTokens != null
            ? <ContextWindow label={title} capacity={row.capacity} L={L} legend={false}
              parts={[{id:'input',label:L('Reported model input','模型上报的输入'),tokens:row.inputTokens}]}/>
            : <p className="usage-note">{row.capacity != null ? '— / ' + row.capacity.toLocaleString(L('en','zh-CN')) + ' tokens'
              : L('Model token count not reported yet', '模型尚未上报 token 数')}</p>}
          {row.inputTokens != null && row.capacity == null && <p className="usage-note">{L('Window capacity not reported', '模型未提供窗口容量')}</p>}
          {row.model && <dl className="usage-model"><dt>{L('Model', '模型')}</dt><dd>{row.model}</dd></dl>}
        </section>
      }) : <>
      {usage?.previous && <p className="usage-note">{L('Showing the last recorded usage', '显示上次用量记录')}</p>}
      {status && <p className="usage-note" role="status">{status}</p>}
      {usage && (count != null || usage.capacity != null) && (
        <section className="usage-section" aria-label={modelWindow}>
          <h4>{modelWindow}</h4>
          {count != null ? <ContextWindow label={modelWindow} capacity={usage.capacity} L={L} legend={!composition}
            parts={[{ id: 'input', label: L('Reported model input', '模型上报的输入'), tokens: count }]} />
            : <div className="rp-capacity">— / {usage.capacity?.toLocaleString(L('en','zh-CN'))} tokens</div>}
          {usage.capacity == null && <p className="usage-note">{L('Window capacity not reported', '模型未提供窗口容量')}</p>}
          {usage.model && <dl className="usage-model"><dt>{L('Model', '模型')}</dt><dd>{usage.model}</dd></dl>}
        </section>
      )}
      {composition && <section className="usage-section" aria-label={breakdown}>
        <h4 className="usage-breakdown-heading">{breakdown}<span>{units}</span></h4>
        <ContextWindow view="composition" capacity={null} label={breakdown} L={L} unit={units} parts={[
          {id:'system',label:L('System instructions','系统提示'),tokens:composition.system},
          {id:'tools',label:L('Tool definitions','工具定义'),tokens:composition.tools},
          {id:'attachments',label:L('Attachment references','附件引用'),tokens:composition.attachments,
            files:composition.files.map(f=>({id:f.id,name:f.name,tokens:f.bytes}))},
          {id:'conversation',label:L('Conversation & task data','对话与任务信息'),tokens:composition.conversation},
          {id:'memory',label:L('Memory','记忆'),tokens:composition.memory},
        ]} />
      </section>}
      {(count != null || budget) && !composition && <p className="usage-note">{L('This turn has no recorded input breakdown.', '这轮未记录分类明细。')}</p>}
      {budget && (
        <section className="usage-section" aria-label={hostBudget}>
          <h4>{hostBudget}</h4>
          <ContextWindow label={hostBudget} capacity={budget.maxBytes} unit={L('bytes','字节')} L={L}
            parts={[
              { id: 'request', label: L('Request', '请求'), tokens: budget.bytes },
              { id: 'reserved', label: L('Reserved', '预留'), tokens: budget.reservedBytes },
            ]} />
        </section>
      )}
      </>}
    </InspectorCard>
  )
}
