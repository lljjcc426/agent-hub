import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type ComponentType, type KeyboardEvent } from 'react'
import { smartPunctuation } from '../chat/smart-punctuation.ts'
import { modifierEnterLabel, sendModifier, type SendShortcut } from '../chat/send-shortcut.ts'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowUp, Box, LoaderCircle, Plus, ShieldCheck, ShieldOff, SlidersHorizontal, X } from 'lucide-react'
import { ApprovalOptions, approvalLabel, commands, matchingCommands, CommandList, ContextOverview, UsageRing, windowReadout,
  type ChatCommand, type Localize, type Mode } from '../chat/composer-commands.tsx'
import { RouterModelOptions, type ModelConnectionStore } from '../chat/router-model.tsx'
import type { CurrentContext } from '../chat/context-card.tsx'
import type { ChatSkill, ChatSkillCatalog, ChatSkillRef } from '../../src/chat-skills.ts'
import { finishLayerExit } from './overlays.tsx'
import '../chat/composer-controls.css'

type Subpage = Exclude<ChatCommand, 'attach' | 'commits'>
type Source = Subpage | 'slash' | 'plus'
type Menu = { source: Source; page: Subpage | 'commands'; query: string }

function SendMessage({ canSend, sending, shortcut, L, onClick }: {
  canSend: boolean; sending: boolean; shortcut: SendShortcut; L: Localize; onClick: () => void
}) {
  const label = L('Send message', '发送消息')
  return <button type="button" className="send-button" disabled={!canSend}
    aria-label={label} aria-keyshortcuts={shortcut === 'enter' ? 'Enter' : sendModifier.name + '+Enter'}
    title={label + ' · ' + (shortcut === 'enter' ? 'Enter' : modifierEnterLabel)} onClick={onClick}>
    {sending ? <LoaderCircle size={18} className="spin"/> : <ArrowUp size={20}/>}
  </button>
}

export type ComposerActionsProps = {
  L: Localize; visible: boolean; sending: boolean; mode?: Mode; usage: CurrentContext
  router: string; model?: string; modelBackend?: string; uploadDisabled: boolean
  onContext?: () => void; saveMode: (next: Mode) => Promise<void>; onModelSaved: () => Promise<void>
  onUsageOpen?: () => void
  onCommitTrail?: (opener: HTMLElement | null) => void
  onEnter: (text: string) => void
  sendShortcut?: SendShortcut
  loadSkills?: (signal: AbortSignal) => Promise<ChatSkillCatalog>
  skill?: ChatSkillRef | null
  onSkillChange?: (skill: ChatSkillRef | null) => void
}
export type TextInputProps = Omit<ComponentPropsWithRef<'textarea'>, 'style'>

export function ChatComposer({ L, visible, sending, mode, usage, router, model, modelBackend, uploadDisabled,
  onContext, onUsageOpen, saveMode, onModelSaved, onCommitTrail, onEnter, loadSkills, skill, onSkillChange,
  sendShortcut = 'enter', Input = 'textarea', value, setText, onSend, canSend, onAttach, modelStore }: ComposerActionsProps & {
  Input?: ComponentType<TextInputProps> | 'textarea'; value?: string; canSend: boolean
  setText: (text: string) => void; onAttach: () => void; onSend: () => void; modelStore?: ModelConnectionStore
}) {
  const listId = useId(), paletteId = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  const opener = useRef<HTMLElement>(null), palette = useRef<HTMLDivElement>(null), paletteBody = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<Menu | null>(null), [highlight, setHighlight] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [modelWrites, setModelWrites] = useState(0)
  const [catalog, setCatalog] = useState<ChatSkillCatalog>({items:[],refreshing:true})
  const [skillsFailed, setSkillsFailed] = useState(false)
  const current = useRef(menu)
  current.current = menu
  const showContext = !!onContext
  const displayedMenu = visible && (showContext || menu?.page !== 'context') ? menu : null
  const source = displayedMenu?.source
  const open = !!source
  const page = displayedMenu?.page
  const slashList = source === 'slash' && page === 'commands'
  const slash = slashList && !closing
  const nested = page !== 'commands' && (source === 'slash' || source === 'plus')
  const query = menu?.query ?? ''
  const items = matchingCommands(query, L, !!onCommitTrail, showContext)
  const skillItems = slashList && loadSkills ? catalog.items.filter(item =>
    item.name.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query)
  ).sort((a,b) => Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query))) : []
  const optionIds = [...items.map(item => item.id), ...skillItems.map(skill => skill.id)]
  const count = optionIds.length
  const active = highlight === null ? (count ? 0 : -1) : optionIds.indexOf(highlight)
  const highlightAt = (index: number) => setHighlight(optionIds[index] ?? null)
  const waitingForSkills = slashList && !count && catalog.refreshing && !skillsFailed
  const empty = count ? undefined : waitingForSkills ? L('Loading skills…','正在加载技能…') :
    skillsFailed ? L('Skills unavailable','暂时无法加载技能') : L('No matches','没有匹配项')
  const readout = windowReadout(usage, L)
  const modelLabel = model || L('Model', '模型')
  const policyGroup = L('Approval policy', '审批策略')
  const policyLabel = mode ? approvalLabel(mode, L) : policyGroup
  const policyTitle = mode ? policyGroup + ' · ' + policyLabel : policyGroup
  const contextTitle = L('Context usage', '上下文用量') + ' · ' + readout.label
  const PolicyIcon = mode === 'full' ? ShieldOff : ShieldCheck
  const title = commands.find(c => c.id === page)?.title(L)

  function show(next: Menu) {
    if (next.page === 'context') onUsageOpen?.()
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
    if (source === 'slash') setText('/' + menu.query)
    show({ ...menu, page: 'commands' })
  }
  function shortcut(next: Exclude<Source, 'slash'>, trigger: HTMLElement) {
    if (!closing && source === next) { close(); return }
    if (slash) setText('')
    opener.current = trigger
    setHighlight(null)
    show({ source: next, page: next === 'plus' ? 'commands' : next, query: '' })
  }
  function updateQuery(text: string) {
    const query = /^\/[^\s/]*$/u.test(text) ? text.slice(1).toLowerCase() : null
    if (query === null || (!loadSkills && !matchingCommands(query, L, !!onCommitTrail, showContext).length)) {
      if (menu) close(false)
      return
    }
    opener.current = input.current
    setHighlight(null)
    show({ source: 'slash', page: 'commands', query })
  }
  function choose(command: ChatCommand) {
    if (!menu || (command === 'attach' && uploadDisabled)) return
    if (slash) setText('')
    if (command === 'attach') {
      close()
      onAttach()
    } else if (command === 'commits') {
      close(false)
      onCommitTrail?.(opener.current)
    } else show({ ...menu, page: command })
  }
  function selectSkill(item: ChatSkill) {
    onSkillChange?.({id:item.id,name:item.name})
    setText('')
    close()
  }
  function chooseActive() {
    if (slash && (waitingForSkills || active < 0 && highlight !== null)) return true
    if (!slash || active < 0) return false
    const command = items[active]
    if (command) choose(command.id)
    else selectSkill(skillItems[active - items.length]!)
    return true
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

  useEffect(() => {
    if (!visible || (!showContext && current.current?.page === 'context')) setMenu(null)
  }, [visible, showContext])
  useEffect(() => {
    if (!slash || !loadSkills) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setSkillsFailed(false)
    const load = async () => {
      try {
        const result = await loadSkills(controller.signal)
        if (controller.signal.aborted) return
        setCatalog(result)
        if (result.refreshing) timer = setTimeout(load, 1000)
      } catch {
        if (!controller.signal.aborted) setSkillsFailed(true)
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [slash, loadSkills])
  useLayoutEffect(() => {
    if (slash) palette.current?.querySelectorAll('[role=option]')[active]?.scrollIntoView({block:'nearest'})
  }, [active, slash, count])
  useLayoutEffect(() => {
    const panel = palette.current, body = paletteBody.current, form = input.current?.form
    if (!panel || !body || !form || !open) return
    panel.showPopover()
    let anchor: DOMRect
    const place = () => {
      const rect = form.getBoundingClientRect(), viewport = window.visualViewport
      anchor = rect
      const height = viewport?.height ?? innerHeight
      const top = viewport?.offsetTop ?? 0, bottom = top + height
      const left = viewport?.offsetLeft ?? 0, right = left + (viewport?.width ?? innerWidth)
      const width = Math.min(320, rect.width, right - left - 16)
      panel.style.width = width + 'px'
      panel.style.left = Math.max(left + 8, Math.min(rect.left, right - width - 8)) + 'px'
      const above = rect.top - top - 16, below = bottom - rect.bottom - 16
      const up = above >= 290 || above >= below
      panel.dataset.side = up ? 'above' : 'below'
      panel.style.top = up ? 'auto' : rect.bottom + 8 + 'px'
      panel.style.bottom = up ? innerHeight - rect.top + 8 + 'px' : 'auto'
      panel.style.setProperty('--palette-available-height', Math.max(0, up ? above : below) + 'px')
      panel.style.setProperty('--palette-slash-limit', height / 4 + 'px')
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
    const observer = new ResizeObserver(() => panel.style.setProperty('--palette-height', body.offsetHeight + 'px'))
    observer.observe(body)
    // The welcome layout can move the composer while its dimensions stay the same.
    const follow = () => {
      const rect = form.getBoundingClientRect()
      if (rect.x !== anchor.x || rect.y !== anchor.y || rect.width !== anchor.width || rect.height !== anchor.height) place()
      frame = requestAnimationFrame(follow)
    }
    let frame = requestAnimationFrame(follow)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('focusin', dismiss)
    return () => {
      panel.hidePopover()
      cancelAnimationFrame(frame)
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
      {skill && <div className="composer-skill">
        <Box size={14}/><span>/{skill.name}</span>
        <button type="button" aria-label={L('Remove skill','移除技能')} onClick={() => {
          onSkillChange?.(null)
          input.current?.focus({preventScroll:true})
        }}><X size={13}/></button>
      </div>}
      <Input ref={input} className="composer-input" rows={1} maxLength={100000}
        {...(value === undefined ? {} : {value, onChange: event => setText(event.currentTarget.value)})}
        placeholder={L('Message ' + router + '…', '向 ' + router + ' 发送消息…')}
        aria-label={L('Message ' + router, '向 ' + router + ' 发送消息')}
        role={slash ? 'combobox' : undefined} aria-autocomplete={slash ? 'list' : undefined}
        aria-expanded={slash || undefined} aria-controls={slash ? listId : undefined}
        aria-activedescendant={slash && active >= 0 ? listId + '-' + active : undefined}
        onInput={event => {
          const native = event.nativeEvent as InputEvent, field = event.currentTarget
          if (native.isComposing) return
          if (native.inputType === 'insertText' && native.data && document.documentElement.dataset.appearanceSmart === 'true') {
            const result = smartPunctuation(field.value, field.selectionStart, native.data)
            if (result.text !== field.value) {
              const end = field.selectionStart
              let start = 0
              while (start < end && field.value[start] === result.text[start]) start++
              field.setSelectionRange(start, end)
              // A native editing command keeps undo/redo; assigning value clears the browser's history.
              document.execCommand('insertText', false, result.text.slice(start, result.caret))
              setText(field.value)
              field.setSelectionRange(result.caret, result.caret)
            }
          }
          updateQuery(field.value)
        }}
        onCompositionEnd={event => updateQuery(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (slash && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
          if (slash && count && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault()
            const step = event.key === 'ArrowDown' ? 1 : -1
            const next = active < 0 ? (step === 1 ? 0 : count - 1) : (active + step + count) % count
            highlightAt(items[next]?.id === 'attach' && uploadDisabled && count > 1 ? (next + step + count) % count : next)
            return
          }
          if (event.key !== 'Enter' || event.shiftKey) return
          if (chooseActive()) { event.preventDefault(); return }
          if (sendShortcut === 'modifier-enter' && (!event[sendModifier.eventKey] || event.altKey)) return
          event.preventDefault()
          if (slash) close()
          if (!modelWrites) onEnter(event.currentTarget.value)
        }}/>
    </div>
    <div className="composer-toolbar" onKeyDown={event => {
      if (open && !closing && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    }}>
      <button type="button" data-menu-trigger className="composer-plus icon-button" aria-label={L('Chat actions','对话操作')}
        title={L('Chat actions','对话操作')} aria-haspopup="menu" aria-expanded={!closing && source === 'plus'} aria-controls={source === 'plus' ? paletteId : undefined}
        onClick={e => shortcut('plus', e.currentTarget)}><Plus size={19}/></button>
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
        {showContext && <button type="button" data-menu-trigger className="icon-button composer-context" aria-label={contextTitle}
          title={[contextTitle, readout.tokens].filter(Boolean).join(' · ')}
          aria-haspopup="dialog" aria-expanded={!closing && source === 'context'} aria-controls={source === 'context' ? paletteId : undefined}
          onClick={e => shortcut('context', e.currentTarget)}><UsageRing fraction={readout.fraction}/></button>}
        <SendMessage canSend={canSend && !modelWrites} sending={sending} shortcut={sendShortcut} L={L} onClick={() => {
          if (chooseActive()) return
          if (slash) close()
          onSend()
        }}/>
      </div>
    </div>
    {source && page && createPortal(
      <div ref={palette} id={paletteId} popover="manual" tabIndex={-1} className="roppo-ui composer-palette"
        data-slash-list={slashList || undefined}
        data-closing={closing ? '' : undefined} inert={closing} aria-hidden={closing || undefined}
        role={page === 'model' || page === 'context' ? 'dialog' : undefined}
        aria-label={page === 'model' ? L('Chat model','对话模型') : title} onKeyDown={moveInMenu}>
        <div ref={paletteBody} className="palette-body"><div key={page} className="palette-page" data-page={page}>
          {(page === 'permissions' || page === 'context') && <div className="palette-heading">
            {nested && <button type="button" aria-label={L('Back to chat actions','返回对话操作')} onClick={back}><ArrowLeft size={16}/></button>}
            <strong>{page === 'permissions' ? L('How should Roppo ask for approval?', 'Roppo 应如何请求批准？') : title}</strong>
          </div>}
          {page === 'commands' && <CommandList items={items} skills={skillItems} empty={empty} slash={slashList} listId={listId} active={active}
            uploadDisabled={uploadDisabled} mode={mode} L={L} onHighlight={highlightAt} onChoose={choose} onSkill={selectSkill}/>}
          {page === 'permissions' && <ApprovalOptions mode={mode} L={L} onSave={saveMode} onClose={finish}/>}
          {page === 'model' && <RouterModelOptions store={modelStore} L={L} model={model} backend={modelBackend} onSaved={onModelSaved}
            onSaving={active => setModelWrites(count => count + (active ? 1 : -1))} onClose={finish} onBack={nested ? back : undefined}/>}
          {page === 'context' && onContext && <ContextOverview readout={readout} L={L} onDetails={() => { close(false); onContext() }}/>}
        </div></div>
      </div>, document.body
    )}
  </>
}
