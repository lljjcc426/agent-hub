import {ChevronDown} from 'lucide-react'
import {pendingHref} from './pending-links.ts'
import { DisclosureRoot, DisclosureSummary } from '../ui/overlays.tsx'
import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import type { ChatSessions, FileReview } from '../../src/chat.ts'
import type { ChatDecision, PublicPlan } from '../../src/chat-workflow.ts'
import { AgentPlan } from '../ui/agent-run.tsx'
import { ApprovalCard, DecisionCard } from '../ui/agent-decisions.tsx'
import { WorkerQuestion } from './worker-question-preview.tsx'
import type { DecisionAttempt } from './decision-state.ts'
import { DeliveryReviewCard } from '../ui/delivery-review.tsx'
import { PendingRequests } from '../ui/pending-requests.tsx'

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
    if(workerId||!goal.steps.length)continue
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
  conversation:string
  pendingIds:ReadonlySet<string>
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

// The host binds each link to its item. The model supplies plain text, never a destination.
export function PendingNotice({id,kind,notice,subject,status}:{
  id:string;kind:'approval'|'answer'|'review';notice?:string;subject?:string;status?:string
}) {
  const {L,conversation,pendingIds}=useContext(Flow)!
  const label=kind==='approval'?L('approval','审批'):kind==='review'?L('review','审阅'):L('answer','回答')
  const words=kind==='approval'?/审批|批准|\bapproval\b|\bapprove\b/i:kind==='review'?/审阅|审批|\breview\b/i:/回答|选择|答复|\banswer\b|\bchoose\b/i
  const text=notice?.trim()||subject||''
  if(!pendingIds.has(id))return <p className="pending-notice resolved" data-workflow-id={id}>{subject||label} · {status||L('Closed','已结束')}</p>
  const word=words.exec(text)
  const link=<a className="pending-action-link" href={pendingHref(conversation,id)}>{word?.[0]||label}</a>
  return <p className="pending-notice" data-workflow-id={id}>{word
    ? <>{text.slice(0,word.index)}{link}{text.slice(word.index+word[0].length)}</>
    : <>{text}{text?' ':''}{link}</>}</p>
}

function approvalOutcome(a:Request,L:Localize) {
  if(a.state==='denied')return L('Denied','已拒绝')
  if(a.state==='expired')return L('Expired','已过期')
  if(a.state==='answered')return ['answerText' in a && a.answerText,L('Answered','已回答')].filter(Boolean).join(' · ')
  if('executionState' in a){
    switch(a.executionState){
      case 'failed': return L('Approved · execution failed','已批准 · 执行失败')
      case 'uncertain': return L('Outcome unconfirmed','执行结果待核对')
      case 'complete': return L('Approved · completed','已批准 · 执行成功')
      case 'executing': return L('Approved · running','已批准 · 执行中')
      case 'cancelled': return L('Cancelled','已取消')
    }
  }
  return a.state==='approved'?L('Approved','已批准'):undefined
}

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
function FileReviewCard({ id, name, review }: { id: string; name: string; review: FileReview }) {
  const { L, readonly, readDraft, reviewFile } = useContext(Flow)!
  const { busy, submit, error } = useSubmit(L)
  return (
    <div className="roppo-ui workflow-card">
      <DeliveryReviewCard key={review.fileId} name={name} state={review.state} L={L}
        disabled={readonly || busy} readDraft={async () => (await readDraft(id)).text}
        onDecision={state => void submit(() => reviewFile(id, state))}/>
      {error}
    </div>
  )
}

function RouterDecision({ id, decision }: { id: string; decision: ChatDecision }) {
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
  const facts = Object.entries(a.facts)
  const detailed = (value: string) => value.length > 180 || value.includes('\n')
  return (
    <>
      <ApprovalCard
        L={L}
        title={titles[a.method] ?? L('Authorization request', '授权请求')}
        risk={actor(a.workerId)}
        statusLabel={approvalOutcome(a,L)}
        state={a.state === 'answered' ? 'resolved' : a.state}
        details={facts.filter(([, value]) => !detailed(value)).map(([key, value]) => ({ label: labels[key] ?? key, value }))}
        disabled={disabled}
        onDecision={(value) =>
          void submit(() => authorize(a.id, value === 'approved' ? 'accept' : 'decline'))
        }
      >
        {facts.filter(([, value]) => detailed(value)).map(([key,value]) =>
          <DisclosureRoot className="workflow-draft pending-fact" key={key}>
            <DisclosureSummary>{labels[key] ?? key}<ChevronDown size={13} aria-hidden="true"/></DisclosureSummary>
            <pre tabIndex={0}>{value}</pre>
          </DisclosureRoot>)}
      </ApprovalCard>
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
    if(item.kind==='question'){
      const q=item.question
      rows.push(<PendingNotice key={q.id} id={q.id} kind="answer" subject={q.question} status={q.answer?.text}/>)
    }else if(item.kind==='approval'){
      const a=item.approval, question=a.method==='item/tool/requestUserInput'
      const subject = question ? a.questions.map(q=>q.question).join(' · ')
        : a.notice || a.facts.reason?.slice(0,360) || a.facts.target?.slice(0,120) || (a.facts.command ? L('Run command','运行命令') : undefined)
      rows.push(<PendingNotice key={a.id} id={a.id} kind={question?'answer':'approval'} notice={a.notice} subject={subject} status={approvalOutcome(a,L)}/>)
    }
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


// The tray belongs to the conversation owner even when the transcript shows a read-only Worker.
export function PendingTray({cards,loading,selectedId,close,locate}:{selectedId?:string;cards:Snapshot['pendingCards'];loading:boolean;close:()=>void;locate:(card:Snapshot['pendingCards'][number])=>void}){
  const flow=useContext(Flow)!
  return <Flow.Provider value={{...flow,readonly:false}}>
    <PendingRequests L={flow.L} loading={loading} selectedId={selectedId} close={close}
      items={cards.map(card => ({id:card.id, locate:()=>locate(card), content:
        card.kind==='choice'?<RouterDecision id={card.id} decision={card.decision}/>:
        card.kind==='file'?<FileReviewCard id={card.id} name={card.name} review={card.review}/>:
        card.kind==='approval'?<NativeCard request={card.request}/>:
        <WorkerQuestion key={card.question.version} item={card.question} L={flow.L} readonly={false} send={flow.answerWorker} refresh={flow.refresh}/>,
      }))}/>
  </Flow.Provider>
}
