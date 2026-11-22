import {z} from 'zod'
import type {Runtime} from './runtime.ts'
import {marketBlockers} from './plugin-market.ts'
import {heldArtifactReads,unsettledTaskEffects} from './artifact-read-recovery.ts'
import {acceptanceRetryTarget,retainedGoalDelivery} from './goal-acceptance.ts'
import type {Run,Store} from './store.ts'
import {heldQuestionNode,type RouterGoal} from './router-goals.ts'
import {legacyAnsweredGoalReply} from './business-decisions.ts'
import type {Ticket} from './vendor/dsh-core/index.ts'
import type {ChatDelivery} from './chat-deliveries.ts'
import type {ReplanRound} from './goal-replanning.ts'

export class DeploymentError extends Error {constructor(readonly code:string,message:string,readonly status=409){super(message)}}
const command=z.object({action:z.enum(['prepare','finish','abort']),operationId:z.string().uuid(),
 expectedRevision:z.number().int().nonnegative().optional(),legacyPauseSeq:z.number().int().positive().safe().optional()}).strict()
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
  for(const fileId of delivery.files??[]){
   const file=store.get<ChatDelivery>('chat-delivery',fileId)
   if(!file?.mime||file.ticketId!==id||store.db.prepare('SELECT length(bytes) AS size FROM chat_delivery_bytes WHERE id=?').get(fileId)?.size!==file.size)return
  }
 }
 return ids
}

export function deploymentBlockers(store:DeploymentStore,activeExecutions=0,stateDir?:string){
 const artifactHolds=stateDir&&!activeExecutions?heldArtifactReads(store,stateDir):[]
 const verifiedReceipts=new Set(artifactHolds.filter(hold=>hold.proof.receipt.state==='running').map(hold=>hold.proof.receiptId))
 const items=marketBlockers({store}).filter(i=>i.kind!=='goals'&&i.kind!=='tasks').map(item=>
  item.kind==='backend-effects'?{...item,count:item.count-verifiedReceipts.size}:item).filter(item=>item.count>0)
 const count=(kind:string,n:number)=>{if(n)items.push({kind,count:n})}
 const goals=store.list<RouterGoal&{deleted?:boolean}>('router-goal').filter(g=>g.objective&&!g.deleted&&!['completed','cancelled'].includes(g.state))
 const retained=new Set(artifactHolds.map(hold=>hold.run.ticketId))
 const unsettled=goals.filter(goal=>{
  const ids=heldAcceptanceTasks(store,goal)??heldAnsweredQuestionTasks(store,goal)
  if(!ids)return true
  for(const id of ids)retained.add(id)
  return false
 })
 count('tasks',store.list<Ticket>('ticket').filter(t=>!t.ended&&!retained.has(t.id)).length)
 count('goals',unsettled.length)
 count('active-models',activeExecutions)
 count('delegated-work',store.list<any>('delegation-outbound').filter(t=>t.contract&&!t.deleted&&!(t.remote&&['ready','cancelled'].includes(t.remote.state)&&(t.acceptance==='passed'||t.desired==='cancelled'&&t.remote.controlEpoch>=t.controlEpoch))).length)
 for(const table of ['webhook_inbox','webhook_deliveries']){
  const exists=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
  if(exists)count(table,Number(store.db.prepare('SELECT COUNT(*) n FROM '+table+" WHERE state IN ('received','pending','sending','held','uncertain')").get()!.n))
 }
 return items
}
export async function deploymentMaintenance(host:Runtime,input:unknown){
 const x=command.parse(input),store=host.store,old=store.get<Maintenance>('deployment-maintenance',x.operationId)
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
