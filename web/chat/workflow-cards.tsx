import {ArrowLeft, ChevronDown, ChevronRight, CircleHelp, FileText, History, Search, ShieldCheck} from 'lucide-react'
import {pendingHref} from './pending-links.ts'
import { DisclosureRoot, DisclosureSummary } from '../ui/overlays.tsx'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatRunState, ChatSessions, FileReview } from '../../src/chat.ts'
import type { ChatDecision, PublicPlan } from '../../src/chat-workflow.ts'
import { AgentPlan } from '../ui/agent-run.tsx'
import { Button } from '../ui/controls.tsx'
import {AnswerFields, ApprovalFrame, ApprovalStatus, QuestionCard, type ApprovalResult} from './approval-card.tsx'
import { WorkerQuestion } from './worker-question-preview.tsx'
import type { DecisionAttempt } from './decision-state.ts'
import { DraftText } from '../ui/delivery-review.tsx'
import { PendingRequests } from '../ui/pending-requests.tsx'
import type { ChatSpace } from './chat-settings.tsx'

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
export type ThinkingItem = {kind:'thinking'; at:number; runId:string; calls:ChatCall[]; state?:ChatRunState}
type FlowItem =
  | {kind:'plan'; at:number; plan:Plan}
  | ThinkingItem
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
  display: ChatSpace['display'],
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
    const visible = workerId ? p.workerId === workerId : display === 'group' || !p.workerId
    if(!visible || (!p.workerId && graphs.has(p.runId)))continue
    add(p.runId,p.ticketId,{kind:'plan',at:p.createdAt??0,plan:p},p.live)
  }
  const activities=new Map<string,ChatCall[]>()
  for(const call of snapshot.calls){
    if(workerId&&workerId!==call.workerId)continue
    if(call.kind==='tool' ? internalTools.has(call.name) : call.name!==call.kind&&!call.status)continue
    if(call.permission==='pending' && snapshot.approvals.some(a=>a.runId===call.runId && a.workerId===call.workerId))continue
    const calls=activities.get(call.runId)??[]
    calls.push(call)
    activities.set(call.runId,calls)
  }
  for(const [runId,calls] of activities){
    calls.sort((a,b)=>a.startedAt-b.startedAt)
    const first=calls.find(call=>call.kind==='tool')??calls.find(call=>call.status||call.state!=='completed')
    if(!first)continue
    const state=snapshot.run?.id===runId?snapshot.run.state:undefined
    add(runId,first.ticketId,{kind:'thinking',at:first.startedAt,runId,calls,state},calls.some(call=>call.state==='running'))
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
  thinking: (item: ThinkingItem) => ReactNode
}
const Flow = createContext<FlowProps | null>(null)
export const WorkflowProvider = Flow.Provider

function RecordLink({id}: {id: string}) {
  const {L, conversation} = useContext(Flow)!
  return <a className="pending-action-link chat-record-link" href={pendingHref(conversation, id)} aria-controls="pending-tray">
    {L('View record', '查看记录')}<ChevronRight size={14} aria-hidden="true"/>
  </a>
}

function approvalResult(state: string): ApprovalResult {
  if (state === 'answered' || state === 'denied') return state
  if (['cancelled','expired','resolved','superseded'].includes(state)) return 'closed'
  return 'approved'
}

const resultLabel = (result: ApprovalResult, L: Localize) => ({
  approved: L('Approved', '已批准'), denied: L('Denied', '已拒绝'),
  answered: L('Answered', '已回答'), closed: L('Closed', '已结束'),
})[result]

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
export function FileReviewCard({id, name, review, archived = false}: {id:string; name:string; review:FileReview; archived?:boolean}) {
  const {L, readonly, readDraft, reviewFile, pendingIds} = useContext(Flow)!
  const {busy, submit, error} = useSubmit(L)
  const pending = review.state === 'pending'
  const disabled = readonly || busy || archived || !pendingIds.has(id)
  const result = pending ? undefined : approvalResult(review.state)
  const status = review.state === 'approved' ? L('Approved · delivered','已批准 · 文件已交付') :
    review.state === 'superseded' ? L('Replaced','已替换') :
    review.state === 'cancelled' ? L('Cancelled','已取消') :
    result ? resultLabel(result,L) : L('Awaiting approval','待审批')

  return <ApprovalFrame L={L} kind="file" id={id} title={name} notice={review.notice} status={status} result={result}>
    {pending ? <>
      {!archived && pendingIds.has(id) && <DraftText L={L} readDraft={async () => (await readDraft(id)).text}/>}
      <div className="chat-approval-actions">
        <Button disabled={disabled} onClick={() => void submit(() => reviewFile(id,'denied'))}>{L('Decline','拒绝交付')}</Button>
        <Button tone="primary" disabled={disabled} onClick={() => void submit(() => reviewFile(id,'approved'))}>{L('Deliver file','确认交付')}</Button>
      </div>
    </> : !archived && <div className="chat-approval-receipt"><RecordLink id={id}/></div>}
    {error}
  </ApprovalFrame>
}

export function RouterDecision({id, decision, archived = false}: {id:string; decision:ChatDecision; archived?:boolean}) {
  const {L, decide, readonly, pendingIds} = useContext(Flow)!
  const {busy, submit, error} = useSubmit(L)
  if (decision.closed && !decision.answer) return <ApprovalFrame L={L} kind="choice" id={id} title={decision.question}
    status={L('Cancelled','已取消')} result="closed"/>
  return <div className="workflow-card">
    <QuestionCard id={id} L={L} question={decision.question} notice={decision.pendingNotice} options={decision.options.map(o => ({
      label:o.label,
      detail:[o.label===decision.defaultOption&&!decision.answer ? L('Using this option','正按此选项进行') : null,o.detail].filter(Boolean).join(' · '),
    }))}
      answer={decision.answer} custom disabled={busy || readonly || archived || !pendingIds.has(id)}
      onAnswer={answer => void submit(() => decide(id,answer))} footer={archived ? undefined : <RecordLink id={id}/>}/>
    {error}
  </div>
}

type NativeQuestion = Extract<Request, {questions: unknown}>['questions'][number]
function NativeQuestions({request, archived}: {request:Request & {questions:NativeQuestion[]}; archived:boolean}) {
  const {L, authorize, readonly, pendingIds} = useContext(Flow)!
  const {busy, submit, error} = useSubmit(L)
  const [answers, setAnswers] = useState<Record<string,string>>({})
  const pending = request.state === 'pending', disabled = readonly || archived || busy || !pendingIds.has(request.id)
  const questions = request.questions
  const title = questions.length === 1 ? questions[0]!.question : questions.map(q=>q.question).join(' · ')
  const ready = questions.length > 0 && questions.every(q=>answers[q.id]?.trim())
  return <ApprovalFrame L={L} id={request.id} kind="choice" title={title} notice={request.notice}
    status={pending ? L('Awaiting answer','待答复') : request.state==='expired' ? L('Expired','已过期') : resultLabel(approvalResult(request.state),L)}
    result={pending ? undefined : approvalResult(request.state)}>
    {pending ? <form className="chat-approval-form" onSubmit={event => {
      event.preventDefault()
      if (disabled || !ready) return
      const result = Object.fromEntries(questions.map(q=>[q.id,{answers:[answers[q.id]!.trim()]}]))
      void submit(() => authorize(request.id,result))
    }}>
      {questions.map(q=><div className="chat-approval-question" key={q.id}>
        {questions.length > 1 && <strong>{q.question}</strong>}
        <AnswerFields L={L} label={q.question} options={q.options} custom={q.custom} secret={q.secret}
          value={answers[q.id] ?? ''} disabled={disabled} change={text=>setAnswers(previous=>({...previous,[q.id]:text}))}/>
      </div>)}
      <div className="chat-approval-actions">
        <Button tone="primary" type="submit" disabled={disabled || !ready}>
          {questions.some(q=>q.options.length) ? L('Confirm selection','确认选择') : L('Submit answer','提交答复')}
        </Button>
      </div>
    </form> : request.state === 'answered' && <div className="chat-approval-receipt">
      {'answerText' in request && request.answerText && <span>{request.answerText}</span>}
      {!archived && <RecordLink id={request.id}/>}
    </div>}
    {error}
  </ApprovalFrame>
}

function NativeCard({request:a, archived = false}: {request:Request; archived?:boolean}) {
  const {L, authorize, readonly, actor, pendingIds} = useContext(Flow)!
  const {busy, submit, error} = useSubmit(L)
  if (a.method === 'item/tool/requestUserInput' && 'questions' in a)
    return <NativeQuestions request={a} archived={archived}/>
  const pending = a.state === 'pending', disabled = readonly || busy || archived || !pendingIds.has(a.id)
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
  return <ApprovalFrame L={L} id={a.id} kind="permission" title={titles[a.method] ?? L('Authorization request','授权请求')}
    notice={a.notice} status={pending ? L('Awaiting approval','待审批') : approvalOutcome(a,L) ?? L('Closed','已结束')}
    result={pending ? undefined : approvalResult(a.state)}>
    <div className="chat-approval-context">{scope || actor(a.workerId)}</div>
    {facts.length > 0 && <DisclosureRoot className="workflow-draft pending-fact">
      <DisclosureSummary>{a.facts.command?L('View command','查看命令'):L('Request details','请求详情')}<ChevronDown size={14} aria-hidden="true"/></DisclosureSummary>
      <dl>{facts.map(([key,value])=><div key={key}><dt>{labels[key]??key}</dt><dd><pre tabIndex={0}>{value}</pre></dd></div>)}</dl>
    </DisclosureRoot>}
    {pending ? <div className="chat-approval-actions">
      <Button disabled={disabled} onClick={()=>void submit(()=>authorize(a.id,'decline'))}>{L('Deny','拒绝')}</Button>
      <Button tone="primary" disabled={disabled} onClick={()=>void submit(()=>authorize(a.id,'accept'))}>{L('Allow once','允许一次')}</Button>
    </div> : !archived && <div className="chat-approval-receipt"><RecordLink id={a.id}/></div>}
    {error}
  </ApprovalFrame>
}

export function WorkflowCards({ anchor }: { anchor: string }) {
  const { L, blocks, thinking, readonly, answerWorker, refresh } = useContext(Flow)!,
    b = blocks.get(anchor)
  if (!b) return null
  const states = {
    pending: L('Pending', '待执行'),
    running: L('In progress', '进行中'),
    completed: L('Completed', '已完成'),
    blocked: L('Blocked', '受阻'),
  }
  const rows:ReactNode[]=[]
  for(const item of b){
    if(item.kind==='thinking'){
      rows.push(<div key={'thinking:'+item.runId}>{thinking(item)}</div>)
      continue
    }
    if(item.kind==='question'){
      const question=item.question
      rows.push(<WorkerQuestion key={question.version} item={question} L={L} readonly={readonly}
        send={answerWorker} refresh={refresh} footer={<RecordLink id={question.id}/>}/>)
    }else if(item.kind==='approval'){
      const a=item.approval
      if(!('automatic' in a && a.automatic))rows.push(<NativeCard key={a.id} request={a}/>)
    }
    else {
      const p=item.plan
      rows.push(<div className="workflow-plan" key={p.id}>
        <AgentPlan L={L} title={p.title} live={p.live} steps={p.steps.map(s=>({...s,tool:[s.workerId,s.state&&states[s.state]].filter(Boolean).join(' · ')}))}/>
      </div>)
    }
  }
  return rows.length?<section className="roppo-ui workflow-block" aria-label={L('Run activity','执行活动')}>{rows}</section>:null
}


type ArchivePage=ReturnType<ChatSessions['approvalHistory']>
type ArchiveRecord=ReturnType<ChatSessions['approvalRecord']>
type ReadHistory=<T>(query:URLSearchParams,signal:AbortSignal)=>Promise<T>

function ArchiveDetail({id,read}:{id:string;read:ReadHistory}){
  const flow=useContext(Flow)!,{L}=flow
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
  const {answerWorker,refresh}=flow
  return <div className="history-detail" data-record-id={record.id}>
    <time className="history-record-time" dateTime={new Date(record.createdAt).toISOString()}>
      {new Date(record.createdAt).toLocaleString(L('en','zh-CN'),{dateStyle:'medium',timeStyle:'short'})}
    </time>
    {record.kind==='file' ? <FileReviewCard archived id={record.id} name={record.name} review={record.review}/> :
      record.kind==='choice' ? <RouterDecision archived id={record.id} decision={record.decision}/> :
      record.kind==='question' ? <WorkerQuestion L={L} item={record.question} readonly send={answerWorker} refresh={refresh}/> :
      <NativeCard archived request={record.request}/>}
  </div>
}

function HistoryResults({read,select,query,result}:{read:ReadHistory;select:(id:string)=>void;query:string;result?:ApprovalResult}){
  const {L}=useContext(Flow)!
  const [items,setItems]=useState<ArchivePage['items']>([])
  const [next,setNext]=useState<ArchivePage['next']>(null)
  const [cursor,setCursor]=useState<ArchivePage['next']>(null)
  const [busy,setBusy]=useState(true),[error,setError]=useState(false),[retry,setRetry]=useState(0)
  useEffect(()=>{
    const controller=new AbortController(),params=new URLSearchParams()
    if(cursor){params.set('before',String(cursor.at));params.set('beforeId',cursor.id)}
    if(query)params.set('q',query)
    if(result)params.set('result',result)
    setBusy(true);setError(false)
    read<ArchivePage>(params,controller.signal).then(page=>{
      if(controller.signal.aborted)return
      setItems(previous=>cursor?[...new Map([...previous,...page.items].map(row=>[row.id,row])).values()]:page.items)
      setNext(page.next);setBusy(false)
    }).catch(()=>{if(!controller.signal.aborted){setError(true);setBusy(false)}})
    return ()=>controller.abort()
  },[read,cursor,retry,query,result])
  const locale=L('en','zh-CN')
  const date=new Intl.DateTimeFormat(locale,{month:'numeric',day:'numeric'})
  const time=new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit'})
  const today=date.format(Date.now())
  return <div className="history-list">
    {items.map((item,index)=>{
      const dateLabel=date.format(item.createdAt)
      const Icon=item.result==='answered'?CircleHelp:item.kind==='chat-message'?FileText:ShieldCheck
      return <div key={item.id}>
        {(index===0||dateLabel!==date.format(items[index-1]!.createdAt)) &&
          <h3 className="history-day">{dateLabel===today?L('Today','今天'):dateLabel}</h3>}
        <button type="button" className="history-row" onClick={()=>select(item.id)}>
          <Icon size={17} aria-hidden="true"/>
          <span className="history-row-label">
            <strong>{item.label || (item.tool==='superagent_shell'?L('Run command','运行命令'):L('Operation approval','操作审批'))}</strong>
            <time dateTime={new Date(item.createdAt).toISOString()}>{time.format(item.createdAt)}</time>
          </span>
          <ApprovalStatus state={item.result} label={resultLabel(item.result,L)}/>
          <ChevronRight size={14} aria-hidden="true"/>
        </button>
      </div>
    })}
    {busy?<p role="status">{L('Loading…','加载中…')}</p>:error?<button className="history-text-button" onClick={()=>setRetry(n=>n+1)}>{L('Could not load. Retry','加载失败，重试')}</button>
      :next?<button className="history-text-button" onClick={()=>{setBusy(true);setCursor(next)}}>{L('Load earlier records','加载更早的记录')}</button>
      :!items.length?<p role="status">{query||result?L('No matching records','没有找到匹配的记录'):L('No approval history yet.','暂无审批记录')}</p>:null}
  </div>
}

function HistoryList({read,select,version}:{read:ReadHistory;select:(id:string)=>void;version:string}){
  const {L}=useContext(Flow)!
  const [draft,setDraft]=useState(''),[query,setQuery]=useState(''),[result,setResult]=useState<ApprovalResult>()
  useEffect(()=>{
    const timer=setTimeout(()=>setQuery(draft.trim()),160)
    return ()=>clearTimeout(timer)
  },[draft])
  const filters=[undefined,'approved','denied','answered'] as const
  return <>
    <div className="history-tools">
      <label className="history-search">
        <Search size={15} aria-hidden="true"/>
        <input value={draft} maxLength={120} onChange={event=>setDraft(event.target.value)}
          aria-label={L('Search approval history','搜索审批记录')} placeholder={L('Search requests or files','搜索事项或文件')}/>
      </label>
      <div className="history-filters" role="group" aria-label={L('Filter by decision','按结果筛选')}>
        {filters.map(filter=><button type="button" key={filter??'all'} aria-pressed={result===filter} onClick={()=>setResult(filter)}>
          {filter?resultLabel(filter,L):L('All','全部')}
        </button>)}
      </div>
    </div>
    <div className="history-scroll"><HistoryResults key={JSON.stringify([query,result,version])} read={read} select={select} query={query} result={result}/></div>
  </>
}

// Owner actions remain available in the tray even when viewing a read-only Worker transcript.
export function PendingTray({cards,loading,selectedId,close,read,clearSelection}:{
  selectedId?:string;cards:Snapshot['pendingCards'];loading:boolean;close:()=>void
  read:ReadHistory;clearSelection:()=>void
}){
  const flow=useContext(Flow)!,{L}=flow
  const [history,setHistory]=useState(false),[opened,setOpened]=useState<string>()
  const found=cards.some(card=>card.id===selectedId)
  const recordId=opened ?? (!loading&&!found?selectedId:undefined)
  const historyVisible=history||!!recordId
  const navRef=useRef<HTMLButtonElement>(null)
  useEffect(()=>{if(recordId)navRef.current?.focus({preventScroll:true})},[recordId])
  const switchPage=()=>{
    if(recordId){clearSelection();setOpened(undefined);setHistory(true)}
    else if(history){clearSelection();setHistory(false)}
    else setHistory(true)
  }
  const navLabel=recordId?L('Back to approval history','返回审批记录'):history?L('Back to pending requests','返回待处理事项'):L('Approval history','审批记录')
  const archiveButton=<button ref={navRef} type="button" className="icon-button history-access" title={navLabel} aria-label={navLabel} onClick={switchPage}>
    {historyVisible?<><ArrowLeft size={16}/><span>{recordId?L('History','记录'):L('Pending','待处理')}</span></>:
      <><History size={15}/><span>{L('History','记录')}</span></>}
  </button>
  return <Flow.Provider value={{...flow,readonly:false}}>
    <PendingRequests L={L} loading={loading} selectedId={selectedId} close={close}
      heading={historyVisible?L('Approval history','审批记录'):undefined} navigation={archiveButton}
      items={historyVisible?[]:cards.map(card=>({id:card.id,content:
        card.kind==='choice'?<RouterDecision id={card.id} decision={card.decision}/>:
        card.kind==='file'?<FileReviewCard id={card.id} name={card.name} review={card.review}/>:
        card.kind==='approval'?<NativeCard request={card.request}/>:
        <WorkerQuestion key={card.question.version} item={card.question} L={L} readonly={false} send={flow.answerWorker} refresh={flow.refresh}/>,
      }))}>
      {historyVisible ? <>
        {history && <div hidden={!!recordId} className="history-page">
          <HistoryList read={read} select={setOpened} version={cards.map(card=>card.id).join(' ')}/>
        </div>}
        {recordId && <ArchiveDetail key={recordId} id={recordId} read={read}/>}
      </> : undefined}
    </PendingRequests>
  </Flow.Provider>
}
