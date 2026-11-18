import { useEffect, useId, useRef, useState, type ComponentProps, type RefObject } from 'react'
import { ComposerPrimitive, useAui } from '@assistant-ui/react'
import { ChartNoAxesColumn, ChevronRight } from 'lucide-react'

type L = (en: string, zh: string) => string
const commands = [
  {
    id: 'context',
    title: (L: L) => L('Context usage', '上下文用量'),
    Icon: ChartNoAxesColumn,
  },
] as const
export type ChatCommand = (typeof commands)[number]['id']

export function CommandInput({
  visible,
  L,
  onCommand,
  consume,
  ...input
}: ComponentProps<typeof ComposerPrimitive.Input> & {
  visible: boolean
  L: L
  onCommand: (command: ChatCommand) => void
  consume: RefObject<(() => boolean) | null>
}) {
  const aui = useAui(),
    wrap = useRef<HTMLDivElement>(null),
    listId = useId()
  const [query, setQuery] = useState<string | null>(null),
    [index, setIndex] = useState(0)
  const matches =
    query === null ? [] : commands.filter((c) => c.id.startsWith(query) || c.title(L).includes(query))
  const menu = visible && matches.length > 0
  function close() {
    setQuery(null)
  }
  useEffect(() => {
    if (!visible) close()
  }, [visible])
  useEffect(() => {
    if (!menu) return
    const dismiss = (event: PointerEvent) => {
      if (
        !wrap.current?.contains(event.target as Node) &&
        !(event.target as Element).closest('.send-button')
      )
        close()
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [menu])
  function choose(command: ChatCommand) {
    aui.composer.setText('')
    setQuery(null)
    wrap.current?.querySelector('textarea')?.focus()
    onCommand(command)
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
  }, [consume, menu, index, query, onCommand])
  return (
    <div
      className="command-input"
      ref={wrap}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && menu && !event.nativeEvent.isComposing) {
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
              <span>/{c.id}</span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
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
