import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { ArrowLeft, Check, ChevronRight, LoaderCircle, RotateCcw, Search } from 'lucide-react'
import type { Config } from '../../src/config.ts'
import type { AgentOptions, BackendDefinition } from '../../src/backend-config.ts'
import { configuredReasoningEffort, reasoningOverride } from '../../src/agent-options.ts'
import type { ReasoningEffort } from '../../src/reasoning-effort.ts'
import { SelectField, TextField } from '../ui/controls.tsx'
import type { Localize } from './composer-commands.tsx'
import { effortLabel, useModelCapabilities, type LoadModelCapabilities } from './model-capabilities.ts'
import { lastRead, rememberRead } from './last-read.ts'
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
  onClose: () => void; onBack?: () => void; model?: string; backend?: string; L: Localize; onSaved: () => Promise<void>
  onSaving: (active: boolean) => void
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

function selection(config: ModelConfig) {
  const backend = selectedBackend(config)
  const definitions: Record<string, ModelDefinition> = { codex: { kind: 'codex' }, ...config.backends }
  const connections = Object.fromEntries(Object.entries(definitions).map(([id, d]) => [id, {
    label: d.label ?? (id === 'codex' ? 'Codex' : id), model: d.model,
  }]))
  return {backend, model: selectedModel(config, backend), effort: configuredEffort(config), connections}
}

const lastSelection = 'roppo.models.selection'

function changesModel(config: ModelConfig, {backend, model}: Choice) {
  return selectedBackend(config) !== backend || model !== undefined && model !== selectedModel(config)
}

function modelPatch(config: ModelConfig, choice: Choice) {
  const {backend, model, effort} = choice
  const changed = changesModel(config, choice)
  const router = { ...config.execution.router, backend }
  if (selectedBackend(config) !== backend) {
    delete router.parameters
    delete router.nativeTool
  }
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

export function RouterModelOptions({ onClose, onBack, model, backend: activeBackend, L, onSaved, onSaving, store = hostSettings }: Props) {
  const [data, setData] = useState<Configuration | null>(null)
  const [remembered] = useState(() => store === hostSettings ? lastRead<ReturnType<typeof selection>>(lastSelection, 'router') : undefined)
  const [picker, setPicker] = useState<{backend: string; query: string} | null>(null)
  const [refreshes, setRefreshes] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const [draft, setDraft] = useState<Effort>()
  const version = useRef<Version | null>(null), pending = useRef<Choice | null>(null), writing = useRef(false)
  const modelButton = useRef<HTMLButtonElement>(null), pickerPanel = useRef<HTMLDivElement>(null), wasPicking = useRef(false)

  async function load(signal?: AbortSignal) {
    setError('')
    try {
      const next = await store.load(signal)
      if (signal?.aborted) return
      version.current = next.current
      setData(next)
      setDraft(undefined)
      if (store === hostSettings) rememberRead(lastSelection, 'router', selection(next.current.config))
    } catch (e) { if (!signal?.aborted) setError((e as Error).message) }
  }
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [store])
  const picking = picker !== null
  useLayoutEffect(() => {
    if (picking) {
      const selected = pickerPanel.current?.querySelector<HTMLButtonElement>('[aria-checked=true]')
      const target = selected ?? pickerPanel.current?.querySelector('select')
      target?.focus({ preventScroll: true })
    } else if (wasPicking.current) modelButton.current?.focus({ preventScroll: true })
    wasPicking.current = picking
  }, [picking])

  async function save(choice: Choice) {
    if (!version.current) return
    pending.current = choice
    if (writing.current) return
    writing.current = true
    setSaving(true)
    onSaving(true)
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
        if (store === hostSettings) rememberRead(lastSelection, 'router', selection(saved.config))
        if (switching) setPicker(null)
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
      onSaving(false)
    }
    if (updated) await refreshChat()
  }

  async function refreshChat() {
    try { await onSaved(); setError(previous => previous === 'refresh_failed' ? '' : previous) }
    catch { setError(previous => previous || 'refresh_failed') }
  }
  const config = data?.current.config
  const saved = remembered && (!activeBackend || activeBackend === remembered.backend) &&
    (!model || !remembered.model || model === remembered.model || model === remembered.backend) ? remembered : undefined
  const current = config ? selection(config) : saved
  const backend = current?.backend ?? ''
  const connections = current?.connections ?? {}
  const connectionLabel = (id: string) => connections[id]?.label ?? id
  const configuredModel = current?.model
  const refreshConnection = (id: string) => setRefreshes(previous => ({...previous, [id]: (previous[id] ?? 0) + 1}))
  const capabilities = useModelCapabilities(backend, configuredModel, store.capabilities, 0, refreshes[backend] ?? 0)
  const activeModel = configuredModel ?? capabilities.model
  const modelName = activeModel ?? model ?? connectionLabel(backend)
  const browsing = picker && Object.hasOwn(connections, picker.backend) ? picker.backend : backend
  const otherCatalog = useModelCapabilities(browsing === backend ? '' : browsing, connections[browsing]?.model,
    store.capabilities, 0, refreshes[browsing] ?? 0)
  const catalog = browsing === backend ? capabilities : otherCatalog
  const fallback = browsing === backend ? activeModel ?? model : connections[browsing]?.model
  const available = catalog.models.length ? catalog.models : fallback ? [fallback] : []
  const query = picker?.query.trim().toLowerCase() ?? ''
  const results = available.filter(id => id.toLowerCase().includes(query))
  const currentIndex = browsing === backend && fallback ? results.indexOf(fallback) : -1
  if (currentIndex > 0) results.unshift(results.splice(currentIndex, 1)[0]!)
  const stops: Effort[] = [null, ...capabilities.efforts]
  const configured = current?.effort
  const displayed = stops.find(level => level === (draft === undefined ? configured : draft)) ?? null
  const valueText = capabilities.pending && !capabilities.model && capabilities.reasoning.source === 'unknown'
    ? L('Reasoning effort', '思考强度') : effortLabel(displayed, L)
  const canReset = !!config && !saving && configured != null
  const backButton = (back: () => void, label: string) => <button type="button" className="model-icon" aria-label={label}
    onClick={back}><ArrowLeft size={16}/></button>
  function chooseModel(selected?: string) {
    if (!config || saving) return
    if (browsing === backend && selected === fallback) setPicker(null)
    else void save({backend: browsing, model: selected, effort: null})
  }
  return <div className="router-model-options" onKeyDown={event => {
    if (picking && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      setPicker(null)
    }
  }}>
    {!current && onBack && <div className="palette-heading">
      {backButton(onBack, L('Back to chat actions', '返回对话操作'))}<strong>{L('Model connection', '模型连接')}</strong>
    </div>}
    {!current && !error && <div className="router-model-loading" role="status"><LoaderCircle className="spin" size={16}/>{L('Loading connections…', '正在读取连接…')}</div>}
    {current && (picker ? <div className="model-connection-list" ref={pickerPanel}>
      <div className="palette-heading">{backButton(() => setPicker(null), L('Back to model', '返回模型'))}
        <strong>{L('Choose a model', '选择模型')}</strong></div>
      <div className="model-picker-controls">
        <SelectField label={L('Model connection', '模型连接')} value={browsing} disabled={saving}
          onClick={() => refreshConnection(browsing)}
          onChange={event => {
            const next = event.target.value
            if (next === backend) refreshConnection(next)
            setPicker({backend: next, query: ''})
          }}>
          {Object.keys(connections).map(id => <option key={id} value={id}>{connectionLabel(id)}</option>)}
        </SelectField>
        {(available.length > 6 || picker.query) && <TextField type="search" label={L('Search models', '搜索模型')}
          placeholder={L('Search models', '搜索模型')} icon={<Search size={14}/>} value={picker.query}
          onChange={event => setPicker({...picker, query: event.target.value})}/>}
      </div>
      {catalog.pending && !available.length ? <div className="router-model-loading" role="status"><LoaderCircle className="spin" size={15}/>{L('Loading models…', '正在读取模型…')}</div>
        : query && !results.length ? <p className="model-picker-empty" role="status">{L('No matching models', '没有匹配的模型')}</p>
        : <div role="menu" className="model-picker-results" aria-label={L('Models', '模型')} aria-busy={saving || catalog.pending}>
          {results.map(id => {
            const selected = browsing === backend && id === fallback
            return <button key={id} type="button" role="menuitemradio" aria-checked={selected}
              className="palette-row model-option" aria-disabled={!config || saving} onClick={() => chooseModel(id)}>
              <strong>{id}</strong>{selected && <Check size={15}/>}
            </button>
          })}
          {!available.length && <button type="button" role="menuitemradio" aria-checked={browsing === backend}
            className="palette-row model-option" aria-disabled={!config || saving} onClick={() => chooseModel()}>
            <strong>{L('Use connection default', '使用连接默认模型')}</strong>{browsing === backend && <Check size={15}/>}
          </button>}
        </div>}
      {store.connectionsUrl && <a className="palette-row model-manage" href={store.connectionsUrl} onClick={onClose}>
        <span>{L('Manage connections', '管理连接')}</span><ChevronRight size={14}/></a>}
    </div> : <div className="model-dial" aria-busy={capabilities.pending}>
      <div className="model-dial-head">
        {onBack && backButton(onBack, L('Back to chat actions', '返回对话操作'))}
        <div className="model-dial-title">
          <strong key={valueText}>{valueText}</strong>
          <button ref={modelButton} type="button" className="model-name-button" aria-haspopup="menu"
            aria-label={L('Model connection', '模型连接') + ' · ' + modelName} onClick={() => {
              refreshConnection(backend)
              setPicker({backend, query: ''})
            }}>
            <span>{modelName}</span><ChevronRight size={13}/></button>
        </div>
        {(stops.length > 1 || !capabilities.pending && configured != null) && <button type="button" className="model-icon model-reset" aria-disabled={!canReset}
          aria-label={L('Reset reasoning to model default', '恢复模型默认思考强度')} title={L('Reset to model default', '恢复模型默认')}
          onClick={() => { if (canReset) void save({ backend, effort: null }) }}><RotateCcw size={15}/></button>}
      </div>
      {stops.length > 1 && <EffortSlider stops={stops} index={stops.indexOf(displayed)} valueText={valueText} L={L} disabled={!config}
        onPreview={setDraft} onCommit={value => void save({ backend, effort: value })}/>}
    </div>)}
    {error && <div className="router-model-error" role="alert">
      {error === 'settings_conflict' ? L('Settings changed. Reload to continue.', '配置已变更，请重新读取。')
        : error === 'refresh_failed' ? L('Saved. Chat could not refresh.', '已保存，Chat 刷新失败。')
        : L('Could not load or save settings.', '未能读取或保存配置。')}
      <button type="button" onClick={() => void (error === 'refresh_failed' ? refreshChat() : load())}>{L('Retry', '重试')}</button>
    </div>}
  </div>
}
