import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronUp,
  GitBranch,
  GripVertical,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react'
import { Button, IconButton } from './controls.tsx'
import { Disclosure } from './overlays.tsx'
import { SwitchView, switchView, useOrderedListMotion } from './transitions.tsx'

export interface PlanStep {
  id: string
  title: string
  tool: string
  state?: 'pending' | 'running' | 'completed' | 'blocked'
}
export type RunPhase = 'ready' | 'running' | 'paused' | 'done'
function stepState(index: number, current: number, phase: RunPhase) {
  if (phase === 'done' || index < current) return 'done'
  if (index === current && phase !== 'ready') return 'current'
  return 'waiting'
}

export function AgentPlan({
  title,
  steps,
  current = 0,
  phase = 'ready',
  live = true,
  L = (_en, zh) => zh,
  onChange,
  onRun,
  createStep,
}: {
  title: string
  steps: PlanStep[]
  current?: number
  phase?: RunPhase
  live?: boolean
  L?: (en: string, zh: string) => string
  onChange?: (steps: PlanStep[]) => void
  onRun?: () => void
  createStep?: () => PlanStep
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [dragged, setDragged] = useState<string | null>(null)
  const canEdit = !!onChange && (phase === 'ready' || phase === 'done')
  const list = useOrderedListMotion(steps)
  useEffect(() => {
    if (!canEdit) setEditing(null)
  }, [canEdit])
  function begin(step: PlanStep) {
    setDraft(step.title)
    setEditing(step.id)
  }
  function finish(id: string) {
    if (draft.trim()) onChange?.(steps.map((s) => (s.id === id ? { ...s, title: draft.trim() } : s)))
    setEditing(null)
  }
  function move(from: number, to: number) {
    if (from < 0 || to < 0 || to >= steps.length || from === to) return
    const next = steps.slice()
    next.splice(to, 0, next.splice(from, 1)[0]!)
    onChange?.(next)
  }
  return (
    <div className="rp-plan">
      <div className="rp-card-kicker">
        <span>{title}</span>
        <span>
          {steps.length} {L('steps', '个步骤')}
        </span>
      </div>
      <ol ref={list}>
        {steps.map((step, i) => {
          const state = step.state
            ? ({ pending: 'waiting', running: 'current', completed: 'done', blocked: 'blocked' } as const)[
                step.state
              ]
            : stepState(i, current, phase)
          return (
            <li
              key={step.id}
              data-item={step.id}
              data-state={state}
              data-dragged={dragged === step.id}
              onDragOver={(event) => {
                if (dragged) event.preventDefault()
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragged)
                  move(
                    steps.findIndex((s) => s.id === dragged),
                    i,
                  )
                setDragged(null)
              }}
            >
              <span className="rp-step-index">
                {state === 'done' ? (
                  <Check size={14} />
                ) : state === 'current' && live && (step.state === 'running' || phase === 'running') ? (
                  <LoaderCircle className="rp-spin" size={15} />
                ) : (
                  i + 1
                )}
              </span>
              {editing === step.id ? (
                <form
                  className="rp-step-editor"
                  onSubmit={(e) => {
                    e.preventDefault()
                    finish(step.id)
                  }}
                >
                  <input
                    value={draft}
                    aria-label="步骤名称"
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setEditing(null)
                      }
                    }}
                  />
                  <IconButton type="submit" label="保存步骤">
                    <Check size={14} />
                  </IconButton>
                </form>
              ) : (
                <span className="rp-step-name">
                  <strong>{step.title}</strong>
                  {step.tool && <small>{step.tool}</small>}
                </span>
              )}
              {canEdit && editing !== step.id && (
                <span className="rp-step-tools">
                  <IconButton label={'编辑' + step.title} onClick={() => begin(step)}>
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton
                    label={'删除' + step.title}
                    onClick={() => onChange?.(steps.filter((s) => s.id !== step.id))}
                  >
                    <X size={13} />
                  </IconButton>
                  <span
                    className="rp-grip"
                    role="button"
                    tabIndex={0}
                    aria-label={'调整顺序：' + step.title}
                    title="拖动或按 Alt 加方向键调整顺序"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', step.id)
                      setDragged(step.id)
                    }}
                    onDragEnd={() => setDragged(null)}
                    onKeyDown={(e) => {
                      if (e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
                        e.preventDefault()
                        move(i, i + (e.key === 'ArrowUp' ? -1 : 1))
                      }
                    }}
                  >
                    <GripVertical size={14} />
                  </span>
                </span>
              )}
            </li>
          )
        })}
      </ol>
      {(onRun || createStep) && (
        <footer className="rp-card-foot">
          {canEdit && createStep && (
            <Button
              tone="quiet"
              onClick={() => {
                const step = createStep()
                onChange?.([...steps, step])
                begin(step)
              }}
            >
              <Plus size={14} />
              添加步骤
            </Button>
          )}
          {onRun && (
            <Button tone="primary" disabled={!canEdit || !steps.length || !!editing} onClick={onRun}>
              <Play size={13} />
              {phase === 'done'
                ? '重新运行'
                : phase === 'running'
                  ? '执行中'
                  : phase === 'paused'
                    ? '已暂停'
                    : '运行计划'}
            </Button>
          )}
        </footer>
      )}
    </div>
  )
}

export interface MonitorStep {
  id: string
  title: string
  tool: string
  elapsed: number
}
function duration(ms: number) {
  return (ms / 1000).toFixed(1) + ' s'
}
export function AgentMonitor({
  name,
  model,
  steps,
  current,
  phase,
  cost,
  onToggle,
}: {
  name: string
  model: string
  steps: MonitorStep[]
  current: number
  phase: RunPhase
  cost: string
  onToggle: () => void
}) {
  const [fold, setFold] = useState(false)
  const [pinned, setPinned] = useState<string | null>(null)
  const step = steps.find((s) => s.id === pinned) ?? steps[Math.min(current, steps.length - 1)]
  const total = steps.reduce((a, s) => a + s.elapsed, 0)
  return (
    <div className="rp-monitor">
      <button
        type="button"
        className="rp-monitor-head"
        aria-expanded={!fold}
        aria-label={fold ? '展开运行监视器' : '折叠运行监视器'}
        onClick={() => setFold(!fold)}
      >
        <span className="rp-live-dot" data-working={phase === 'running'} />
        <span>
          <strong>{name}</strong>
          <small>{model}</small>
        </span>
        <span className="rp-meter-cost">{cost}</span>
        {fold ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
      </button>
      <div className="rp-fold" data-expanded={!fold} inert={fold}>
        <div>
          <div className="rp-monitor-body">
            <SwitchView>
              <div className="rp-monitor-now">
                <span>{step?.title || '暂无步骤'}</span>
                <time>{duration(step?.elapsed ?? 0)}</time>
              </div>
            </SwitchView>
            <div className="rp-time-strip" aria-label="步骤耗时">
              {steps.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  data-state={stepState(i, current, phase)}
                  aria-pressed={step?.id === s.id}
                  aria-label={s.title + ' ' + duration(s.elapsed)}
                  style={{ flexGrow: Math.max(s.elapsed, 250) }}
                  onClick={() => switchView('panel', () => setPinned(s.id))}
                />
              ))}
            </div>
            <div className="rp-card-foot">
              <Button
                disabled={!steps.length}
                tone="quiet"
                onClick={() => {
                  setPinned(null)
                  onToggle()
                }}
              >
                {phase === 'running' ? <Pause size={14} /> : <Play size={14} />}
                {{ ready: '开始监视', running: '暂停运行', paused: '继续运行', done: '再运行一次' }[phase]}
              </Button>
              <small>
                {duration(total)} · {Math.min(phase === 'done' ? steps.length : current, steps.length)}/
                {steps.length}
              </small>
            </div>
            <Disclosure title="运行日志">
              <ol className="rp-run-log">
                {steps
                  .filter((s) => s.elapsed > 0)
                  .map((s) => (
                    <li key={s.id}>
                      <span>{s.tool}</span>
                      <time>{duration(s.elapsed)}</time>
                    </li>
                  ))}
                {total === 0 && <li>等待运行</li>}
              </ol>
            </Disclosure>
          </div>
        </div>
      </div>
    </div>
  )
}

export interface Checkpoint {
  id: string
  title: string
  time: string
}
export interface Attempt {
  id: string
  label: string
  parent?: { attemptId: string; pointId: string; title: string }
  points: Checkpoint[]
}
export function AgentCheckpoints({
  attempts,
  active,
  onSelect,
  onRewind,
}: {
  attempts: Attempt[]
  active: string
  onSelect: (id: string) => void
  onRewind: (attemptId: string, checkpointId: string) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<{ id: string; d: string }[]>([])
  useLayoutEffect(() => {
    const host = root.current!
    function measure() {
      if (!host.offsetWidth) return
      const area = host.getBoundingClientRect(),
        paths: { id: string; d: string }[] = []
      for (const a of attempts) {
        if (!a.parent) continue
        const point = host.querySelector<HTMLElement>(
          '[data-attempt="' +
            CSS.escape(a.parent.attemptId) +
            '"] [data-point="' +
            CSS.escape(a.parent.pointId) +
            '"]',
        )
        const branch = host.querySelector<HTMLElement>(
          '[data-attempt="' + CSS.escape(a.id) + '"] .rp-attempt-heading',
        )
        if (!point || !branch) continue
        const p = point.getBoundingClientRect(),
          q = branch.getBoundingClientRect()
        const x = p.left - area.left + 3,
          y = p.top - area.top + p.height / 2,
          end = q.top - area.top + q.height / 2,
          gutter = Math.max(3, x - 16)
        paths.push({
          id: a.id,
          d: [
            `M${x} ${y} H${gutter + 4} Q${gutter} ${y} ${gutter} ${y + 4}`,
            `V${end - 4} Q${gutter} ${end} ${gutter + 4} ${end} H${q.left - area.left + 4}`,
          ].join(' '),
        })
      }
      setEdges(paths)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [attempts])
  return (
    <div className="rp-checkpoints" ref={root}>
      <svg aria-hidden="true" className="rp-branch-lines">
        {edges.map((e) => (
          <path key={e.id} d={e.d} pathLength="1" />
        ))}
      </svg>
      {attempts.map((a) => (
        <section key={a.id} data-attempt={a.id} data-active={a.id === active}>
          <button
            type="button"
            className="rp-attempt-heading"
            aria-pressed={active === a.id}
            onClick={() => onSelect(a.id)}
          >
            <GitBranch size={15} />
            <strong>{a.label}</strong>
            <small>{a.parent ? '从「' + a.parent.title + '」分支' : a.points.length + ' 个检查点'}</small>
          </button>
          <ol>
            {a.points.map((pt) => (
              <li key={pt.id} data-point={pt.id}>
                <span>{pt.title}</span>
                <time>{pt.time}</time>
                <IconButton
                  label={'从' + a.label + '的' + pt.title + '重试'}
                  onClick={() => onRewind(a.id, pt.id)}
                >
                  <RotateCcw size={13} />
                </IconButton>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}
