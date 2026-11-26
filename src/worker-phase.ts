import type {Runtime} from './runtime.ts'
import {stableDigest} from './sources.ts'
import type {RouterGoal} from './router-goals.ts'
import type {GoalNode} from './goal-contract.ts'
import type {Run} from './store.ts'
import {taskView} from './task-context.ts'
import {unsettledTaskEffects} from './artifact-read-recovery.ts'
import type {TicketInput,Ticket} from './vendor/dsh-core/index.ts'
import type {PluginThread} from './backends/plugin-process.ts'
import type {GoalDelivery} from './goal-verification.ts'
import {previewText} from './working-context.ts'
import type {WorkItem,WorkOwner} from './work.ts'

export function phaseJobs(items:WorkItem[],owner:Pick<WorkOwner,'ticketId'|'assignmentId'|'agentId'>){
 return items.filter(j=>j.ticketId===owner.ticketId&&j.assignmentId===owner.assignmentId&&j.agentId===owner.agentId)
  .reverse().map(j=>({id:j.id,state:j.state,kind:j.kind,exitCode:j.exitCode,description:previewText(j.command??j.prompt??'',180)}))
}

interface PhaseHandoff {
 reason:'worker_phase';ticketId:string;assignmentId:string;goalId:string;nodeId:string;scopeId:string;ownerEpoch:number
 cause:string;inputId?:string;previousThread:string;previousTurn?:string;previousReport?:string;at:number
}

function mayStartPhase(goal:RouterGoal,task:Ticket){
 return goal.managed&&!goal.cancelledByUser&&!goal.supersededBy&&['active','waiting'].includes(goal.state)&&!task.ended&&!task.attention
}

/** Called inside the same transaction as the host-authorized change of phase. Never interrupts a turn. */
export function beginWorkerPhase(host:Runtime,g:RouterGoal,n:GoalNode,task:Ticket,cause:string,inputId?:string){
 const store=host.store,run=store.get<Run>('run',task.id),a=task.assignments.at(-1),owner=host.scopes.ownership(task.id)
 if(!mayStartPhase(g,task)||!run?.threadId||!run.prepared||run.phase!=='idle'||run.waitingForWriter||run.assignmentId!==a?.id||
  n.ticketId!==task.id||n.workerId!==run.workerId||owner?.state!=='active'||owner.scopeId!==g.scopeId||
  run.webFetchReplay||store.get('task-continuation',task.id)||!host.goals.effectsSettled(task.id)||unsettledTaskEffects(store,task.id,0))return
 const tools=run.agentOptions?.tools??host.config.backends[run.backendId??host.config.execution.roles.worker??host.config.execution.backend]?.defaults?.tools
 if(tools&&!tools.includes('superagent_read'))return
 const thread=store.get<PluginThread>('backend-plugin-thread',run.threadId)
 if(thread&&(thread.state!=='completed'||thread.effectIds.some(id=>store.get<{state:string}>('backend-plugin-tool',id)?.state!=='complete')))return
 const key=stableDigest([g.id,n.id,task.id,a.id,cause,run.threadId])
 if(store.get('context-handoff',key))return
 const delivery=store.get<GoalDelivery>('goal-delivery',task.id)
 const report=delivery?.assignmentId===a.id&&delivery.goalId===g.id?delivery.report.summary:a.report?.summary
 const record:PhaseHandoff={reason:'worker_phase',ticketId:task.id,assignmentId:a.id,goalId:g.id,nodeId:n.id,
  scopeId:owner.scopeId,ownerEpoch:owner.ownerEpoch,cause,inputId,previousThread:run.threadId,previousTurn:run.turnId,
  previousReport:report&&previewText(report,1000),at:Date.now()}
 store.put('context-handoff',key,record)
 const {threadId,turnId,result,webFetchReplay,...retained}=run
 store.put('run',task.id,{...retained,rebuild:key} satisfies Run)
 return key
}

/** Materialize from currently scoped records. Older jobs remain addressable by their original IDs. */
export function workerPhaseInput(host:Runtime,task:Ticket,run:Run,g:RouterGoal|undefined){
 const key=run.rebuild
 if(!key)return
 const phase=host.store.get<PhaseHandoff>('context-handoff',key)
 if(phase?.reason!=='worker_phase')return
 const owner=host.scopes.ownership(task.id),n=g?.nodes?.find(n=>n.ticketId===task.id)
 if(run.threadId===phase.previousThread||!g||!mayStartPhase(g,task)||owner?.state!=='active'||phase.ticketId!==task.id||phase.assignmentId!==run.assignmentId||g?.id!==phase.goalId||n?.id!==phase.nodeId||
   owner?.scopeId!==phase.scopeId||owner.ownerEpoch!==phase.ownerEpoch||host.store.get('task-continuation',task.id))
  throw Error('Worker phase handoff changed authority')
 return retainedPhaseBrief(host,task,run,g,n,phase)
}

/** Read-only projection of evidence already authorized by the caller. It cannot open or resume a task. */
export function retainedPhaseBrief(host:Runtime,task:Ticket,run:Run,g:RouterGoal,n:GoalNode,phase:Pick<PhaseHandoff,'inputId'|'previousReport'>){
 const visible=taskView(host.store,task)
 const userInputs=visible.inputs.filter(i=>i.kind==='trigger'&&i.human||i.kind==='resumed'||i.kind==='text')
 const latest=userInputs.slice(-4).map(i=>{
  const text=i.kind==='text'?i.text:'triggerId' in i?host.store.triggers.get(i.triggerId)?.text:undefined
  return {resource:'ticket/'+task.id+'/input/'+i.id,...(i.kind==='trigger'||i.kind==='resumed'?{source:'trigger/'+i.triggerId}:{}),text:text&&previewText(text,500)}
 })
 const jobs=phaseJobs(host.work.list(task.id),run)
 return {goalId:g.id,step:n.id,inputId:phase.inputId,previousReport:phase.previousReport,currentInstruction:n.instruction,
  expectedFiles:[...new Set([...(n.outputs??[]),...g.criteria.filter(c=>n.criterionIds.includes(c.id)).flatMap(c=>c.files??[])])],
  priorUserInputs:{total:userInputs.length,recent:latest,all:'ticket/'+task.id+'/inputs'},
  jobs:{total:jobs.length,recent:jobs.slice(0,8),index:'job-index'},
  notice:'Continue the same assignment and workspace. Use the retained report and job IDs. Check earlier user requirements and the job index when needed. Read original output with superagent_job read and an explicit offset. Reconcile uncertain writes before acting.'}
}

/** A phase note is the original scoped, paged resource. Leave live user input and instructions intact. */
export function phaseInputs(inputs:TicketInput[],ticketId:string,inputId?:string):TicketInput[]{
 if(!inputId)return inputs
 return inputs.map(input=>{
  if(input.id!==inputId||input.kind!=='note'||input.text.length<2048)return input
  const start=input.text.indexOf('{')
  if(start<0)return input
  let body
  try{body=JSON.parse(input.text.slice(start))}catch{return input}
  if(!body||typeof body!=='object')return input
  const field=['prerequisiteEvidence','prerequisites'].find(k=>Array.isArray(body[k])&&JSON.stringify(body[k]).length>2048)
  if(!field)return input
  const items=body[field],original='ticket/'+ticketId+'/input/'+input.id
  body[field]={count:items.length,original,entries:items.slice(0,12).map((e:Record<string,unknown>|null)=>({
   id:e?.id,kind:e?.kind,key:typeof e?.key==='string'?previewText(e.key,150):undefined,
  }))}
  return {...input,text:input.text.slice(0,start)+JSON.stringify(body)}
 })
}
