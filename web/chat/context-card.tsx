import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { ChatSessions } from '../../src/chat.ts'
import { ContextWindow } from '../ui/agent-decisions.tsx'
import { InspectorCard } from '../ui/layout.tsx'
import { Disclosure } from '../ui/overlays.tsx'

type Usage = ReturnType<ChatSessions['contextUsage']>
type Localize = (en: string, zh: string) => string
type LoadUsage = (id: string, signal: AbortSignal, activity?: string) => Promise<Usage>

export function ContextCard({ conversationId, load, L, focusOnReveal, onClose }: {
  conversationId: string | null
  load: LoadUsage
  L: Localize
  focusOnReveal: boolean
  onClose: () => void
}) {
  const [trail, setTrail] = useState<string[]>([])
  const selected = trail.at(-1)
  const [snapshot, setSnapshot] = useState<{ selected?: string; data: Usage } | null>(null)
  const [failure, setFailure] = useState<{ selected?: string } | null>(null)
  const usage = snapshot && snapshot.selected === selected ? snapshot.data : null
  const failed = !!failure && failure.selected === selected
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (focusOnReveal) closeButton.current?.focus({ preventScroll: true })
  }, [focusOnReveal])
  useEffect(() => {
    if (!conversationId) return
    const id = conversationId
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function read() {
      try {
        const data = await load(id, controller.signal, selected)
        if (!controller.signal.aborted) {
          setSnapshot({selected, data})
          setFailure(null)
        }
      } catch {
        if (!controller.signal.aborted) setFailure({selected})
      }
      if (!controller.signal.aborted && !selected) timer = setTimeout(read, 4000)
    }
    void read()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [conversationId, load, selected])
  const modelWindow = L('Model window', '模型窗口')
  const hostBudget = L('Host context budget', '宿主上下文预算')
  const count = usage?.inputTokens
  const budget = usage?.budget
  const composition = usage?.composition
  const locale = L('en', 'zh-CN')
  const breakdown = L('Router input composition', 'Router 输入构成')
  const units = L('bytes','字节')
  let status = ''
  if (failed) status = usage
    ? L('Couldn’t refresh usage', '暂时无法刷新用量')
    : L('Usage unavailable', '暂时无法读取用量')
  else if (!conversationId || (usage && count == null && !budget && !composition)) status = L('No usage reported yet', '暂无用量记录')
  else if (composition && count == null) status = L('Model token count not reported yet', '模型尚未上报 token 数')
  else if (!usage) status = L('Loading…', '读取中…')

  return (
    <InspectorCard title={L('Context usage', '上下文用量')} action={
      <button type="button" ref={closeButton} className="rp-icon-button" onClick={onClose}
        aria-label={L('Close context usage', '关闭上下文用量')}><X size={15} /></button>
    }>
      {(usage?.previous || selected) && <nav className="usage-history" aria-label={L('Input history','输入历史')}>
        <button type="button" className="rp-icon-button" aria-label={L('Older turn','上一轮')}
          disabled={!usage?.previous} onClick={() => {if (usage?.previous) setTrail([...trail,usage.previous])}}><ChevronLeft size={15}/></button>
        <span>{selected ? L('Earlier turn','历史轮次') : L('Latest turn','最近一轮')}
          {usage?.at && <time dateTime={new Date(usage.at).toISOString()}>{new Intl.DateTimeFormat(locale,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(usage.at)}</time>}
        </span>
        <button type="button" className="rp-icon-button" aria-label={trail.length > 1 ? L('Newer turn','下一轮') : L('Latest turn','最近一轮')}
          disabled={!selected} onClick={() => setTrail(trail.slice(0,-1))}><ChevronRight size={15}/></button>
      </nav>}
      {status && <p className="usage-note" role="status">{status}</p>}
      {usage && count != null && (
        <section className="usage-section" aria-label={modelWindow}>
          <h4>{modelWindow}</h4>
          <ContextWindow label={modelWindow} capacity={usage.capacity} L={L} legend={!composition}
            parts={[{ id: 'input', label: L('Reported model input', '模型上报的输入'), tokens: count }]} />
          {usage.capacity == null && <p className="usage-note">{L('Window capacity not reported', '模型未提供窗口容量')}</p>}
          {usage.model && <dl className="usage-model"><dt>{L('Model', '模型')}</dt><dd>{usage.model}</dd></dl>}
          {usage.modelInputs?.length > 1 && <Disclosure title={L('Model calls', '本轮模型调用')+' · '+usage.modelInputs.length}>
            <ol className="usage-steps">{usage.modelInputs.map((tokens,i)=><li key={i}>
              <span>{L('Call ', '调用 ')+(i+1)}</span><b>{tokens.toLocaleString(locale)} tokens</b>
            </li>)}</ol>
          </Disclosure>}
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
      {usage?.activity && !composition && <p className="usage-note">{L('This turn has no recorded input breakdown.', '这轮未记录分类明细。')}</p>}
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
