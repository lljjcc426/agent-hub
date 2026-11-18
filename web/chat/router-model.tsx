import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { ArrowLeft, Check, ChevronRight, LoaderCircle, RotateCcw } from 'lucide-react'
import type { Config } from '../../src/config.ts'
import type { AgentOptions, BackendDefinition } from '../../src/backend-config.ts'
import { mergeParameters } from '../../src/agent-options.ts'
import type { Localize } from './composer-commands.tsx'
import './router-model.css'

type Effort = NonNullable<AgentOptions['effort']>
type Choice = { backend: string; effort: Effort | '' }
type Version = { revision: number; config: Config }
type Configuration = { current: Version; agentCapabilities?: Record<string, { efforts?: Effort[] }> }
type Props = {
  onClose: () => void; onBack?: () => void; busy: boolean; model?: string; L: Localize; onSaved: () => Promise<void>
}
const effortOrder: Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal, ...(body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : {}) })
  const data = await response.json()
  if (!response.ok) throw Error(data.code ?? 'configuration_failed')
  return data
}

function selectedBackend(config: Config) {
  return config.execution.router?.backend ?? config.execution.roles.router ?? config.execution.backend
}

function configuredEffort(config: Config) {
  const router = config.execution.router
  const kind = config.backends[selectedBackend(config)]?.kind
  const parameters = router?.parameters
  const provider = kind === 'openai-chat' ? parameters?.reasoning_effort
    : kind === 'openai-responses' ? (parameters?.reasoning as { effort?: unknown } | undefined)?.effort : undefined
  return router?.effort ?? (typeof provider === 'string' ? provider : '')
}

function modelPatch(config: Config, { backend, effort }: Choice) {
  const changed = selectedBackend(config) !== backend
  const router = { ...config.execution.router, backend }
  if (changed) { delete router.model; delete router.parameters }
  if (effort) router.effort = effort
  else delete router.effort

  const definition = config.backends[backend]
  if (definition?.kind === 'openai-chat' || definition?.kind === 'openai-responses') {
    // Keep explicit provider fields and the generic effort override in agreement.
    const parameters = mergeParameters(mergeParameters(definition.parameters, definition.defaults?.parameters), router.parameters)
    if (effort) {
      if (definition.kind === 'openai-chat' && parameters.reasoning_effort !== undefined)
        router.parameters = { ...router.parameters, reasoning_effort: effort }
      const reasoning = parameters.reasoning as { effort?: string } | undefined
      if (definition.kind === 'openai-responses' && reasoning?.effort !== undefined)
        router.parameters = mergeParameters(router.parameters, { reasoning: { effort } })
    } else if (router.parameters) {
      router.parameters = structuredClone(router.parameters)
      const reasoning = router.parameters.reasoning as { effort?: string } | undefined
      if (definition.kind === 'openai-chat') delete router.parameters.reasoning_effort
      else if (reasoning?.effort !== undefined) {
        delete reasoning.effort
        if (!Object.keys(reasoning).length) delete router.parameters.reasoning
      }
      if (!Object.keys(router.parameters).length) delete router.parameters
    }
  }
  return { execution: { ...config.execution, router }, ...(changed ? {
    models: Object.fromEntries(Object.entries(config.models).filter(([key]) => key !== 'router')),
  } : {}) }
}

function EffortSlider({ stops, index, valueText, L, disabled, onPreview, onCommit }: {
  stops: Choice['effort'][]; index: number; valueText: string; L: Localize; disabled: boolean
  onPreview: (value: Choice['effort']) => void; onCommit: (value: Choice['effort']) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const slider = useRef<HTMLLabelElement>(null), rail = useRef<HTMLSpanElement>(null)
  const drag = useRef<{ id: number; left: number; width: number; initial: number } | null>(null)
  function follow(event: PointerEvent<HTMLInputElement>) {
    const active = drag.current
    if (!active || event.pointerId !== active.id) return
    const progress = Math.max(0, Math.min(1, (event.clientX - active.left) / active.width))
    slider.current!.style.setProperty('--effort-pointer', String(progress))
  }
  function start(event: PointerEvent<HTMLInputElement>) {
    if (!event.isPrimary || event.button !== 0) return
    const { left, width } = rail.current!.getBoundingClientRect()
    drag.current = { id: event.pointerId, left, width, initial: event.currentTarget.valueAsNumber }
    event.currentTarget.setPointerCapture(event.pointerId)
    slider.current!.dataset.dragging = ''
    follow(event)
  }
  function release(event: PointerEvent<HTMLInputElement>, cancelled = false) {
    const active = drag.current
    if (!active || event.pointerId !== active.id) return
    drag.current = null
    if (cancelled) {
      event.currentTarget.valueAsNumber = active.initial
      onPreview(stops[active.initial]!)
    }
    delete slider.current!.dataset.dragging
    slider.current!.style.removeProperty('--effort-pointer')
  }
  useLayoutEffect(() => {
    const range = input.current!
    // The native change event commits a drag on release and keyboard steps immediately.
    const commit = () => onCommit(stops[range.valueAsNumber]!)
    range.addEventListener('change', commit)
    return () => range.removeEventListener('change', commit)
  }, [stops, onCommit])
  return <label ref={slider} className="effort-slider" data-disabled={disabled || undefined}
    style={{ '--effort-stop': index / (stops.length - 1) } as CSSProperties}>
    <span aria-hidden="true" className="effort-track"><span ref={rail} className="effort-stops">
      <span className="effort-fill"/>
      {stops.map((stop, i) => <i key={stop} data-active={i <= index || undefined}/>)}
      <span className="effort-travel"><span className="effort-thumb"/></span>
    </span></span>
    <input ref={input} type="range" min={0} max={stops.length - 1} step={1} value={index}
      aria-label={L('Reasoning effort', '思考强度')} aria-valuetext={valueText} disabled={disabled}
      onPointerDown={start} onPointerMove={follow} onPointerUp={event => release(event)}
      onPointerCancel={event => release(event, true)} onLostPointerCapture={event => release(event, true)}
      onInput={event => onPreview(stops[event.currentTarget.valueAsNumber]!)}/>
  </label>
}

export function RouterModelOptions({ onClose, onBack, busy, model, L, onSaved }: Props) {
  const [data, setData] = useState<Configuration | null>(null)
  const [list, setList] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('')
  const [draft, setDraft] = useState<Choice['effort'] | null>(null)
  const version = useRef<Version | null>(null), pending = useRef<Choice | null>(null), writing = useRef(false)
  const modelButton = useRef<HTMLButtonElement>(null), choices = useRef<HTMLDivElement>(null), wasList = useRef(false)

  async function load(signal?: AbortSignal) {
    setError('')
    try {
      const next = await request<Configuration>('/configuration', undefined, signal)
      version.current = next.current
      setData(next)
      setDraft(null)
    } catch (e) { if (!signal?.aborted) setError((e as Error).message) }
  }
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [])
  useLayoutEffect(() => {
    if (list) choices.current?.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus({ preventScroll: true })
    else if (wasList.current) modelButton.current?.focus({ preventScroll: true })
    wasList.current = list
  }, [list])

  async function save(choice: Choice) {
    if (busy || !version.current) return
    pending.current = choice
    if (writing.current) return
    writing.current = true
    setSaving(true)
    setError('')
    let updated = false
    let lastChoice = choice
    try {
      // Rapid keyboard changes share the latest confirmed settings revision.
      while (pending.current) {
        const next = pending.current
        lastChoice = next
        pending.current = null
        const current: Version = version.current
        if (selectedBackend(current.config) === next.backend && configuredEffort(current.config) === next.effort) continue
        version.current = await request<Version>('/settings', { revision: current.revision, patch: modelPatch(current.config, next) })
        const saved = version.current
        setData(previous => previous && { ...previous, current: saved })
        if (selectedBackend(current.config) !== next.backend) setList(false)
        updated = true
      }
      setDraft(value => value === lastChoice.effort ? null : value)
    } catch (e) {
      pending.current = null
      setDraft(null)
      setError((e as Error).message)
    } finally {
      writing.current = false
      setSaving(false)
    }
    if (updated) await refreshChat()
  }

  async function refreshChat() {
    try { await onSaved(); setError(previous => previous === 'refresh_failed' ? '' : previous) }
    catch { setError(previous => previous || 'refresh_failed') }
  }
  const config = data?.current.config, backend = config ? selectedBackend(config) : ''
  const definitions: Record<string, BackendDefinition> = { codex: { kind: 'codex' }, ...config?.backends }
  const definition = definitions[backend]
  const connectionLabel = (id: string) => definitions[id]?.label ?? (id === 'codex' ? 'Codex' : id)
  const modelName = config?.execution.router?.model ?? config?.models.router ?? definition?.model ??
    (definition?.kind === 'codex' ? config?.model : undefined) ?? model ?? connectionLabel(backend)
  const configured = config ? configuredEffort(config) : ''
  const effort = effortOrder.find(level => level === configured) ?? ''
  const reported = data?.agentCapabilities?.[backend]?.efforts
  const options = reported ?? (definition?.kind === 'codex' ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high'])
  const stops: Choice['effort'][] = ['', ...effortOrder.filter(level => options.includes(level) || level === effort)]
  const adjustable = definition?.kind !== 'anthropic' && stops.length > 1
  const labels = { '': L('Model default', '模型默认'), none: L('Off', '关闭'), minimal: L('Minimal', '最少'),
    low: L('Low', '低'), medium: L('Medium', '中等'), high: L('High', '高'), xhigh: L('Extra high', '最高') }
  const displayed = draft ?? effort
  const valueText = draft === null && configured && !effort ? configured : labels[displayed]
  const canReset = !busy && !saving && !!configured
  const backButton = (back: () => void, label: string) => <button type="button" className="model-icon" aria-label={label}
    onClick={back}><ArrowLeft size={16}/></button>
  return <div className="router-model-options" onKeyDown={event => {
    if (list && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setList(false) }
  }}>
    {!config && onBack && <div className="palette-heading">
      {backButton(onBack, L('Back to chat actions', '返回对话操作'))}<strong>{L('Model connection', '模型连接')}</strong>
    </div>}
    {!config && !error && <div className="router-model-loading" role="status"><LoaderCircle className="spin" size={16}/>{L('Loading connections…', '正在读取连接…')}</div>}
    {config && (list ? <div className="model-connection-list">
      <div className="palette-heading">{backButton(() => setList(false), L('Back to model', '返回模型'))}
        <strong>{L('Model connections', '模型连接')}</strong></div>
      <div ref={choices} role="menu" aria-label={L('Model connections', '模型连接')} aria-busy={saving}>
        {Object.entries(definitions).map(([id, d]) => {
          const name = connectionLabel(id), detail = id === backend ? modelName : d.model
          return <button key={id} type="button" role="menuitemradio" aria-checked={id === backend}
            className="palette-row model-option" aria-disabled={busy || saving}
            onClick={() => {
              if (busy || saving) return
              if (id === backend) setList(false)
              else void save({ backend: id, effort: '' })
            }}>
            <span><strong>{name}</strong>{detail && detail !== name && <small>{detail}</small>}</span>
            {id === backend && <Check size={15}/>}
          </button>
        })}
      </div>
      <a className="palette-row model-manage" href="/configure#models" onClick={onClose}>
        <span>{L('Manage connections', '管理连接')}</span><ChevronRight size={14}/></a>
    </div> : <div className="model-dial">
      <div className="model-dial-head">
        {onBack && backButton(onBack, L('Back to chat actions', '返回对话操作'))}
        <div className="model-dial-title">
          <strong key={adjustable ? valueText : ''}>{adjustable ? valueText : L('Model thinking', '模型思考')}</strong>
          <button ref={modelButton} type="button" className="model-name-button" aria-haspopup="menu"
            aria-label={L('Model connection', '模型连接') + ' · ' + modelName} onClick={() => setList(true)}>
            <span>{modelName}</span><ChevronRight size={13}/></button>
        </div>
        {adjustable && <button type="button" className="model-icon model-reset" aria-disabled={!canReset}
          aria-label={L('Reset reasoning to model default', '恢复模型默认思考强度')} title={L('Reset to model default', '恢复模型默认')}
          onClick={() => { if (canReset) void save({ backend, effort: '' }) }}><RotateCcw size={15}/></button>}
      </div>
      {adjustable ? <EffortSlider stops={stops} index={stops.indexOf(displayed)} valueText={valueText} L={L} disabled={busy}
        onPreview={setDraft} onCommit={value => void save({ backend, effort: value })}/>
        : <a className="palette-row model-manage" href="/configure#execution/configuration" onClick={onClose}>
          <span>{L('Configure model thinking', '配置模型思考参数')}</span><ChevronRight size={14}/></a>}
    </div>)}
    {busy && config && <p className="router-model-notice">{L('Available when this run finishes.', '本次任务结束后可切换。')}</p>}
    {error && <div className="router-model-error" role="alert">
      {error === 'settings_conflict' ? L('Settings changed. Reload to continue.', '配置已变更，请重新读取。')
        : error === 'refresh_failed' ? L('Saved. Chat could not refresh.', '已保存，Chat 刷新失败。')
        : L('Could not load or save settings.', '未能读取或保存配置。')}
      <button type="button" onClick={() => void (error === 'refresh_failed' ? refreshChat() : load())}>{L('Retry', '重试')}</button>
    </div>}
  </div>
}
