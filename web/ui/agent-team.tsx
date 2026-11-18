import { useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowRight, Check, CircleAlert, Pause, RotateCcw } from 'lucide-react'
import { AgentAvatar } from '../chat/agent-avatar.tsx'
import { CopyButton } from '../chat/copy-button.tsx'
import { Button, ChoiceGroup } from './controls.tsx'
import { Disclosure } from './overlays.tsx'
import { SwitchView } from './transitions.tsx'

export interface TeamMember {
  id: string
  name: string
  kind: 'router' | 'worker'
  model: string
  task: string
  working: boolean
  portrait?: ReactNode
  usageFallback?: string
  statusLabel?: string
  tokens: number | null
  capacity: number | null
  tools: string[]
}
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const number = (value: number) => compact.format(value)
const zh = (_en: string, text: string) => text

function CrewNode({
  member,
  selected,
  onClick,
}: {
  member: TeamMember
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="rp-crew-node"
      aria-label={member.name}
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="rp-node-heading">
        {member.portrait ?? <AgentAvatar id={member.id} kind={member.kind} size={22} />}
        <strong>{member.name}</strong>
        <i
          className="rp-live-dot"
          data-working={member.working}
          aria-label={member.statusLabel ?? (member.working ? '工作中' : '待命')}
        />
      </span>
      <small>{member.model}</small>
      <span className="rp-node-task">{member.task}</span>
      {member.tokens !== null && member.capacity !== null && member.capacity > 0 ? <>
        <span className="rp-meter"><i style={{width: Math.min(100,100*member.tokens/member.capacity)+'%'}}/></span>
        <small className="rp-crew-usage">{number(member.tokens)} / {number(member.capacity)}
          <b>{Math.round(100*member.tokens/member.capacity)}%</b>
        </small>
      </> : <small>{member.tokens !== null && number(member.tokens)+' · '}{member.usageFallback ?? '暂无读数'}</small>}
    </button>
  )
}

export function AgentCrew({
  lead,
  workers,
  selected,
  onSelect,
}: {
  lead: TeamMember
  workers: TeamMember[]
  selected: string
  onSelect: (id: string) => void
}) {
  const current = [lead, ...workers].find((m) => m.id === selected) ?? lead
  const node = (m: TeamMember) => (
    <CrewNode key={m.id} member={m} selected={m.id === current.id} onClick={() => onSelect(m.id)} />
  )
  return (
    <div className="rp-crew" data-many={workers.length>2 || undefined}>
      <div className="rp-crew-lead">{node(lead)}</div>
      {workers.length > 0 && (
        <>
          <svg
            className="rp-wires rp-crew-wires"
            viewBox="0 0 100 36"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {workers.map((m, i) => {
              const end = (100 * (i + 0.5)) / workers.length
              const bend = Math.sign(end - 50) * 2
              const path = `M50 0 V8 Q50 13 ${50 + bend} 13 H${end - bend} Q${end} 13 ${end} 19 V36`
              return (
                <g key={m.id}>
                  <path d={path} />
                  {m.working && <path d={path} className="rp-travelling" />}
                </g>
              )
            })}
          </svg>
          <div className="rp-crew-workers" style={{ '--crew-count': workers.length } as CSSProperties}>
            {workers.map(node)}
          </div>
        </>
      )}
      {current.tools.length > 0 && <SwitchView>
        <div className="rp-node-detail">
          <strong>{current.name}</strong>
          <span>{current.tools.join(' · ')}</span>
        </div>
      </SwitchView>}
    </div>
  )
}

export interface ToolNode {
  id: string
  name: string
  icon: ReactNode
  calls: number
  state: 'done' | 'running' | 'paused' | 'error' | 'unused'
  duration: string
  input: string
  args: Record<string, unknown>
  result: string
}
function ToolArguments({
  tool,
  onReplay,
}: {
  tool: ToolNode
  onReplay: (id: string, args: Record<string, unknown>) => void
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(tool.args, null, 2)),
    [error, setError] = useState('')
  function replay() {
    let args: unknown
    try {
      args = JSON.parse(draft)
    } catch {
      setError('参数需要是有效的 JSON 对象')
      return
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      setError('参数需要是 JSON 对象')
      return
    }
    onReplay(tool.id, args as Record<string, unknown>)
  }
  return (
    <Disclosure title="调用详情">
      <div className="rp-tool-args">
        <label>
          {tool.input}
          <textarea
            aria-label="工具参数"
            value={draft}
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value)
              setError('')
            }}
          />
        </label>
        {error && <span role="alert">{error}</span>}
        <Button
          onClick={replay}
          disabled={
            tool.state === 'running' ||
            tool.state === 'paused' ||
            draft === JSON.stringify(tool.args, null, 2)
          }
        >
          用新参数重放
        </Button>
      </div>
    </Disclosure>
  )
}
export function ToolAccessMap({
  agents,
  agentId,
  onAgentChange,
  tools,
  selected,
  onSelect,
  onReplay,
}: {
  agents: { id: string; name: string; kind: 'router' | 'worker' }[]
  agentId: string
  onAgentChange: (id: string) => void
  tools: ToolNode[]
  selected: string
  onSelect: (id: string) => void
  onReplay: (id: string, args?: Record<string, unknown>) => void
}) {
  const agent = agents.find((a) => a.id === agentId)!
  const focused = tools.find((t) => t.id === selected) ?? tools[0]
  const split = Math.ceil(tools.length / 2),
    columns = [tools.slice(0, split), tools.slice(split)]
  const nodes = (column: ToolNode[]) =>
    column.map((t) => (
      <button
        type="button"
        key={t.id}
        className="rp-tool-node"
        aria-pressed={focused?.id === t.id}
        onClick={() => onSelect(t.id)}
      >
        <span>
          {t.icon}
          <strong>{t.name}</strong>
        </span>
        <small>
          {t.state === 'running'
            ? '调用中'
            : t.state === 'paused'
              ? '已暂停'
              : t.state === 'error'
                ? '失败'
                : t.calls
                  ? t.calls + ' 次调用'
                  : '未调用'}
        </small>
      </button>
    ))
  return (
    <div className="rp-access">
      <ChoiceGroup
        label="工具所属 Agent"
        value={agentId}
        choices={agents.map((a) => ({ value: a.id, label: a.name }))}
        onChange={onAgentChange}
      />
      <div className="rp-map">
        <svg
          className="rp-wires rp-map-wires"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {columns.flatMap((column, side) =>
            column.map((t, i) => {
              const y = ((i + 0.5) * 100) / column.length,
                x = side ? 68 : 32,
                bendX = side ? 2 : -2,
                bendY = Math.sign(y - 50) * 3
              const path = [
                `M50 50 H${x - bendX} Q${x} 50 ${x} ${50 + bendY}`,
                `V${y - bendY} Q${x} ${y} ${x + bendX} ${y} H${side ? 86 : 14}`,
              ].join(' ')
              return (
                <g key={t.id} data-unused={t.state === 'unused'}>
                  <path d={path} />
                  {t.state === 'running' && <path d={path} className="rp-travelling" />}
                </g>
              )
            }),
          )}
        </svg>
        <div className="rp-map-column">{nodes(columns[0]!)}</div>
        <div className="rp-map-agent">
          <AgentAvatar kind={agent.kind} id={agent.id} size={29} />
          <strong>{agent.name}</strong>
        </div>
        <div className="rp-map-column">{nodes(columns[1]!)}</div>
      </div>
      {focused && (
        <SwitchView>
          <div className="rp-map-receipt">
            <div>
              <strong>{focused.name}</strong>
              <small>
                {focused.state === 'running'
                  ? '调用中'
                  : focused.state === 'paused'
                    ? '已暂停'
                    : focused.result}
              </small>
            </div>
            <Button
              tone="quiet"
              disabled={focused.state === 'running' || focused.state === 'paused'}
              onClick={() => onReplay(focused.id)}
            >
              <RotateCcw size={14} />
              {focused.calls ? '重放' : '试运行'}
            </Button>
          </div>
        </SwitchView>
      )}
      {focused && <ToolArguments key={focused.id} tool={focused} onReplay={onReplay} />}
    </div>
  )
}

export interface HandoffLeg {
  id: string
  label: string
  from: string
  to: string
  items: { name: string; carried: boolean }[]
}
export function AgentHandoff({
  route,
  legs,
  active,
  onChange,
}: {
  route: { name: string; kind: 'router' | 'worker'; id: string }[]
  legs: HandoffLeg[]
  active: number
  onChange: (n: number) => void
}) {
  const leg = legs[active]
  if (!leg) return null
  return (
    <div className="rp-handoff">
      <div className="rp-relay">
        {route.map((node, i) => (
          <div className="rp-relay-stop" key={i}>
            {i > 0 && (
              <span className="rp-relay-track" data-active={i === active + 1}>
                <i key={leg.id} />
              </span>
            )}
            <span className="rp-relay-node" data-active={i === active + 1}>
              <AgentAvatar id={node.id} kind={node.kind} size={23} />
              <b>{node.name}</b>
            </span>
          </div>
        ))}
      </div>
      <ChoiceGroup
        label="交接记录"
        value={leg.id}
        choices={legs.map((l) => ({ value: l.id, label: l.label }))}
        onChange={(id) => onChange(legs.findIndex((l) => l.id === id))}
      />
      <SwitchView>
        <div className="rp-handoff-receipt">
          <strong>
            {leg.from}
            <ArrowRight size={14} />
            {leg.to}
          </strong>
          <ul>
            {leg.items.map((item) => (
              <li key={item.name}>
                {item.carried ? <Check size={14} /> : <CircleAlert size={14} />}
                <span>{item.name}</span>
                <small>{item.carried ? '已传递' : '未传递'}</small>
              </li>
            ))}
          </ul>
        </div>
      </SwitchView>
    </div>
  )
}

export interface CallEntry {
  id: string
  name: string
  summary: string
  status: 'working' | 'paused' | 'done' | 'error'
  elapsed: string
  args?: Record<string, unknown>
  result?: unknown
  details?: [string, string][]
  timestamp?: string
  arrival?: boolean
}
export function ToolCallCard({
  calls,
  onRetry,
  L = zh,
  showHeading = true,
}: {
  showHeading?: boolean
  calls: CallEntry[]
  onRetry?: (id: string) => void
  L?: (en: string, zh: string) => string
}) {
  const running = calls.filter((c) => c.status === 'working').length
  return (
    <div className="rp-call-group">
      {showHeading && (
        <div className="rp-card-kicker">
          <span>{L('Tool calls', '工具调用')}</span>
          <span>{running ? running + L(' running', ' 项执行中') : calls.length + L(' calls', ' 次')}</span>
        </div>
      )}
      {calls.map((c) => (
        <Disclosure
          key={c.id}
          arrival={c.arrival}
          title={
            <span className="rp-call-heading">
              {c.status === 'done' ? (
                <Check size={15} />
              ) : c.status === 'error' ? (
                <CircleAlert size={15} />
              ) : c.status === 'paused' ? (
                <Pause size={15} />
              ) : (
                <i className="rp-live-dot" data-working="true" />
              )}
              <span>
                <b>{c.name}</b>
                <small>{c.summary}</small>
              </span>
              <time>{[c.timestamp, c.elapsed].filter(Boolean).join(' · ')}</time>
            </span>
          }
        >
          <div className="rp-call-data">
            {(
              c.details ?? [
                [L('Arguments', '参数'), JSON.stringify(c.args, null, 2)],
                [
                  L('Result', '结果'),
                  c.status === 'working'
                    ? L('Waiting for result…', '等待结果…')
                    : typeof c.result === 'string'
                      ? c.result
                      : JSON.stringify(c.result, null, 2),
                ],
              ]
            ).map(([label, value]) => (
              <div key={label}>
                <header>
                  <span>{label}</span>
                  <CopyButton value={value ?? ''} L={L} label={L('Copy ', '复制') + label} />
                </header>
                <pre>{value}</pre>
              </div>
            ))}
            {c.status === 'error' && onRetry && (
              <Button onClick={() => onRetry(c.id)}>
                <RotateCcw size={13} />
                {L('Retry', '重试调用')}
              </Button>
            )}
          </div>
        </Disclosure>
      ))}
    </div>
  )
}
