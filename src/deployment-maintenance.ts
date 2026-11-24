import {z} from 'zod'
import {statSync} from 'node:fs'
import type {Runtime} from './runtime.ts'
import {marketBlockers} from './plugin-market.ts'
import {heldArtifactReads,unsettledTaskEffects} from './artifact-read-recovery.ts'
import {retainedBackendReceipts} from './backend-receipt-recovery.ts'
import {refusedWorkerJobReads,settledProviderTurn,unstartedWorkerShell} from './backends/opencode-read-recovery.ts'
import type {PluginThread,PluginToolEffect} from './backends/plugin-process.ts'
import type {WorkerAttempt,WorkerEventReceipt} from './async-worker-inbox.ts'
import {repositoryEffectsSettled} from './repository-source.ts'
import {acceptanceRetryTarget,retainedGoalDelivery} from './goal-acceptance.ts'
import type {Run,Store} from './store.ts'
import {consumedInputWake,retainedInputWakes} from './task-context.ts'
import {heldQuestionNode,type RouterGoal} from './router-goals.ts'
import {legacyAnsweredGoalReply,type BusinessDecisionView} from './business-decisions.ts'
import type {Ticket} from './vendor/dsh-core/index.ts'
import type {ChatDelivery} from './chat-deliveries.ts'
import type {ReplanRound} from './goal-replanning.ts'
import type {VerificationRound} from './goal-verification.ts'
import type {TaskOwnership} from './router-scope.ts'
import {bodyDigest,stableDigest} from './sources.ts'
import {sourceHeldNode} from './goal-source-checkpoint.ts'
import {restoreRetainedFiles,retainedFileHandoffSchema} from './chat-file-handoff.ts'

export class DeploymentError extends Error {constructor(readonly code:string,message:string,readonly status=409){super(message)}}
const command=z.discriminatedUnion('action',[
 z.object({action:z.enum(['prepare','finish','abort']),operationId:z.string().uuid(),
  expectedRevision:z.number().int().nonnegative().optional(),legacyPauseSeq:z.number().int().positive().safe().optional()}).strict(),
 z.object({action:z.literal('restore-files'),operationId:z.string().uuid(),handoff:retainedFileHandoffSchema}).strict(),
])
interface Maintenance {id:string;state:'preparing'|'prepared'|'finished'|'aborted'|'failed';wasPaused:boolean;pauseSeq?:number;at:number;resumed?:boolean;reason?:string}
export function pauseControl(host:Runtime){
 const row=host.store.db.prepare("SELECT seq,body FROM audit WHERE json_extract(body,'$.type')='pause' ORDER BY seq DESC LIMIT 1").get()
 return row?{...JSON.parse(String(row.body)),seq:Number(row.seq)}:undefined
}
type DeploymentStore = Pick<Store,'db'|'get'|'list'|'deliveries'>

function heldAnsweredQuestionTasks(store:DeploymentStore,goal:RouterGoal){
 if(goal.state!=='held'||goal.nextAt!==undefined||goal.delegationIds?.length)return
 const held=goal.nodes?.find(node=>node.state==='held')
 if(!held?.ticketId||!goal.taskIds.includes(held.ticketId)||!goal.nodes!.every(node=>node===held||node.state==='passed'))return
 const run=store.get<Run>('run',held.ticketId),reply=run&&legacyAnsweredGoalReply(store,run)
 if(reply&&heldQuestionNode(goal,held.ticketId,reply.saved.summary)&&!unsettledTaskEffects(store,held.ticketId,reply.at))return [held.ticketId]
}

function heldAcceptanceTasks(store:DeploymentStore,goal:RouterGoal):string[]|undefined {
 if(goal.nextAt!==undefined||goal.delegationIds?.length||!acceptanceRetryTarget(store,goal))return
 const replan=goal.replanId&&store.get<ReplanRound>('goal-replan',goal.replanId)
 if(replan&&['pending','planning','reviewing','approved'].includes(replan.state))return
 const ids=[...new Set(goal.nodes?.flatMap(node=>node.ticketId?[node.ticketId]:[])??[])]
 if(!ids.length||goal.taskIds.some(id=>!ids.includes(id)))return
 for(const id of ids){
  const delivery=retainedGoalDelivery(store,goal,id)
  if(!delivery)return
  if(unsettledTaskEffects(store,id,delivery.at))return
  if(!retainedDeliveryFiles(store,id,delivery.files))return
 }
 return ids
}

function retainedDeliveryFiles(store:DeploymentStore,id:string,files:string[]=[]){
 return files.every(fileId=>{
  const file=store.get<ChatDelivery>('chat-delivery',fileId)
  return file?.mime&&file.ticketId===id&&store.db.prepare('SELECT length(bytes) AS size FROM chat_delivery_bytes WHERE id=?').get(fileId)?.size===file.size
 })
}

/** Final quality rejection parks the graph with its individual ready deliveries intact. */
function rejectedOverallRound(store:DeploymentStore,goal:RouterGoal){
 const id=goal.finalRoundId,round=id&&store.get<VerificationRound>('goal-verification',id)
 if(!round||round.id!==id||round.goalId!==goal.id||round.nodeId!==undefined||round.scopeId!==goal.scopeId||
  round.entryId!==goal.entryId||round.triggerId!==goal.triggerId||!round.finishedAt||
  !['failed','insufficient'].includes(round.state)||!round.checks?.some(check=>check.verdict!=='passed')||
  !Array.isArray(round.snapshot?.tasks)||!Array.isArray(round.ticketIds))return
 const held=goal.nodes?.filter(node=>node.state!=='passed')
 if(held?.length!==1)return
 const node=held[0]!
 if(node.state!=='held'||node.roundId!==id||node.failure?.kind!=='quality'||!goal.reason||
  node.reason!==goal.reason||node.failure.reason!==goal.reason||node.repairs-(node.repairStart??0)<(goal.maxRepairs??2))return
 if(id!=='verify-'+stableDigest([goal.id,'goal',round.snapshot])||
  !store.db.prepare("SELECT 1 FROM jobs WHERE id=? AND kind='goal-verify' AND state='done' AND json_extract(payload,'$.roundId')=? AND json_extract(payload,'$.goalId')=?").get('goal-verify:'+id,id,goal.id))return
 const ids=new Set(goal.taskIds),tasks=round.snapshot.tasks
 if(!ids.size||tasks.length!==ids.size||new Set(tasks.map(t=>t.ticketId)).size!==ids.size||
  round.ticketIds.length!==ids.size||new Set(round.ticketIds).size!==ids.size||round.ticketIds.some(t=>!ids.has(t)))return
 for(const task of tasks){
  const delivery=retainedGoalDelivery(store,goal,task.ticketId)
  if(!ids.has(task.ticketId)||!delivery||delivery.assignmentId!==task.assignmentId||delivery.inputRevision!==task.inputRevision||
   stableDigest(delivery)!==task.reportHash||!retainedDeliveryFiles(store,task.ticketId,delivery.files))return
 }
 return node
}

// The graph keeps ownership while a Worker waits. Its last applied result and
// the native turn must agree before that running node can survive a cutover.
function completedWaitingTurn(store:DeploymentStore,goal:RouterGoal,ticket:Ticket,run:Run,owner:TaskOwnership){
 const assignment=ticket.assignments.at(-1)
 if(!assignment||assignment.id!==run.assignmentId||assignment.report?.state!=='waiting'||ticket.attention||
  ticket.undelivered.length||run.phase!=='idle'||run.failure||!run.threadId||!run.turnId)return false
 const thread=store.get<PluginThread>('backend-plugin-thread',run.threadId)
 const session=store.get<{ticketId?:string}>('model-session',run.threadId)
 if(thread?.state!=='completed'||thread.id!==run.threadId||thread.turnId!==run.turnId||
  thread.backendId!==run.backendId||thread.cwd!==run.cwd||session?.ticketId!==ticket.id||
  !Array.isArray(thread.effectIds)||thread.effectIds.some(id=>{
   const effect=store.get<PluginToolEffect>('backend-plugin-tool',id)
   return effect?.state!=='complete'||!effect.result||effect.result.permission==='uncertain'||
    effect.children?.some(child=>child.state!=='complete'||child.permission==='uncertain')
  }))return false
 const current=store.get<{ticketId:string;assignmentId:string;attemptId:string}>('async-worker-current',ticket.id)
 if(current?.ticketId!==ticket.id||current.assignmentId!==assignment.id||!current.attemptId)return false
 const attempt=store.get<WorkerAttempt>('async-worker-attempt',current.attemptId)
 const terminal=store.get<{eventId:string;attemptId:string;ticketId:string;assignmentId:string}>('async-worker-terminal',current.attemptId)
 if(!attempt?.causeJobId||!attempt.basis||attempt.id!==current.attemptId||attempt.ticketId!==ticket.id||attempt.assignmentId!==assignment.id||
  terminal?.attemptId!==attempt.id||terminal.ticketId!==ticket.id||terminal.assignmentId!==assignment.id||!terminal.eventId||
  store.get('async-worker-revoked',attempt.id))return false
 const event=store.get<WorkerEventReceipt>('async-worker-event',terminal.eventId)
 if(event?.id!==terminal.eventId||event.attemptId!==attempt.id||event.ticketId!==ticket.id||event.assignmentId!==assignment.id||
  event.kind!=='result'||event.disposition!=='applied'||event.nativeTurnDigest!==stableDigest(run.turnId)||
  event.basis?.goalId!==goal.id||event.basis.dataRevision!==(owner.dataRevision??1)||stableDigest(event.basis)!==stableDigest(attempt.basis))return false
 if(!store.db.prepare("SELECT 1 FROM jobs WHERE id=? AND kind='execute' AND state='done' AND json_extract(payload,'$.ticketId')=? AND json_extract(payload,'$.assignmentId')=?").get(attempt.causeJobId,ticket.id,assignment.id))return false
 return !store.db.prepare(`SELECT 1 FROM jobs WHERE state IN ('pending','running','blocked','uncertain')
  AND (json_extract(payload,'$.ticketId')=? OR json_extract(payload,'$.assignmentId')=?) LIMIT 1`).get(ticket.id,assignment.id)&&
  repositoryEffectsSettled(store,ticket.id)
}

// An idle Chat task may still be waiting on a user or a prerequisite. A
// replacement host can keep that checkpoint without dispatching another turn.
function heldChatTasks(store:DeploymentStore,goal:RouterGoal,stateDir:string){
 const nodes=goal.nodes,jobs:string[]=[],receipts:{id:string;threadId:string;turnId:string;tool:string}[]=[]
 const sourceHold=goal.reason==='Error: Goal sources changed; explicit goal reauthorization is required'
 if(!nodes||!goal.managed||goal.supersededBy||goal.cancelledByUser||
  goal.delegationIds?.length||goal.project?.review?.state==='pending')return
 // The sole unfinished Worker can be stopped or have completed a waiting turn.
 const activeNode=goal.state==='active'&&!goal.project&&!goal.replanId&&goal.nextAt===undefined&&
  nodes.filter(node=>node.state!=='passed').length===1?nodes.find(node=>node.state==='running'):undefined
 if(!activeNode&&(goal.state!=='held'||!nodes.some(node=>node.state==='held'||sourceHold&&node.state==='running')))return
 const chat=store.get<{conversationId:string;cancelled?:boolean;cancelRequested?:boolean}>('chat-run',goal.triggerId)
 if(!chat||chat.cancelled||chat.cancelRequested)return
 const conversation=store.get<{sourceId:string;discussion:string}>('chat-conversation',chat.conversationId)
 if(!conversation?.sourceId||conversation.discussion!==goal.discussion||
  goal.discussion!==conversation.sourceId+':chat:'+chat.conversationId)return
 if(store.db.prepare(`SELECT 1 FROM records WHERE json_extract(body,'$.goalId')=? AND
   ((kind='goal-verification' AND json_extract(body,'$.state') IN ('pending','running'))
    OR (kind='goal-replan' AND json_extract(body,'$.state') IN ('pending','planning','reviewing','approved'))
    OR (kind='goal-wake' AND json_extract(body,'$.state') IN ('queued','running'))) LIMIT 1`).get(goal.id))return
 const finalHold=rejectedOverallRound(store,goal)
 const ids=new Set<string>()
 let hasProviderCheckpoint=false
 for(const node of nodes){
  const id=node.ticketId
  if(!id||ids.has(id)||node.teamTargetId||node.delegationId||node.retryAt!==undefined||
   node.failure?.kind==='unconfirmed_effect'||
   !['held','waiting_dependency','passed',...(sourceHold||node===activeNode?['running']:[])].includes(node.state))return
  ids.add(id)
  const ticket=store.get<Ticket>('ticket',id),run=store.get<Run>('run',id),owner=store.get<TaskOwnership>('task-ownership',id)
  const assignment=ticket?.assignments.at(-1)
  const waitingOnDependency=node.state==='waiting_dependency'&&node.dependsOn.some(dep=>nodes.some(item=>item.id===dep&&item.state!=='passed'))
  if(node.state==='waiting_dependency'&&!waitingOnDependency)return
  const refused=run&&node.state==='held'&&node.failure?.kind==='uncertain'?refusedWorkerJobReads(store,stateDir,run):undefined
  const shell=run&&!refused&&!goal.project&&!goal.replanId&&(node===activeNode||node.state==='held'&&node.failure?.kind==='uncertain')&&
   node.dependsOn.every(dep=>nodes.some(n=>n.id===dep&&n.state==='passed'))?unstartedWorkerShell(store,stateDir,run):undefined
  const provider=run&&!shell&&!refused&&!goal.project&&!goal.replanId&&(node===activeNode||node.state==='held'&&node.failure?.kind==='uncertain')&&
   node.dependsOn.every(dep=>nodes.some(n=>n.id===dep&&n.state==='passed'))?settledProviderTurn(store,stateDir,run):undefined
  const stopped=shell||provider
  if(node.failure?.kind==='uncertain'&&!refused&&!stopped)return
  if(!ticket||ticket.ended||!assignment||!run||run.ticketId!==id||run.phase!=='idle'&&!refused&&!stopped||run.waitingForWriter||
   !owner||owner.scopeId!==goal.scopeId||owner.discussion!==goal.discussion||unsettledTaskEffects(store,id,0))return
  const parked=goal.state==='held'&&sourceHold&&node.state==='running'?sourceHeldNode(store,ticket,run,owner):undefined
  const waiting=node===activeNode&&!node.failure&&node.dependsOn.every(dep=>nodes.some(n=>n.id===dep&&n.state==='passed'))&&
   completedWaitingTurn(store,goal,ticket,run,owner)
  if((node.state==='running'||stopped)&&(!parked&&!stopped&&!waiting||owner.originEntry!==goal.entryId||
   store.get<{privateActor?:string}>('entry-binding',goal.entryId)?.privateActor!==goal.actor))return
  if(!parked&&(assignment.state!=='running'||run.assignmentId!==assignment.id||owner.state!=='active'))return
  if(ticket.undelivered.length&&(!waitingOnDependency&&!parked&&!stopped||
   !ticket.undelivered.every(inputId=>ticket.inputs.some(input=>input.id===inputId))))return
  try{if(!statSync(run.cwd).isDirectory())return}catch{return}
  if(run.threadId&&store.get<PluginThread>('backend-plugin-thread',run.threadId)?.state==='running')return
  if(store.db.prepare(`SELECT 1 FROM jobs WHERE state IN ('blocked','uncertain')
    AND (json_extract(payload,'$.ticketId')=? OR json_extract(payload,'$.assignmentId')=?) LIMIT 1`).get(id,assignment.id))return
  if(store.db.prepare(`SELECT 1 FROM records WHERE kind='browser-receipt' AND json_extract(body,'$.ticketId')=?
    AND json_extract(body,'$.state') IS NOT 'complete' LIMIT 1`).get(id))return
  if(waiting)continue
  const attempt=store.get<{attemptId:string;assignmentId:string}>('async-worker-current',id)
  if(refused){
   if(!attempt||!run.threadId||!run.turnId||ticket.attention||ticket.undelivered.length||owner.originEntry!==goal.entryId||
    store.get<{privateActor?:string}>('entry-binding',goal.entryId)?.privateActor!==goal.actor)return
   for(const call of refused.interrupted)receipts.push({id:call.id,threadId:run.threadId,turnId:run.turnId,tool:'superagent_job'})
   // A wake may run before the initial activation job. The held goal parks
   // that exact pending job; maintenance must leave it and its receipts intact.
   const initial='execute:'+assignment.id+':initial'
   if(store.db.prepare("SELECT 1 FROM jobs WHERE id=? AND state='pending' AND kind='execute' AND json_extract(payload,'$.ticketId')=? AND json_extract(payload,'$.assignmentId')=?").get(initial,id,assignment.id))jobs.push(initial)
  }
  if(parked){
   if(ticket.attention||!ticket.undelivered.length)return
   if(parked==='start')jobs.push('start:'+assignment.id)
   continue
  }
  if(attempt){
   const terminal=store.get<{ticketId:string;assignmentId:string}>('async-worker-terminal',attempt.attemptId)
   if(attempt.assignmentId!==assignment.id||terminal?.ticketId!==id||terminal.assignmentId!==assignment.id)return
  }
  if(stopped){
   if(!run.threadId||!run.turnId||ticket.attention||assignment.report?.state!=='blocked')return
   for(const inputId of ticket.undelivered){
    const input=ticket.inputs.find(item=>item.id===inputId)
    if(provider&&input?.kind==='note')continue
    const trigger=input?.kind==='trigger'&&store.get<{human:boolean;actor:{source:string;id:string}}>('trigger',input.triggerId)
    if(!trigger||!trigger.human||!trigger.actor||JSON.stringify([trigger.actor.source,trigger.actor.id])!==goal.actor)return
   }
   if(shell)receipts.push({id:shell.callback.id,threadId:run.threadId,turnId:run.turnId,tool:'superagent_shell'})
   else{
    const wakes=retainedInputWakes(store,run)
    if(!attempt||!wakes)return
    for(const receiptId of provider!.settledBatches.keys())receipts.push({id:receiptId,threadId:run.threadId,turnId:run.turnId,tool:'code_mode'})
    for(const callback of provider!.undispatched)receipts.push({id:callback.id,threadId:run.threadId,turnId:run.turnId,tool:'superagent_desktop'})
    jobs.push(...wakes);hasProviderCheckpoint=true
   }
   continue
  }
  if(node===finalHold){
   if(assignment.report?.state!=='waiting'||ticket.attention||ticket.undelivered.length||
    owner.originEntry!==goal.entryId||store.get<{privateActor?:string}>('entry-binding',goal.entryId)?.privateActor!==goal.actor)return
  }else if(node.state==='passed'){
   const round=node.roundId&&store.get<VerificationRound>('goal-verification',node.roundId)
   const delivery=retainedGoalDelivery(store,goal,id)
   if(!round||round.state!=='passed'||round.goalId!==goal.id||round.nodeId!==node.id||
    !delivery||!retainedDeliveryFiles(store,id,delivery.files))return
  }else{
   if(!assignment.report||!['blocked','failed',...(waitingOnDependency?['waiting']:[])].includes(assignment.report.state))return
   if(ticket.attention){
    const decision=store.get<BusinessDecisionView>('business-decision',ticket.attention.id)
    if(decision?.ticketId!==id||decision.question!==ticket.attention.question)return
    if(decision.status!=='pending'){
     const answer=store.get<{assignmentId:string;triggerId:string}>('question-answer',bodyDigest([id,decision.id]))
     if(!waitingOnDependency||decision.status!=='answered'||answer?.assignmentId!==assignment.id||
      !store.get('trigger',answer.triggerId))return
    }
   }
  }
  if(!ticket.undelivered.length&&run.phase==='idle'){
   const wakes=store.db.prepare(`SELECT id FROM jobs WHERE kind='execute' AND state='pending' AND attempts=0
    AND json_extract(payload,'$.ticketId')=? AND json_extract(payload,'$.assignmentId')=?`).all(id,assignment.id)
   for(const wake of wakes)if(consumedInputWake(String(wake.id),assignment.id,ticket,run))jobs.push(String(wake.id))
  }
 }
 // Older overall quality holds kept their last active goal timestamp. It cannot
 // dispatch a quality-held node; queued wakes and active rounds were checked above.
 if(goal.nextAt!==undefined&&!finalHold&&(!receipts.length&&!hasProviderCheckpoint||nodes.some(n=>n.state==='held'&&n.failure?.kind!=='uncertain')))return
 if(new Set(goal.taskIds).size!==ids.size||goal.taskIds.some(id=>!ids.has(id)))return
 return {ids:[...ids],jobs,receipts}
}

export function inspectDeployment(store:DeploymentStore,activeExecutions=0,stateDir?:string){
 const artifactHolds=stateDir&&!activeExecutions?heldArtifactReads(store,stateDir):[]
 const backendReceipts=(stateDir&&!activeExecutions?retainedBackendReceipts(store,stateDir):[]).map(({id,threadId,turnId,name,recovery})=>({id,threadId,turnId,tool:name,recovery:recovery?.reason}))
 const verifiedReceipts=new Set(artifactHolds.filter(hold=>hold.proof.receipt.state==='running').map(hold=>hold.proof.receiptId))
 for(const receipt of backendReceipts)verifiedReceipts.add(receipt.id)
 const goals=store.list<RouterGoal&{deleted?:boolean}>('router-goal').filter(g=>g.objective&&!g.deleted&&!['completed','cancelled'].includes(g.state))
 const retained=new Set(artifactHolds.map(hold=>hold.run.ticketId))
 const heldGoals:{goalId:string;taskIds:string[]}[]=[],parkedJobs=new Set<string>()
 const unsettled=goals.filter(goal=>{
  const existing=heldAcceptanceTasks(store,goal)??heldAnsweredQuestionTasks(store,goal)
  const chat=!existing&&stateDir&&!activeExecutions?heldChatTasks(store,goal,stateDir):undefined
  const ids=existing??chat?.ids
  for(const key of chat?.jobs??[])parkedJobs.add(key)
  for(const receipt of chat?.receipts??[]){
   if(!verifiedReceipts.has(receipt.id))backendReceipts.push({...receipt,recovery:undefined})
   verifiedReceipts.add(receipt.id)
  }
  if(!ids)return true
  for(const id of ids)retained.add(id)
  heldGoals.push({goalId:goal.id,taskIds:ids})
  return false
 })
 const items=marketBlockers({store}).filter(i=>i.kind!=='goals'&&i.kind!=='tasks').map(item=>
  item.kind==='backend-effects'?{...item,count:item.count-verifiedReceipts.size}:item).filter(item=>item.count>0)
 const count=(kind:string,n:number)=>{if(n)items.push({kind,count:n})}
 const jobs=items.find(item=>item.kind==='jobs')
 if(jobs)jobs.count-=parkedJobs.size
 count('tasks',store.list<Ticket>('ticket').filter(t=>!t.ended&&!retained.has(t.id)).length)
 count('goals',unsettled.length)
 count('active-models',activeExecutions)
 count('active-managed-work',Number(store.db.prepare(`SELECT COUNT(*) AS n FROM records WHERE kind='work'
  AND json_extract(body,'$.state') IN ('starting','running')`).get()!.n))
 count('delegated-work',store.list<any>('delegation-outbound').filter(t=>t.contract&&!t.deleted&&!(t.remote&&['ready','cancelled'].includes(t.remote.state)&&(t.acceptance==='passed'||t.desired==='cancelled'&&t.remote.controlEpoch>=t.controlEpoch))).length)
 for(const table of ['webhook_inbox','webhook_deliveries']){
  const exists=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
  if(exists)count(table,Number(store.db.prepare('SELECT COUNT(*) n FROM '+table+" WHERE state IN ('received','pending','sending','held','uncertain')").get()!.n))
 }
 return {blockers:items.filter(item=>item.count>0),heldGoals,backendReceipts}
}

export function deploymentBlockers(store:DeploymentStore,activeExecutions=0,stateDir?:string){
 return inspectDeployment(store,activeExecutions,stateDir).blockers
}
export async function deploymentMaintenance(host:Runtime,input:unknown,signal?:AbortSignal){
 const x=command.parse(input),store=host.store,old=store.get<Maintenance>('deployment-maintenance',x.operationId)
 if(x.action==='restore-files'){
  const authorize=()=>{
   const maintenance=store.get<Maintenance>('deployment-maintenance',x.operationId),control=pauseControl(host)
   if(!host.schedulingPaused||maintenance?.state!=='prepared'||control?.seq!==maintenance.pauseSeq||control?.controlId!==maintenance.id)
    throw new DeploymentError('maintenance_not_prepared','A current maintenance pause is required')
   const retained=inspectDeployment(store,host.activeExecutions,host.config.stateDir)
   if(retained.blockers.length||!retained.heldGoals.some(goal=>goal.taskIds.includes(x.handoff.ticketId)))
    throw new DeploymentError('maintenance_task_unavailable','The Chat task must be at its retained checkpoint')
  }
  return restoreRetainedFiles(host,x.handoff,authorize,signal??new AbortController().signal)
 }
 if(x.action!=='prepare'){
  if(!old){if(x.action==='abort')return {operationId:x.operationId,state:'not_found',resumed:false};throw new DeploymentError('maintenance_not_found','Known maintenance operation required')}
  if(old.state==='failed'&&x.action==='abort'){store.put('deployment-maintenance',old.id,{...old,state:'aborted'});return {operationId:old.id,state:'aborted',resumed:false}}
  if(['finished','aborted'].includes(old.state))return {operationId:old.id,state:old.state,resumed:old.resumed??false,...(old.reason?{reason:old.reason}:{})}
  if(old.state!=='prepared'&&!(old.state==='preparing'&&x.action==='abort'))throw new DeploymentError('maintenance_not_prepared','Maintenance did not reach the prepared state; abort interrupted preparation')
  const control=pauseControl(host),owned=control?.controlId===old.id&&(old.state==='preparing'||control.seq===old.pauseSeq)
  // A later human pause/resume always wins over the installer receipt.
  if(owned&&!old.wasPaused)host.pause(false)
  const state=x.action==='finish'?'finished':'aborted'
  store.put('deployment-maintenance',old.id,{...old,state,resumed:owned&&!old.wasPaused,...(!owned?{reason:'pause_control_changed'}:{})})
  return {operationId:old.id,state,resumed:owned&&!old.wasPaused,...(!owned?{reason:'pause_control_changed'}:{})}
 }
 if(old){if(old.state!=='prepared')throw new DeploymentError('maintenance_operation_ended','Use a new maintenance operation');return {operationId:old.id,state:old.state,wasPaused:old.wasPaused}}
 if(x.expectedRevision!==host.settings.current().revision)throw new DeploymentError('settings_conflict','Read the current settings revision before maintenance')
 if(store.list<Maintenance>('deployment-maintenance').some(m=>['preparing','prepared'].includes(m.state)))throw new DeploymentError('maintenance_in_progress','Finish or abort the existing maintenance first')
 // An installer migrating from an older release may adopt its manual pause.
 // The exact audit sequence fences any intervening operator pause or resume.
 if(x.legacyPauseSeq!==undefined){
  const pause=pauseControl(host)
  if(!host.schedulingPaused||pause?.seq!==x.legacyPauseSeq||pause.value!==true||pause.controlId)
   throw new DeploymentError('maintenance_pause_changed','The recorded legacy pause is no longer current')
 }
 const busy=deploymentBlockers(store,host.activeExecutions,host.config.stateDir);if(busy.length)throw new DeploymentError('deployment_busy','Unsettled work blocks upgrade: '+JSON.stringify(busy))
 const record:Maintenance={id:x.operationId,state:'preparing',wasPaused:host.schedulingPaused&&x.legacyPauseSeq===undefined,at:Date.now()}
 store.put('deployment-maintenance',record.id,record)
 try{
  await host.pauseForConfiguration(record.id)
  if(store.get<Maintenance>('deployment-maintenance',record.id)?.state!=='preparing')throw new DeploymentError('maintenance_cancelled','Maintenance preparation was cancelled')
  const control=pauseControl(host)
  if(control?.controlId!==record.id)throw new DeploymentError('maintenance_pause_changed','Pause control changed during preparation')
  const pending=deploymentBlockers(store,host.activeExecutions,host.config.stateDir);if(pending.length)throw new DeploymentError('deployment_busy','New work arrived while preparing upgrade: '+JSON.stringify(pending))
  store.put('deployment-maintenance',record.id,{...record,state:'prepared',pauseSeq:control.seq})
  return {operationId:record.id,state:'prepared',wasPaused:record.wasPaused}
 }catch(error){
  if(pauseControl(host)?.controlId===record.id)host.pause(record.wasPaused)
  if(store.get<Maintenance>('deployment-maintenance',record.id)?.state==='preparing')store.put('deployment-maintenance',record.id,{...record,state:'failed'})
  throw error
 }
}
