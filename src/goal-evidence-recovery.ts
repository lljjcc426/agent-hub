import {unsettledTaskEffects} from './artifact-read-recovery.ts'
import {goalHandoffEvidence} from './goal-handoff-evidence.ts'
import {internalEvidence,outputKey} from './goal-internal-files.ts'
import type {GoalNode} from './goal-contract.ts'
import type {GoalDelivery} from './goal-verification.ts'
import type {RouterGoal} from './router-goals.ts'
import type {ScopeContext} from './router-scope.ts'
import type {Runtime} from './runtime.ts'
import type {Run,Store} from './store.ts'
import {stableDigest} from './sources.ts'
import {allowNewTaskInputs} from './task-context.ts'

export function capturedOutputs(store:Store,g:RouterGoal,n:GoalNode){
 if(!n.derivedFrom||n.criterionIds.length||!n.outputs?.length)return
 const ids:string[]=[]
 for(const path of n.outputs){
  const ref=store.get<{artifactId:string;ticketId:string}>('goal-captured-output',outputKey(g.id,n.id,path))
  if(!ref||ref.ticketId!==n.ticketId)return
  ids.push(ref.artifactId)
 }
 return ids
}

/** A settled, scoped Worker blocker may have an independent answer in the host ledger. */
export function recoverGoalEvidence(h:Runtime,g:RouterGoal,n:GoalNode,c:ScopeContext){
 const id=n.ticketId
 if(!id||h.schedulingPaused||!h.config.work.autoRecover||!g.managed||!g.contract||g.project||g.supersededBy||
    g.replanId||g.acceptanceOverflow||g.turns>=g.maxTurns||g.failures>=3||!h.artifacts.canCapture(g)||
    n.dependsOn.some(dep=>g.nodes?.find(item=>item.id===dep)?.state!=='passed'))return false
 const {store}=h,task=store.tickets.get(id),assignment=task?.assignments.at(-1),report=assignment?.report
 const run=store.get<Run>('run',id)
 if(!task||task.ended||task.attention||task.undelivered.length||!assignment||assignment.state!=='running'||
    report?.state!=='blocked'||run?.phase!=='idle'||run.assignmentId!==assignment.id||run.failure||run.waitingForWriter||
    store.get('goal-delivery',id)||store.get('task-continuation',id)||h.executionActive(id))return false
 const outputs=capturedOutputs(store,g,n)
 const handoffs=goalHandoffEvidence(h,g,id,c)
 if(!outputs&&!handoffs.some(receipt=>receipt.exchanges.length))return false
 h.scopes.checkTask(id,c,true)
 const attempt=store.get<{attemptId:string;assignmentId:string}>('async-worker-current',id)
 if(attempt){
  const terminal=store.get<{ticketId:string;assignmentId:string}>('async-worker-terminal',attempt.attemptId)
  if(attempt.assignmentId!==assignment.id||terminal?.ticketId!==id||terminal.assignmentId!==assignment.id)return false
 }
 if(!h.goals.effectsSettled(id)||unsettledTaskEffects(store,id,0)||
    store.db.prepare(`SELECT 1 FROM jobs WHERE state IN ('pending','running','blocked','uncertain')
      AND (json_extract(payload,'$.ticketId')=? OR json_extract(payload,'$.assignmentId')=?) LIMIT 1`).get(id,assignment.id)||
    store.db.prepare(`SELECT 1 FROM records WHERE (kind='browser-receipt' AND json_extract(body,'$.ticketId')=?
      OR kind='backend-plugin-tool' AND json_extract(body,'$.threadId')=?) AND json_extract(body,'$.state') IS NOT 'complete' LIMIT 1`).get(id,run.threadId??''))return false
 const digest=stableDigest(handoffs)
 const outputDigest=outputs&&stableDigest([g.contract,n.instruction,n.dependsOn.map(dep=>g.nodes!.find(item=>item.id===dep)?.roundId),outputs,digest])
 let review=false
 if(outputs&&outputDigest!==n.outputReviewDigest){
  // Pointers alone cannot prove that the bytes in the current workspace still match.
  try{review=n.outputs!.every((path,i)=>{
   const a=internalEvidence(store,g.id,n.id,id,run.cwd,path)?.artifact
   return a?.id===outputs[i]&&!!a&&!h.memory.cleanup.blocked('goal-artifact',a.id,a)
  })}catch{/* A changed or inaccessible output needs a fresh capture. */}
 }
 const seen=store.get<{digest:string;assignmentId:string}>('worker-handoff-evidence',id)
 const wake=handoffs.some(receipt=>receipt.exchanges.length)&&!(seen?.assignmentId===assignment.id&&seen.digest===digest)&&n.handoffWakeDigest!==digest
 if(!review&&!wake)return false
 return store.atomic(()=>{
  if(review){
   const candidate={goalId:g.id,ticketId:id,triggerId:g.triggerId,scopeId:g.scopeId,assignmentId:assignment.id,
    report:{state:report.state,summary:report.summary},inputRevision:h.scopes.ownership(id)!.dataRevision??1,
    retainedOutputs:{digest:outputDigest!,reportedAt:report.at}}
   store.put('goal-delivery',id,{...candidate,id:stableDigest(candidate),at:Date.now()} satisfies GoalDelivery)
   n.outputReviewDigest=outputDigest
   h.engine.report(id,{state:'waiting',summary:'已提交现有产物，正在独立验收。',question:null})
   n.state='verifying'
  }else{
   const previous=task.inputs.map(input=>input.id)
   h.scopes.noteInput(id,c);h.memory.moveTaskContext(id,c)
   h.engine.report(id,{state:'waiting',summary:'已收到原始交接记录，正在继续处理。',question:null})
   h.engine.note(id,'The host recovered the authenticated handoff exchange for this task. Read chatFileHandoffEvidence and continue the existing work from its receipts and files.')
   allowNewTaskInputs(store,id,previous)
   n.handoffWakeDigest=digest;n.state='running'
  }
  n.reason=undefined;n.failure=undefined;n.retryAt=undefined;n.roundId=undefined
  g.state='active';g.reason=undefined;g.nextAt=undefined;g.finalRoundId=undefined;g.revision++
  store.put('router-goal',g.id,g)
  store.audit({type:'goal.evidence_recovered',goalId:g.id,nodeId:n.id,ticketId:id,assignmentId:assignment.id,
   action:review?'verify_outputs':'deliver_handoff',digest:review?outputDigest:digest})
  return true
 })
}
