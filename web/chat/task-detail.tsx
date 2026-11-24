import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleAlert, Clock3, FileText, RotateCcw, Wrench, X } from 'lucide-react'
import { taskCallLimit, type TaskExecutionCall, type TaskExecutionDetail, type TaskExecutionEvent } from '../../src/chat-task-detail.ts'
import type { AcceptanceRetryResult } from '../../src/goal-acceptance.ts'
import { Button, IconButton } from '../ui/controls.tsx'
import { taskStatus } from '../ui/task-activity.tsx'
import { AgentIdentity } from '../ui/work.tsx'
import type { Localize } from './composer-commands.tsx'
import { toolLabel, toolStatus } from './tool-trace.tsx'
import { TaskHandoffSequence } from './task-handoff-sequence.tsx'
import { downloadUrl } from './delivery-links.ts'

type Tab = 'progress' | 'tools'
type LoadTask = (id: string, signal: AbortSignal) => Promise<TaskExecutionDetail>
type RetryAcceptance = (id: string, revision: number) => Promise<AcceptanceRetryResult>
type Entry = { id: string; at: number; event?: TaskExecutionEvent; call?: TaskExecutionCall }
type Tone = 'working' | 'problem' | 'done' | 'recorded'
const problems = new Set(['cancelled'])
const terminal = new Set(['completed', 'cancelled', 'failed'])
const taskListPreviewLimit = 10

function useTaskRecord(id: string, load: LoadTask, active: boolean) {
  const [record, setRecord] = useState<TaskExecutionDetail>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    let timer: number | undefined
    async function refresh() {
      let interval = 1800
      try {
        if (!document.hidden) {
          const result = await load(id, controller.signal)
          if (controller.signal.aborted) return
          setRecord(result)
          setFailed(false)
          if (terminal.has(result.activity.state) && !result.calls.some(call => call.state === 'running')) interval = 5000
        }
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof Error && 'status' in error && [404,409].includes(Number(error.status))) setRecord(undefined)
        setFailed(true)
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(refresh, interval)
      }
    }
    void refresh()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [id, active, load, attempt])
  return { record, failed, retry: () => setAttempt(n => n + 1) }
}

function eventLabel(event: TaskExecutionEvent, L: Localize) {
  switch (event.kind) {
    case 'created': return L('Task created','创建任务')
    case 'received': return L('Message received','收到消息')
    case 'started': return L('Started work','开始处理')
    case 'plan': return L('Plan updated','更新任务计划')
    case 'report': return event.state ? taskStatus(event.state,L) : L('Worker report','任务汇报')
    case 'closed': return taskStatus(event.state ?? 'completed',L)
    case 'result': return L('Result shared in Chat','结果已发到对话')
    case 'files': return L('Files delivered','文件已交付')
    case 'reply': return L('Sent a reply','发出回复')
    case 'opening': return L('Sent an opening message','发出开场白')
  }
}

function callState(call: TaskExecutionCall, L: Localize) {
  if (call.state === 'running')
    return { tone:'working' as const, label:L('In progress','进行中') }
  const items=call.webBatch?.items
  if(items?.some(item=>item.status==='completed')&&items.some(item=>item.status!=='completed'))
    return {tone:'recorded' as const,label:L('Results recorded','已记录结果')}
  if(call.state==='failed'||call.state==='interrupted')return {tone:'recorded' as const,label:toolStatus(call,L)}
  const problem = problems.has(call.state) || call.permission === 'denied' || call.permission === 'uncertain'
  return { tone:problem ? 'problem' as const : 'done' as const, label:toolStatus(call,L) }
}

function durationLabel(ms: number, locale: string, L: Localize) {
  if (ms < 100) return L('< 0.1 s','< 0.1 秒')
  const unit = ms >= 3600000 ? [3600000,'hr','小时'] as const : ms >= 60000 ? [60000,'min','分钟'] as const : [1000,'s','秒'] as const
  const text = new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(ms/unit[0])
  return text + ' ' + L(unit[1],unit[2])
}

function recordedDuration(call: TaskExecutionCall) {
  return call.reported || call.state === 'interrupted' || call.endedAt === undefined ? undefined : call.endedAt-call.startedAt
}

function RecordRow({label, description, meta, tone, open, toggle, children}: {
  label: ReactNode; description?: string; meta: string; tone: Tone; open: boolean; toggle: () => void; children: ReactNode
}) {
  return <>
    <button type="button" className="task-run-record" data-tone={tone} aria-expanded={open} onClick={toggle}>
      <span>{label}{description && <span className="task-run-record-description">{description}</span>}</span>
      <small>{meta}</small><ChevronDown size={14} aria-hidden="true"/>
    </button>
    <div className="task-run-fold" data-open={open} inert={!open} aria-hidden={!open}><div>{children}</div></div>
  </>
}

function TaskAcceptance({id, acceptance, retry, refresh, locale, L}: {
  id: string; acceptance: NonNullable<TaskExecutionDetail['acceptance']>; retry: RetryAcceptance;
  refresh: () => void; locale: string; L: Localize;
}) {
  const [result,setResult]=useState<AcceptanceRetryResult>()
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const state=result?.state??acceptance.state
  const overflow=result?.state==='held'?result.overflow:acceptance.state==='held'?acceptance.overflow:undefined
  const format=new Intl.NumberFormat(locale,{maximumFractionDigits:2})
  const size=(bytes:number)=>bytes>=1024*1024
    ? format.format(bytes/(1024*1024))+' MiB' : format.format(bytes/1024)+' KiB'
  const collected=overflow&&(size(overflow.bytes)===size(overflow.limitBytes)
    ? format.format(overflow.bytes)+' '+L('bytes','字节') : size(overflow.bytes))
  const source=overflow?.largest.key==='host-execution'?L('Execution log','命令和工具记录')
    : overflow?.largest.key==='delivery'?L('Worker report','Worker 汇报')
    : overflow?.largest.key
  async function submit(){
    if(busy||state!=='held'||acceptance.state!=='held')return
    setBusy(true)
    setError('')
    try{setResult(await retry(id,acceptance.revision));refresh()}
    catch{setError(L('Could not queue acceptance. Check the task and try again.','暂时无法排队验收，请查看任务状态后重试。'));refresh()}
    finally{setBusy(false)}
  }
  return <section className="task-run-acceptance" aria-label={L('Independent acceptance','独立验收')}>
    <div className="task-run-acceptance-head">
      <h4>{L('Independent acceptance','独立验收')}</h4>
      <span role="status">{busy?L('Checking evidence…','正在检查材料…'):
        state==='queued'?L('Acceptance queued','验收已排队'):
        state==='running'?L('Reviewing','正在验收'):L('Acceptance paused','验收暂停')}</span>
    </div>
    {overflow ? <>
      <p>{L('Evidence collected so far is '+collected+' and exceeds the '+size(overflow.limitBytes)+' limit.',
        '目前已收集 '+collected+'，超过 '+size(overflow.limitBytes)+' 上限。')}</p>
      <p>{L('Largest item read so far is ','已读取的最大来源为 ')}<strong>{source}</strong> · {size(overflow.largest.bytes)}</p>
    </> : state==='held' && acceptance.state==='held' && <p>
      {acceptance.reason==='size'?L('The previous evidence package exceeded the limit. Retry to check the current files.',
        '上次验收材料超限。重试时会重新检查当前材料。'):
        L('Retry the review of the saved delivery.','可以用已保存的交付重试验收。')}
    </p>}
    {!!acceptance.files.length && <ul aria-label={L('Files awaiting acceptance','待验收交付')}>
      {acceptance.files.map(file=>{
        const query=new URLSearchParams({acceptance:id,...(file.preview?{preview:'1'}:{})})
        return <li key={file.id}><a href={downloadUrl(file)+'?'+query}
          target={file.preview?'_blank':undefined} rel="noreferrer"><FileText size={14} aria-hidden="true"/>{file.name}</a></li>
      })}
    </ul>}
    {error && <p role="alert">{error}</p>}
    {state==='held' && <Button disabled={busy} onClick={()=>void submit()}>
      <RotateCcw size={14} aria-hidden="true"/>{L('Retry acceptance','重试验收')}
    </Button>}
  </section>
}

function TaskRecord({record, locale, L, agentName, selectAgent, retryAcceptance, refresh}: {
  record: TaskExecutionDetail; locale: string; L: Localize;
  agentName: (id?: string) => string; selectAgent: (id: string) => void;
  retryAcceptance: RetryAcceptance; refresh: () => void;
}) {
  const [tab, setTab] = useState<Tab>('progress')
  const [expanded, setExpanded] = useState<string>()
  const [tool, setTool] = useState<string>()
  const [showAll, setShowAll] = useState({progress:false, tools:false})
  const progressListId = useId()
  const toolListId = useId()
  const revealedList = useRef<HTMLElement | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const { activity, span } = record
  const tools = record.calls.filter(call => call.kind === 'tool' && call.name !== 'chat_opening')
  const ticketById = new Map(activity.tickets.map(ticket => [ticket.id,ticket]))
  const executors = new Map<string,{call:TaskExecutionCall;workerId?:string;models:Set<string>}>()
  for (const call of record.calls) {
    if (call.kind === 'tool') continue
    const workerId = call.kind === 'router' ? undefined : call.workerId ?? ticketById.get(call.ticketId ?? '')?.workerId
    const key = workerId ? 'worker:'+workerId : call.kind === 'subagent' && call.agentId ? 'subagent:'+call.agentId : call.kind
    const executor = executors.get(key) ?? {call,workerId,models:new Set<string>()}
    const model = [call.backend,call.model].filter(Boolean).join(' · ')
    if (model) executor.models.add(model)
    executors.set(key,executor)
  }
  const entries = useMemo(() => {
    const all: Entry[] = [
      ...record.events.map(event => ({id:'event:'+event.id,at:event.at,event})),
      ...record.calls.filter(call => call.kind !== 'tool').map(call => ({id:'call:'+call.id,at:call.startedAt,call})),
    ]
    return all.sort((a,b) => a.at-b.at)
  }, [record])
  const clock = useMemo(() => new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}),[locale])
  const dateTime = useMemo(() => new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'medium'}),[locale])
  const duration = (ms: number) => durationLabel(ms,locale,L)

  useLayoutEffect(() => {
    if (tab === 'tools' && tool) list.current?.querySelector('.task-run-tool[data-selected]')?.scrollIntoView({block:'nearest'})
  }, [tab, tool])

  useLayoutEffect(() => {
    const revealed = revealedList.current
    revealedList.current = null
    if (!revealed) return
    const firstNew = revealed.children.item(taskListPreviewLimit)?.querySelector<HTMLButtonElement>('.task-run-record')
    firstNew?.focus({preventScroll:true})
    firstNew?.scrollIntoView({block:'nearest'})
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const easing = getComputedStyle(revealed).getPropertyValue('--team-ease').trim() || 'ease-out'
    const rows = Array.from(revealed.children).slice(taskListPreviewLimit,taskListPreviewLimit+8)
    const animations = rows.map((row,index) => row.animate([
      { opacity: .25, transform: 'translateY(9px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 260, delay: index*26, easing, fill: 'backwards' }))
    return () => animations.forEach(animation => animation.cancel())
  }, [showAll])

  function showAllButton(kind: Tab, count: number, listId: string) {
    if (showAll[kind] || count <= taskListPreviewLimit) return null
    return <button type="button" className="task-run-more" aria-controls={listId} aria-expanded={false}
      onClick={event => {
        revealedList.current = event.currentTarget.ownerDocument.getElementById(listId)
        setShowAll(current => ({...current,[kind]:true}))
      }}>{L('Show all','展开全部')} <ChevronDown size={13} aria-hidden="true"/></button>
  }

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'progress' : event.key === 'End' ? 'tools' : tab === 'progress' ? 'tools' : 'progress'
    setTab(next)
    event.currentTarget.querySelector<HTMLButtonElement>('#task-run-tab-'+next)?.focus({preventScroll:true})
  }

  return <>
    <div className="task-run-title">
      <h3>{activity.title || L('Task','任务')}</h3>
      <span className="task-run-status" data-problem={problems.has(activity.state) || undefined} role="status">
        {taskStatus(activity.state,L)}
      </span>
    </div>
    {(activity.objective || activity.nextAction) && <p className="task-run-note">{activity.objective || activity.nextAction}</p>}
    {record.acceptance && <TaskAcceptance key={record.acceptance.state==='held'?record.acceptance.revision:record.acceptance.state}
      id={activity.id} acceptance={record.acceptance} retry={retryAcceptance} refresh={refresh} locale={locale} L={L}/>}

    {!!executors.size && <div className="task-run-executors" aria-label={L('Agents and recorded models','处理 Agent 和记录的模型')}>
      {[...executors.entries()].map(([key,{call,workerId,models}]) => <AgentIdentity key={key} size={32}
        id={workerId ?? call.agentId} kind={call.kind === 'router' ? 'router' : 'worker'}
        name={workerId ? agentName(workerId) : call.kind === 'subagent' ? L('Subagent','子 Agent') : agentName()}
        detail={[...models].join(' / ') || L('No model recorded','暂无模型记录')}/>)}
    </div>}

    <div className="task-run-elapsed">
      {span ? <>
        <span>{span.complete ? L('Total time','总用时') : L('Recorded time','已记录用时')}</span>
        <strong>{duration(span.to-span.from)}</strong>
      </> : <span>{L('No recorded duration','暂无耗时记录')}</span>}
    </div>
    <TaskHandoffSequence record={record} L={L} agentName={agentName}/>
    <div className="team-tabs task-run-tabs" role="tablist" aria-label={L('Task record tabs','执行详情分组')} data-tab={tab} onKeyDown={keys}>
      <button id="task-run-tab-progress" role="tab" type="button" aria-controls="task-run-progress" aria-selected={tab==='progress'}
        tabIndex={tab==='progress'?0:-1} onClick={() => setTab('progress')}><Clock3 size={16} aria-hidden="true"/>{L('Progress','进度')}</button>
      <button id="task-run-tab-tools" role="tab" type="button" aria-controls="task-run-tools" aria-selected={tab==='tools'}
        tabIndex={tab==='tools'?0:-1} onClick={() => setTab('tools')}><Wrench size={16} aria-hidden="true"/>{L('Tools','工具')}</button>
    </div>
    {record.callsTruncated && <p className="task-run-note">{L('Showing the latest '+taskCallLimit+' calls for this task.','显示此任务最近 '+taskCallLimit+' 条调用。')}</p>}
    <div id="task-run-progress" role="tabpanel" aria-labelledby="task-run-tab-progress" hidden={tab!=='progress'} className="task-run-arrive">
      {entries.length ? <ol id={progressListId} className="task-run-timeline">
        {(showAll.progress ? entries : entries.slice(0,taskListPreviewLimit)).map(({id,at:time,event,call}) => {
          const callStatus = call && callState(call,L)
          const tone = callStatus?.tone ?? (event?.state && ['blocked','held','failed','interrupted'].includes(event.state) ? 'recorded' : event?.state && problems.has(event.state) ? 'problem' : 'done')
          const wait = event?.waitMs
          const took = call ? recordedDuration(call) : undefined
          const name = event ? eventLabel(event,L) : call?.kind === 'subagent' ? L('Subagent run','子 Agent 处理') : L('Model run','模型处理')
          const meta = tone === 'working' || tone === 'problem' ? callStatus?.label ?? clock.format(time)
            : took === undefined ? clock.format(time) : duration(took)
          const related = ticketById.get(event?.ticketId ?? call?.ticketId ?? '')
          return <li key={id} data-tone={tone}>
            <span className="task-run-marker" aria-hidden="true">{tone==='done' ? <Check size={11}/> : tone==='problem' ? <CircleAlert size={15}/> : null}</span>
            <div>
              <RecordRow label={name} meta={meta} tone={tone} open={expanded===id} toggle={() => setExpanded(expanded===id?undefined:id)}>
                <p><time dateTime={new Date(time).toISOString()}>{dateTime.format(time)}</time>{related ? ' · '+related.title : ''}</p>
                {wait !== undefined && <p>{L('Waited ','等待开始 ')+duration(wait)}</p>}
                {call && <p>{agentName(call.workerId ?? related?.workerId)}{call.model ? ' · '+call.model : ''}</p>}
              </RecordRow>
            </div>
          </li>
        })}
      </ol> : <p className="task-run-note">{L('No progress timestamps were recorded for this task.','这个任务暂无进度时间记录。')}</p>}
      {showAllButton('progress',entries.length,progressListId)}
      {!!activity.steps.length && <div className="task-run-plan">
        <h4>{L('Task plan','任务计划')}</h4><ol>{activity.steps.map(step => <li key={step.id}>{step.title}
          {step.state && <small>{taskStatus(step.state,L)}</small>}</li>)}</ol>
      </div>}
      {!!activity.tickets.length && <div className="task-run-plan">
        <h4>{L('Assigned work','分派记录')}</h4>
        {activity.tickets.map(ticket => <div key={ticket.id} className="task-run-ticket">
          {ticket.title !== activity.title && <strong>{ticket.title}</strong>}
          <button type="button" className="task-run-link" onClick={() => selectAgent(ticket.workerId)}>
            {agentName(ticket.workerId)} · {taskStatus(ticket.reviewing?'reviewing':ticket.state,L)} <ArrowRight size={13} aria-hidden="true"/>
          </button>
          {(ticket.question || ticket.summary) && <p>{ticket.question || ticket.summary}</p>}
        </div>)}
      </div>}
    </div>
    <div ref={list} id="task-run-tools" role="tabpanel" aria-labelledby="task-run-tab-tools" hidden={tab!=='tools'} className="task-run-arrive">
      {tools.length ? <ul id={toolListId} className="task-run-tools">{(showAll.tools ? tools : tools.slice(0,taskListPreviewLimit)).map(call => {
        const status = callState(call,L), took = recordedDuration(call)
        const action = toolLabel(call,L)
        return <li className="task-run-tool" data-selected={tool===call.id || undefined} key={call.id}>
          <RecordRow label={call.name ? <code className="task-run-tool-name">{call.name}</code> : action}
            description={call.name && action!==call.name ? action : undefined} meta={status.label} tone={status.tone} open={tool===call.id}
            toggle={() => setTool(tool===call.id ? undefined : call.id)}>
            <p>{agentName(call.workerId)} · {dateTime.format(call.startedAt)}</p>
            <p>{status.label}{status.tone!=='working' && (took===undefined ? ' · '+L('Duration unavailable','未记录耗时') : ' · '+duration(took))}</p>
            {call.webBatch?.items.map((item,index)=><p key={item.target}>
              {L('Page','网页')} {index+1} · {item.reused?L('Reused','复用'):item.status==='completed'?L('Succeeded','成功'):item.status==='skipped'?L('Skipped','跳过'):L('Failed','失败')}
              {item.httpStatus?(' · HTTP '+item.httpStatus):''} · {duration(item.endedAt-item.startedAt)}
            </p>)}
          </RecordRow>
        </li>
      })}</ul> : <p className="task-run-note">{L('No tool calls were recorded for this task.','这个任务暂无工具调用记录。')}</p>}
      {showAllButton('tools',tools.length,toolListId)}
    </div>
  </>
}

export function TaskDetail({id, load, retryAcceptance, active, closing, layerRef, back, close, locale, L, agentName, selectAgent}: {
  id: string; load: LoadTask; active: boolean; closing: boolean; layerRef: Ref<HTMLElement>;
  retryAcceptance: RetryAcceptance;
  back: () => void; close: () => void; locale: string; L: Localize;
  agentName: (id?: string) => string; selectAgent: (id: string) => void;
}) {
  const backButton = useRef<HTMLButtonElement>(null)
  const {record, failed, retry} = useTaskRecord(id,load,active)
  useLayoutEffect(() => {
    if (active) backButton.current?.focus({preventScroll:true})
  }, [active])
  return <section ref={layerRef} className="task-drawer-layer task-run-layer roppo-ui" aria-labelledby="task-run-heading"
    data-closing={closing || undefined} inert={closing} aria-hidden={closing || undefined}>
    <header className="task-run-heading">
      <button ref={backButton} type="button" className="rp-icon-button" aria-label={L('Back to task list','返回任务列表')}
        title={L('Back to task list','返回任务列表')} onClick={back}><ArrowLeft size={18} aria-hidden="true"/></button>
      <h2 id="task-run-heading">{L('Task details','执行详情')}</h2>
      <IconButton label={L('Close panel','收起面板')} onClick={close}><X size={18} aria-hidden="true"/></IconButton>
    </header>
    <div className="task-run-scroll" aria-busy={!record && !failed}>
      {failed && <div className="task-run-error">
        <span role="status">{L('The latest record could not be loaded.','暂时读不到最新记录。')}</span>
        <Button onClick={retry}>{L('Retry','重试')}</Button>
      </div>}
      {record ? <TaskRecord record={record} locale={locale} L={L} agentName={agentName} selectAgent={selectAgent}
        retryAcceptance={retryAcceptance} refresh={retry}/>
        : !failed && <p className="task-run-note" role="status">{L('Loading task history…','正在读取任务记录…')}</p>}
    </div>
  </section>
}
