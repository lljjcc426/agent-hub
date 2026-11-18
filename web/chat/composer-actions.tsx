import { useImperativeHandle, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ComposerPrimitive } from '@assistant-ui/react'
import { Check, Plus, ShieldCheck, Shield, ChevronRight } from 'lucide-react'
import { commands, type ChatCommand } from './composer-commands.tsx'
import { RouterModelControl } from './router-model.tsx'
import { spaceRequest, type ChatSpace } from './chat-settings.tsx'

type Props = {
  actions: RefObject<((command: ChatCommand) => void) | null>
  L: (en: string, zh: string) => string
  mode: ChatSpace['approvalMode']
  uploadDisabled: boolean
  modelBusy: boolean
  onContext: () => void
  onModelSaved: () => Promise<void>
  onModeSaved: () => Promise<void>
}
export function ComposerActions({
  actions,
  L,
  mode,
  uploadDisabled,
  modelBusy,
  onContext,
  onModeSaved,
  onModelSaved,
}: Props) {
  const anchor = useRef<HTMLButtonElement>(null),
    upload = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<'menu' | 'permissions' | 'model' | null>(null)
  const [saving, setSaving] = useState(false),
    [failed, setFailed] = useState(false)
  const visible = view === 'menu' || view === 'permissions'
  function choose(command: ChatCommand) {
    setFailed(false)
    if (command === 'model' || command === 'permissions') {
      setView(command)
      return
    }
    menu.current?.hidePopover()
    setView(null)
    if (command === 'context') onContext()
    if (command === 'attach' && !uploadDisabled) upload.current?.click()
  }
  useImperativeHandle(actions, () => choose)
  useLayoutEffect(() => {
    const popup = menu.current
    if (!popup) return
    if (!visible) {
      popup.hidePopover()
      return
    }
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect()
      if (rect) {
        popup.style.left = Math.max(10, Math.min(rect.left, innerWidth - popup.offsetWidth - 10)) + 'px'
        popup.style.bottom = innerHeight - rect.top + 8 + 'px'
      }
    }
    popup.showPopover()
    place()
    const active = popup.querySelector<HTMLButtonElement>('button[aria-checked="true"],button:not(:disabled)')
    if (view === 'permissions') popup.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    else active?.focus()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [visible, view])
  async function change(next: ChatSpace['approvalMode']) {
    if (saving) return
    setSaving(true)
    setFailed(false)
    try {
      if (mode !== next) {
        await spaceRequest({ approvalMode: next }, 'PATCH')
        await onModeSaved()
      }
      setView(null)
      anchor.current?.focus()
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  const choices = [
    { id: 'ask', title: L('Request approval', '请求批准'), Icon: ShieldCheck },
    { id: 'full', title: L('Full access', '完全访问权限'), Icon: Shield },
  ] as const
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="icon-button composer-plus"
        aria-label={L('Chat actions', '对话操作')}
        aria-haspopup="menu"
        aria-expanded={visible}
        onClick={() => setView(visible ? null : 'menu')}
      >
        <Plus size={19} />
      </button>
      <ComposerPrimitive.AddAttachment
        ref={upload}
        hidden
        tabIndex={-1}
        disabled={uploadDisabled}
        aria-label={L('Attach files', '上传文件')}
      />
      {createPortal(
        <div
          ref={menu}
          popover="auto"
          className="roppo-ui composer-action-popover"
          role="menu"
          aria-label={
            view === 'permissions' ? L('Approval policy', '审批策略') : L('Chat actions', '对话操作')
          }
          onToggle={(e) => {
            if (e.newState === 'closed')
              setView((current) => (current === 'menu' || current === 'permissions' ? null : current))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setView(null)
              anchor.current?.focus()
              return
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
            e.preventDefault()
            const buttons = Array.from(
              e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
            )
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            const next =
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? buttons.length - 1
                  : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            buttons[next]?.focus()
          }}
        >
          {view === 'permissions'
            ? choices.map(({ id, title, Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={id === mode}
                  disabled={saving}
                  onClick={() => void change(id)}
                >
                  <Icon size={16} />
                  <span>{title}</span>
                  {id === mode && <Check size={15} />}
                </button>
              ))
            : commands.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitem"
                  disabled={c.id === 'attach' && uploadDisabled}
                  onClick={() => choose(c.id)}
                >
                  <c.Icon size={16} />
                  <span>{c.title(L)}</span>
                  {c.id === 'permissions' ? <small>{choices.find((x) => x.id === mode)?.title}</small> : null}
                  {['model', 'permissions'].includes(c.id) && <ChevronRight size={13} />}
                </button>
              ))}
          {failed && <div role="alert">{L('Could not save. Try again.', '保存失败，请重试。')}</div>}
        </div>,
        document.body
      )}
      <RouterModelControl
        anchor={anchor}
        shown={view === 'model'}
        onClose={() => setView((v) => (v === 'model' ? null : v))}
        busy={modelBusy}
        L={L}
        onSaved={onModelSaved}
      />
    </>
  )
}
