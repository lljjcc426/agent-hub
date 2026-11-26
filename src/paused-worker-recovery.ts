import type {WorkerAttempt,WorkerEventReceipt} from './async-worker-inbox.ts'
import type {PluginThread} from './backends/plugin-process.ts'
import {pausedOpenCodeTurn} from './backends/opencode-read-recovery.ts'
import type {RouterGoal} from './router-goals.ts'
import type {RouterRoute,TaskOwnership} from './router-scope.ts'
import type {Run,Store} from './store.ts'
import {stableDigest} from './sources.ts'
import type {Trigger} from './vendor/dsh-core/index.ts'

type RecoveryStore=Pick<Store,'get'|'db'>
type GoalReceipt={scopeId:string;entryId:string;triggerId:string;result:RouterGoal;action?:string;at?:number}
type Pause= {at:number;revision:number}
type Terminal = {eventId:string;ticketId:string;assignmentId:string}

// The host consumes a journal proof, irrespective of the model API or adapter format.
type PausedTurnProof={
 calls:{tool:string;effectId:string;success:boolean;callId?:string}[]
 jobs:{id:string;commandDigest:string}[]
}
type PausedTurnReader=(store:RecoveryStore,stateDir:string,run:Run,attempt:WorkerAttempt)=>PausedTurnProof|undefined
const pausedTurnReaders:ReadonlyMap<string,PausedTurnReader>=new Map([['opencode-cli',pausedOpenCodeTurn]])

export function hasPausedTurnReader(store:RecoveryStore,run:Run|undefined){
 const thread=run?.threadId&&store.get<PluginThread>('backend-plugin-thread',run.threadId)
 return !!thread&&thread.state!=='completed'&&pausedTurnReaders.has(thread.pluginId)
}

export function relatedPause(store:RecoveryStore,goal:RouterGoal,ticketId:string):Pause|undefined{
 if(!goal.managed||!goal.contract||goal.project||goal.cancelledByUser||goal.supersededBy||goal.replanId)return
 const receipts=store.db.prepare(`SELECT body FROM records WHERE kind='goal-receipt' AND json_extract(body,'$.goalId')=?
   AND json_extract(body,'$.result.state') IN ('paused','active') ORDER BY rowid DESC`).all(goal.id)
 const contract=stableDigest(goal.contract)
 const matching=receipts.map(row=>JSON.parse(String(row.body)) as GoalReceipt).filter(r=>
  r?.scopeId===goal.scopeId&&r.entryId===goal.entryId&&r.result?.id===goal.id&&r.result.actor===goal.actor&&
  r.result.discussion===goal.discussion&&r.result.bindingRevision===goal.bindingRevision&&r.result.planRevision===goal.planRevision&&
  r.result.taskIds?.includes(ticketId)&&stableDigest(r.result.contract??null)===contract)
 const pause=matching.find(r=>r.result.state==='paused'&&(!r.action||r.action==='pause'))
 if(!pause)return
 if(goal.state==='paused'){
  if(pause.result.revision!==goal.revision)return
 }else if(!matching.some(r=>r.result.state==='active'&&(!r.action||r.action==='resume')&&
   r.result.revision===pause.result.revision+1&&r.result.revision<=goal.revision&&r.triggerId===goal.triggerId&&r.result.triggerId===r.triggerId))return
 const trigger=store.get<Trigger>('trigger',pause.triggerId)
 const route=store.get<RouterRoute>('router-route',pause.triggerId)
 const at=pause.at??Date.parse(trigger?.at??'')
 if(!trigger?.human||!Number.isFinite(at)||JSON.stringify([trigger.actor.source,trigger.actor.id])!==goal.actor||
   route?.entryId!==goal.entryId||route.scopeId!==goal.scopeId||route.discussion!==goal.discussion)return
 return {at,revision:pause.result.revision}
}

export function readPausedTurn(store:RecoveryStore,stateDir:string,goal:RouterGoal,run:Run,pause:Pause){
 if(!run.threadId||!run.turnId||run.waitingForWriter)return
 const thread=store.get<PluginThread>('backend-plugin-thread',run.threadId)
 const reader=thread&&pausedTurnReaders.get(thread.pluginId)
 if(!reader)return
 const owner=store.get<TaskOwnership>('task-ownership',run.ticketId)
 if(owner?.state!=='active'||owner.scopeId!==goal.scopeId||owner.originEntry!==goal.entryId||
   owner.discussion!==goal.discussion||owner.backendId!==run.backendId)return
 const row=store.db.prepare(`SELECT body FROM records WHERE kind='async-worker-attempt'
   AND json_extract(body,'$.ticketId')=? AND json_extract(body,'$.assignmentId')=?
   AND json_extract(body,'$.startedAt')<=? ORDER BY json_extract(body,'$.startedAt') DESC LIMIT 1`).get(run.ticketId,run.assignmentId,pause.at)
 if(!row)return
 const attempt=JSON.parse(String(row.body)) as WorkerAttempt, basis=attempt.basis
 const terminal=store.get<Terminal>('async-worker-terminal',attempt.id)
 const event=terminal&&store.get<WorkerEventReceipt>('async-worker-event',terminal.eventId)
 const marker=store.get<{goalId:string;ticketId:string;assignmentId:string;revision:number}>('async-worker-paused',attempt.id)
 if(marker&&(marker.goalId!==goal.id||marker.ticketId!==run.ticketId||marker.assignmentId!==run.assignmentId||marker.revision!==pause.revision))return
 if(!event||terminal?.ticketId!==run.ticketId||terminal.assignmentId!==run.assignmentId||
   event.attemptId!==attempt.id||event.kind!=='blocked'||event.observedAt<pause.at||
   event.nativeTurnDigest!==stableDigest(run.turnId)||stableDigest(event.basis)!==stableDigest(basis)||
   store.get('async-worker-revoked',attempt.id)||
   basis.goalId!==goal.id||basis.contractDigest!==stableDigest(goal.contract)||basis.planRevision!==(goal.planRevision??null)||
   basis.bindingRevision!==goal.bindingRevision||basis.ownerEpoch!==owner.ownerEpoch||basis.dataRevision!==(owner.dataRevision??null))return
 const proof=reader(store,stateDir,run,attempt)
 if(!proof)return
 return {...proof,attempt,continuationId:'goal-resume:'+stableDigest([goal.id,run.ticketId,run.assignmentId,pause.revision,run.threadId,run.turnId])}
}

export interface ResumedWorker {
 id:string;goalId:string;ticketId:string;assignmentId:string;triggerId:string;pauseRevision:number;inputId?:string;
 jobs:{id:string;commandDigest:string}[];
}

/** Earlier releases could save a checkpoint while the old blocked report kept the resume note out of the queue. */
export function parkedCheckpoint(store:RecoveryStore,stateDir:string,goal:RouterGoal,run:Run){
 const resumed=store.get<ResumedWorker>('goal-worker-continuation',run.ticketId)
 if(!resumed||resumed.inputId||resumed.goalId!==goal.id||resumed.triggerId!==goal.triggerId||
   resumed.assignmentId!==run.assignmentId||run.rebuild!==resumed.id||run.threadId||run.phase!=='idle')return
 const handoff=store.get<{ticketId:string;previousThread:string;previousTurn:string;reason:string;at:number}>('context-handoff',resumed.id)
 if(!handoff||handoff.ticketId!==run.ticketId||handoff.reason!=='user_resumed_from_checkpoint'||
   store.db.prepare(`SELECT 1 FROM records WHERE kind='async-worker-attempt' AND json_extract(body,'$.ticketId')=?
    AND json_extract(body,'$.startedAt')>=? LIMIT 1`).get(run.ticketId,handoff.at))return
 const pause=relatedPause(store,goal,run.ticketId)
 if(!pause)return
 const proof=readPausedTurn(store,stateDir,goal,{...run,threadId:handoff.previousThread,turnId:handoff.previousTurn},pause)
 if(!proof||proof.continuationId!==resumed.id||
   !proof.jobs.every(job=>resumed.jobs.some(saved=>saved.id===job.id&&saved.commandDigest===job.commandDigest)))return
 return {resume:resumed,handoff,proof}
}
