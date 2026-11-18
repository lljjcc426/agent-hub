import { useEffect, useId, useRef, useState, type ComponentProps, type RefObject } from 'react'
import { ComposerPrimitive, useAui } from '@assistant-ui/react'
import { ChartNoAxesColumn, ChevronRight, X } from 'lucide-react'
import type { ChatSessions } from '../../src/chat.ts'
import { ContextWindow } from '../ui/agent-decisions.tsx'

type L = (en: string, zh: string) => string
type Usage = ReturnType<ChatSessions['contextUsage']>
type LoadUsage = (id: string, signal: AbortSignal) => Promise<Usage>
type CommandProps = { conversationId: string | null; L: L; load: LoadUsage }
function useUsage({ conversationId, L, load }: CommandProps) {
  const [usage, setUsage] = useState<Usage | null>(null),
    [failed, setFailed] = useState(false)
  useEffect(() => {
    setUsage(null)
    setFailed(false)
    if (!conversationId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function read() {
      try {
        const data = await load(conversationId!, controller.signal)
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
  const status = failed
    ? L('Usage unavailable', '暂时无法读取用量')
    : !conversationId || (usage && usage.inputTokens == null && !usage.budget)
      ? L('No usage reported yet', '暂无用量记录')
      : !usage
        ? L('Loading…', '读取中…')
        : ''
  return { usage, status }
}
function UsagePreview(props: CommandProps) {
  const { usage } = useUsage(props)
  return <>{usage?.inputTokens != null ? usage.inputTokens.toLocaleString() + ' tokens' : '/context'}</>
}
function UsageDetails(props: CommandProps) {
  const { L } = props,
    { usage, status } = useUsage(props),
    count = usage?.inputTokens
  return (
    <>
      {status && <p role="status">{status}</p>}
      {count != null && usage && (
        <ContextWindow
          L={L}
          capacity={usage.capacity}
          parts={[{ id: 'input', label: L('Last model input', '最近一次模型输入'), tokens: count }]}
        />
      )}
      {usage?.budget && (
        <details className="budget-details" open={count == null || undefined}>
          <summary>{L('Host context budget', '宿主上下文预算')}</summary>
          <ContextWindow
            L={L}
            capacity={usage.budget.maxBytes}
            unit={L('bytes', '字节')}
            parts={[
              { id: 'request', label: L('Request', '请求'), tokens: usage.budget.bytes },
              { id: 'reserved', label: L('Reserved', '预留'), tokens: usage.budget.reservedBytes },
            ]}
          />
        </details>
      )}
    </>
  )
}
// A command owns its preview, data source and expanded view. Typing ordinary text mounts none of them.
const commands = [
  {
    id: 'context',
    title: (L: L) => L('Context usage', '上下文用量'),
    Icon: ChartNoAxesColumn,
    Preview: UsagePreview,
    Panel: UsageDetails,
  },
] as const
type Command = (typeof commands)[number]['id']

export function CommandInput({
  conversationId: id,
  visible,
  L,
  load,
  consume,
  ...input
}: ComponentProps<typeof ComposerPrimitive.Input> & {
  conversationId: string | null
  visible: boolean
  L: L
  load: (id: string, signal: AbortSignal) => Promise<Usage>
  consume: RefObject<(() => boolean) | null>
}) {
  const aui = useAui(),
    wrap = useRef<HTMLDivElement>(null),
    listId = useId()
  const [query, setQuery] = useState<string | null>(null),
    [chosen, setChosen] = useState<Command | null>(null),
    [index, setIndex] = useState(0)
  const matches =
    query === null ? [] : commands.filter((c) => c.id.startsWith(query) || c.title(L).includes(query))
  const menu = visible && matches.length > 0,
    open = visible && (menu || chosen !== null)
  function close() {
    setQuery(null)
    setChosen(null)
  }
  useEffect(() => {
    close()
  }, [id, visible])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (
        !wrap.current?.contains(event.target as Node) &&
        !(event.target as Element).closest('.send-button')
      )
        close()
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [open])
  function choose(command: Command) {
    aui.composer.setText('')
    setQuery(null)
    setChosen(command)
    wrap.current?.querySelector('textarea')?.focus()
  }
  const consumeChoice = () => {
    const c = matches[index]
    if (menu && c) {
      choose(c.id)
      return true
    }
    return false
  }
  useEffect(() => {
    consume.current = consumeChoice
    return () => {
      consume.current = null
    }
  }, [consume, menu, index, query])
  const selected = commands.find((c) => c.id === chosen),
    props = { conversationId: id, L, load }
  return (
    <div
      className="command-input"
      ref={wrap}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          close()
          wrap.current?.querySelector('textarea')?.focus()
        }
      }}
    >
      {menu && (
        <div
          className="roppo-ui slash-surface"
          id={listId}
          role="listbox"
          aria-label={L('Chat commands', 'Chat 命令')}
        >
          {matches.map((c, i) => (
            <button
              type="button"
              role="option"
              key={c.id}
              id={listId + '-' + i}
              aria-selected={i === index}
              tabIndex={-1}
              onPointerMove={() => setIndex(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(c.id)}
            >
              <c.Icon size={17} />
              <strong>{c.title(L)}</strong>
              <span>
                <c.Preview {...props} />
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
      )}
      {visible && selected && (
        <section
          className="roppo-ui slash-surface context-panel"
          role="region"
          aria-label={selected.title(L)}
        >
          <header>
            <strong>{selected.title(L)}</strong>
            <button
              type="button"
              className="rp-icon-button"
              aria-label={L('Close', '关闭')}
              onClick={() => {
                close()
                wrap.current?.querySelector('textarea')?.focus()
              }}
            >
              <X size={15} />
            </button>
          </header>
          <selected.Panel {...props} />
        </section>
      )}
      <ComposerPrimitive.Input
        {...input}
        role={menu ? 'combobox' : undefined}
        aria-autocomplete={menu ? 'list' : undefined}
        aria-expanded={menu || undefined}
        aria-controls={menu ? listId : undefined}
        aria-activedescendant={menu ? listId + '-' + index : undefined}
        onInput={(event) => {
          if ((event.nativeEvent as InputEvent).isComposing) return
          const text = event.currentTarget.value
          setChosen(null)
          setQuery(/^\/[^\s/]*$/u.test(text) ? text.slice(1).toLowerCase() : null)
          setIndex(0)
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (menu && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault()
            setIndex((index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length)
            return
          }
          if (menu && event.key === 'Enter' && !event.shiftKey && consumeChoice()) {
            event.preventDefault()
            return
          }
          input.onKeyDown?.(event)
        }}
      />
    </div>
  )
}
