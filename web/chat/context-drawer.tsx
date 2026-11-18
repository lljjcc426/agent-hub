import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ChatSessions } from '../../src/chat.ts'

type Usage = ReturnType<ChatSessions['contextUsage']>
type Localize = (en: string, zh: string) => string
type LoadUsage = (id: string, signal: AbortSignal) => Promise<Usage>

function UsageSection({ title, used, capacity, locale, rows }: {
  title: string
  used: number
  capacity: number | null
  locale: string
  rows: [string, string][]
}) {
  const heading = useId()
  const ratio = capacity !== null && capacity > 0 ? used / capacity : null
  const percent = ratio == null ? null : new Intl.NumberFormat(locale, {
    style: 'percent', maximumFractionDigits: 1,
  }).format(ratio)
  return (
    <section className="usage-section" aria-labelledby={heading}>
      <div className="usage-section-heading">
        <h3 id={heading}>{title}</h3>
        {percent !== null && <span>{percent}</span>}
      </div>
      {ratio !== null && capacity !== null && (
        <div className="usage-meter" role="meter" aria-labelledby={heading}
          aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={Math.min(used, capacity)}
          aria-valuetext={percent ?? undefined}>
          <i style={{ width: Math.min(ratio, 1) * 100 + '%' }} />
        </div>
      )}
      <dl>
        {rows.map(([label, value]) => (
          <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>
        ))}
      </dl>
    </section>
  )
}

export function ContextDrawer({ conversationId, load, L, overlay, onClose }: {
  conversationId: string | null
  load: LoadUsage
  L: Localize
  overlay: boolean
  onClose: () => void
}) {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [failed, setFailed] = useState(false)
  const heading = useId()
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (overlay) closeButton.current?.focus({ preventScroll: true })
  }, [overlay])
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
  const locale = L('en', 'zh-CN')
  const number = new Intl.NumberFormat(locale)
  const metric = (n: number, unit: string) => number.format(n) + ' ' + unit
  const bytes = L('bytes', '字节')
  const count = usage?.inputTokens
  const budget = usage?.budget
  let status = ''
  if (failed) status = usage
    ? L('Couldn’t refresh usage', '暂时无法刷新用量')
    : L('Usage unavailable', '暂时无法读取用量')
  else if (!conversationId || (usage && count == null && !budget)) status = L('No usage reported yet', '暂无用量记录')
  else if (!usage) status = L('Loading…', '读取中…')

  return (
    <aside id="session-panel" className="session-panel chat-inspector context-drawer" aria-labelledby={heading}>
      <header className="usage-header">
        <h2 id={heading}>{L('Context usage', '上下文用量')}</h2>
        <button type="button" ref={closeButton} className="icon-button" onClick={onClose}
          aria-label={L('Close context usage', '关闭上下文用量')}><X size={17} /></button>
      </header>
      <div className="usage-content">
        {status && <p role="status">{status}</p>}
        {usage && count != null && (
          <UsageSection title={L('Model window', '模型窗口')} used={count} capacity={usage.capacity} locale={locale}
            rows={[
              ...(usage.model ? [[L('Model', '模型'), usage.model] as [string, string]] : []),
              [L('Last model input', '最近一次模型输入'), metric(count, 'tokens')],
              [L('Window capacity', '窗口容量'), usage.capacity == null ? L('Not reported', '未提供') : metric(usage.capacity, 'tokens')],
            ]} />
        )}
        {budget && (
          <UsageSection title={L('Host context budget', '宿主上下文预算')} used={budget.bytes + budget.reservedBytes} capacity={budget.maxBytes} locale={locale}
            rows={[
              [L('Request', '请求'), metric(budget.bytes, bytes)],
              [L('Reserved', '预留'), metric(budget.reservedBytes, bytes)],
              [L('Budget limit', '预算上限'), metric(budget.maxBytes, bytes)],
            ]} />
        )}
      </div>
    </aside>
  )
}
