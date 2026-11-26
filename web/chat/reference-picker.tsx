import { Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ChatQuoteView } from '../../src/chat-interactions.ts'
import { InputControl } from '../ui/controls.tsx'
import type { Localize } from './composer-commands.tsx'

export type LoadReferences = (query: string, signal: AbortSignal) => Promise<ChatQuoteView[]>

export function ReferencePicker({ load, choose, L }: {
  load: LoadReferences; choose: (reference: ChatQuoteView) => void; L: Localize
}) {
  const [query, setQuery] = useState('')
  const [response, setResponse] = useState<{ query: string; rows?: ChatQuoteView[] }>()
  const results = useRef<HTMLDivElement>(null)
  const current = response?.query === query ? response : undefined
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const rows = await load(query, controller.signal)
        if (!controller.signal.aborted) setResponse({ query, rows })
      } catch {
        if (!controller.signal.aborted) setResponse({ query })
      }
    }, query ? 150 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [load, query])
  const label = L('Search messages in this conversation', '搜索当前对话的消息')
  return <>
    <label className="palette-reference-search">
      <Search size={15} aria-hidden="true"/>
      <InputControl data-reference-search aria-label={label} placeholder={label}
        value={query} maxLength={200} onChange={event => setQuery(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'ArrowDown' && current?.rows?.length) {
            event.preventDefault()
            event.stopPropagation()
            results.current?.querySelector('button')?.focus()
          }
          if (event.key === 'Enter' && current?.rows?.[0]) {
            event.preventDefault()
            choose(current.rows[0])
          }
        }}/>
    </label>
    <div ref={results} role="menu" aria-label={L('Messages to reference', '可引用的消息')}>
      {current?.rows?.map(item => <button key={item.messageId} type="button" role="menuitem" className="palette-row palette-reference"
        onClick={() => choose(item)}>
        <span><strong>{item.role === 'user' ? L('You', '你') : item.label || 'Router'}</strong><small>{item.text}</small></span>
      </button>)}
    </div>
    {!current?.rows?.length && <p className="palette-empty" role="status">{!current ? L('Searching…', '正在搜索…')
      : !current.rows ? L('Could not load messages.', '暂时无法读取消息。') : L('No matching messages', '没有符合条件的消息')}</p>}
  </>
}
