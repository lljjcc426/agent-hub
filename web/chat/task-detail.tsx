import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleAlert, Clock3, Wrench, X } from 'lucide-react'
import { taskCallLimit, type TaskExecutionCall, type TaskExecutionDetail, type TaskExecutionEvent } from '../../src/chat-task-detail.ts'
import { Button, IconButton } from '../ui/controls.tsx'
import { taskStatus } from '../ui/task-activity.tsx'
import { AgentIdentity } from '../ui/work.tsx'
import type { Localize } from './composer-commands.tsx'
import { toolLabel, toolStatus } from './tool-trace.tsx'
import { TaskHandoffSequence } from './task-handoff-sequence.tsx'

type Tab = 'progress' | 'tools'
type LoadTask = (id: string, signal: AbortSignal) => Promise<TaskExecutionDetail>
type Entry = { id: string; at: number; event?: TaskExecutionEvent; call?: TaskExecutionCall }
type Tone = 'working' | 'problem' | 'done'
const problems = new Set(['failed', 'interrupted', 'blocked', 'cancelled', 'held'])
const terminal = new Set(['completed', 'cancelled', 'failed'])

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

function RecordRow({label, meta, tone, open, toggle, children}: {
  label: string; meta: string; tone: Tone; open: boolean; toggle: () => void; children: ReactNode
}) {
  return <>
    <button type="button" className="task-run-record" data-tone={tone} aria-expanded={open} onClick={toggle}>
      <span>{label}</span><small>{meta}</small><ChevronDown size={14} aria-hidden="true"/>
    </button>
    <div className="task-run-fold" data-open={open} inert={!open} aria-hidden={!open}><div>{children}</div></div>
  </>
}

function TaskRecord({record, locale, L, agentName, selectAgent}: {
  record: TaskExecutionDetail; locale: string; L: Localize;
  agentName: (id?: string) => string; selectAgent: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('progress')
  const [expanded, setExpanded] = useState<string>()
  const [tool, setTool] = useState<string>()
  const toolsTab = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const { activity, span } = record
  const tools = record.calls.filter(call => call.kind === 'tool' && call.name !== 'chat_opening')
  const ticketById = new Map(activity.tickets.map(ticket => [ticket.id,ticket]))
  const executors = new Map<string,TaskExecutionCall>()
  for (const call of record.calls) {
    if (call.kind === 'tool') continue
    const key = JSON.stringify([call.kind,call.workerId ?? call.agentId,call.backend,call.model])
    if (!executors.has(key)) executors.set(key,call)
  }
  const entries = useMemo(() => {
    const milestones = new Set(record.events.map(event => event.kind))
    const visibleCalls = record.calls.filter(call => call.name !== 'chat_opening' &&
      !(call.kind === 'tool' && call.state === 'completed' && call.name === 'superagent_plan' && milestones.has('plan')))
    const all: Entry[] = [
      ...record.events.map(event => ({id:'event:'+event.id,at:event.at,event})),
      ...visibleCalls.map(call => ({id:'call:'+call.id,at:call.startedAt,call})),
    ]
    return all.sort((a,b) => a.at-b.at)
  }, [record])
  const clock = useMemo(() => new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}),[locale])
  const dateTime = useMemo(() => new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'medium'}),[locale])
  const duration = (ms: number) => durationLabel(ms,locale,L)

  useLayoutEffect(() => {
    if (tab === 'tools' && tool) list.current?.querySelector('.task-run-tool[data-selected]')?.scrollIntoView({block:'nearest'})
  }, [tab, tool])

  function jump(id: string) {
    setTool(id)
    setTab('tools')
    toolsTab.current?.focus({preventScroll:true})
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

    {!!executors.size && <div className="task-run-executors" aria-label={L('Agents and recorded models','处理 Agent 和记录的模型')}>
      {[...executors.entries()].map(([key,call]) => <AgentIdentity key={key} size={32}
        id={call.workerId ?? call.agentId} kind={call.kind === 'router' ? 'router' : 'worker'}
        name={call.kind === 'subagent' && !call.workerId ? L('Subagent','子 Agent') : agentName(call.workerId)}
        detail={[call.backend,call.model].filter(Boolean).join(' · ') || L('No model recorded','暂无模型记录')}/>)}
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
      <button ref={toolsTab} id="task-run-tab-tools" role="tab" type="button" aria-controls="task-run-tools" aria-selected={tab==='tools'}
        tabIndex={tab==='tools'?0:-1} onClick={() => setTab('tools')}><Wrench size={16} aria-hidden="true"/>{L('Tools','工具')}</button>
    </div>
    {record.callsTruncated && <p className="task-run-note">{L('Showing the latest '+taskCallLimit+' calls for this task.','显示此任务最近 '+taskCallLimit+' 条调用。')}</p>}
    <div id="task-run-progress" role="tabpanel" aria-labelledby="task-run-tab-progress" hidden={tab!=='progress'} className="task-run-arrive">
      {entries.length ? <ol className="task-run-timeline">
        {entries.map(({id,at:time,event,call}) => {
          const callStatus = call && callState(call,L)
          const tone = callStatus?.tone ?? (event?.state && problems.has(event.state) ? 'problem' : 'done')
          const wait = event?.waitMs
          const took = call ? recordedDuration(call) : undefined
          const name = event ? eventLabel(event,L) : call!.kind === 'tool' ? toolLabel(call!,L) : L('Model run','模型处理')
          const meta = tone === 'working' || tone === 'problem' ? callStatus?.label ?? clock.format(time)
            : took === undefined ? clock.format(time) : duration(took)
          const related = ticketById.get(event?.ticketId ?? call?.ticketId ?? '')
          return <li key={id} data-tone={tone}>
            <span className="task-run-marker" aria-hidden="true">{tone==='done' ? <Check size={11}/> : tone==='problem' ? <CircleAlert size={15}/> : null}</span>
            <div>
              <RecordRow label={name} meta={meta} tone={tone} open={expanded===id} toggle={() => setExpanded(expanded===id?undefined:id)}>
                <p><time dateTime={new Date(time).toISOString()}>{dateTime.format(time)}</time>{related ? ' · '+related.title : ''}</p>
                {wait !== undefined && <p>{L('Waited ','等待开始 ')+duration(wait)}</p>}
                {call && call.kind !== 'tool' && <p>{agentName(call.workerId)}{call.model ? ' · '+call.model : ''}</p>}
                {call?.kind === 'tool' && <button type="button" className="task-run-link" onClick={() => jump(call.id)}>
                  {L('View tool record','查看工具记录')} <ArrowRight size={13} aria-hidden="true"/>
                </button>}
              </RecordRow>
            </div>
          </li>
        })}
      </ol> : <p className="task-run-note">{L('No progress timestamps were recorded for this task.','这个任务暂无进度时间记录。')}</p>}
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
      {tools.length ? <ul className="task-run-tools">{tools.map(call => {
        const status = callState(call,L), took = recordedDuration(call)
        return <li className="task-run-tool" data-selected={tool===call.id || undefined} key={call.id}>
          <RecordRow label={toolLabel(call,L)} meta={status.label} tone={status.tone} open={tool===call.id}
            toggle={() => setTool(tool===call.id ? undefined : call.id)}>
            <p>{call.name && <code>{call.name} · </code>}{agentName(call.workerId)} · {dateTime.format(call.startedAt)}</p>
            <p>{status.label}{status.tone!=='working' && (took===undefined ? ' · '+L('Duration unavailable','未记录耗时') : ' · '+duration(took))}</p>
          </RecordRow>
        </li>
      })}</ul> : <p className="task-run-note">{L('No tool calls were recorded for this task.','这个任务暂无工具调用记录。')}</p>}
    </div>
  </>
}

export function TaskDetail({id, load, active, closing, layerRef, back, close, locale, L, agentName, selectAgent}: {
  id: string; load: LoadTask; active: boolean; closing: boolean; layerRef: Ref<HTMLElement>;
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
      {record ? <TaskRecord record={record} locale={locale} L={L} agentName={agentName} selectAgent={selectAgent}/>
        : !failed && <p className="task-run-note" role="status">{L('Loading task history…','正在读取任务记录…')}</p>}
    </div>
  </section>
}
