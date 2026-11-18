import { DisclosureRoot, DisclosureSummary } from '../ui/overlays.tsx'
import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import type { ChatSessions, FileReview } from '../../src/chat.ts'
import type { ChatDecision, PublicPlan } from '../../src/chat-workflow.ts'
import { AgentPlan } from '../ui/agent-run.tsx'
import { ApprovalCard, DecisionCard } from '../ui/agent-decisions.tsx'
import { WorkerQuestion } from './worker-question-preview.tsx'
import type { DecisionAttempt } from './decision-state.ts'
import { ChevronDown } from 'lucide-react'

type Snapshot = ReturnType<ChatSessions['view']>
type Request = Snapshot['approvals'][number]
type Localize = (en: string, zh: string) => string
type Plan = {
  id: string
  title: string
  steps: { id: string; title: string; state?: PublicPlan['steps'][number]['state']; workerId?: string }[]
  live: boolean
}
type FlowItem =
  | {kind:'plan'; at:number; plan:Plan}
  | {kind:'call'; at:number; call:Snapshot['calls'][number]}
  | {kind:'question'; at:number; question:Snapshot['decisions'][number]}
  | {kind:'approval'; at:number; approval:Request}
type Block=FlowItem[]
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
  const byRun=new Map<string,Snapshot['messages']>()
  for(const message of messages){
    const turn=byRun.get(message.runId)??[]
    turn.push(message)
    byRun.set(message.runId,turn)
  }
  function add(runId:string,ticketId:string|undefined,item:FlowItem,active:boolean){
    const turn=byRun.get(runId)??[]
    // Place the event after the preceding visible message, also when the Worker transcript is filtered.
    const before=turn.filter(m=>m.createdAt<=item.at)
    const anchor=(ticketId&&before.findLast(m=>m.ticketId===ticketId)?.id)||before.at(-1)?.id||turn[0]?.id||(active?'pending':undefined)
    if(!anchor)return
    const block=blocks.get(anchor)??[]
    block.push(item);blocks.set(anchor,block)
  }
  const graphs=new Set<string>()
  for(const goal of snapshot.plans){
    if(workerId)continue
    graphs.add(goal.runId)
    add(goal.runId,undefined,{kind:'plan',at:goal.createdAt,plan:{...goal,live:goal.state==='active'}},goal.state==='active')
  }
  for(const p of snapshot.publicPlans){
    if(workerId&&workerId!==p.workerId||!p.workerId&&graphs.has(p.runId))continue
    add(p.runId,p.ticketId,{kind:'plan',at:p.createdAt??0,plan:p},p.live)
  }
  for(const call of snapshot.calls){
    if(call.kind!=='tool'||internalTools.has(call.name)||workerId&&workerId!==call.workerId)continue
    add(call.runId,call.ticketId,{kind:'call',at:call.startedAt,call},call.state==='running')
  }
  for(const approval of snapshot.approvals){
    if(workerId&&workerId!==approval.workerId)continue
    add(approval.runId,approval.ticketId,{kind:'approval',at:approval.createdAt,approval},approval.state==='pending')
  }
  for(const question of snapshot.decisions??[]){
    if(workerId&&workerId!==question.workerId)continue
    add(question.runId,question.ticketId,{kind:'question',at:question.createdAt,question},false)
  }
  for(const block of blocks.values())block.sort((a,b)=>a.at-b.at)
  return blocks
}

type FlowProps = {
  L: Localize
  blocks: Map<string, Block>
  readonly: boolean
  actor:(id:string)=>string
  decide: (id: string, answer: string) => Promise<void>
  answerWorker:(body:DecisionAttempt)=>Promise<unknown>
  refresh:()=>Promise<void>
  readDraft: (id: string) => Promise<{ text: string }>
  reviewFile: (id: string, state: 'approved' | 'denied') => Promise<void>
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
export function FileReviewCard({ id, name, review }: { id: string; name: string; review: FileReview }) {
  const { L, readonly, readDraft, reviewFile } = useContext(Flow)!
  const { busy, submit, error } = useSubmit(L)
  const [draft, setDraft] = useState<string | null>(null)
  const [readError, setReadError] = useState(false)
  async function openDraft() {
    if (draft !== null) return
    setReadError(false)
    try { setDraft((await readDraft(id)).text) }
    catch { setReadError(true) }
  }
  const pending = review.state === 'pending'
  return (
    <div className="roppo-ui workflow-card">
      <ApprovalCard L={L} title={name} risk={L('File delivery', '文件交付')} details={[]}
        state={review.state === 'superseded' || review.state === 'cancelled' ? 'resolved' : review.state}
        statusLabel={review.state === 'superseded' ? L('Replaced', '已替换') : review.state === 'cancelled' ? L('Cancelled', '已取消') : undefined}
        actionLabels={{approve: L('Deliver file', '确认交付'), deny: L('Decline', '拒绝交付')}}
        disabled={readonly || busy}
        onDecision={(state) => void submit(() => reviewFile(id, state))}>
        {pending && <DisclosureRoot className="workflow-draft" onToggle={e => { if(e.currentTarget.open) void openDraft() }}>
          <DisclosureSummary>{L('Read draft', '查看原文')}<ChevronDown size={13} aria-hidden="true" /></DisclosureSummary>
          {draft !== null ? <pre tabIndex={0}>{draft}</pre>
            : <span role="status">{readError ? L('Could not load. Reopen to retry.', '读取失败，请重新展开。') : L('Loading…', '读取中…')}</span>}
        </DisclosureRoot>}
      </ApprovalCard>
      {error}
    </div>
  )
}

export function RouterDecision({ id, decision }: { id: string; decision: ChatDecision }) {
  const { L, decide, readonly } = useContext(Flow)!
  const { busy, submit, error } = useSubmit(L)
  if (decision.closed) return <div className="rp-native-closed" role="status">{decision.question} · {L('Cancelled', '已取消')}</div>
  return (
    <div className="roppo-ui workflow-card">
      <DecisionCard
        L={L}
        question={decision.question}
        options={decision.options.map((o, i) => ({
          id: String(i),
          label: o.label,
          detail: [o.label===decision.defaultOption&&!decision.answer?L('Using this option','正按此选项进行'):null,o.detail].filter(Boolean).join(' · '),
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
  const { L, authorize, readonly, actor } = useContext(Flow)!,
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
    tool:L('Tool','工具'),action:L('Action','操作'),change:L('Change','变更'),target:L('Target','目标'),version:L('Version','版本'),branch:L('Branch','分支'),sha:L('Commit','提交'),connection:L('Connection','连接'),access:L('Access','访问权限'),
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
  const actionTitles:Record<string,string>={
    superagent_shell:a.facts.target?L('Write to shared directory','写入共享目录'):a.facts.access==='network'?L('Run command with network access','联网运行命令'):L('Run command','运行命令'),
    superagent_publish:L('Publish draft','发布草稿'),superagent_review:L('Submit review','提交评审'),
    superagent_workflow:L('Change issue status','修改事项状态'),superagent_ack:L('Send reply','发送回复'),
    superagent_browser:L('Interact with page','操作网页'),workspace_browser:L('Interact with page','操作网页'),
    worker_manage:L('Change Worker','更改 Worker'),router_knowledge:L('Change document','更改文档'),
  }
  const titles: Record<string, string> = {
    'roppo/tool': actionTitles[a.facts.tool??'']??a.facts.tool??L('Run this action','执行本次操作'),
    'item/commandExecution/requestApproval': L('Run command', '执行命令'),
    'item/fileChange/requestApproval': L('Change files', '修改文件'),
    'item/permissions/requestApproval': L('Grant permissions', '授予权限'),
  }
  return (
    <>
      <ApprovalCard
        L={L}
        title={titles[a.method] ?? L('Authorization request', '授权请求')}
        risk={actor(a.workerId)}
        statusLabel={'executionState' in a && typeof a.executionState==='string' ? ({uncertain:L('Outcome unconfirmed','结果待核对'),failed:L('Execution failed','执行失败'),cancelled:L('Cancelled','已取消')} as Record<string,string>)[a.executionState] : undefined}
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
  const { L, blocks, tools, readonly, answerWorker, refresh } = useContext(Flow)!,
    b = blocks.get(anchor)
  if (!b) return null
  const states = {
    pending: L('Pending', '待执行'),
    running: L('In progress', '进行中'),
    completed: L('Completed', '已完成'),
    blocked: L('Blocked', '受阻'),
  }
  const rows:ReactNode[]=[]
  let previous:Snapshot['calls']=[]
  function flush(){
    if(previous.length)rows.push(<div key={previous[0]!.id}>{tools(previous)}</div>)
    previous=[]
  }
  for(const item of b){
    if(item.kind==='call'){
      const last=previous.at(-1)
      if(last&&(last.parentId!==item.call.parentId||last.workerId!==item.call.workerId))flush()
      previous.push(item.call)
      continue
    }
    flush()
    if(item.kind==='question')rows.push(<WorkerQuestion key={item.question.id+item.question.version} item={item.question} L={L} readonly={readonly} send={answerWorker} refresh={refresh}/>)
    else if(item.kind==='approval')rows.push(<NativeCard key={item.approval.id} request={item.approval}/>)
    else {
      const p=item.plan
      rows.push(<div className="workflow-plan" key={p.id}>
        <AgentPlan L={L} title={p.title} live={p.live} steps={p.steps.map(s=>({...s,tool:[s.workerId,s.state&&states[s.state]].filter(Boolean).join(' · ')}))}/>
      </div>)
    }
  }
  flush()
  return <section className="roppo-ui workflow-block" aria-label={L('Run activity','执行活动')}>{rows}</section>
}
