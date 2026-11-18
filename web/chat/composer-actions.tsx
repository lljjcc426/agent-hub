import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react'
import { ArrowLeft, ArrowUp, LoaderCircle, Plus, ShieldCheck, ShieldOff, SlidersHorizontal } from 'lucide-react'
import { ApprovalOptions, approvalLabel, commands, matchingCommands, CommandList, ContextOverview, UsageRing, windowReadout,
  type ChatCommand, type Localize, type Mode } from './composer-commands.tsx'
import { RouterModelOptions } from './router-model.tsx'
import type { CurrentContext } from './context-card.tsx'
import { finishLayerExit } from '../ui/overlays.tsx'
import './composer-controls.css'

type Subpage = Exclude<ChatCommand, 'attach'>
type Source = Subpage | 'slash' | 'plus'
type Menu = { source: Source; page: Subpage | 'commands'; query: string }

function SendMessage({ sending, L, onClick }: { sending: boolean; L: Localize; onClick: () => void }) {
  const canSend = useAuiState(s => !s.thread.isDisabled && s.composer.canSend)
  return <button type="button" className="send-button" disabled={!canSend}
    aria-label={L('Send message', '发送消息')} onClick={onClick}>
    {sending ? <LoaderCircle size={18} className="spin"/> : <ArrowUp size={20}/>}
  </button>
}

type Props = {
  L: Localize; visible: boolean; sending: boolean; mode?: Mode; usage: CurrentContext
  router: string; model?: string; modelBusy: boolean; uploadDisabled: boolean
  onContext: () => void; saveMode: (next: Mode) => Promise<void>; onModelSaved: () => Promise<void>
  onEnter: (text: string) => void
}
export function ComposerControls({ L, visible, sending, mode, usage, router, model, modelBusy, uploadDisabled,
  onContext, saveMode, onModelSaved, onEnter }: Props) {
  const aui = useAui(), listId = useId(), paletteId = useId()
  const input = useRef<HTMLTextAreaElement>(null), upload = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement>(null), palette = useRef<HTMLDivElement>(null), paletteBody = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<Menu | null>(null), [index, setIndex] = useState(0)
  const [closing, setClosing] = useState(false)
  const current = useRef(menu)
  current.current = menu
  const source = visible ? menu?.source : undefined
  const open = !!source
  const page = visible ? menu?.page : undefined
  const slashList = source === 'slash' && page === 'commands'
  const slash = slashList && !closing
  const nested = page !== 'commands' && (source === 'slash' || source === 'plus')
  const items = matchingCommands(menu?.query ?? '', L)
  const readout = windowReadout(usage, L)
  const modelLabel = model || L('Model', '模型')
  const policyGroup = L('Approval policy', '审批策略')
  const policyLabel = mode ? approvalLabel(mode, L) : policyGroup
  const policyTitle = mode ? policyGroup + ' · ' + policyLabel : policyGroup
  const contextTitle = L('Context usage', '上下文用量') + ' · ' + readout.label
  const PolicyIcon = mode === 'full' ? ShieldOff : ShieldCheck
  const title = commands.find(c => c.id === page)?.title(L)

  function show(next: Menu) {
    setClosing(false)
    setMenu(next)
  }
  function close(focus = true) {
    setClosing(true)
    if (focus) opener.current?.focus({ preventScroll: true })
  }
  function finish() {
    if (current.current === menu) close()
  }
  function back() {
    if (!nested || !menu) { close(); return }
    if (source === 'slash') aui.composer.setText('/' + menu.query)
    show({ ...menu, page: 'commands' })
  }
  function shortcut(next: Exclude<Source, 'slash'>, trigger: HTMLElement) {
    if (!closing && source === next) { close(); return }
    if (slash) aui.composer.setText('')
    opener.current = trigger
    setIndex(0)
    show({ source: next, page: next === 'plus' ? 'commands' : next, query: '' })
  }
  function updateQuery(text: string) {
    const query = /^\/[^\s/]*$/u.test(text) ? text.slice(1).toLowerCase() : null
    if (query === null || !matchingCommands(query, L).length) {
      if (menu) close(false)
      return
    }
    opener.current = input.current
    setIndex(0)
    show({ source: 'slash', page: 'commands', query })
  }
  function choose(command: ChatCommand) {
    if (!menu || (command === 'attach' && uploadDisabled)) return
    if (slash) aui.composer.setText('')
    if (command === 'attach') {
      close()
      upload.current?.click()
    } else show({ ...menu, page: command })
  }
  function moveInMenu(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      back()
      return
    }
    const target = event.target as Element
    if (page !== 'commands' && page !== 'permissions' && !(page === 'model' && target.closest('[role=menu]'))) return
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^=menuitem]:not(:disabled)'))
    if (!options.length) return
    event.preventDefault()
    const at = options.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 :
      (at + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
    options[next]?.focus()
  }

  useEffect(() => { if (!visible) setMenu(null) }, [visible])
  useLayoutEffect(() => {
    const panel = palette.current, body = paletteBody.current, form = input.current?.form
    if (!panel || !body || !form || !open) return
    panel.showPopover()
    const place = () => {
      const rect = form.getBoundingClientRect(), viewport = window.visualViewport
      const top = viewport?.offsetTop ?? 0, bottom = top + (viewport?.height ?? innerHeight)
      const left = viewport?.offsetLeft ?? 0, right = left + (viewport?.width ?? innerWidth)
      const width = Math.min(320, rect.width, right - left - 16)
      panel.style.width = width + 'px'
      panel.style.left = Math.max(left + 8, Math.min(rect.left, right - width - 8)) + 'px'
      const above = rect.top - top - 16, below = bottom - rect.bottom - 16
      const up = above >= 290 || above >= below
      panel.dataset.side = up ? 'above' : 'below'
      panel.style.top = up ? 'auto' : rect.bottom + 8 + 'px'
      panel.style.bottom = up ? innerHeight - rect.top + 8 + 'px' : 'auto'
      panel.style.maxHeight = Math.max(0, up ? above : below) + 'px'
    }
    function dismiss(event: Event) {
      const target = event.target
      if (!(target instanceof Element) || panel!.contains(target) || target.closest('[data-menu-trigger]')) return
      if (target === input.current && current.current?.source === 'slash' && current.current.page === 'commands') return
      if (target.closest('.send-button') && current.current?.source === 'slash' && current.current.page === 'commands') return
      setClosing(true)
    }
    place()
    panel.style.setProperty('--palette-height', body.offsetHeight + 'px')
    const observer = new ResizeObserver(entries => {
      if (entries.some(entry => entry.target === body)) panel.style.setProperty('--palette-height', body.offsetHeight + 'px')
      if (entries.some(entry => entry.target !== body)) place()
    })
    observer.observe(body)
    observer.observe(form)
    const area = form.closest('.composer-area')
    if (area) observer.observe(area)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('focusin', dismiss)
    return () => {
      panel.hidePopover()
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('focusin', dismiss)
    }
  }, [open])
  useLayoutEffect(() => {
    if (closing && palette.current) return finishLayerExit(palette.current, () => setMenu(null))
  }, [closing])
  useLayoutEffect(() => {
    const panel = palette.current
    if (!panel || !page || closing) return
    if (slash) { input.current?.focus({ preventScroll: true }); return }
    const target = panel.querySelector<HTMLElement>('[aria-checked=true], [role=menuitem]:not(:disabled), .palette-details') ?? panel
    target.focus({ preventScroll: true })
  }, [page, source, slash, closing])

  return <>
    <div className="command-input">
      <ComposerPrimitive.Input ref={input} className="composer-input" rows={1} maxLength={100000} submitMode="none"
        placeholder={L('Message ' + router + '…', '向 ' + router + ' 发送消息…')}
        aria-label={L('Message ' + router, '向 ' + router + ' 发送消息')}
        role={slash ? 'combobox' : undefined} aria-autocomplete={slash ? 'list' : undefined}
        aria-expanded={slash || undefined} aria-controls={slash ? listId : undefined}
        aria-activedescendant={slash ? listId + '-' + index : undefined}
        onInput={event => { if (!(event.nativeEvent as InputEvent).isComposing) updateQuery(event.currentTarget.value) }}
        onCompositionEnd={event => updateQuery(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (slash && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
          if (slash && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault()
            setIndex((index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
            return
          }
          if (event.key !== 'Enter' || event.shiftKey) return
          event.preventDefault()
          if (slash && items[index]) choose(items[index].id)
          else onEnter(event.currentTarget.value)
        }}/>
    </div>
    <div className="composer-toolbar">
      <button type="button" data-menu-trigger className="composer-plus icon-button" aria-label={L('Chat actions','对话操作')}
        title={L('Chat actions','对话操作')} aria-haspopup="menu" aria-expanded={!closing && source === 'plus'} aria-controls={source === 'plus' ? paletteId : undefined}
        onClick={e => shortcut('plus', e.currentTarget)}><Plus size={19}/></button>
      <ComposerPrimitive.AddAttachment ref={upload} hidden tabIndex={-1} disabled={uploadDisabled} aria-label={L('Attach files','上传文件')}/>
      <button type="button" data-menu-trigger className="composer-choice composer-model"
        aria-label={L('Model connection','模型连接') + ' · ' + modelLabel} title={L('Model connection','模型连接') + ' · ' + modelLabel}
        aria-haspopup="dialog" aria-expanded={!closing && source === 'model'} aria-controls={source === 'model' ? paletteId : undefined}
        onClick={e => shortcut('model', e.currentTarget)}><SlidersHorizontal size={15}/><span>{modelLabel}</span></button>
      <button type="button" data-menu-trigger className="composer-choice composer-policy" data-mode={mode}
        aria-label={policyTitle} title={policyTitle} aria-haspopup="menu" aria-expanded={!closing && source === 'permissions'}
        aria-controls={source === 'permissions' ? paletteId : undefined} onClick={e => shortcut('permissions', e.currentTarget)}>
        <PolicyIcon size={15}/><span>{policyLabel}</span>
      </button>
      <div className="send-actions">
        <button type="button" data-menu-trigger className="icon-button composer-context" aria-label={contextTitle}
          title={[contextTitle, readout.tokens].filter(Boolean).join(' · ')}
          aria-haspopup="dialog" aria-expanded={!closing && source === 'context'} aria-controls={source === 'context' ? paletteId : undefined}
          onClick={e => shortcut('context', e.currentTarget)}><UsageRing fraction={readout.fraction}/></button>
        <SendMessage sending={sending} L={L} onClick={() => {
          if (slash && items[index]) choose(items[index].id)
          else aui.composer.send()
        }}/>
      </div>
    </div>
    {source && page && createPortal(
      <div ref={palette} id={paletteId} popover="manual" tabIndex={-1} className="roppo-ui composer-palette"
        data-closing={closing ? '' : undefined} inert={closing} aria-hidden={closing || undefined}
        role={page === 'model' || page === 'context' ? 'dialog' : undefined}
        aria-label={page === 'model' ? L('Chat model','对话模型') : title} onKeyDown={moveInMenu}>
        <div ref={paletteBody} className="palette-body"><div key={page} className="palette-page" data-page={page}>
          {(page === 'permissions' || page === 'context') && <div className="palette-heading">
            {nested && <button type="button" aria-label={L('Back to chat actions','返回对话操作')} onClick={back}><ArrowLeft size={16}/></button>}
            <strong>{page === 'permissions' ? L('How should Roppo ask for approval?', 'Roppo 应如何请求批准？') : title}</strong>
          </div>}
          {page === 'commands' && <CommandList items={items} slash={slashList} listId={listId} active={index}
            uploadDisabled={uploadDisabled} mode={mode} L={L} onHighlight={setIndex} onChoose={choose}/>}
          {page === 'permissions' && <ApprovalOptions mode={mode} L={L} onSave={saveMode} onClose={finish}/>}
          {page === 'model' && <RouterModelOptions L={L} model={model} busy={modelBusy} onSaved={onModelSaved} onClose={finish} onBack={nested ? back : undefined}/>}
          {page === 'context' && <ContextOverview readout={readout} L={L} onDetails={() => { close(false); onContext() }}/>}
        </div></div>
      </div>, document.body
    )}
  </>
}
