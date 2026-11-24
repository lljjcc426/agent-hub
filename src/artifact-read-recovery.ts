import {lstatSync} from 'node:fs'
import {join} from 'node:path'
import {proveInterruptedArtifactRead,type ArtifactReadProof} from './backends/opencode-read-recovery.ts'
import {artifactReadAssetId} from './goal-artifacts.ts'
import {repositoryEffectsSettled} from './repository-source.ts'
import type {Run,Store} from './store.ts'
import type {Ticket} from './vendor/dsh-core/index.ts'

type RecoveryStore=Pick<Store,'db'|'get'|'list'|'deliveries'>
type ArtifactReadHold={run:Run;proof:ArtifactReadProof}

export function unsettledTaskEffects(store:Pick<Store,'db'>,id:string,since:number,awaitedShellAssignment?:string){
 return !!store.db.prepare(`SELECT 1 FROM records WHERE
  (json_extract(body,'$.ticketId')=? AND (
    (kind='work' AND ((json_extract(body,'$.state') IN ('starting','running') AND NOT
      (? IS NOT NULL AND json_extract(body,'$.assignmentId') IS ? AND json_extract(body,'$.kind') IS 'shell' AND json_extract(body,'$.agentId') IS NULL))
      OR (json_extract(body,'$.state')='interrupted' AND coalesce(json_extract(body,'$.endedAt'),?)>=?)))
    OR (kind='execution-call' AND json_extract(body,'$.state')='running')
    OR (kind='workflow-action' AND json_extract(body,'$.state') IN ('pending','applying','uncertain'))
    OR (kind='approval' AND (json_extract(body,'$.status')='pending'
      OR (json_extract(body,'$.key') IS NOT NULL AND json_extract(body,'$.status')='resolved' AND coalesce(json_extract(body,'$.delivered'),0)=0)))))
  OR (kind='chat-permission' AND json_extract(body,'$.actor.ticketId')=? AND
    json_extract(body,'$.phase') IN ('pending','approved','executing','uncertain')) LIMIT 1`).get(id,awaitedShellAssignment??null,awaitedShellAssignment??null,since,since,id)
}

function hasOtherTaskWork(store:RecoveryStore,run:Run){
 const {ticketId,assignmentId}=run
 const attempt=store.get<{attemptId:string;assignmentId:string}>('async-worker-current',ticketId)
 if(attempt){
  const terminal=store.get<{ticketId:string;assignmentId:string}>('async-worker-terminal',attempt.attemptId)
  if(attempt.assignmentId!==assignmentId||terminal?.ticketId!==ticketId||terminal.assignmentId!==assignmentId)return true
 }
 if(unsettledTaskEffects(store,ticketId,0)||!repositoryEffectsSettled(store,ticketId))return true
 if(store.deliveries().some(delivery=>delivery.ticketId===ticketId&&!['sent','dropped'].includes(delivery.status)))return true
 return !!store.db.prepare(`SELECT 1 FROM jobs WHERE state IN ('pending','running','uncertain','blocked') AND
   (json_extract(payload,'$.ticketId')=? OR json_extract(payload,'$.assignmentId')=?) LIMIT 1`).get(ticketId,assignmentId)
  ||!!store.db.prepare(`SELECT 1 FROM records WHERE kind IN ('tool-receipt','browser-receipt')
   AND json_extract(body,'$.ticketId')=? AND json_extract(body,'$.state') IS NOT 'complete' LIMIT 1`).get(ticketId)
  ||!!store.db.prepare(`SELECT 1 FROM records g WHERE g.kind='router-goal' AND json_extract(g.body,'$.state') NOT IN ('completed','cancelled')
   AND (EXISTS (SELECT 1 FROM json_each(g.body,'$.taskIds') WHERE value=?)
    OR EXISTS (SELECT 1 FROM json_each(g.body,'$.nodes') WHERE json_extract(value,'$.ticketId')=?)) LIMIT 1`).get(ticketId,ticketId)
}

export function heldArtifactReads(store:RecoveryStore,stateDir:string,active:(ticketId:string)=>boolean=()=>false):ArtifactReadHold[]{
 const holds:ArtifactReadHold[]=[]
 for(const ticket of store.list<Ticket>('ticket')){
  if(ticket.ended||!Array.isArray(ticket.undelivered)||ticket.undelivered.length||active(ticket.id))continue
  const assignment=ticket.assignments.at(-1)
  if(assignment?.state!=='running'||assignment.report?.state!=='blocked')continue
  const run=store.get<Run>('run',ticket.id)
  if(!run||run.ticketId!==ticket.id||run.assignmentId!==assignment.id||run.failure||run.waitingForWriter)continue
  const proof=proveInterruptedArtifactRead(store,stateDir,run)
  if(!proof||hasOtherTaskWork(store,run))continue
  // open() materializes an asset in this directory before publishing its asset row.
  // Either trace of materialization requires an operator to inspect the outcome.
  const assetId=artifactReadAssetId(ticket.id,proof.artifactId)
  if(store.get('asset',assetId))continue
  try{if(lstatSync(join(stateDir,'assets',assetId),{throwIfNoEntry:false}))continue}
  catch{continue}
  holds.push({run,proof})
 }
 return holds
}

export function reconcileArtifactReads(store:Store,stateDir:string,active?:(ticketId:string)=>boolean){
 store.atomic(()=>{
  for(const {run,proof} of heldArtifactReads(store,stateDir,active)){
   if(proof.receipt.state!=='running')continue
   const reconciliation={
    reason:'interrupted_artifact_read',ticketId:run.ticketId,assignmentId:run.assignmentId,
    threadId:proof.threadId,turnId:proof.turnId,at:Date.now(),
   } as const
   store.put('backend-plugin-tool',proof.receiptId,{...proof.receipt,state:'complete',
    result:{success:false,contentItems:[{type:'inputText',text:'The interrupted artifact read returned no result. Check the original artifact and its authorization before trying again.'}]},
    reconciliation,
   })
   // Keep the original ticket, assignment, thread and files. Retrying remains an explicit action.
   store.put('run',run.ticketId,{...run,phase:'idle',error:undefined})
   store.audit({type:'artifact.read.reconciled',receiptId:proof.receiptId,...reconciliation})
  }
 })
}
