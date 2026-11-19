import {ArrowLeft,ChevronDown,History} from 'lucide-react'
import {pendingHref} from './pending-links.ts'
import { DisclosureRoot, DisclosureSummary } from '../ui/overlays.tsx'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatSessions, FileReview } from '../../src/chat.ts'
import type { ChatDecision, PublicPlan } from '../../src/chat-workflow.ts'
import { AgentPlan } from '../ui/agent-run.tsx'
import { Button } from '../ui/controls.tsx'
import { DecisionCard } from '../ui/agent-decisions.tsx'
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
type ChatCall = Snapshot['calls'][number]
type CallItem = {kind:'call'; at:number; call:ChatCall; parentId?:string; model?:ChatCall}
type FlowItem =
  | {kind:'plan'; at:number; plan:Plan}
  | CallItem
  | {kind:'question'; at:number; question:Snapshot['decisions'][number]}
  | {kind:'approval'; at:number; approval:Request}
type Block=FlowItem[]
const internalTools = new Set([
  'chat_opening',
  'chat_request_decision',
  'chat_deliver_file',
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
    if(!anchor)return false
    const block=blocks.get(anchor)??[]
    block.push(item);blocks.set(anchor,block)
    return true
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
  const models=new Map(snapshot.calls.filter(call=>call.kind!=='tool' && (call.kind===call.name||call.status)
    && (!workerId||call.workerId===workerId)).map(call=>[call.id,call]))
  const attached=new Set<string>()
  for(const call of snapshot.calls){
    if(call.kind!=='tool'||internalTools.has(call.name)||workerId&&workerId!==call.workerId)continue
    if(call.permission==='pending' && snapshot.approvals.some(a=>a.runId===call.runId && a.workerId===call.workerId))continue
    const candidates=call.parentId ? [] : [...models.values()].filter(model=>
      model.runId===call.runId&&model.workerId===call.workerId&&model.ticketId===call.ticketId&&
      model.startedAt<=call.startedAt&&(model.endedAt===undefined||model.endedAt>=call.startedAt))
    const parent=call.parentId ? models.get(call.parentId) : candidates.length===1?candidates[0]:undefined
    const model=parent?.runId===call.runId && !attached.has(parent.id) ? parent : undefined
    if(add(call.runId,call.ticketId,{kind:'call',at:call.startedAt,call,parentId:call.parentId??parent?.id,model},call.state==='running') && model)
      attached.add(model.id)
  }
  // A model that called a visible tool shares that tool’s existing position.
  // Keep tool-free activity while it is live or has a recorded public update.
  for(const model of models.values()){
    if(attached.has(model.id) || (model.state!=='running'&&!model.status)) continue
    add(model.runId,model.ticketId,{kind:'call',at:model.startedAt,call:model},model.state==='running')
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
  thinking: (calls: ChatCall[], model?: ChatCall) => ReactNode
}
const Flow = createContext<FlowProps | null>(null)
export const WorkflowProvider = Flow.Provider

// The author controls the sentence; only the host can bind a real request to a link.
export function PendingNotice({id,kind,notice,subject,status}:{
  id:string;kind:'approval'|'answer'|'review';notice?:string;subject?:string;status?:string
}) {
  const {L,conversation,pendingIds}=useContext(Flow)!
  const text=notice?.trim()||subject||''
  const permission=kind!=='answer'
  if(!permission && !pendingIds.has(id))
    return <p className="pending-notice resolved" data-workflow-id={id}>{subject} · {status||L('Closed','已结束')}</p>
  const words=permission ? (L('en','zh')==='zh'?/审批/:/\bapproval\b/i) : /回答|选择|答复|\banswer\b|\bchoose\b/i
  const word=words.exec(text)
  const label=word?.[0] || (permission?L('approval','审批'):L('answer','回答'))
  const link=<a className={'pending-action-link'+(permission?' approval-link':'')} href={pendingHref(conversation,id)}
    aria-controls="pending-tray">{label}</a>
  return <p className="pending-notice" data-workflow-id={id}>{word
    ? <>{text.slice(0,word.index)}{link}{text.slice(word.index+word[0].length)}</>
    : <>{text}{text?' ':''}{link}</>}</p>
}

function approvalOutcome(a:Request,L:Localize) {
  if(a.state==='denied')return L('Denied','已拒绝')
  if('executionState' in a && a.executionState==='cancelled')return L('Cancelled','已取消')
  if(a.state==='expired')return L('Expired','已过期')
  if(a.state==='answered')return ['answerText' in a && a.answerText,L('Answered','已回答')].filter(Boolean).join(' · ')
  if('executionState' in a){
    switch(a.executionState){
      case 'failed': return L('Approved · execution failed','已批准 · 执行失败')
      case 'uncertain': return L('Outcome unconfirmed','执行结果待核对')
      case 'complete': return L('Approved · completed','已批准 · 执行成功')
      case 'executing': return L('Approved · running','已批准 · 执行中')
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
  const scope=a.facts.target || a.facts.cwd || a.facts.connection
  const facts=Object.entries(a.facts).filter(([key])=>key!=='tool')
  return <section className="permission-review" role="group" aria-label={L('Authorization request','授权请求')}>
    <h3>{titles[a.method] ?? L('Authorization request','授权请求')}</h3>
    <div className="permission-scope">{scope || actor(a.workerId)}</div>
    {a.notice && <p className="permission-reason">{a.notice}</p>}
    {facts.length>0 && <DisclosureRoot className="workflow-draft pending-fact">
      <DisclosureSummary>{a.facts.command?L('View command','查看命令'):L('Request details','请求详情')}<ChevronDown size={14}/></DisclosureSummary>
      <dl>{facts.map(([key,value])=><div key={key}><dt>{labels[key]??key}</dt><dd><pre tabIndex={0}>{value}</pre></dd></div>)}</dl>
    </DisclosureRoot>}
    {pending ? <div className="permission-actions">
      <Button tone="quiet" disabled={disabled} onClick={()=>void submit(()=>authorize(a.id,'decline'))}>{L('Deny','拒绝')}</Button>
      <Button tone="primary" disabled={disabled} onClick={()=>void submit(()=>authorize(a.id,'accept'))}>{L('Allow once','允许一次')}</Button>
    </div> : <p className="permission-result" role="status">{approvalOutcome(a,L)}</p>}
    {error}
  </section>
}
export function WorkflowCards({ anchor }: { anchor: string }) {
  const { L, blocks, thinking } = useContext(Flow)!,
    b = blocks.get(anchor)
  if (!b) return null
  const states = {
    pending: L('Pending', '待执行'),
    running: L('In progress', '进行中'),
    completed: L('Completed', '已完成'),
    blocked: L('Blocked', '受阻'),
  }
  const rows:ReactNode[]=[]
  let previous:CallItem[]=[]
  function flush(){
    const first=previous[0]
    if(first){
      const model=first.call.kind==='tool' ? first.model : first.call
      rows.push(<div key={model?.id??first.call.id}>{thinking(first.call.kind==='tool'?previous.map(item=>item.call):[],model)}</div>)
    }
    previous=[]
  }
  for(const item of b){
    if(item.kind==='call'){
      const last=previous.at(-1)
      if(last&&(last.call.kind!=='tool'||item.call.kind!=='tool'||last.call.runId!==item.call.runId||
        last.parentId!==item.parentId||last.call.workerId!==item.call.workerId||last.call.ticketId!==item.call.ticketId))flush()
      previous.push(item)
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
      if('automatic' in a && a.automatic){
        rows.push(<p className="pending-notice resolved" key={a.id} data-workflow-id={a.id}>{L('Execution needs attention','执行需要检查')}</p>)
        continue
      }
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


type ArchivePage=ReturnType<ChatSessions['approvalHistory']>
type ArchiveRecord=ReturnType<ChatSessions['approvalRecord']>
type ReadHistory=<T>(query:URLSearchParams,signal:AbortSignal)=>Promise<T>

function ArchiveDetail({id,read}:{id:string;read:ReadHistory}){
  const {L}=useContext(Flow)!
  const [record,setRecord]=useState<ArchiveRecord>()
  const [failure,setFailure]=useState(false)
  const [retry,setRetry]=useState(0)
  useEffect(()=>{
    const controller=new AbortController()
    setFailure(false)
    read<ArchiveRecord>(new URLSearchParams({item:id}),controller.signal)
      .then(value=>{if(!controller.signal.aborted)setRecord(value)})
      .catch(()=>{if(!controller.signal.aborted)setFailure(true)})
    return ()=>controller.abort()
  },[id,read,retry])
  if(!record)return <div className="pending-empty" role="status">{failure
    ? <>{L('This record is unavailable.','这条记录暂时无法查看。')} <button className="history-text-button" onClick={()=>setRetry(n=>n+1)}>{L('Retry','重试')}</button></>
    : L('Loading…','加载中…')}</div>
  return <div className="history-detail" data-record-id={record.id}>
    {record.kind==='file'?<section className="permission-review">
      <h3>{record.name}</h3>
      {record.review.notice && <p className="permission-reason">{record.review.notice}</p>}
      <p className="permission-result" role="status">{({
        approved:L('Approved · delivered','已批准 · 文件已交付'),denied:L('Denied','已拒绝'),
        superseded:L('Replaced','已替换'),cancelled:L('Cancelled','已取消'),pending:L('Pending','待处理'),
      })[record.review.state]}</p>
    </section>:<NativeCard request={record.request}/>}
  </div>
}

function HistoryList({read,select}:{read:ReadHistory;select:(id:string)=>void}){
  const {L}=useContext(Flow)!
  const [items,setItems]=useState<ArchivePage['items']>([])
  const [next,setNext]=useState<ArchivePage['next']>(null)
  const [cursor,setCursor]=useState<ArchivePage['next']>(null)
  const [busy,setBusy]=useState(true),[error,setError]=useState(false),[retry,setRetry]=useState(0)
  useEffect(()=>{
    const controller=new AbortController()
    const query=cursor?new URLSearchParams({before:String(cursor.at),beforeId:cursor.id}):new URLSearchParams()
    setBusy(true);setError(false)
    read<ArchivePage>(query,controller.signal).then(page=>{
      if(controller.signal.aborted)return
      setItems(previous=>cursor?[...new Map([...previous,...page.items].map(row=>[row.id,row])).values()]:page.items)
      setNext(page.next);setBusy(false)
    }).catch(()=>{if(!controller.signal.aborted){setError(true);setBusy(false)}})
    return ()=>controller.abort()
  },[read,cursor,retry])
  return <div className="history-list">
    {items.map(item=><button className="history-row" key={item.id} onClick={()=>select(item.id)}>
      <span>{item.label || (item.tool==='superagent_shell'?L('Run command','运行命令'):L('Operation approval','操作审批'))}</span>
      <small>{item.state==='denied'?L('Denied','已拒绝'):['expired','cancelled','superseded'].includes(item.state)?L('Closed','已结束'):L('Approved','已批准')} · <time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString(L('en','zh-CN'),{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></small>
    </button>)}
    {busy?<p role="status">{L('Loading…','加载中…')}</p>:error?<button className="history-text-button" onClick={()=>setRetry(n=>n+1)}>{L('Could not load. Retry','加载失败，重试')}</button>
      :next?<button className="history-text-button" onClick={()=>{setBusy(true);setCursor(next)}}>{L('Load earlier records','加载更早的记录')}</button>
      :!items.length?<p role="status">{L('No approval history yet.','暂无审批记录')}</p>:null}
  </div>
}

// Owner actions remain available in the tray even when viewing a read-only Worker transcript.
export function PendingTray({cards,loading,selectedId,close,locate,read,clearSelection,linkedAnswer}:{
  selectedId?:string;cards:Snapshot['pendingCards'];loading:boolean;close:()=>void;locate:(card:Snapshot['pendingCards'][number])=>void
  read:ReadHistory;clearSelection:()=>void;linkedAnswer:boolean
}){
  const flow=useContext(Flow)!,{L}=flow
  const [history,setHistory]=useState(false),[opened,setOpened]=useState<string>()
  const selected=cards.find(c=>c.id===selectedId)
  const found=!!selected
  const single=selected?.kind==='file'||(selected?.kind==='approval'&&selected.request.method!=='item/tool/requestUserInput')
  const recordId=opened ?? (!loading&&!found&&!linkedAnswer?selectedId:undefined)
  const historyVisible=history||!!recordId
  const navRef=useRef<HTMLButtonElement>(null)
  useEffect(()=>{if(recordId)navRef.current?.focus({preventScroll:true})},[recordId])
  const switchPage=()=>{
    if(single && !historyVisible){clearSelection();return}
    if(recordId){clearSelection();setOpened(undefined);setHistory(true)}
    else {clearSelection();setHistory(!history)}
  }
  const navLabel=recordId?L('Back to approval history','返回审批记录'):(history||single)?L('Back to pending requests','返回待处理事项'):L('Approval history','审批记录')
  const archiveButton=<button ref={navRef} type="button" className="icon-button history-access" title={navLabel} aria-label={navLabel} onClick={switchPage}>
    {historyVisible||single?<ArrowLeft size={16}/>:<><History size={15}/><span>{L('History','记录')}</span></>}
  </button>
  return <Flow.Provider value={{...flow,readonly:false}}>
    <PendingRequests L={L} loading={loading} selectedId={linkedAnswer&&!found?undefined:selectedId} close={close}
      heading={historyVisible?L('Approval history','审批记录'):undefined} navigation={archiveButton}
      items={(single?[selected]:cards).map(card=>({id:card.id,locate:()=>locate(card),content:
        card.kind==='choice'?<RouterDecision id={card.id} decision={card.decision}/>:
        card.kind==='file'?<FileReviewCard id={card.id} name={card.name} review={card.review}/>:
        card.kind==='approval'?<NativeCard request={card.request}/>:
        <WorkerQuestion key={card.question.version} item={card.question} L={L} readonly={false} send={flow.answerWorker} refresh={flow.refresh}/>,
      }))}>
      {historyVisible ? <>
        {history && <div hidden={!!recordId} className="history-scroll"><HistoryList read={read} select={setOpened}/></div>}
        {recordId && <ArchiveDetail key={recordId} id={recordId} read={read}/>}
      </> : undefined}
    </PendingRequests>
  </Flow.Provider>
}
