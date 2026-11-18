import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import type { ChatSessions } from '../../src/chat.ts'
import type { ChatDecision, PreviewCard, PublicPlan } from '../../src/chat-workflow.ts'
import { AgentPlan } from '../ui/agent-run.tsx'
import { ApprovalCard, DecisionCard } from '../ui/agent-decisions.tsx'
import { ToolCallCard } from '../ui/agent-team.tsx'

type Snapshot = ReturnType<ChatSessions['view']>
type Request = Snapshot['approvals'][number]
type Localize = (en: string, zh: string) => string
type Plan = {
  id: string
  title: string
  steps: { id: string; title: string; state?: PublicPlan['steps'][number]['state']; workerId?: string }[]
  live: boolean
}
type Block = { plans: Plan[]; calls: Snapshot['calls']; approvals: Request[] }
const internalTools = new Set([
  'chat_request_decision',
  'chat_preview_cards',
  'superagent_plan',
  'superagent_status',
  'chat_react',
])

export function groupWorkflow(
  snapshot: Snapshot | null,
  messages: Snapshot['messages'],
  workerId?: string,
) {
  const blocks = new Map<string, Block>()
  if (!snapshot) return blocks
  const turns = new Map<string, string>(),
    tickets = new Map<string, string>()
  for (const m of messages) {
    if (!turns.has(m.runId) || m.role === 'user') turns.set(m.runId, m.id)
    if (m.ticketId && !tickets.has(m.ticketId)) tickets.set(m.ticketId, m.id)
  }
  const find = (run: string, ticket?: string) => (ticket && tickets.get(ticket)) || turns.get(run)
  function block(id: string) {
    if (!blocks.has(id)) blocks.set(id, { plans: [], calls: [], approvals: [] })
    return blocks.get(id)!
  }
  const graphs = new Set<string>()
  for (const goal of snapshot.plans) {
    if (workerId) continue
    const id = find(goal.runId) ?? (goal.state === 'active' ? 'pending' : undefined)
    if (id) {
      graphs.add(goal.runId)
      block(id).plans.push({ ...goal, live: goal.state === 'active' })
    }
  }
  for (const p of snapshot.publicPlans) {
    if ((workerId && workerId !== p.workerId) || (!p.workerId && graphs.has(p.runId))) continue
    const id = find(p.runId, p.ticketId) ?? (p.live ? 'pending' : undefined)
    if (id) block(id).plans.push(p)
  }
  for (const call of snapshot.calls) {
    if (workerId && workerId !== call.workerId) continue
    const id = find(call.runId, call.ticketId) ?? (call.state === 'running' ? 'pending' : undefined)
    if (!id) continue
    if (call.kind === 'tool' && !internalTools.has(call.name)) block(id).calls.push(call)
  }
  for (const a of snapshot.approvals) {
    if (workerId && a.workerId !== workerId) continue
    const id = find(a.runId, a.ticketId) ?? (a.state === 'pending' ? 'pending' : undefined)
    if (id) block(id).approvals.push(a)
  }
  return blocks
}

type FlowProps = {
  L: Localize
  blocks: Map<string, Block>
  readonly: boolean
  decide: (id: string, answer: string) => Promise<void>
  authorize: (id: string, value: unknown) => Promise<void>
  tools: (calls: Snapshot['calls']) => ReactNode
}
const Flow = createContext<FlowProps | null>(null)
export const WorkflowProvider = Flow.Provider

function useSubmit(L: Localize) {
  const lock = useRef(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const submit = async (action: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      await action()
    } catch {
      setError(
        L('Could not submit. Check the current request and try again.', '提交失败，请查看请求状态后重试。'),
      )
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return {
    busy,
    submit,
    error: error ? (
      <p role="alert" className="workflow-error">
        {error}
      </p>
    ) : null,
  }
}
export function CardPreview({ cards }: { cards: PreviewCard[] }) {
  const { L } = useContext(Flow)!
  const [approval, setApproval] = useState<'pending'|'approved'|'denied'>('pending')
  const [answer, setAnswer] = useState<string|null>(null)
  const filename = 'notes.md'
  return (
    <section className="roppo-ui workflow-block card-preview" aria-label={L('Card preview', '卡片示例')}>
      <h4>{L('Interactive preview', '交互示例')}</h4>
      {cards.map(card => {
        switch (card) {
          case 'approval': return <ApprovalCard key={card} L={L} title={L('Read a file', '读取文件')}
            risk={L('Preview', '示例')} state={approval} onDecision={setApproval} onReset={() => setApproval('pending')}
            details={[{label:L('File', '文件'),value:filename}]} />
          case 'decision': return <DecisionCard key={card} L={L} question={L('How should the notes be arranged?', '你希望如何整理笔记？')}
            options={[{id:'list', label:L('List', '列表'),detail:''},{id:'table',label:L('Table', '表格'),detail:''}]}
            answer={answer} onAnswer={setAnswer} onReset={() => setAnswer(null)} />
          case 'plan': return <AgentPlan key={card} L={L} title={L('Organize the notes', '整理笔记')} live={false}
            steps={[{id:'read',title:L('Read the notes', '阅读笔记'),tool:'',state:'completed'},
              {id:'group',title:L('Group by topic', '按主题整理'),tool:'',state:'pending'}]} />
          case 'tools': return <ToolCallCard key={card} L={L} calls={[{id:'example',name:'router_read',
            summary:filename,status:'done',elapsed:'',details:[[L('File', '文件'),filename],[L('Result','结果'),L('Example note','示例笔记')]]}]} />
        }
      })}
    </section>
  )
}

export function RouterDecision({ id, decision }: { id: string; decision: ChatDecision }) {
  const { L, decide, readonly } = useContext(Flow)!
  const { busy, submit, error } = useSubmit(L)
  return (
    <div className="roppo-ui workflow-card">
      <DecisionCard
        L={L}
        question={decision.question}
        options={decision.options.map((o, i) => ({
          id: String(i),
          label: o.label,
          detail: o.detail ?? '',
        }))}
        answer={decision.answer ?? null}
        disabled={busy || readonly}
        onAnswer={(answer) => void submit(() => decide(id, answer))}
      />
      {error}
    </div>
  )
}

function NativeCard({ request: a }: { request: Request }) {
  const { L, authorize, readonly } = useContext(Flow)!,
    { busy, submit, error } = useSubmit(L)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const pending = a.state === 'pending',
    disabled = busy || readonly
  if (a.method === 'item/tool/requestUserInput') {
    if (!pending)
      return (
        <div className="rp-native-closed" role="status">
          {a.questions.map((q) => q.question).join(' · ')} ·{' '}
          {a.state === 'expired' ? L('Expired', '已过期') : L('Answered', '已答复')}
        </div>
      )
    const send = (values: Record<string, string>) =>
      submit(() =>
        authorize(
          a.id,
          Object.fromEntries(Object.entries(values).map(([id, answer]) => [id, { answers: [answer] }])),
        ),
      )
    return (
      <section className="workflow-questions">
        {a.questions.map((q) => (
          <DecisionCard
            key={q.id}
            L={L}
            question={q.question}
            options={q.options.map((o, i) => ({ ...o, id: String(i) }))}
            allowCustom={q.custom}
            secret={q.secret}
            answer={answers[q.id] ? (q.secret ? '••••' : answers[q.id]!) : null}
            disabled={disabled}
            onReset={a.questions.length > 1 ? () => setAnswers((v) => ({ ...v, [q.id]: '' })) : undefined}
            onAnswer={(value) => {
              const next = { ...answers, [q.id]: value }
              if (a.questions.length === 1) void send(next)
              else setAnswers(next)
            }}
          />
        ))}
        {a.questions.length > 1 && (
          <button
            type="button"
            className="rp-button"
            data-tone="primary"
            disabled={disabled || !a.questions.every((q) => answers[q.id])}
            onClick={() => void send(answers)}
          >
            {L('Submit answers', '提交答复')}
          </button>
        )}
        {error}
      </section>
    )
  }
  const labels: Record<string, string> = {
    command: L('Command', '命令'),
    commandActions: L('Command actions', '命令操作'),
    cwd: L('Directory', '工作目录'),
    reason: L('Reason', '原因'),
    grantRoot: L('Access path', '授权路径'),
    permissions: L('Permissions', '权限'),
    additionalPermissions: L('Additional permissions', '额外权限'),
    networkApprovalContext: L('Network access', '网络访问'),
    proposedExecpolicyAmendment: L('Suggested command rule', '建议的命令规则'),
    proposedNetworkPolicyAmendments: L('Suggested network rules', '建议的网络规则'),
  }
  const titles: Record<string, string> = {
    'item/commandExecution/requestApproval': L('Run command', '执行命令'),
    'item/fileChange/requestApproval': L('Change files', '修改文件'),
    'item/permissions/requestApproval': L('Grant permissions', '授予权限'),
  }
  return (
    <>
      <ApprovalCard
        L={L}
        title={titles[a.method] ?? L('Authorization request', '授权请求')}
        risk={a.workerId}
        state={a.state === 'answered' ? 'resolved' : a.state}
        details={Object.entries(a.facts).map(([key, value]) => ({ label: labels[key] ?? key, value }))}
        disabled={disabled}
        onDecision={(value) =>
          void submit(() => authorize(a.id, value === 'approved' ? 'accept' : 'decline'))
        }
      />
      {error}
    </>
  )
}
export function WorkflowCards({ anchor }: { anchor: string }) {
  const { L, blocks, tools } = useContext(Flow)!,
    b = blocks.get(anchor)
  if (!b) return null
  const states = {
    pending: L('Pending', '待执行'),
    running: L('In progress', '进行中'),
    completed: L('Completed', '已完成'),
    blocked: L('Blocked', '受阻'),
  }
  return (
    <section className="roppo-ui workflow-block" aria-label={L('Run activity', '执行活动')}>
      {b.plans.map((p) => (
        <div className="workflow-plan" key={p.id}>
          <AgentPlan
            L={L}
            title={p.title}
            live={p.live}
            steps={p.steps.map((s) => ({
              ...s,
              tool: [s.workerId, s.state && states[s.state]].filter(Boolean).join(' · '),
            }))}
          />
        </div>
      ))}
      {!!b.calls.length && tools(b.calls)}
      {b.approvals.map((a) => (
        <NativeCard key={a.id} request={a} />
      ))}
    </section>
  )
}
