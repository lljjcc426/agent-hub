import { useMemo, useState } from 'react'
import { Maximize2, Workflow } from 'lucide-react'
import type { TaskExecutionDetail, TaskExecutionHandoff } from '../../src/chat-task-detail.ts'
import { Dialog } from '../ui/overlays.tsx'
import { taskStatus } from '../ui/task-activity.tsx'
import { AgentSequence, type SequenceMessage, type SequenceParticipant } from '../ui/run-visualizations.tsx'
import type { Localize } from './composer-commands.tsx'
import { toolLabel, toolStatus } from './tool-trace.tsx'

type Timed = SequenceMessage & { at:number }

export function taskSequence(record:TaskExecutionDetail,L:Localize,agentName:(id?:string)=>string) {
  const participants = new Map<string,SequenceParticipant>()
  const entries: Timed[] = []
  const router = 'router'
  const user = 'user'
  const tools = 'tool'
  function recordedModel(id?:string){
    const call=record.calls.findLast(call=>!!call.model && (id ? call.workerId===id : call.kind==='router'))
    return call?.model
  }
  participants.set(user,{id:user,name:L('You','你'),kind:'person'})
  participants.set(router,{id:router,name:agentName(),kind:'agent',avatarKind:'router',model:recordedModel()})
  const worker = (id:string, name = agentName(id)) => {
    const key = 'worker:'+id
    if(!participants.has(key)) participants.set(key,{id:key,name,kind:'agent',avatarId:id,avatarKind:'worker',model:recordedModel(id)})
    return key
  }
  const actor = (value:TaskExecutionHandoff['from']) =>
    value.kind === 'worker' ? worker(value.id,value.label || agentName(value.id)) : router
  const titles = new Map(record.activity.tickets.map(ticket => [ticket.id,ticket.title]))
  const pending = new Map<string,Timed>()
  const handoffs = (record.handoffs ?? []).slice().sort((a,b) => a.at-b.at)
  for (const handoff of handoffs) {
    const from = actor(handoff.from), to = actor(handoff.to)
    const assignment = handoff.kind === 'assignment'
    const label = assignment ? L('Assigned task','分派任务')
      : handoff.kind === 'files' ? L('Delivered files','交付文件') : L('Shared result','提交结果')
    const previous = pending.get(handoff.ticketId)
    const replyTo = !assignment && previous?.from === to && previous.to === from ? previous.id : undefined
    const message: Timed = {id:'handoff:'+handoff.id,at:handoff.at,from,to,label,
      kind:assignment ? undefined : 'reply', replyTo, detail:titles.get(handoff.ticketId)}
    entries.push(message)
    if (assignment) pending.set(handoff.ticketId,message)
    else if (replyTo) pending.delete(handoff.ticketId)
  }
  const requestByRun = new Map<string,string>()
  for (const event of record.events) {
    const id = 'message:'+event.id
    if (event.kind === 'received') {
      if (event.runId) requestByRun.set(event.runId,id)
      entries.push({id,at:event.at,from:user,to:router,label:L('Received request','收到消息')})
    }
    if (event.kind === 'opening' || event.kind === 'reply') entries.push({
      id,at:event.at,from:router,to:user,kind:'reply',
      replyTo:event.kind==='reply'&&event.runId ? requestByRun.get(event.runId) : undefined,
      label:event.kind === 'opening' ? L('Opening update','开场回复') : L('Sent reply','发出回复'),
    })
  }
  const calls = new Map(record.calls.map(call => [call.id,call]))
  for (const call of record.calls) {
    // Reported summaries and recovery timestamps are not recorded call/return pairs.
    if (call.kind !== 'tool' || call.reported || ['chat_opening','superagent_status','superagent_plan'].includes(call.name)) continue
    if (call.name==='worker_manage' && call.action==='assign' && handoffs.some(handoff =>
      handoff.kind==='assignment' && handoff.to.id===call.target && handoff.at>=call.startedAt &&
      handoff.at<=(call.endedAt??call.startedAt))) continue
    const parent = call.parentId ? calls.get(call.parentId) : undefined
    const workerId = call.workerId ?? parent?.workerId
    const caller = workerId ? worker(workerId) : router
    if (!participants.has(tools)) participants.set(tools,{id:tools,name:L('Tools','工具'),kind:'tool'})
    const id = 'tool:'+call.id
    const label = toolLabel(call,L)
    entries.push({id,at:call.startedAt,from:caller,to:tools,label,
      state:call.permission==='pending' ? 'waiting' : undefined, detail:toolStatus(call,L)})
    if (call.endedAt !== undefined && call.state !== 'interrupted') entries.push({
      id:id+':return',at:call.endedAt,from:tools,to:caller,label:toolStatus(call,L),
      kind:'reply',replyTo:id,state:call.state === 'failed' ? 'failed' : undefined,detail:label,
    })
  }
  entries.sort((a,b) => a.at-b.at)
  const used = new Set(entries.flatMap(entry => [entry.from,entry.to]))
  const baseline = record.span?.from ?? entries[0]?.at ?? 0
  return {
    participants:[...participants.values()].filter(participant => used.has(participant.id)),
    messages:entries.map(({at,...message}) => ({...message,timeMs:at-baseline})),
  }
}

export function TaskHandoffSequence({record,L,agentName}: {
  record:TaskExecutionDetail;L:Localize;agentName:(id?:string)=>string
}) {
  const [open,setOpen]=useState(false)
  const [round,setRound]=useState(0)
  const data=useMemo(()=>round?taskSequence(record,L,agentName):null,[round,record,L,agentName])
  const title=record.activity.title||L('Task','任务')
  const heading=L('Handoff sequence','接力时序')
  const running=record.activity.state==='running'
  const statusLabel=taskStatus(record.activity.state,L)
  return <div className="task-run-sequence">
    <button className="task-run-record task-run-sequence-toggle" type="button"
      aria-haspopup="dialog"
      onClick={event=>{
        event.currentTarget.focus({preventScroll:true})
        setRound(value=>value+1)
        setOpen(true)
      }}>
      <Workflow size={15} aria-hidden="true"/><span>{heading}</span><Maximize2 size={14} aria-hidden="true"/>
    </button>
    {data&&<Dialog className="task-sequence-dialog" open={open} title={heading}
      closeLabel={L('Close handoff sequence','关闭接力时序')} onClose={()=>setOpen(false)}>
      {data.messages.length ?
        <AgentSequence key={round} {...data} title={title} running={running} statusLabel={statusLabel}
          playOnMount active={open} L={L}/>
        : <p className="task-run-note">{L('No exchanges were recorded for this task.','这个任务暂无接力记录。')}</p>}
    </Dialog>}
  </div>
}
