import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ChatSessions } from '../../src/chat.ts'
import { ContextWindow } from '../ui/agent-decisions.tsx'
import { InspectorCard } from '../ui/layout.tsx'

type Usage = ReturnType<ChatSessions['contextUsage']>
type Localize = (en: string, zh: string) => string
type LoadUsage = (id: string, signal: AbortSignal) => Promise<Usage>

export function useCurrentContext(conversationId: string | null, turnId: string | undefined,
  model: string | undefined, backend: string | undefined, callId: string | undefined,
  usageRevision: number | undefined, watch: boolean, load: LoadUsage): CurrentContext {
  const key = JSON.stringify([conversationId, backend, model])
  const revision = JSON.stringify([turnId, callId, usageRevision])
  const [snapshot, setSnapshot] = useState<{ key: string; revision: string; data?: Usage; failed?: boolean }>()
  useEffect(() => {
    if (!conversationId) return
    const id = conversationId
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function read() {
      let refreshIn = watch ? 4000 : 0
      try {
        const data = await load(id, controller.signal)
        if (!controller.signal.aborted) setSnapshot({ key, revision, data })
      } catch {
        if (!controller.signal.aborted) setSnapshot(last => last?.key === key
          ? { ...last, failed: true } : { key, revision, failed: true })
        refreshIn = 8000
      }
      if (refreshIn && !controller.signal.aborted) timer = setTimeout(read, refreshIn)
    }
    void read()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [key, revision, conversationId, watch, load])
  if (!conversationId) return { empty: true }
  if (snapshot?.key !== key) return {}
  const data = snapshot.data
  return data && (data.inputTokens != null || data.composition || data.budget) && snapshot.revision !== revision
    ? { ...snapshot, data: { ...data, previous: true } } : snapshot
}

export type CurrentContext = { data?: Usage; failed?: boolean; empty?: boolean }

export function ContextCard({ current, L, focusOnReveal, onClose }: {
  current: CurrentContext
  L: Localize
  focusOnReveal: boolean
  onClose: () => void
}) {
  const usage = current.data
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
  else if (current.empty || (usage && count == null && !budget && !composition)) status = L('No usage reported yet', '暂无用量记录')
  else if (composition && count == null) status = L('Model token count not reported yet', '模型尚未上报 token 数')
  else if (!usage) status = L('Loading…', '读取中…')

  return (
    <InspectorCard title={L('Context usage', '上下文用量')} action={
      <button type="button" ref={closeButton} className="rp-icon-button" onClick={onClose}
        aria-label={L('Close context usage', '关闭上下文用量')}><X size={15} /></button>
    }>
      {usage?.previous && <p className="usage-note">{L('Showing the last recorded usage', '显示上次用量记录')}</p>}
      {status && <p className="usage-note" role="status">{status}</p>}
      {usage && count != null && (
        <section className="usage-section" aria-label={modelWindow}>
          <h4>{modelWindow}</h4>
          <ContextWindow label={modelWindow} capacity={usage.capacity} L={L} legend={!composition}
            parts={[{ id: 'input', label: L('Reported model input', '模型上报的输入'), tokens: count }]} />
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
    </InspectorCard>
  )
}
