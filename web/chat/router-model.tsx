import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { ArrowLeft, Check, ChevronRight, LoaderCircle, RotateCcw } from 'lucide-react'
import type { Config } from '../../src/config.ts'
import type { AgentOptions, BackendDefinition } from '../../src/backend-config.ts'
import { configuredReasoningEffort, reasoningOverride } from '../../src/agent-options.ts'
import type { ReasoningEffort } from '../../src/reasoning-effort.ts'
import type { Localize } from './composer-commands.tsx'
import { effortLabel, useModelCapabilities, type LoadModelCapabilities } from './model-capabilities.ts'
import './router-model.css'

type Effort = ReasoningEffort | null
type Choice = { backend: string; model?: string; effort: Effort }
type ModelDefinition = Pick<BackendDefinition, 'kind' | 'model' | 'label' | 'defaults'> & {parameters?: AgentOptions['parameters']}
type ModelConfig = Pick<Config, 'model' | 'models'> & {
  effort?: Config['effort']
  backends: Record<string, ModelDefinition>
  execution: Pick<Config['execution'], 'roles' | 'router' | 'backend'>
}
type Version = { revision: number; config: ModelConfig }
type Configuration = { current: Version }
export type ModelConnectionStore = {
  load: (signal?: AbortSignal) => Promise<Configuration>
  save: (revision: number, patch: ReturnType<typeof modelPatch>) => Promise<Version>
  capabilities?: LoadModelCapabilities
  connectionsUrl?: string
}
type Props = {
  store?: ModelConnectionStore
  onClose: () => void; onBack?: () => void; busy: boolean; model?: string; L: Localize; onSaved: () => Promise<void>
}
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal, ...(body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : {}) })
  const data = await response.json()
  if (!response.ok) throw Error(data.code ?? 'configuration_failed')
  return data
}

function selectedBackend(config: ModelConfig) {
  return config.execution.router?.backend ?? config.execution.roles.router ?? config.execution.backend
}

function selectedModel(config: ModelConfig, backend = selectedBackend(config)) {
  const definition = config.backends[backend]
  return config.execution.router?.model ?? config.models.router ?? definition?.model ??
    (definition?.kind === 'codex' || backend === 'codex' && !definition ? config.model : undefined)
}

function configuredEffort(config: ModelConfig) {
  const backend = selectedBackend(config), definition = config.backends[backend]
  const kind = definition?.kind ?? (backend === 'codex' ? 'codex' : '')
  return configuredReasoningEffort(kind, config.execution.router, definition?.defaults, definition?.parameters, config.effort)
}

function changesModel(config: ModelConfig, {backend, model}: Choice) {
  return selectedBackend(config) !== backend || model !== undefined && model !== selectedModel(config)
}

function modelPatch(config: ModelConfig, choice: Choice) {
  const {backend, model, effort} = choice
  const changed = changesModel(config, choice)
  const router = { ...config.execution.router, backend }
  if (selectedBackend(config) !== backend) delete router.parameters
  if (changed) router.model = model
  Object.assign(router, reasoningOverride(config.backends[backend]?.kind ?? '', router.parameters, effort))
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

const hostSettings: ModelConnectionStore = {
  load: signal => request<Configuration>('/configuration', undefined, signal),
  save: (revision, patch) => request<Version>('/settings', {revision, patch}),
  connectionsUrl: '/configure#models',
}

export function RouterModelOptions({ onClose, onBack, busy, model, L, onSaved, store = hostSettings }: Props) {
  const [data, setData] = useState<Configuration | null>(null)
  const [list, setList] = useState<'connections' | 'models' | null>(null)
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const [draft, setDraft] = useState<Effort>()
  const version = useRef<Version | null>(null), pending = useRef<Choice | null>(null), writing = useRef(false)
  const modelButton = useRef<HTMLButtonElement>(null), choices = useRef<HTMLDivElement>(null), wasList = useRef(false)

  async function load(signal?: AbortSignal) {
    setError('')
    try {
      const next = await store.load(signal)
      version.current = next.current
      setData(next)
      setDraft(undefined)
    } catch (e) { if (!signal?.aborted) setError((e as Error).message) }
  }
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [store])
  useLayoutEffect(() => {
    if (list) {
      const selected = choices.current?.querySelector<HTMLButtonElement>('[aria-checked=true]')
      selected?.focus({ preventScroll: true })
      if (list === 'models') selected?.scrollIntoView({block: 'nearest'})
    }
    else if (wasList.current) modelButton.current?.focus({ preventScroll: true })
    wasList.current = !!list
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
        const switching = changesModel(current.config, next)
        if (!switching && configuredEffort(current.config) === next.effort) continue
        version.current = await store.save(current.revision, modelPatch(current.config, next))
        const saved = version.current
        setData(previous => previous && { ...previous, current: saved })
        if (switching) setList(null)
        updated = true
      }
      setDraft(value => value === lastChoice.effort ? undefined : value)
    } catch (e) {
      pending.current = null
      setDraft(undefined)
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
  const definitions: Record<string, ModelDefinition> = { codex: { kind: 'codex' }, ...config?.backends }
  const connectionLabel = (id: string) => definitions[id]?.label ?? (id === 'codex' ? 'Codex' : id)
  const configuredModel = config ? selectedModel(config, backend) : undefined
  const capabilities = useModelCapabilities(backend, configuredModel, store.capabilities)
  const activeModel = configuredModel ?? capabilities.model
  const modelName = activeModel ?? model ?? connectionLabel(backend)
  const stops: Effort[] = [null, ...capabilities.efforts]
  const configured = config ? configuredEffort(config) : undefined
  const displayed = stops.find(level => level === (draft === undefined ? configured : draft)) ?? null
  const valueText = effortLabel(displayed, L)
  const canReset = !busy && !saving && configured != null
  const backButton = (back: () => void, label: string) => <button type="button" className="model-icon" aria-label={label}
    onClick={back}><ArrowLeft size={16}/></button>
  return <div className="router-model-options" onKeyDown={event => {
    if (list && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      setList(list === 'models' ? 'connections' : null)
    }
  }}>
    {!config && onBack && <div className="palette-heading">
      {backButton(onBack, L('Back to chat actions', '返回对话操作'))}<strong>{L('Model connection', '模型连接')}</strong>
    </div>}
    {!config && !error && <div className="router-model-loading" role="status"><LoaderCircle className="spin" size={16}/>{L('Loading connections…', '正在读取连接…')}</div>}
    {config && (list === 'models' ? <div className="model-connection-list">
      <div className="palette-heading">{backButton(() => setList('connections'), L('Back to connections', '返回连接'))}
        <strong>{L('Choose a model', '选择模型')}</strong></div>
      <div ref={choices} role="menu" className="model-picker-results" aria-label={L('Models', '模型')} aria-busy={saving}>
        {capabilities.models.map(id => <button key={id} type="button" role="menuitemradio" aria-checked={id === activeModel}
          className="palette-row model-option" aria-disabled={busy || saving} onClick={() => {
            if (busy || saving) return
            if (id === activeModel) setList(null)
            else void save({backend, model: id, effort: null})
          }}><strong>{id}</strong>{id === activeModel && <Check size={15}/>}</button>)}
      </div>
    </div> : list === 'connections' ? <div className="model-connection-list">
      <div className="palette-heading">{backButton(() => setList(null), L('Back to model', '返回模型'))}
        <strong>{L('Model connections', '模型连接')}</strong></div>
      <div ref={choices} role="menu" aria-label={L('Model connections', '模型连接')} aria-busy={saving}>
        {Object.entries(definitions).map(([id, d]) => {
          const name = connectionLabel(id), detail = id === backend ? modelName : d.model
          return <button key={id} type="button" role="menuitemradio" aria-checked={id === backend}
            className="palette-row model-option" aria-disabled={busy || saving}
            onClick={() => {
              if (busy || saving) return
              if (id === backend) setList(null)
              else void save({ backend: id, effort: null })
            }}>
            <span><strong>{name}</strong>{detail && detail !== name && <small>{detail}</small>}</span>
            {id === backend && <Check size={15}/>}
          </button>
        })}
      </div>
      {capabilities.models.length > 1 && <button type="button" className="palette-row model-manage"
        aria-haspopup="menu" onClick={() => setList('models')}>
        <span>{L('Choose a model', '选择模型')}</span><ChevronRight size={14}/></button>}
      {store.connectionsUrl && <a className="palette-row model-manage" href={store.connectionsUrl} onClick={onClose}>
        <span>{L('Manage connections', '管理连接')}</span><ChevronRight size={14}/></a>}
    </div> : <div className="model-dial" aria-busy={capabilities.pending}>
      <div className="model-dial-head">
        {onBack && backButton(onBack, L('Back to chat actions', '返回对话操作'))}
        <div className="model-dial-title">
          <strong key={valueText}>{valueText}</strong>
          <button ref={modelButton} type="button" className="model-name-button" aria-haspopup="menu"
            aria-label={L('Model connection', '模型连接') + ' · ' + modelName} onClick={() => setList('connections')}>
            <span>{modelName}</span><ChevronRight size={13}/></button>
        </div>
        {(stops.length > 1 || !capabilities.pending && configured != null) && <button type="button" className="model-icon model-reset" aria-disabled={!canReset}
          aria-label={L('Reset reasoning to model default', '恢复模型默认思考强度')} title={L('Reset to model default', '恢复模型默认')}
          onClick={() => { if (canReset) void save({ backend, effort: null }) }}><RotateCcw size={15}/></button>}
      </div>
      {stops.length > 1 && <EffortSlider stops={stops} index={stops.indexOf(displayed)} valueText={valueText} L={L} disabled={busy}
        onPreview={setDraft} onCommit={value => void save({ backend, effort: value })}/>}
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
