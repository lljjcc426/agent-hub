import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ChatSessions } from '../../src/chat.ts'
import { ContextWindow } from '../ui/agent-decisions.tsx'
import { InspectorCard } from '../ui/layout.tsx'

type Usage = ReturnType<ChatSessions['contextUsage']>
type Localize = (en: string, zh: string) => string
type LoadUsage = (id: string, signal: AbortSignal) => Promise<Usage>

export function ContextCard({ conversationId, load, L, focusOnReveal, onClose }: {
  conversationId: string | null
  load: LoadUsage
  L: Localize
  focusOnReveal: boolean
  onClose: () => void
}) {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [failed, setFailed] = useState(false)
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
        const data = await load(id, controller.signal)
        if (!controller.signal.aborted) {
          setUsage(data)
          setFailed(false)
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      }
      if (!controller.signal.aborted) timer = setTimeout(read, 4000)
    }
    void read()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [conversationId, load])
  const modelWindow = L('Model window', '模型窗口')
  const hostBudget = L('Host context budget', '宿主上下文预算')
  const count = usage?.inputTokens
  const budget = usage?.budget
  let status = ''
  if (failed) status = usage
    ? L('Couldn’t refresh usage', '暂时无法刷新用量')
    : L('Usage unavailable', '暂时无法读取用量')
  else if (!conversationId || (usage && count == null && !budget)) status = L('No usage reported yet', '暂无用量记录')
  else if (!usage) status = L('Loading…', '读取中…')

  return (
    <InspectorCard title={L('Context usage', '上下文用量')} action={
      <button type="button" ref={closeButton} className="rp-icon-button" onClick={onClose}
        aria-label={L('Close context usage', '关闭上下文用量')}><X size={15} /></button>
    }>
      {status && <p className="usage-note" role="status">{status}</p>}
      {usage && count != null && (
        <section className="usage-section" aria-label={modelWindow}>
          <ContextWindow label={modelWindow} capacity={usage.capacity} L={L}
            parts={[{ id: 'input', label: L('Last model input', '最近一次模型输入'), tokens: count }]} />
          {usage.capacity == null && <p className="usage-note">{L('Window capacity not reported', '模型未提供窗口容量')}</p>}
          {usage.model && <dl className="usage-model"><dt>{L('Model', '模型')}</dt><dd>{usage.model}</dd></dl>}
        </section>
      )}
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
