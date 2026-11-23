import {unsettledTaskEffects} from './artifact-read-recovery.ts'
import {recoverGoalEvidence} from './goal-evidence-recovery.ts'
import {hasOutstandingQuestion} from './business-decisions.ts'
import {z} from 'zod'
import {startCodeProject,type GoalProject,type CodeReceipt} from './project-code.ts'
import {projectBudget} from './project-budget.ts'
import type {Runtime} from './runtime.ts'
import type {ScopeContext} from './router-scope.ts'
import type {Trigger,Mandate,Ticket} from './vendor/dsh-core/index.ts'
import type {RouterAdmission} from './router-ingress.ts'
import type {ToolSpec} from './model.ts'
import type {ContextManifest} from './router-memory.ts'
import {bodyDigest,stableDigest} from './sources.ts'
import {workerPermissions,workerProfiles} from './worker-pool.ts'
import {repositoryEffectsSettled} from './repository-source.ts'
import {goalDetailsSchema,criterionSchema,nodeSchema,validateGraph,classifyExecutionFailure,classifyGoalFailure,classifyVerificationFailure,type GoalNode,type GoalFailure} from './goal-contract.ts'
import {unconfirmedEffectMessage} from './chat-permissions.ts'
import type {GoalDelivery,VerificationRound} from './goal-verification.ts'
import type {Run} from './store.ts'
import {DELEGATED_GOALS_DB_SCHEMA} from './store.ts'
import {allowNewTaskInputs} from './task-context.ts'
import type {GoalContract} from './goal-replanning.ts'
import {previouslyRecoveredRead,proveInterruptedOpenCodeRead,refusedWorkerJobReads,unstartedWorkerShell} from './backends/opencode-read-recovery.ts'
import type {PluginThread} from './backends/plugin-process.ts'
import {AcceptanceEvidenceTooLarge,acceptanceRetryTarget,type AcceptanceRetryResult,type AcceptanceRetryStatus,type EvidenceOverflow} from './goal-acceptance.ts'
import {ChatError} from './chat-errors.ts'
import {retainedWorkspace,type GoalWorkspace,type GoalWorkspaceMode,type WorkspaceSource} from './workspace.ts'

const id=z.string().min(1).max(300)
const resumeTarget=z.object({id,expectedRevision:z.number().int().nonnegative(),operationId:id}).strict()
const resumeTargets=z.array(resumeTarget).min(1).max(20).refine(items=>
 new Set(items.map(item=>item.id)).size===items.length&&new Set(items.map(item=>item.operationId)).size===items.length,
 'Each goal needs its own ID and operation ID')
const resumeMany=z.object({action:z.literal('resume_many'),targets:resumeTargets}).strict()
export interface GoalResumeOutcome {id:string;title:string;resumed:boolean;state?:RouterGoal['state'];reason?:string;taskIds?:string[]}
const criterion=criterionSchema
const verification=z.object({criterionId:id,ticketId:id.optional(),delegationId:id.optional(),reportAt:id,explanation:z.string().min(1).max(4000)}).strict().refine(v=>!!v.ticketId!==!!v.delegationId,'A check needs its actual task or delegation reference')
export const goalCommandSchema=z.object({action:z.enum(['list','inspect','start','update','wait','complete','pause','resume','resume_many','cancel']),targets:resumeTargets.optional(),id:id.optional(),details:goalDetailsSchema.optional(),supersedes:z.object({goalId:id,expectedRevision:z.number().int().min(0)}).strict().optional(),continueFrom:z.object({goalId:id,ticketId:id,expectedRevision:z.number().int().min(0)}).strict().optional(),operationId:id.optional(),expectedRevision:z.number().int().min(0).optional(),title:z.string().min(1).max(300).optional(),objective:z.string().min(1).max(16000).optional(),authorizationQuote:z.string().min(1).max(16000).optional(),criteria:z.array(criterion).min(1).max(50).optional(),plan:z.array(z.string().min(1).max(4000)).max(100).optional(),nextAction:z.string().min(1).max(4000).optional(),reason:z.string().min(1).max(4000).optional(),wakeAfterSeconds:z.number().int().min(10).max(86400).optional(),needsHuman:z.boolean().optional(),checks:z.array(verification).max(50).optional(),maxTurns:z.number().int().min(1).max(10000).optional(),nodes:z.array(nodeSchema).min(1).max(100).optional(),budget:z.object({maxMinutes:z.number().positive().max(43200).optional(),maxUsd:z.number().positive().optional()}).strict().refine(b=>b.maxMinutes!==undefined||b.maxUsd!==undefined,'Set a time or cost limit').optional(),maxParallel:z.number().int().min(1).max(10).optional(),maxRepairs:z.number().int().min(0).max(10).optional(),maxReplans:z.number().int().min(0).max(5).optional()}).strict()
export interface RouterGoal {workspace?:GoalWorkspace;cancelledByUser?:true;acceptanceOverflow?:EvidenceOverflow;supersedes?:string;supersededBy?:string;project?:GoalProject;id:string;scopeId:string;entryId:string;discussion:string;actor:string;triggerId:string;bindingRevision:number;revision:number;title:string;objective:string;criteria:z.infer<typeof criterion>[];plan:string[];state:'active'|'waiting'|'needs_input'|'paused'|'held'|'completed'|'cancelled';taskIds:string[];delegationIds?:string[];contextIds?:string[];nextAction:string;reason?:string;nextAt?:number;turns:number;maxTurns:number;failures:number;lastFingerprint?:string;checks?:z.infer<typeof verification>[];at:number;nodes?:GoalNode[];maxParallel?:number;maxRepairs?:number;finalRoundId?:string;recovery?:GoalFailure;recoveryAttempts?:number;managed?:boolean;contract?:GoalContract;planRevision?:number;replans?:number;maxReplans?:number;replanId?:string}
interface Wake {id:string;goalId:string;scopeId:string;entryId:string;triggerId:string;triggerHash:string;goalRevision:number;state:'queued'|'running'|'done'|'failed';at:number}
const terminal=new Set(['completed','cancelled'])
const githubReadContinuation='The previous GitHub resource read failed. Continue the original task in its retained workspace with current tools. Use github_read for the repository and verify the evidence you cite.'
const heldReason=(nodes:GoalNode[])=>nodes.filter(n=>n.state==='held').map(n=>n.title+': '+n.reason).join('; ')
export function heldQuestionNode(goal:RouterGoal,ticketId:string,summary:string){
 const node=goal.nodes?.find(item=>item.ticketId===ticketId)
 if(!node||!['active','waiting','held'].includes(goal.state)||node.state!=='held'||goal.supersededBy||
    goal.replanId||goal.acceptanceOverflow||goal.project?.review?.state==='pending')return
 if(goal.state==='held'&&goal.reason!==heldReason(goal.nodes!))return
 if(node.reason!==summary.slice(0,1000)||!['quality','environment'].includes(node.failure?.kind??'')||
    node.dependsOn.some(id=>goal.nodes!.find(item=>item.id===id)?.state!=='passed'))return
 return node
}

/** The same goal fence applies when accepting a follow-up and when executing it. */
export function goalExecutionHold(goal:RouterGoal|undefined,ticketId:string){
 if(!goal)return
 const node=goal.nodes?.find(item=>item.ticketId===ticketId)
 if((goal.state==='active'||goal.state==='waiting')&&node?.state!=='held')return
 return {id:goal.id,title:goal.title,revision:goal.revision,state:goal.state,nodeState:node?.state,
  reason:node?.reason??goal.reason}
}
type ReadRecovery={run:Run;proof:NonNullable<ReturnType<typeof proveInterruptedOpenCodeRead|typeof refusedWorkerJobReads>>}
function readContinuation(proof:ReadRecovery['proof']){
 if(proof.kind==='denied_job_reads')return {instruction:'Continue the same node from the retained workspace. Reads of jobs owned by an earlier assignment returned no output. Use the existing evidence files and current assignment’s own job IDs. Preserve completed operations without repeating them.',recordedCalls:proof.calls}
 if(proof.kind==='github')return {instruction:githubReadContinuation}
 if(proof.kind==='read_only')return {instruction:'Continue the original task in its retained workspace. The interrupted operations were read-only. Repeat only the unfinished reads needed for the task.'}
 return {instruction:'Continue the original task in its retained workspace. Retry the recorded webfetch_batch calls. The tool reuses saved excerpts and fetches pages with missing results.',
  ...(proof.batches.length===1?{urls:proof.urls}:{batches:proof.batches})}
}
export const goalSpecs:ToolSpec[]=[{type:'function',name:'router_goal',description:'Own a long-running user goal across turns and restarts. When the user wants to continue earlier work, list goals (including ended ones) before starting anything. Resume a held goal with its existing tasks. For several goals the user wants to continue, use resume_many with one target per requested goal (id, expectedRevision and a distinct stable operationId). Report the outcome of every target, including blockers. To continue an ended local Chat goal, start with continueFrom containing its goalId, revision as expectedRevision, and the ticketId whose retained workspace holds the prior work. Use local nodes. The host reuses that directory; instruct the Worker to inspect it for existing files before asking for an upload or creating a retrieval task. Local Chat nodes share their goal workspace by default; use workspace read-only for readers and worktree only for independent parallel Git edits. Prefer nodes with exactly one of workerId (local Worker) or teamTargetId (authorized independent team), dependsOn and criterionIds for host scheduling. Remote nodes retain delegation handles and are independently verified; the host never invents a local Worker. Failed remote contracts are held for review rather than repeated. Do not call team_delegate assign or accept for a managed node. Use workspace-relative file paths for evidence and node outputs. For code changes, declare the changed source and test files or a diff so acceptance can inspect the implementation. Review the requested reply as a deliverable; the host routes it after acceptance. Each criterion may declare files, documents and a deterministic check (file_exists, text_contains, json_equals with JSON pointer, or xlsx_cell_equals with sheet, cell, expected and optional numeric sumRange). The host intercepts ready reports, independently verifies immutable artifacts, repairs failed checks on the same open task and completes the goal only after overall acceptance. Use list and inspect to find existing work from this Chat, including goals created during an internal Worker follow-up. Use worker_manage result with the goal ticket IDs to read Worker reports. When the user explicitly asks to cancel the entire task, identify the goal by title or ID and use cancel with its current revision. Cancelling one Worker is insufficient. If remote work is involved, check whether the remote team has confirmed cancellation. Inspect also returns verification rounds and versioned replanning records. After a settled strategy failure the host may request a new execution graph from the Router model and independently review it. Original objective, authority and acceptance criteria are immutable; replanning cannot change them. Do not manually assign tasks already declared in nodes. Start only when the user asks for sustained/multistep work, with an exact authorizationQuote from the current human message, objective and acceptance criteria. For start, use expectedRevision=0 and assign every criterionId to a node, including the content of a requested reply. To replace an immutable goal, start a new explicitly authorized goal with supersedes {goalId,expectedRevision}; this cancels old execution and preserves its history. Optional details nonGoals/inputs/deadline must be exact excerpts from the current human message. Deadline is requested text only, not automatic expiry or extra permission. Mutations require operationId and expectedRevision. Keep plan/nextAction current. wait with needsHuman=false retains a durable wake; needsHuman=true requires a concrete question/reason. Worker completion does not complete the goal. The host completes accepted goals automatically; complete cannot bypass independent verification. pause/resume/cancel and raising maxTurns require a current explicit human. Reaching the turn allowance holds an unresolved goal; never claim success.',inputSchema:{type:'object',properties:{action:{type:'string',enum:goalCommandSchema.shape.action.options},targets:{type:'array',minItems:1,maxItems:20,items:{type:'object',additionalProperties:false,properties:{id:{type:'string'},expectedRevision:{type:'integer',minimum:0},operationId:{type:'string'}},required:['id','expectedRevision','operationId']}},details:{type:'object',properties:{nonGoals:{type:'array',items:{type:'string'}},inputs:{type:'array',items:{type:'string'}},deadline:{type:'string'}},additionalProperties:false},supersedes:{type:'object',properties:{goalId:{type:'string'},expectedRevision:{type:'integer'}},required:['goalId','expectedRevision'],additionalProperties:false},id:{type:'string'},operationId:{type:'string'},expectedRevision:{type:'integer'},title:{type:'string'},objective:{type:'string'},authorizationQuote:{type:'string'},criteria:{type:'array',items:{type:'object',properties:{id:{type:'string'},description:{type:'string'},files:{type:'array',items:{type:'string'}},documents:{type:'array',items:{type:'string'}},check:{type:'object',properties:{kind:{type:'string',enum:['file_exists','text_contains','json_equals','xlsx_cell_equals']},path:{type:'string'},text:{type:'string'},pointer:{type:'string'},sheet:{type:'string'},cell:{type:'string'},sumRange:{type:'string'},expected:{}},required:['kind','path'],additionalProperties:false}},required:['id','description'],additionalProperties:false}},plan:{type:'array',items:{type:'string'}},nextAction:{type:'string'},reason:{type:'string'},wakeAfterSeconds:{type:'integer'},needsHuman:{type:'boolean'},checks:{type:'array',items:{type:'object',properties:{criterionId:{type:'string'},ticketId:{type:'string'},delegationId:{type:'string'},reportAt:{type:'string'},explanation:{type:'string'}},required:['criterionId','reportAt','explanation'],additionalProperties:false}},maxTurns:{type:'integer'},budget:{type:'object',properties:{maxMinutes:{type:'number'},maxUsd:{type:'number'}},additionalProperties:false},maxParallel:{type:'integer'},maxRepairs:{type:'integer'},maxReplans:{type:'integer'},nodes:{type:'array',items:{type:'object',properties:{id:{type:'string'},title:{type:'string'},instruction:{type:'string'},workerId:{type:'string'},teamTargetId:{type:'string'},dependsOn:{type:'array',items:{type:'string'}},criterionIds:{type:'array',items:{type:'string'}}},required:['id','title','instruction','criterionIds'],additionalProperties:false}}},required:['action'],additionalProperties:false}}]

export class RouterGoals {
 private nextEvidenceCheck=new Map<string,number>()
 constructor(private host:Runtime,private now:()=>number=Date.now){
  const previous=host.routerIngress.scheduledAuthority
  host.routerIngress.scheduledAuthority=id=>this.authority(id)??previous?.(id)
 }
 private belongs(g:RouterGoal,c:ScopeContext){return g.scopeId===c.route.scopeId&&g.entryId===c.route.entryId&&(g.discussion===c.route.discussion&&g.actor===c.actor||this.host.webhooks?.ownsTrigger(g.contract?.triggerId??g.triggerId)&&c.trigger.human&&this.host.scopes.canManage(c))}
 /** Original, current and receipt-proven historical control anchors. */
 triggerIdsForGoal(g:RouterGoal):string[]{
  const anchors=new Set([g.triggerId,...(g.contract?.triggerId?[g.contract.triggerId]:[])])
  for(const row of this.host.store.db.prepare("SELECT body FROM records WHERE kind='goal-receipt' AND json_extract(body,'$.goalId')=?").all(g.id)){
   const receipt=JSON.parse(String(row.body)) as {scopeId:string;entryId:string;triggerId:string;goalId:string;result:RouterGoal}
   const r=receipt.result
   if(receipt.goalId===g.id&&receipt.scopeId===g.scopeId&&receipt.entryId===g.entryId&&r?.id===g.id&&r.scopeId===g.scopeId&&r.entryId===g.entryId&&r.actor===g.actor&&r.triggerId===receipt.triggerId&&g.contract&&r.contract&&stableDigest(r.contract)===stableDigest(g.contract))anchors.add(r.triggerId)
  }
  return [...anchors]
 }
 goalsForTask(ticketId:string):RouterGoal[]{
  const store=this.host.store,db=store.db
  const ids=new Set(db.prepare("SELECT goal_id FROM goal_reference WHERE kind='task' AND ref=?").all(ticketId).map(r=>String(r.goal_id)))
  const trigger=store.tickets.get(ticketId)?.origin.triggerId
  const assignment=trigger?.startsWith('delegation:')?store.get<{parentTrigger?:string}>('worker-assignment',ticketId):undefined
  if(assignment?.parentTrigger&&store.get('worker-command',trigger!.slice('delegation:'.length))){
   // A node pointer can lag its committed assignment. Narrow by original or
   // receipted trigger, then apply the same proof as goal replacement/recovery.
   const candidates=db.prepare(`SELECT goal_id FROM goal_reference WHERE kind='trigger' AND ref=?
     UNION SELECT json_extract(body,'$.goalId') FROM records WHERE kind='goal-receipt' AND json_extract(body,'$.triggerId')=?`).all(assignment.parentTrigger,assignment.parentTrigger)
   for(const row of candidates){
    const id=String(row.goal_id)
    if(ids.has(id))continue
    const goal=store.get<RouterGoal>('router-goal',id)
    if(goal&&this.taskIdsForGoal(goal).includes(ticketId))ids.add(id)
   }
  }
  return [...ids].map(id=>store.get<RouterGoal>('router-goal',id)!).filter(Boolean)
 }
 /** Recover a committed assignment whose caller crashed before saving its node pointer. */
 taskIdsForGoal(g:RouterGoal):string[]{
  const ids=new Set(g.taskIds),anchors=new Set(this.triggerIdsForGoal(g))
  for(const node of g.nodes??[]){
   if(!node.workerId)continue
   const key=bodyDigest([g.discussion,'goal-node:'+g.id+':'+node.id])
   const receipt=this.host.store.get<{status:string;scopeId?:string;result?:{ticketId?:string;workerId?:string;discussion?:string;parentTrigger?:string}}>('worker-command',key)
   const result=receipt?.result,ticket=result?.ticketId?this.host.store.tickets.get(result.ticketId):undefined
   const assignment=ticket?this.host.store.get<{ticketId:string;workerId:string;discussion:string;parentTrigger?:string}>('worker-assignment',ticket.id):undefined
   const owner=ticket?this.host.scopes.ownership(ticket.id):undefined
   if(receipt?.status==='completed'&&receipt.scopeId===g.scopeId&&ticket?.origin.triggerId==='delegation:'+key&&assignment?.ticketId===ticket.id&&assignment.workerId===node.workerId&&assignment.discussion===g.discussion&&result?.workerId===node.workerId&&result.discussion===g.discussion&&assignment.parentTrigger===result.parentTrigger&&!!assignment.parentTrigger&&anchors.has(assignment.parentTrigger)&&owner?.scopeId===g.scopeId)ids.add(ticket.id)
  }
  return [...ids]
 }
 private sourcesValid(g:RouterGoal){return [...(g.contextIds??[]),...this.host.replanning.contexts(g.id)].every(id=>this.host.continuity.validContext(id))}
 private retryVerification(round:VerificationRound){
  const store=this.host.store,id=round.id+':'+round.attempts
  store.atomic(()=>{
   store.put('goal-verification-attempt',id,{id,roundId:round.id,goalId:round.goalId,scopeId:round.scopeId,entryId:round.entryId,attempt:round.attempts,state:round.state,error:round.error,checks:round.checks,threadId:round.threadId,finishedAt:round.finishedAt,snapshotHash:stableDigest(round.snapshot)})
   store.put('goal-verification',round.id,{...round,state:'pending',error:undefined})
   store.jobState('goal-verify:'+round.id,'pending')
  })
 }
 private accessible(g:RouterGoal,c:ScopeContext,delegated=false){
  return !!g.objective&&(this.belongs(g,c)||delegated&&this.host.chat.canAccessDelegatedGoal(g,c))&&
   !this.host.memory.cleanup.blocked('router-goal',g.id,g)
 }
 list(c:ScopeContext){
  this.host.scopes.assertCurrent(c)
  return this.host.store.list<RouterGoal>('router-goal').filter(g=>this.accessible(g,c,true)).map(g=>this.visibleGoal(g))
 }
 visibleGoal(g:RouterGoal){return this.sourcesValid(g)?g:{...g,state:terminal.has(g.state)?g.state:'held' as const,title:'Goal needs source review',objective:'Prior derived goal content is unavailable',criteria:[],nodes:undefined,project:undefined,contract:undefined,plan:[],checks:undefined,nextAction:'Resume with a current explicitly authorized objective, criteria and plan',reason:'Goal sources changed or were revoked',nextAt:undefined}}
 snapshot(candidates=this.host.store.list<RouterGoal>('router-goal')){return candidates.flatMap(g=>{
  try{const binding=this.host.scopes.binding(g.entryId);if(binding.privateActor||binding.revision!==g.bindingRevision)return [];const t=this.host.store.triggers.get(g.triggerId);if(!t)return [];this.host.routerIngress.authority(t.id);const c=this.host.scopes.context(t,g.discussion);const visible=c&&this.list(c).find(item=>item.id===g.id);return visible?[visible]:[]}catch{return []}
 })}
 private anchor(g:RouterGoal){
  const t=this.host.store.triggers.get(g.triggerId);if(!t||!t.human&&!this.host.webhooks?.ownsTrigger(t.id)&&!this.host.proactive.runForTrigger(t.id)?.spec.skill)throw Error('Goal authorization source unavailable')
  const mandate=this.host.routerIngress.authority(t.id),c=this.host.scopes.context(t,g.discussion)
  if(!c||!this.belongs(g,c)||this.host.scopes.binding(g.entryId).revision!==g.bindingRevision)throw Error('Goal entry or ownership changed')
  if(mandate.strength!=='explicit')throw Error('Goal needs explicit standing authority')
  if(this.host.memory.cleanup.blocked('router-goal',g.id,g))throw Error('Goal history was deleted')
  if(!this.sourcesValid(g))throw Error('Goal sources changed; explicit goal reauthorization is required')
  return {trigger:t,mandate,context:c}
 }
 private fenceCancelled(g:RouterGoal){
  const {store}=this.host,tickets=new Set(g.taskIds)
  this.host.delegation.goalTasks.cancel(g.id)
  for(const wake of store.list<Wake>('goal-wake'))if(wake.goalId===g.id&&wake.state==='queued')store.put('goal-wake',wake.id,{...wake,state:'failed'})
  for(const round of store.list<VerificationRound>('goal-verification'))if(round.goalId===g.id&&['pending','running'].includes(round.state))store.put('goal-verification',round.id,{...round,state:'stale',finishedAt:this.now()})
  for(const round of store.list<import('./goal-replanning.ts').ReplanRound>('goal-replan'))if(round.goalId===g.id&&['pending','planning','reviewing','approved'].includes(round.state))store.put('goal-replan',round.id,{...round,state:'stale'})
  for(const message of store.deliveries())if(message.status==='pending'&&(
   !!message.ticketId&&tickets.has(message.ticketId)||store.get<{goalId?:string}>('router-reply-owner',message.id)?.goalId===g.id
  ))store.outbox.withdraw(message.id)
  store.db.prepare(`UPDATE jobs SET state='cancelled' WHERE state='pending' AND (
   (kind IN ('router','goal-verify','goal-replan') AND json_extract(payload,'$.goalId')=?) OR
   (kind IN ('start','execute') AND json_extract(payload,'$.ticketId') IN (SELECT value FROM json_each(?)))
  )`).run(g.id,JSON.stringify(g.taskIds))
 }
 private finishCancellation(g:RouterGoal){
  const {store}=this.host,reason=g.supersededBy?'Goal contract replaced':'Goal cancelled by user'
  this.host.interruptGoalReviews(g.id)
  if(g.project)this.host.stopProject(g,reason)
  for(const ticketId of g.taskIds){
   const ticket=store.tickets.get(ticketId)
   this.host.interruptForAutomation(ticketId)
   if(!ticket||ticket.ended)continue
   store.atomic(()=>{
    const attempt=store.get<{attemptId:string}>('async-worker-current',ticketId)
    if(attempt)store.put('async-worker-revoked',attempt.attemptId,{ticketId,assignmentId:ticket.assignments.at(-1)?.id,reason:'goal_cancelled',at:this.now()})
    for(const action of this.host.permissions.forWorker(ticketId))this.host.permissions.cancel(action.id)
    this.host.engine.stopTicket(ticketId,reason)
    for(const assignment of ticket.assignments)if(assignment.state!=='ended')store.enqueue('cleanup:'+assignment.id,'cleanup',{ticketId,assignmentId:assignment.id})
   })
  }
 }
 recoverCancellations(){
  for(const g of this.host.store.list<RouterGoal>('router-goal'))if(g.cancelledByUser||g.supersededBy)
   this.finishCancellation(g.supersededBy?{...g,taskIds:this.taskIdsForGoal(g)}:g)
 }
 taskCancelled(ticketId:string){return this.goalsForTask(ticketId).some(g=>!!(g.cancelledByUser||g.supersededBy))}
 private wake(triggerId:string){return this.host.store.get<Wake>('goal-wake',triggerId)}
 forInput(triggerId:string){const wake=this.wake(triggerId);return wake?this.host.store.get<RouterGoal>('router-goal',wake.goalId):this.host.store.list<RouterGoal>('router-goal').find(g=>(g.triggerId===triggerId||g.cancelledByUser&&g.contract?.triggerId===triggerId||!!g.supersededBy&&this.triggerIdsForGoal(g).includes(triggerId))&&(g.cancelledByUser||!!g.supersededBy||!terminal.has(g.state)||!!g.contract?.skill||this.host.webhooks?.ownsTrigger(triggerId)||g.state==='completed'&&g.nodes?.some(n=>n.teamTargetId)))}
 private authority(triggerId:string):Mandate|undefined{
  const wake=this.wake(triggerId);if(!wake)return
  const g=this.host.store.get<RouterGoal>('router-goal',wake.goalId),t=this.host.store.triggers.get(triggerId)
  if(!g||g.state==='cancelled'||!t||stableDigest(t)!==wake.triggerHash)throw Error('Goal wake no longer authorized')
  // A running turn may settle its final reply after complete/needs_input. New
  // effects are fenced separately; queued wakes cannot start a settled goal.
  if(wake.state==='queued'&&(!['active','waiting'].includes(g.state)||wake.goalRevision!==g.revision))throw Error('Goal changed before wake dispatch')
  const {mandate}=this.anchor(g);this.host.scopes.assertTrigger(t)
  return {...mandate,scope:g.objective}
 }
 private pending(g:RouterGoal){return this.host.store.db.prepare("SELECT payload FROM jobs WHERE state IN ('pending','running') AND kind='router'").all().some(row=>{const p=JSON.parse(String(row.payload));return p.triggerId===g.triggerId||this.wake(p.triggerId)?.goalId===g.id})}
 beforeTurn(triggerId:string,receipt=false){const goal=this.forInput(triggerId);if(goal?.supersededBy)throw Error('Goal was replaced by a new contract');if(goal?.cancelledByUser)throw Error('Goal was cancelled by the user');const w=this.wake(triggerId);if(w){const g=this.host.store.get<RouterGoal>('router-goal',w.goalId);if(!g||!['active','waiting'].includes(g.state)&&!(receipt&&g.state==='completed'))throw Error('Goal continuation is not running');this.authority(triggerId);if(w.state==='queued')this.host.store.put('goal-wake',triggerId,{...w,state:'running'})}}
 toolAllowed(triggerId:string,name:string,args:any){
  const w=this.wake(triggerId),g=this.forInput(triggerId);if(!g)return
  if(name==='team_delegate'){
   if(args.action!=='list'&&args.action!=='assign'&&!g.delegationIds?.includes(args.id))throw Error('Goal can only inspect its own delegations')
   if(g.managed&&!['list','inspect'].includes(args.action))throw Error('Managed goal delegations are scheduled and accepted by the host; use router_goal for goal control')
  }
  if(g.state==='completed'){if(name==='router_goal'&&['list','inspect','complete'].includes(args.action)||name==='worker_manage'&&['list','inspect','result'].includes(args.action)&&(args.action==='list'||g.taskIds.includes(args.ticketId))||name==='team_delegate'&&['list','inspect'].includes(args.action)&&(args.action==='list'||g.delegationIds?.includes(args.id)))return;throw Error('Completed goal only permits inspection of its accepted results')}
  if(g.state==='held'&&(
    name==='router_goal'&&(args.action==='list'||args.action==='inspect'&&args.id===g.id)||
    name==='worker_manage'&&(args.action==='list'||['inspect','result'].includes(args.action)&&g.taskIds.includes(args.ticketId))
  ))return
  if(!['active','waiting'].includes(g.state))throw Error('Goal no longer accepts work in this turn')
  if(g.managed&&name==='worker_manage'&&['assign','send'].includes(args.action))throw Error('Goal tasks are scheduled and repaired by the host; inspect existing nodes')
  if(!w&&!this.host.webhooks.ownsTrigger(triggerId)&&(!g.contract?.skill||this.host.store.triggers.get(triggerId)?.human))return
  if(name==='router_memory'&&!['search','read','inspect'].includes(args.action))throw Error('Autonomous goal input cannot mutate Agent memory')
  if(name==='router_journal'&&args.action!=='read')throw Error('Autonomous goal input cannot change original requirements or commitments')
  if(name==='worker_manage'&&!['list','inspect','result','assign','send'].includes(args.action))throw Error('Goal wake cannot reconfigure Workers or change unrelated authority')
  if(name==='worker_manage'&&args.action!=='list'&&args.action!=='assign'&&!g.taskIds.includes(args.ticketId))throw Error('Goal wake can only use tasks owned by this goal')
  if(name==='router_manage')throw Error('Goal wake cannot change standing schedules or duties')
  if(name==='router_goal'&&(!['list','inspect'].includes(args.action)&&args.id!==g.id||!['list','inspect','update','wait','complete'].includes(args.action)))throw Error('Goal wake is restricted to its existing goal')
 }
 noteTask(triggerId:string,ticketId:string){const g=this.forInput(triggerId);if(g&&!g.taskIds.includes(ticketId)){const c=this.anchor(g).context;this.host.scopes.checkTask(ticketId,c,true);const assignment=this.host.store.get<any>('worker-assignment',ticketId);this.host.store.put('router-goal',g.id,{...g,taskIds:[...g.taskIds,ticketId],nodes:[...(g.nodes??[]),{id:ticketId,title:'Delegated task',instruction:this.host.store.tickets.get(ticketId)!.mandate.scope,workerId:assignment.workerId,dependsOn:[],criterionIds:g.criteria.map(cr=>cr.id),ticketId,state:'running',repairs:0,recoveries:0}]})}}
 finishTurn(triggerId:string,error?:unknown){
  const w=this.wake(triggerId),g=this.forInput(triggerId);if(!g)return
  if(w)this.host.store.put('goal-wake',triggerId,{...w,state:error?'failed':'done'})
  const latest=this.host.store.get<RouterGoal>('router-goal',g.id)!
  if(terminal.has(latest.state)||['paused','held','needs_input'].includes(latest.state))return
  const failures=error?latest.failures+1:0,turns=latest.turns+1
  const recovery=error?classifyGoalFailure(String(error),this.now(),latest.recoveryAttempts??0):undefined
  const retriable=recovery&&['transient','quota'].includes(recovery.kind)&&(latest.recoveryAttempts??0)<5
  const state=turns>=latest.maxTurns||error&&!retriable&&failures>=3?'held':latest.state
  const reason=state==='held'?(failures>=3?'Three goal turns failed; inspect retained effects before resuming':'Autonomous turn allowance reached; goal remains unresolved'):latest.reason
  this.host.store.put('router-goal',g.id,{...latest,turns,failures,state,reason,recovery,recoveryAttempts:error?(latest.recoveryAttempts??0)+1:0,nextAt:state==='held'?undefined:retriable?recovery.retryAt:latest.nextAt??this.now()+60000})
  if(state==='held')this.notice({...latest,state,reason},reason!)
 }
 private projectRequester(g:RouterGoal){
  const trigger=this.host.store.triggers.get(g.triggerId)
  if(trigger?.human)return trigger
  const run=this.host.proactive.runForTrigger(g.triggerId)
  return run?this.host.store.triggers.get(run.spec.triggerId):this.host.webhooks.notificationAnchor(g.triggerId)
 }
 notice(g:RouterGoal,text:string,review=false){
  try{
   const {trigger}=this.anchor(g)
   const channel=g.project?this.projectRequester(g)?.channel:trigger.channel
   if(!channel||g.project&&!this.host.proactive.notify(g.triggerId))return
   const ids=[...new Set([...(g.contextIds??[]),...this.host.replanning.contexts(g.id)])]
   const manifests=ids.map(id=>{
    const saved=this.host.store.get<ContextManifest>('context-manifest',id);if(!saved)throw Error('Goal context unavailable')
    // Historical goal context survives task progress, as in continuity.validContext.
    const manifest={...saved,taskOwners:saved.taskOwners.map(t=>({...t,dataRevision:this.host.scopes.ownership(t.id)?.dataRevision??1}))}
    this.host.memory.validate(manifest);return manifest
   })
   const id='goal-notice:'+stableDigest([g.id,g.revision,text])
   // The run remains the authority for delayed delivery to its original requester's channel.
   this.host.store.put('router-reply-owner',id,{goalId:g.id,discussion:g.discussion,triggerId:g.triggerId,inputs:[g.triggerId],manifests})
   this.host.store.outbox.send({id,channel,kind:'reply',text:review?text:'目标「'+g.title+'」尚未完成：'+text})
  }catch{}
 }
 tick(){
  for(let g of this.host.store.list<RouterGoal>('router-goal')){
   if(!['active','waiting'].includes(g.state)||!g.objective||this.pending(g)||g.nodes?.length)continue
   try{
    const {trigger,context}=this.anchor(g)
    // Recover a task committed immediately before a host crash in noteTask.
    const assigned=this.host.store.list<any>('worker-assignment').filter(a=>a.parentTrigger===g.triggerId||this.wake(a.parentTrigger)?.goalId===g.id).map(a=>a.ticketId as string)
    if(assigned.some(id=>!g.taskIds.includes(id))){for(const id of assigned)this.host.scopes.checkTask(id,context);g={...g,taskIds:[...new Set([...g.taskIds,...assigned])]};this.host.store.put('router-goal',g.id,g)}
    const tasks=g.taskIds.map(id=>{this.host.scopes.checkTask(id,context);return this.host.store.tickets.get(id)})
    const fingerprint=stableDigest(tasks.map(t=>({id:t?.id,ended:t?.ended,report:t?.assignments.at(-1)?.report})))
    const busy=tasks.some(t=>t&&!t.ended&&!['blocked','failed'].includes(t.assignments.at(-1)?.report?.state??''))||g.taskIds.some(id=>this.host.store.list<any>('work').some(w=>w.ticketId===id&&['starting','running'].includes(w.state))||this.host.activity.list().some(a=>a.ticketId===id&&a.state==='running'))
    if(busy)continue
    if(g.nextAt!==undefined&&g.nextAt>this.now()&&fingerprint===g.lastFingerprint)continue
    this.host.store.atomic(()=>{
     const sequence=this.host.store.list<Wake>('goal-wake').filter(w=>w.goalId===g.id).length+1,id='goal:'+g.id+':'+sequence
     const t:Trigger={...trigger,id,human:false,addressed:undefined,text:g.objective+'\nNext action: '+g.nextAction,at:new Date(this.now()).toISOString(),meta:{...trigger.meta,origin:'goal-controller',goalId:g.id}}
     this.host.store.triggers.save(t);this.host.scopes.context(t,g.discussion)
     const wake:Wake={id,goalId:g.id,scopeId:g.scopeId,entryId:g.entryId,triggerId:id,triggerHash:stableDigest(t),goalRevision:g.revision,state:'queued',at:this.now()}
     this.host.store.put('goal-wake',id,wake)
     const {mandate}=this.anchor(g)
     this.host.store.put('router-admission',id,{triggerId:id,discussion:g.discussion,policyVersion:mandate.policyVersion,state:'accepted',reason:'Authorized goal continuation',at:t.at,mandate:{...mandate,scope:g.objective}} satisfies RouterAdmission)
     this.host.store.enqueue('router:goal:'+g.id+':'+sequence,'router',{discussion:g.discussion,triggerId:id,goalId:g.id})
     this.host.store.put('router-goal',g.id,{...g,lastFingerprint:fingerprint,nextAt:this.now()+60000})
    })
   }catch(error){this.host.store.put('router-goal',g.id,{...g,state:'held',reason:String(error),nextAt:undefined})}
  }
 }
 get(id:string){return this.host.store.get<RouterGoal>('router-goal',id)}
 context(g:RouterGoal){return this.anchor(g).context}
 private activeAcceptance(g:RouterGoal){
  if(g.state!=='active'&&g.state!=='waiting')return
  for(const id of [g.finalRoundId,...(g.nodes??[]).map(node=>node.roundId)]){
   const round=id&&this.host.store.get<VerificationRound>('goal-verification',id)
   if(round&&round.goalId===g.id&&(round.state==='pending'||round.state==='running'))
    return {state:round.state==='pending'?'queued' as const:'running' as const,roundId:round.id}
  }
 }
 acceptanceStatus(g:RouterGoal):AcceptanceRetryStatus|undefined {
  const active=this.activeAcceptance(g)
  if(active)return {state:active.state}
  const target=acceptanceRetryTarget(this.host.store,g)
  if(target&&!this.host.replanning.active(g)){
   return {state:'held',revision:g.revision,reason:target.reason,overflow:g.acceptanceOverflow}
  }
 }
 retryAcceptance(id:string,revision:number):AcceptanceRetryResult {
  if(!this.host.canWrite())throw new ChatError('host_paused','The host is paused.',409)
  const {store}=this.host
  try{return store.atomic(()=>{
   const goal=this.get(id)
   if(!goal)throw new ChatError('task_missing','Task not found.',404)
   const active=this.activeAcceptance(goal)
   if(active&&(goal.revision===revision||goal.revision===revision+1))return active
   if(goal.revision!==revision)throw new ChatError('acceptance_changed','This task changed. Reload its details.',409)
   const target=acceptanceRetryTarget(store,goal)
   if(!target||this.host.replanning.active(goal))throw new ChatError('acceptance_unavailable','This task is not ready to retry acceptance.',409)
   const round=this.host.verification.ensure(goal,target.node,true)
   if(round.state==='errored'||round.state==='stale')this.retryVerification(round)
   else if(round.state!=='pending')throw new ChatError('acceptance_unavailable','This evidence already has a verification result.',409)
   const jobId='goal-verify:'+round.id
   store.enqueue(jobId,'goal-verify',{roundId:round.id,goalId:goal.id,triggerId:round.triggerId,discussion:goal.discussion})
   if(store.db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId)?.state!=='pending')
    throw new ChatError('acceptance_unavailable','Acceptance could not be queued.',409)
   if(target.node){
    Object.assign(target.node,{state:'verifying',roundId:round.id,reason:undefined,failure:undefined,retryAt:undefined,recoveries:0})
   }else goal.finalRoundId=round.id
   this.save({...goal,revision:goal.revision+1,state:'active',reason:undefined,nextAt:undefined,acceptanceOverflow:undefined,recovery:undefined,recoveryAttempts:0})
   return {state:'queued',roundId:round.id}
  })}catch(error){
   if(error instanceof AcceptanceEvidenceTooLarge){
    const goal=this.get(id)
    if(goal?.state==='held'&&goal.revision===revision)this.save({...goal,acceptanceOverflow:error.overflow})
    return {state:'held',overflow:error.overflow}
   }
   throw error
  }
 }
 forTask(ticketId:string){const row=this.host.store.db.prepare(`SELECT r.body FROM goal_reference link JOIN records r ON r.kind='router-goal' AND r.id=link.goal_id
   WHERE link.kind='task' AND link.ref=? AND json_extract(r.body,'$.state') NOT IN ('completed','cancelled') ORDER BY r.rowid LIMIT 1`).get(ticketId)
  return row?JSON.parse(String(row.body)) as RouterGoal:undefined}
 continuationHold(ticketId:string,c?:ScopeContext){
  const goal=this.forTask(ticketId),hold=goalExecutionHold(goal,ticketId)
  if(!goal||!hold)return
  if(!c||!this.accessible(goal,c,true)||!this.sourcesValid(goal))return {state:'held' as const}
  return hold
 }
 workspaceForTask(ticketId:string){
  const goal=this.forTask(ticketId),node=goal?.nodes?.find(item=>item.ticketId===ticketId)
  if(!goal?.workspace||!node)return
  const mode:GoalWorkspaceMode=node.workspace??'shared'
  return {goal,workspace:goal.workspace,mode,id:mode==='worktree'?ticketId:goal.workspace.id}
 }
 private workspaceSource(ticketId:string,c:ScopeContext){
  const task=this.host.store.tickets.get(ticketId),owner=this.host.scopes.ownership(ticketId)
  if(!task?.ended||!owner||owner.scopeId!==c.route.scopeId||owner.originEntry!==c.route.entryId||
     task.mandate.actor.id!==c.trigger.actor.id||task.mandate.actor.source!==c.trigger.actor.source||
     this.host.memory.cleanup.blocked('ticket',ticketId,task))throw Error('Retained workspace task is unavailable')
  this.host.scopes.checkTask(ticketId,c)
  this.host.scopes.checkTaskEntry(owner,c.route.entryId,'result')
  return {ticketId,ownerEpoch:owner.ownerEpoch,dataRevision:owner.dataRevision??1}
 }
 checkWorkspaceSource(source:WorkspaceSource,c:ScopeContext){
  const current=this.workspaceSource(source.ticketId,c)
  if(current.ownerEpoch!==source.ownerEpoch||current.dataRevision!==source.dataRevision)
   throw Error('Retained workspace authority changed')
 }
 private continueWorkspace(reference:NonNullable<z.infer<typeof goalCommandSchema>['continueFrom']>,c:ScopeContext):GoalWorkspace{
  const prior=this.get(reference.goalId)
  if(!prior||!this.accessible(prior,c)||!terminal.has(prior.state)||prior.revision!==reference.expectedRevision||
     !this.taskIdsForGoal(prior).includes(reference.ticketId))throw Error('Retained goal or task is unavailable')
  const source=this.workspaceSource(reference.ticketId,c)
  const run=this.host.store.get<Run>('run',reference.ticketId)
  if(!run?.prepared||this.host.memory.cleanup.blocked('run',reference.ticketId,run)||
     this.host.executionActive(reference.ticketId)||this.host.work.active(reference.ticketId,run.assignmentId).length)
   throw Error('Retained workspace is still in use or unavailable')
  const id=run.workspaceId??reference.ticketId
  if(run.cwd!==retainedWorkspace(this.host.config.stateDir,id))throw Error('Retained goal workspace does not match the recorded task')
  const owner=run.workspaceSource??source
  this.checkWorkspaceSource(owner,c)
  const active=this.host.store.list<RouterGoal>('router-goal').find(g=>g.workspace?.id===id&&!terminal.has(g.state))
  if(active)throw Error('Resume the existing goal using this workspace: '+active.id)
  return {id,source:owner}
 }
 effectsSettled(ticketId:string){
  return this.effectsSettledAtPhase(ticketId,'idle')
 }
 /** Resume the one node held by this answered report, preserving its assignment and contract. */
 resumeAnsweredQuestion(ticketId:string,summary:string,context:ScopeContext,recoverStartup=false){
  const goal=this.forTask(ticketId)
  const node=goal&&heldQuestionNode(goal,ticketId,summary)
  if(!goal||!node)return false
  try{
   this.host.scopes.checkTask(ticketId,context,true)
   this.host.routerIngress.authority(goal.triggerId)
  }catch{return false}
  if(!this.effectsSettledAtPhase(ticketId,recoverStartup?'uncertain':'idle'))return false
  const next={...node,state:'running' as const,reason:undefined,failure:undefined,retryAt:undefined}
  this.save({...goal,nodes:goal.nodes!.map(item=>item.id===node.id?next:item),state:'active',
    reason:undefined,nextAt:undefined,revision:goal.revision+1})
  return true
 }
 private effectsSettledAtPhase(ticketId:string,phase:'idle'|'uncertain'){
  if(this.host.permissions.hasUnconfirmedEffect(ticketId)||!repositoryEffectsSettled(this.host.store,ticketId)||this.host.workflows.unsettled(ticketId))return false
  const run=this.host.store.get<Run>('run',ticketId)
  return !run||run.phase===phase&&!this.host.activity.list().some(a=>a.ticketId===ticketId&&a.state==='running')&&!this.host.work.list(ticketId).some(w=>['starting','running'].includes(w.state))&&!this.host.toolConnections.receipts(ticketId).some(r=>r.state!=='complete')&&!this.host.store.deliveries().some(d=>d.ticketId===ticketId&&!['sent','dropped'].includes(d.status))
 }
 private interruptedRead(task:Ticket,run:Run|undefined,requested=false):ReadRecovery|undefined{
  const {store}=this.host
  if(!run||run.phase!=='uncertain'&&(run.phase!=='idle'||!run.failure?.readOnlyHistory)||!run.threadId||run.ticketId!==task.id||run.assignmentId!==task.assignments.at(-1)?.id||
   this.host.executionActive(task.id)||!this.effectsSettledAtPhase(task.id,run.phase))return
  const denied=requested?refusedWorkerJobReads(store,this.host.config.stateDir,run):undefined
  if(denied?unsettledTaskEffects(store,task.id,0):this.host.work.list(task.id).length)return
  // Approval effects can execute outside the adapter's tool journal.
  const otherActivity=store.db.prepare(`SELECT 1 FROM records WHERE
   (kind='approval' AND json_extract(body,'$.ticketId')=?)
   OR (kind='chat-permission' AND json_extract(body,'$.actor.ticketId')=?) LIMIT 1`).get(task.id,task.id)
  if(otherActivity&&!denied)return
  const previous=store.db.prepare(`SELECT id FROM records WHERE kind='model-session' AND id<>?
   AND json_extract(body,'$.ticketId')=?`).all(run.threadId,task.id)
  if(previous.some(row=>!previouslyRecoveredRead(store,this.host.config.stateDir,run,String(row.id))))return
  const proof=denied??proveInterruptedOpenCodeRead(store,this.host.config.stateDir,run)
  if(!proof)return
  const assigned=store.get<{workerId:string}>('worker-assignment',task.id)
  const worker=workerProfiles(this.host.config).find(profile=>profile.id===assigned?.workerId)
  if(!worker||worker.id!==run.workerId||worker.backend!==run.backendId)return
  const model=worker.model??this.host.config.backends[worker.backend]?.model??this.host.config.models.worker
  if(run.model&&run.model!==model)return
  // Reuse the normal binding check for changed endpoints, accounts and connectors.
  this.host.model.describe?.(run.threadId)
  return {run,proof}
 }
 private settleInterruptedRead({run,proof}:ReadRecovery,c:ScopeContext,mode:'automatic'|'requested'){
  const {store}=this.host
  for(const {id,receipt} of proof.kind==='read_only'?[]:proof.interrupted){
   store.put('backend-plugin-tool',id,{...receipt,state:'complete',
    result:{success:false,contentItems:[{type:'inputText',text:proof.kind==='denied_job_reads'?'This assignment cannot read the prior job. No output was returned.':'The interrupted GitHub resource read failed before returning a result.'}]},
    reconciliation:{reason:proof.kind==='denied_job_reads'?'prior_assignment_job_read_denied':'interrupted_github_read_failed',mode,previousState:receipt.state,ticketId:run.ticketId,
     assignmentId:run.assignmentId,threadId:run.threadId,turnId:run.turnId,triggerId:c.trigger.id,at:this.now()},
   })
  }
  if(proof.kind==='web_batch')store.audit({type:'opencode.web_batch.recovered',mode,ticketId:run.ticketId,assignmentId:run.assignmentId,...proof.replay})
  // The old adapter turn still has an interrupted journal. Start a new model session on the same task.
  const {threadId,turnId,error,failure,result,toolsVersion,toolsDigest,waitingForWriter,webFetchReplay,...retained}=run
  const session=store.get<object>('model-session',threadId!)
  store.put('model-session',threadId!,{...session,[proof.kind==='denied_job_reads'?'deniedJobReadRecovery':'readRecovery']:{turnId,at:this.now()}})
  const thread=store.get<PluginThread>('backend-plugin-thread',threadId!)
  if(thread&&thread.state!=='failed')store.put('backend-plugin-thread',thread.id,{...thread,state:'failed',lastFailure:{code:'process_failed',at:this.now()}})
  store.db.prepare(`UPDATE jobs SET state='done',error=NULL WHERE kind='execute' AND state='uncertain'
   AND json_extract(payload,'$.ticketId')=? AND json_extract(payload,'$.assignmentId')=?`).run(run.ticketId,run.assignmentId)
  let replay=webFetchReplay
  if(proof.kind==='web_batch'){
   replay=proof.replay
   if(webFetchReplay){
    const {previous=[],...last}=webFetchReplay
    replay={...replay,previous:[last,...previous].slice(0,4)}
   }
  }
  store.put('run',run.ticketId,{...retained,phase:'idle',webFetchReplay:replay} satisfies Run)
 }
 private automaticReadRecoveryAllowed(g:RouterGoal){
  return this.host.config.work.autoRecover&&g.managed&&g.contract&&!g.supersededBy&&g.turns<g.maxTurns&&g.failures<3
 }
 private recoverUnstartedShell(g:RouterGoal,n:GoalNode,c:ScopeContext){
  const id=n.ticketId,store=this.host.store
  if(!id||!this.automaticReadRecoveryAllowed(g)||g.project||!this.host.artifacts.canCapture(g)||n.recoveries>=5||
     this.host.executionActive(id)||store.get('task-continuation',id)||store.get('goal-delivery',id))return false
  const run=store.get<Run>('run',id),task=store.tickets.get(id)
  if(run?.phase!=='uncertain'||!task||task.ended||task.assignments.at(-1)?.report?.state!=='blocked'||
    hasOutstandingQuestion(this.host,task)||!this.host.scopes.taskRunnable(id)||
    !this.host.webhooks.taskExecutionAllowed(id)||this.host.webhooks.continuations.pending(id,run.assignmentId)||
    n.dependsOn.some(dep=>g.nodes!.find(d=>d.id===dep)?.state!=='passed')||!this.effectsSettledAtPhase(id,'uncertain')||
    unsettledTaskEffects(store,id,0)||store.db.prepare(`SELECT 1 FROM jobs WHERE state IN ('pending','running','blocked','uncertain')
     AND (json_extract(payload,'$.ticketId')=? OR json_extract(payload,'$.assignmentId')=?) LIMIT 1`).get(id,run.assignmentId))return false
  const attempt=store.get<{assignmentId:string;attemptId:string}>('async-worker-current',id)
  if(attempt){
   const terminal=store.get<{ticketId:string;assignmentId:string}>('async-worker-terminal',attempt.attemptId)
   if(attempt.assignmentId!==run.assignmentId||terminal?.ticketId!==id||terminal.assignmentId!==run.assignmentId)return false
  }
  if(store.db.prepare(`SELECT 1 FROM records s JOIN records t ON t.kind='backend-plugin-thread' AND t.id=s.id
    JOIN json_each(t.body,'$.effectIds') e LEFT JOIN records r ON r.kind='backend-plugin-tool' AND r.id=e.value
    WHERE s.kind='model-session' AND json_extract(s.body,'$.ticketId')=? AND s.id<>?
    AND json_extract(r.body,'$.state') IS NOT 'complete' LIMIT 1`).get(id,run.threadId??''))return false
  const proof=unstartedWorkerShell(store,this.host.config.stateDir,run)
  if(!proof)return false
  this.host.scopes.checkTask(id,c,true)
  const manifest=store.get<{manifest:ContextManifest}>('task-context',id)?.manifest
  if(manifest)this.host.memory.validate(manifest)
  const worker=workerProfiles(this.host.config).find(p=>p.id===run.workerId)
  if(!worker||worker.backend!==run.backendId||worker.state==='paused'||
     store.get<{workerId:string}>('worker-assignment',id)?.workerId!==worker.id)return false
  const model=worker.model??this.host.config.backends[worker.backend]?.model??this.host.config.models.worker
  if(run.model&&run.model!==model)return false
  this.host.model.describe?.(run.threadId)
  const prerequisites=n.dependsOn.flatMap(dep=>{
   const node=g.nodes!.find(d=>d.id===dep)!,round=store.get<VerificationRound>('goal-verification',node.roundId!)
   if(!round||round.state!=='passed'||!this.host.verification.current(round,g))throw Error('Prerequisite evidence changed before Worker recovery')
   return round.snapshot.evidence.filter(e=>e.artifact).map(e=>({path:e.key,artifact:e.artifact}))
  })
  const note=JSON.stringify({instruction:'Continue the current reviewed task in the retained workspace. The interrupted shell request never started. Inspect existing work and the accepted prerequisite artifacts. Use superagent_artifact_read with each artifact.id. Preserve prior effects.',unstartedRequestId:proof.requestId,prerequisiteEvidence:prerequisites})
  if(Buffer.byteLength(note)>this.host.scopes.scope(g.scopeId).contextBytes)return false
  return store.atomic(()=>{
   const {callback}=proof
   store.put('backend-plugin-tool',callback.id,{...callback.receipt,state:'complete',result:{success:false,contentItems:[{type:'inputText',text:'The host callback failed before a shell job was created.'}]},
    reconciliation:{reason:'shell_not_dispatched',mode:'automatic',previousState:callback.receipt.state,ticketId:id,assignmentId:run.assignmentId,threadId:run.threadId,turnId:run.turnId,triggerId:c.trigger.id,activityId:proof.activityId,at:this.now()}})
   const session=store.get<object>('model-session',run.threadId!)!
   store.put('model-session',run.threadId!,{...session,shellDispatchRecovery:{turnId:run.turnId,at:this.now()}})
   const {threadId,turnId,error,failure,result,waitingForWriter,toolsVersion,toolsDigest,...retained}=run
   store.put('run',id,{...retained,phase:'idle'})
   n.state='running';n.failure=undefined;n.reason=undefined;n.retryAt=undefined;n.recoveries++
   g.state='active';g.reason=undefined;g.nextAt=undefined;g.revision++;this.save(g)
   this.host.scopes.noteInput(id,c);this.host.memory.moveTaskContext(id,c)
   this.host.engine.report(id,{state:'waiting',summary:'已核实上一条命令未启动，正在继续处理。',question:null})
   this.host.engine.note(id,note)
   store.audit({type:'backend.tool.reconciled',receiptId:callback.id,reason:'shell_not_dispatched',activityId:proof.activityId,ticketId:id,confirmed:false})
   return true
  })
 }
 awaitingReadRecovery(run:Run){
  const g=this.forTask(run.ticketId)
  return !!g&&this.automaticReadRecoveryAllowed(g)&&['active','waiting'].includes(g.state)&&
   !!proveInterruptedOpenCodeRead(this.host.store,this.host.config.stateDir,run)
 }
 private recoverInterruptedReads(g:RouterGoal,c:ScopeContext,nodes:GoalNode[]){
  if(!this.automaticReadRecoveryAllowed(g))return false
  const {store}=this.host
  return store.atomic(()=>{
   const recoveries=new Map<GoalNode,{task:Ticket;summary:string;recovery:ReadRecovery}>()
   for(const node of nodes){
    if(!node.ticketId||node.recoveries>=5||node.teamTargetId||node.dependsOn.some(id=>g.nodes?.find(n=>n.id===id)?.state!=='passed'))return false
    const task=store.tickets.get(node.ticketId),assignment=task?.assignments.at(-1),report=assignment?.report
    if(!task||task.ended||task.undelivered.length||!assignment||!report||!['blocked','failed'].includes(report.state)||
     store.get('goal-delivery',task.id)||!this.host.scopes.taskRunnable(task.id)||!this.host.webhooks.taskExecutionAllowed(task.id)||
     this.host.webhooks.continuations.pending(task.id,assignment.id))return false
    this.host.scopes.checkTask(task.id,c,true)
    const manifest=store.get<{manifest:ContextManifest}>('task-context',task.id)?.manifest
    if(manifest)this.host.memory.validate(manifest)
    const recovery=this.interruptedRead(task,store.get<Run>('run',task.id))
    if(!recovery)return false
    recoveries.set(node,{task,summary:report.summary,recovery})
   }
   for(const {task,summary,recovery} of recoveries.values()){
    this.settleInterruptedRead(recovery,c,'automatic')
    this.host.retry(task.id)
    this.host.engine.note(task.id,JSON.stringify({...readContinuation(recovery.proof),previousReport:summary}))
    allowNewTaskInputs(store,task.id,task.inputs.map(i=>i.id))
   }
   const resumed=g.state==='held'?{state:'active' as const,reason:undefined,nextAt:undefined}:{}
   const restarted=g.nodes?.map(node=>recoveries.has(node)?{...node,state:'running' as const,reason:undefined,failure:undefined,retryAt:undefined,recoveries:node.recoveries+1}:node)
   this.save({...g,...resumed,nodes:restarted})
   Object.assign(g,resumed)
   for(const [index,node] of (g.nodes??[]).entries())if(recoveries.has(node))Object.assign(node,restarted![index])
   return true
  })
 }
 recoverFromWatchdog(g:RouterGoal,ticketId:string,recoveryId:string,reason:string){
  const c=this.context(g),n=g.nodes?.find(n=>n.ticketId===ticketId),task=this.host.store.tickets.get(ticketId)
  this.host.scopes.checkTask(ticketId,c,true)
  if(!g.managed||!['active','waiting'].includes(g.state)||!n||!task||task.ended||!this.effectsSettled(ticketId))throw Error('Watchdog recovery requires authorized settled work')
  if(this.host.store.get('goal-delivery',ticketId))throw Error('Retained deliverable must go through independent acceptance')
  const summary='Watchdog detected a stalled execution strategy. Inspect retained workspace and effects before changing implementation. Original objective, authorization and acceptance remain immutable. Evidence: '+recoveryId+'; '+reason
  this.host.engine.report(ticketId,{state:'failed',summary})
  n.state='held';n.reason=summary;n.failure={kind:'quality',reason:summary}
  this.save(g)
 }
 private save(g:RouterGoal){
  this.host.store.put('router-goal',g.id,g)
  if(g.state==='held'){
   const rounds=this.host.store.list<VerificationRound>('goal-verification').filter(r=>r.goalId===g.id&&['failed','insufficient'].includes(r.state)).sort((a,b)=>b.at-a.at)
   if(rounds[0])try{this.host.agentMemory.observeExperience(g,rounds[0])}catch(error){this.host.store.audit({type:'memory.experience_failed',goalId:g.id,error:String(error)})}
  }
 }
 budget(g:RouterGoal){return projectBudget(this.host.store,g,this.now())}
 holdBudget(g:RouterGoal){
  if(!g.project?.policy.budget||g.project.review?.state==='approved'||!['active','waiting'].includes(g.state))return false
  const remaining=this.budget(g)
  if(!remaining?.reason)return false
  g.state='held';g.nextAt=undefined;g.reason=remaining.reason;this.save(g)
  this.host.stopProject(g,remaining.reason);this.notice(g,remaining.reason)
  return true
 }
 private feedback(n:GoalNode,id:string,message:string):Pick<VerificationRound,'id'|'checks'>{
  return {id,checks:[{criterionId:n.criterionIds[0]??n.id,verdict:'failed',method:'program',evidenceIds:[],explanation:message}]}
 }
 private finalReview(g:RouterGoal,round:VerificationRound){
  const p=g.project!,node=g.nodes!.find(n=>n.id===p.integration)!,delivery=this.host.store.get<GoalDelivery>('goal-delivery',node.ticketId!)!
  const code=this.host.projectCode.receipt(delivery.id)
  if(!code?.head||code.error||code.test?.exit!==0)throw Error('The integrated commit needs a fresh passing test')
  const id=stableDigest([g.id,round.id,delivery.id,code.head]).slice(0,16)
  if(p.review?.id===id&&p.review.state==='approved')return true
  p.review={id,head:code.head,roundId:round.id,deliveryId:delivery.id,state:'pending',at:this.now()}
  g.state='needs_input';g.nextAt=undefined;g.nextAction='等待人工验收';g.reason='等待人工验收';this.save(g)
  this.host.store.put('project-review',id,{goalId:g.id,...p.review})
  this.reviewNotice(g,code)
  return false
 }
 private reviewNotice(g:RouterGoal,code:CodeReceipt){
  const p=g.project!,id=p.review!.id,prefix=this.host.sources.get(p.sourceId)?.verificationCommand,command=prefix?prefix+' ':''
  this.notice(g,['请验收「'+g.title+'」。','提交 '+code.head,'通过 '+code.test!.command,code.diffStat,'通过请回复「'+command+'验收通过 '+id+'」，需修改请回复「'+command+'退回 '+id+' 修改意见」。也可在控制面查看补丁和测试输出。'].filter(Boolean).join('\n'),true)
 }
 operatorReview(id:string){
  const record=this.host.store.get<{goalId:string}>('project-review',id),g=record&&this.get(record.goalId)
  if(!g||g.project?.review?.id!==id||this.host.scopes.binding(g.entryId).privateActor)throw Error('Project review is unavailable')
  this.context(g)
  return g
 }
 private decide(g:RouterGoal,id:string,decision:'approve'|'return',by:string,feedback?:string){
  return this.host.store.atomic(()=>{
   this.context(g)
   const p=g.project!,review=p.review
   if(!review||review.id!==id||g.finalRoundId!==review.roundId)throw Error('This project review was superseded')
   const state=decision==='approve'?'approved':'returned'
   if(review.state===state)return review
   if(g.state!=='needs_input'||review.state!=='pending')throw Error('This project review is closed')
   const round=this.host.store.get<VerificationRound>('goal-verification',review.roundId)
   const node=g.nodes!.find(n=>n.id===p.integration)!,d=this.host.store.get<GoalDelivery>('goal-delivery',node.ticketId!)
   if(!round||round.state!=='passed'||!this.host.verification.current(round,g)||d?.id!==review.deliveryId||this.host.projectCode.receipt(d.id)?.head!==review.head)throw Error('The reviewed commit or its evidence changed')
   if(decision==='return'&&!feedback?.trim())throw Error('Describe the requested change')
   p.reviewWaitMs+=Math.max(0,this.now()-review.at)
   Object.assign(review,{state,by,feedback:feedback?.trim(),decidedAt:this.now()})
   this.host.store.put('project-review',id,{goalId:g.id,...review});g.revision++;g.state='active';g.reason=undefined
   g.nextAction=decision==='return'?'根据验收意见修改并重新测试':'交付已验收的提交'
   if(decision==='return'){
    this.repair(g,node,this.feedback(node,'human-review:'+id,feedback!.trim()))
    this.notice(g,'已退回「'+g.title+'」，Worker 将在原任务中修改并重新测试。',true)
   }else this.save(g)
   return review
  })
 }
 decideOperator(id:string,decision:'approve'|'return',operator:string,feedback?:string){return this.decide(this.operatorReview(id),id,decision,'operator:'+operator,feedback)}
 chatReview(t:Trigger){
  if(!t.human)return false
  const prefix=this.host.sources.get(t.source)?.verificationCommand,text=t.text.trim().replace(/^(?:@\S+\s+)*/u,'')
  const match=(prefix&&text.startsWith(prefix+' ')?text.slice(prefix.length).trim():text).match(/^(验收通过|退回|approve commit|return commit)\s+([a-f0-9]{16})(?:\s+([\s\S]+))?$/i)
  if(!match)return false
  const [,verb,id,feedback]=match,c=this.host.scopes.context(t,t.source+':'+t.threads[0]!.id)
  const record=this.host.store.get<{goalId:string}>('project-review',id!),candidate=record&&this.get(record.goalId)
  let g:RouterGoal|undefined
  if(c&&candidate&&candidate.project?.review?.id===id&&candidate.scopeId===c.route.scopeId&&candidate.entryId===c.route.entryId){
   const requester=this.projectRequester(candidate)
   if(requester?.human&&this.host.scopes.actor(requester)===c.actor&&requester.source+':'+requester.threads[0]!.id===c.route.discussion)g=candidate
  }
  let message:string
  try{
   if(!g||this.host.routerIngress.authority(t.id).strength!=='explicit')throw Error('请在派活的原对话，以发起人的身份使用当前验收编号。')
   const returning=verb==='退回'||verb!.toLowerCase()==='return commit'
   if(!returning&&feedback)throw Error('通过请只填写验收编号，修改意见请使用退回。')
   const review=this.decide(g,id!,returning?'return':'approve',c!.actor,feedback)
   message='已记录对提交 '+review.head+' 的'+(returning?'退回意见。':'验收通过。')
  }catch(error){message=String(error).replace(/^Error: /,'')}
  this.host.store.put('project-review-input',t.id,{triggerId:t.id,goalId:g?.id,reviewId:id,message})
  if(t.channel){
   const reply='project-review-input:'+t.id
   this.host.store.put('router-reply-owner',reply,{discussion:t.source+':'+t.threads[0]!.id,triggerId:t.id,inputs:[t.id]})
   this.host.store.outbox.send({id:reply,channel:t.channel,kind:'reply',text:message})
  }
  return true
 }
 reviewSummary(g:RouterGoal){
  const p=g.project,review=p?.review
  if(!p||!review)return
  const code=this.host.projectCode.receipt(review.deliveryId)
  return {id:review.id,goalId:g.id,title:g.title,base:p.base,head:review.head,state:review.state,test:code?.test,diffStat:code?.diffStat,diff:code?.diff,budget:this.budget(g)}
 }
 private advanceRemote(g:RouterGoal,n:GoalNode){
  if(!n.delegationId||n.state==='passed'||n.state==='held')return
  if(n.state==='waiting_dependency'){
   n.state='held';n.reason='Remote prerequisites changed; reconcile the retained contract before creating a new explicitly authorized goal'
   this.host.delegation.cancelWhere(t=>t.goal?.goalId===g.id&&t.goal.nodeId===n.id);return
  }
  const task=this.host.delegation.goalTasks.task(g,n)
  if(task.desired==='cancelled'||['blocked','cancelled'].includes(task.remote?.state??'')){
   n.state='held';n.reason=task.remote?.reason??'Remote work stopped or requires attention';return
  }
  if(task.contract.deadline<=Date.now()&&task.remote?.state!=='ready'){
   n.state='held';n.reason='Remote execution deadline reached; cancellation remains subject to remote confirmation'
   this.host.delegation.cancelWhere(t=>t.id===task.id);return
  }
  if(task.remote?.state!=='ready'||task.error){if(task.error)n.reason='Waiting for a fresh signed remote observation: '+task.error;return}
  n.reason=undefined
  const round=this.host.verification.ensure(g,n);n.roundId=round.id;n.state='verifying'
  if(round.state==='passed')n.state='passed'
  else if(['failed','insufficient'].includes(round.state)){
   n.state='held';n.reason='Independent acceptance did not pass. Remote work will not be repeated automatically.'
  }else if(round.state==='errored'){
   const failure=classifyVerificationFailure(round.error??'Verifier failed',this.now(),n.recoveries)
   if(['transient','quota','protocol'].includes(failure.kind)&&(failure.kind==='protocol'?round.attempts<=2:n.recoveries<5)){
    n.failure??=failure;n.retryAt??=failure.retryAt
    if((n.retryAt??0)<=this.now()){this.retryVerification(round);n.recoveries++;n.retryAt=undefined;n.failure=undefined}
   }else{n.state='held';n.reason='Remote acceptance needs review: '+round.error}
  }else if(round.state==='stale'){n.state='held';n.reason='Remote acceptance evidence or authority changed'}
 }
 private repair(g:RouterGoal,n:GoalNode,round:Pick<VerificationRound,'id'|'checks'>){
  if(n.teamTargetId){n.state='held';n.reason='Remote acceptance needs a reviewed new contract; automatic replay is disabled';this.save(g);return}
  const c=this.context(g),task=this.host.store.tickets.get(n.ticketId!)!
  this.host.scopes.checkTask(task.id,c,true)
  if(task.ended||!this.effectsSettled(task.id))throw Error('Repair requires a retained open task with settled effects')
  const repairKey=stableDigest([round.id,n.id])
  const failed=round.checks.filter(ch=>ch.verdict!=='passed')
  const instruction='Independent acceptance did not pass. Repair only the listed failures while preserving all original constraints. Inspect retained workspace and effects before acting. Do not change acceptance criteria.\n'+JSON.stringify({failed,prerequisites:n.dependsOn.flatMap(id=>{const dep=g.nodes!.find(d=>d.id===id)!;return dep.roundId?this.host.store.get<VerificationRound>('goal-verification',dep.roundId)?.snapshot.evidence.filter(e=>e.kind!=='execution')??[]:[]})})
  if(Buffer.byteLength(instruction)>this.host.scopes.scope(g.scopeId).contextBytes)throw Error('Repair evidence exceeds context budget')
  this.host.store.atomic(()=>{
   if(this.host.store.get('goal-repair',repairKey))return
   const prior=task.inputs.map(i=>i.id)
   this.host.scopes.noteInput(task.id,c);this.host.memory.moveTaskContext(task.id,c)
   if(task.assignments.at(-1)?.report?.state==='blocked'&&!hasOutstandingQuestion(this.host,task))
    this.host.engine.report(task.id,{state:'waiting',summary:'依赖产物已通过验收，正在继续。',question:null})
   this.host.engine.note(task.id,instruction);allowNewTaskInputs(this.host.store,task.id,prior)
   this.host.store.db.prepare("DELETE FROM records WHERE kind='goal-delivery' AND id=?").run(task.id)
   this.host.store.put('goal-repair',repairKey,{id:repairKey,roundId:round.id,goalId:g.id,triggerId:g.triggerId,ticketId:task.id,failed,at:this.now()})
   n.repairs++;n.state='running';n.roundId=undefined;n.refreshFrom=undefined;g.finalRoundId=undefined
   const affected=new Set([n.id]);let grew=true
   while(grew){grew=false;for(const d of g.nodes??[])if(!affected.has(d.id)&&d.dependsOn.some(id=>affected.has(id))){affected.add(d.id);grew=true;if(d.ticketId||d.delegationId){d.state='waiting_dependency';if(!d.refreshFrom||!this.host.store.get('goal-replan',d.refreshFrom))d.refreshFrom=round.id;d.roundId=undefined;d.reason='Prerequisite repair requires refreshing this result'}}}
   this.save(g)
  })
 }
 /** Host-controlled graph scheduling and acceptance; no model decides these transitions. */
 async advance(){
  if(this.host.schedulingPaused)return
  for(let saved of this.host.store.list<RouterGoal>('router-goal')){
   if(!saved.nodes?.length&&saved.taskIds?.length){saved={...saved,nodes:saved.taskIds.map(ticketId=>({id:ticketId,title:'Retained task',instruction:this.host.store.tickets.get(ticketId)?.mandate.scope??'',workerId:this.host.store.get<any>('worker-assignment',ticketId)?.workerId??'',criterionIds:saved.criteria.map(c=>c.id),dependsOn:[],ticketId,state:'running' as const,repairs:0,recoveries:0}))};this.save(saved)}
   const reviewRound=saved.project?.review?.state==='pending'&&saved.finalRoundId?this.host.store.get<VerificationRound>('goal-verification',saved.finalRoundId):undefined
   const refreshReview=saved.state==='needs_input'&&!!reviewRound&&!reviewRound.snapshot.finalCommit
   if(saved.state==='needs_input'&&reviewRound?.snapshot.finalCommit){
    const code=this.host.projectCode.receipt(saved.project!.review!.deliveryId)
    if(code)this.reviewNotice(saved,code)
   }
   const held=saved.state==='held'&&this.automaticReadRecoveryAllowed(saved)&&(saved.nextAt??0)<=this.now()
    ? saved.nodes?.filter(n=>n.state==='held') : undefined
   const evidenceHolds=held&&saved.reason===heldReason(saved.nodes!)&&!saved.project&&
    (this.nextEvidenceCheck.get(saved.id)??0)<=this.now()?held.filter(n=>n.ticketId&&['quality','environment'].includes(n.failure?.kind??'')):[]
   const checkHeldRead=held?.length&&held.every(n=>n.failure?.kind==='uncertain')&&saved.reason===heldReason(saved.nodes!)
    const confirmed=saved.state==='held'&&saved.reason===heldReason(saved.nodes??[])
     ? saved.nodes?.filter(n=>n.state==='held'&&n.failure?.kind==='unconfirmed_effect'&&n.ticketId&&this.effectsSettled(n.ticketId))
     : undefined
   const runnable=['active','waiting'].includes(saved.state)||refreshReview
    if((!runnable&&!checkHeldRead&&!confirmed?.length&&!evidenceHolds.length)||!saved.objective||!saved.nodes?.length)continue
   if(saved.project&&this.holdBudget(saved))continue
   if(this.host.replanning.active(saved))continue
   let g=saved
   try{
    // Established goals may already be held when a compatible release starts.
    // Back off repeated evidence checks while a hold has no safe recovery.
    if(checkHeldRead){g.nextAt=this.now()+60_000;this.host.store.put('router-goal',g.id,g)}
    const c=this.context(g)
    if(evidenceHolds.length){
     this.nextEvidenceCheck.set(g.id,this.now()+60_000)
     for(const node of evidenceHolds)recoverGoalEvidence(this.host,g,node,c)
     if(g.state==='held'&&!confirmed?.length)continue
     this.nextEvidenceCheck.delete(g.id)
    }
    if(checkHeldRead){
     if(!held.some(node=>this.recoverUnstartedShell(g,node,c)))this.recoverInterruptedReads(g,c,held)
     continue
    }
    if(confirmed?.length){
     for(const node of confirmed){node.state='running';node.reason=undefined;node.failure=undefined}
     g.state='active';g.reason=undefined;g.nextAt=undefined;this.save(g)
    }
    if(refreshReview){
     this.host.store.atomic(()=>{
      const review=g.project!.review!
      this.host.store.put('goal-verification',reviewRound!.id,{...reviewRound,state:'stale'})
      this.host.store.db.prepare("DELETE FROM records WHERE kind='project-commit' AND id=?").run(review.deliveryId)
      g.project!.reviewWaitMs+=Math.max(0,this.now()-review.at)
      g.project!.review=undefined;g.finalRoundId=undefined
      g.state='active';g.reason=undefined;g.nextAction='重新测试提交并更新验收证据'
      this.save(g)
     })
     if(this.holdBudget(g))continue
    }
    if(g.state==='waiting'&&g.nextAt&&g.nextAt>this.now()&&!g.nodes!.some(n=>n.ticketId||n.delegationId))continue
    const nodes=g.nodes!
    // A previously accepted upstream artifact changing invalidates downstream acceptance.
    for(const n of nodes)if(n.state==='passed'){
     const round=n.roundId?this.host.store.get<VerificationRound>('goal-verification',n.roundId):undefined
     if(!round||!this.host.verification.current(round,g)){
      n.state='verifying';n.roundId=undefined;g.finalRoundId=undefined
      const affected=new Set([n.id]);let grew=true
      while(grew){grew=false;for(const d of nodes)if(!affected.has(d.id)&&d.dependsOn.some(id=>affected.has(id))){affected.add(d.id);grew=true;d.state='held';d.reason='A prerequisite changed after acceptance; reconcile downstream work before resuming'}}
     }
    }
    for(const n of nodes){
     if(n.teamTargetId){this.advanceRemote(g,n);continue}
     if(!n.ticketId||n.state==='passed'||n.state==='held')continue
     if(n.state==='waiting_dependency'){
      if(n.dependsOn.every(id=>nodes.find(d=>d.id===id)?.state==='passed')&&this.effectsSettled(n.ticketId)){
       const dependent=this.host.store.tickets.get(n.ticketId)
       if(!dependent||hasOutstandingQuestion(this.host,dependent)||this.host.approvals.waiting(n.ticketId)||this.host.permissions.forWorker(n.ticketId).length)continue
       if(this.host.replanning.resumeNode(g,n))continue
       if((n.repairs-(n.repairStart??0))>=(g.maxRepairs??2)){n.state='held';n.reason='Dependent refresh allowance reached'}
       else this.repair(g,n,{id:n.refreshFrom!,checks:n.criterionIds.map(criterionId=>({criterionId,verdict:'failed',explanation:'A prerequisite was repaired. Re-read its accepted evidence and refresh this dependent deliverable.',evidenceIds:[],method:'program'}))})
      }
      continue
     }
     this.host.scopes.checkTask(n.ticketId,c,true)
     const task=this.host.store.tickets.get(n.ticketId),run=this.host.store.get<Run>('run',n.ticketId)
     if(!task)throw Error('Goal task is unavailable')
     if(task.ended&&task.ended.by==='human'){n.state='held';n.reason='Task stopped by a human';continue}
     const proposal=this.host.store.get<GoalDelivery>('goal-delivery',n.ticketId)
     if(task.ended&&!proposal){n.state='held';n.reason='Legacy task ended without retained acceptance evidence; start a new authorized goal to verify or repair it';continue}
     if(proposal&&this.host.permissions.hasUnconfirmedEffect(n.ticketId)){
      n.state='held';n.reason=unconfirmedEffectMessage;n.failure={kind:'unconfirmed_effect',reason:n.reason}
      continue
     }
     if(proposal&&this.effectsSettled(n.ticketId)){
      if(g.project){
       const code=this.host.projectCode.check(g,n,proposal)
       if(!code){n.state='verifying';continue}
       if(code.error){
        if(n.repairs-(n.repairStart??0)>=(g.maxRepairs??2)){n.state='held';n.reason=code.error;n.failure={kind:'quality',reason:code.error}}
        else this.repair(g,n,this.feedback(n,code.id,code.error))
        continue
       }
      }
      const round=this.host.verification.ensure(g,n);n.roundId=round.id;n.state='verifying'
      if(round.state==='passed')n.state='passed'
      else if(['failed','insufficient'].includes(round.state)){
       if((n.repairs-(n.repairStart??0))>=(g.maxRepairs??2)){n.state='held';n.reason='Acceptance repair allowance reached; unresolved checks remain'}
       else this.repair(g,n,round)
      }else if(round.state==='errored'){
       const failure=classifyVerificationFailure(round.error??'Verifier failed',this.now(),n.recoveries)
       if(['transient','quota','protocol'].includes(failure.kind)&&(failure.kind==='protocol'?round.attempts<=2:n.recoveries<5)){
        n.failure??=failure;n.retryAt??=failure.retryAt
        if((n.retryAt??0)<=this.now()){this.retryVerification(round);n.recoveries++;n.retryAt=undefined;n.failure=undefined}
       }else if(failure.kind==='protocol'&&round.checks.some(ch=>ch.verdict==='insufficient')){
        this.host.store.put('goal-verification',round.id,{...round,state:'insufficient'});n.failure=undefined;n.retryAt=undefined
       }else{n.state='held';n.reason='Verification could not be completed: '+round.error}
      }else if(round.state==='stale'){n.state='held';n.reason='Acceptance input changed; reconcile and resume with current requirements'}
      continue
     }
     const report=task.assignments.at(-1)?.report
     if(['blocked','failed'].includes(report?.state??'')){
      if(run?.phase==='running'||run?.phase==='starting'||task.undelivered.length&&run?.phase!=='uncertain')continue
      if(run?.phase==='uncertain'){
       if(this.host.executionActive(task.id))continue
       if(this.recoverUnstartedShell(g,n,c))continue
       if(this.recoverInterruptedReads(g,c,[n]))continue
      }
      // A just-finished Worker can still have a Router-inbox report awaiting flush.
      // Let that bounded delivery/turn settle before deciding that replanning is unavailable.
      if(run?.phase==='idle'&&(this.host.activity.list().some(a=>a.ticketId===n.ticketId&&a.state==='running')||this.host.store.deliveries().some(d=>d.ticketId===n.ticketId&&['pending','sending'].includes(d.status))))continue
      const failure=run?.phase==='uncertain'?{kind:'uncertain' as const,reason:run.error??'Execution outcome uncertain'}
       :run?.failure?classifyExecutionFailure(run.failure,report!.summary,this.now(),n.recoveries):classifyGoalFailure(report!.summary,this.now(),n.recoveries)
      if(['quality','environment'].includes(failure.kind)&&recoverGoalEvidence(this.host,g,n,c))continue
      n.failure??=failure
      if(['transient','quota'].includes(failure.kind)&&n.recoveries<5){
       if(!this.effectsSettled(n.ticketId))continue
       n.retryAt??=failure.retryAt
       if((n.retryAt??0)<=this.now()){
        if(run?.failure?.readOnlyHistory){
         if(this.recoverInterruptedReads(g,c,[n]))continue
         n.state='held';n.reason='The provider stopped after read-only work and the saved session could not yet be recovered';n.retryAt=undefined
        }else{this.host.retry(n.ticketId);n.recoveries++;n.failure=undefined;n.retryAt=undefined}
       }
      }else{n.state='held';n.reason=failure.reason}
     }
    }
    this.save(g)
    let occupied=nodes.filter(n=>['running','verifying'].includes(n.state)).length
    for(const n of nodes){
     if(n.state!=='pending'||occupied>=(g.maxParallel??2)||n.dependsOn.some(id=>nodes.find(d=>d.id===id)?.state!=='passed'))continue
     if(n.teamTargetId){
      if(this.host.delegation.goalTasks.assertTarget(g,n).target.state==='paused'){n.reason='Waiting for the child team to resume intake';this.save(g);continue}
      n.reason=undefined
     }else this.host.replanning.assertWorker(g,n.workerId)
     const dependencies=n.dependsOn.flatMap(id=>{const dep=nodes.find(d=>d.id===id)!;const round=this.host.store.get<VerificationRound>('goal-verification',dep.roundId!)!;return round.snapshot.evidence.filter(e=>e.kind!=='execution')})
     const text=JSON.stringify({objective:g.objective,...(g.contract?.details?{contractDetails:g.contract.details}:{}),node:{title:n.title,instruction:n.instruction},criteria:this.host.verification.criteria(g,n),originalAcceptance:g.criteria,authorizationScope:g.contract?.mandate.scope,automationData:this.host.webhooks.inputData(g.triggerId),requirements:this.host.continuity.command({action:'read'},c).requirements,prerequisiteEvidence:dependencies})
     const packet=this.host.memory.build(c,{goalId:g.id,instruction:text},'goal-worker')
     if(g.workspace?.source&&!n.teamTargetId){
      const source=g.workspace.source
      this.checkWorkspaceSource(source,c)
      packet.manifest.taskOwners.push({id:source.ticketId,epoch:source.ownerEpoch,dataRevision:source.dataRevision})
     }
     const documentIds=[...new Set([...dependencies.filter(e=>e.kind==='document').map(e=>e.key),...g.criteria.flatMap(cr=>cr.documents??[])])]
     packet.manifest.knowledge=documentIds.flatMap(id=>this.host.knowledge.references(this.host.knowledge.command({action:'read',id},c),c))
     this.host.store.put('context-manifest',packet.manifest.id,packet.manifest);this.host.memory.validate(packet.manifest)
     const dispatchRevision=g.revision,dispatchContract=stableDigest(g.contract)
     const result=n.teamTargetId?await this.host.delegation.goalTasks.assign(g,n,c,packet.manifest,text):await this.host.manager.call({action:'assign',id:n.workerId,text,requestId:'goal-node:'+g.id+':'+n.id,revision:this.host.settings.current().revision},{discussion:g.discussion,trigger:c.trigger,scoped:c,manifest:packet.manifest})
     // The command is idempotent and its assignment is durable before this pointer.
     const current=this.get(g.id),target=current?.nodes?.find(d=>d.id===n.id)
     if(!current||current.supersededBy||!['active','waiting'].includes(current.state)||current.revision!==dispatchRevision||stableDigest(current.contract)!==dispatchContract||!target){
      // Keep the late handle for audit and restart cleanup, never adopt it into
      // the replacement or dispatch the remaining nodes of this stale graph.
      if(current){
       if(n.teamTargetId){current.delegationIds=[...new Set([...(current.delegationIds??[]),result.id])];if(target)target.delegationId=result.id}
       else{current.taskIds=[...new Set([...current.taskIds,result.ticketId])];if(target)target.ticketId=result.ticketId}
       if(target){target.state='held';target.reason='Contract changed while dispatch was pending'}
       if(['active','waiting'].includes(current.state)){current.state='held';current.reason='Contract changed while dispatch was pending';current.nextAt=undefined}
       this.save(current)
      }
      if(n.teamTargetId)this.host.delegation.goalTasks.cancel(g.id)
      else{this.host.interruptForAutomation(result.ticketId);if(!this.host.store.tickets.get(result.ticketId)?.ended)this.host.engine.stopTicket(result.ticketId,'Contract changed during dispatch')}
      if(!current)throw Error('Goal disappeared during dispatch')
      g=current;break
     }
     g=current;target.state='running';target.reason=undefined
     if(n.teamTargetId){target.delegationId=result.id;g.delegationIds=[...new Set([...(g.delegationIds??[]),result.id])]}
     else{target.ticketId=result.ticketId;if(!g.taskIds.includes(result.ticketId))g.taskIds.push(result.ticketId)}
     this.save(g);occupied++
    }
    if(!['active','waiting'].includes(g.state))continue
    if(g.nodes!.every(n=>n.state==='passed')){
     const round=this.host.verification.ensure(g);g.finalRoundId=round.id;this.save(g)
     if(round.state==='passed'&&this.host.verification.current(round,g)){
      this.host.store.atomic(()=>{
       this.context(g)
       const latest=this.get(g.id)!;if(!['active','waiting'].includes(latest.state))return
       if(g.project&&!this.finalReview(g,round))return
       for(const n of g.nodes!){if(n.teamTargetId)this.host.delegation.goalTasks.accept(g,n,round);else{const d=this.host.store.get<GoalDelivery>('goal-delivery',n.ticketId!)!;this.host.acceptGoalDelivery(d)}}
       if(g.nodes!.some(n=>!n.teamTargetId&&(!this.host.store.tickets.get(n.ticketId!)?.ended||!this.effectsSettled(n.ticketId!))))return
       g.state='completed';g.nextAt=undefined;g.reason=undefined;g.recovery=undefined
       g.checks=g.criteria.map(cr=>{const n=g.nodes!.find(n=>n.criterionIds.includes(cr.id))!;return {criterionId:cr.id,...(n.teamTargetId?{delegationId:n.delegationId!,reportAt:String(round.finishedAt)}:{ticketId:n.ticketId!,reportAt:this.host.store.tickets.get(n.ticketId!)!.assignments.at(-1)!.report!.at}),explanation:'Independent acceptance '+round.id}})
       this.save(g)
       try{this.host.agentMemory.observeExperience(g,round)}catch(error){this.host.store.audit({type:'memory.experience_failed',goalId:g.id,error:String(error)})}
       if(g.project)this.notice(g,'已完成「'+g.title+'」。人工验收提交 '+g.project.review!.head+'。',true)
       if(g.nodes!.every(n=>n.teamTargetId)){
        const {trigger}=this.anchor(g),id='goal-complete:'+g.id
        if(trigger.channel){this.host.store.put('router-reply-owner',id,{discussion:g.discussion,triggerId:g.triggerId,inputs:[g.triggerId]});this.host.store.outbox.send({id,channel:trigger.channel,kind:'reply',text:'目标「'+g.title+'」已通过独立验收。'})}
       }
      })
     }else if(['failed','insufficient'].includes(round.state)){
      const failedIds=new Set(round.checks.filter(ch=>ch.verdict!=='passed').map(ch=>ch.criterionId))
      const target=g.nodes!.find(n=>g.project?n.id===g.project.integration:n.criterionIds.some(id=>failedIds.has(id)))??g.nodes!.at(-1)!
      if((target.repairs-(target.repairStart??0))<(g.maxRepairs??2))this.repair(g,target,round)
      else{target.state='held';target.reason='Overall goal acceptance did not pass within the repair allowance';target.failure={kind:'quality',reason:target.reason};target.roundId=round.id;this.save(g);if(!this.host.replanning.consider(g)){g.state='held';g.nextAt=undefined;g.reason=target.reason;this.save(g);this.notice(g,g.reason)}}
     }else if(round.state==='errored'){
      const failure=classifyVerificationFailure(round.error??'Verifier failed',this.now(),g.recoveryAttempts??0)
      if(['transient','quota','protocol'].includes(failure.kind)&&(failure.kind==='protocol'?round.attempts<=2:(g.recoveryAttempts??0)<5)){
       g.recovery??=failure
       if((g.recovery.retryAt??0)<=this.now()){this.retryVerification(round);g.recoveryAttempts=(g.recoveryAttempts??0)+1;g.recovery=undefined}
       this.save(g)
      }else if(failure.kind==='protocol'&&round.checks.some(ch=>ch.verdict==='insufficient')){
       this.host.store.put('goal-verification',round.id,{...round,state:'insufficient'});g.recovery=undefined;this.save(g)
      }else{g.state='held';g.reason='Overall verification requires recovery: '+round.error;this.save(g);this.notice(g,g.reason)}
     }else if(round.state==='stale'){g.state='held';g.reason='Overall verification requires recovery: stale evidence';this.save(g);this.notice(g,g.reason)}
    }else if(g.nodes!.some(n=>n.state==='held')&&!g.nodes!.some(n=>['running','verifying'].includes(n.state)||n.state==='pending'&&n.dependsOn.every(id=>g.nodes!.find(d=>d.id===id)?.state==='passed'))){
     if(this.host.replanning.consider(g))continue
     g.state='held';g.reason=heldReason(g.nodes!);g.nextAt=undefined;this.save(g);this.notice(g,g.reason)
    }
   }catch(error){
    const latest=this.get(g.id)
    if(latest&&['active','waiting'].includes(latest.state)){
     g={...latest,state:'held',reason:String(error),nextAt:undefined,
      acceptanceOverflow:error instanceof AcceptanceEvidenceTooLarge?error.overflow:undefined}
     this.save(g)
     if(g.project)this.host.stopProject(g,g.reason!)
     this.notice(g,g.reason!)
    }
   }
  }
 }
 command(value:unknown,c:ScopeContext,manifest?:ContextManifest,skill?:{id:string;version:number}):any{
  this.host.scopes.assertCurrent(c);const x=goalCommandSchema.parse(value)
  if(x.action==='resume_many'){
   const {targets}=resumeMany.parse(value)
   if(!c.trigger.human||this.host.routerIngress.authority(c.trigger.id).strength!=='explicit')throw Error('Resuming goals requires explicit human input')
   const outcomes:GoalResumeOutcome[]=targets.map(target=>{
    const goal=this.get(target.id)
    if(!goal||!this.accessible(goal,c)||!this.sourcesValid(goal))return {id:target.id,title:target.id,resumed:false,reason:'Goal unavailable'}
    try{
     const result:RouterGoal=this.command({action:'resume',...target},c,manifest)
     return {id:result.id,title:result.title,resumed:result.state==='active',state:result.state,reason:result.reason,taskIds:result.taskIds}
    }catch(error){return {id:target.id,title:goal.title,resumed:false,state:goal.state,reason:error instanceof Error?error.message:String(error)}}
   })
   return {outcomes}
  }
  if(x.targets)throw Error('Multiple targets require resume_many')
  if((x.details||x.supersedes)&&x.action!=='start')throw Error('Contract details and replacement require a new goal')
  if(x.continueFrom&&x.action!=='start')throw Error('Workspace continuation requires starting a goal')
  if(x.supersedes&&x.continueFrom)throw Error('Choose a replacement or continue an ended workspace')
  if(x.action==='list')return {items:this.list(c)}
  if(x.action==='inspect'){
   const goal=x.id?this.get(x.id):undefined
   if(!goal||!this.accessible(goal,c,true)||!this.sourcesValid(goal))throw Error('Goal unavailable')
   return {goal:{...goal,taskIds:this.taskIdsForGoal(goal)},replanning:this.host.replanning.list(goal),attempts:this.host.store.list<{goalId:string}>('goal-verification-attempt').filter(a=>a.goalId===goal.id),rounds:this.host.store.list<VerificationRound>('goal-verification').filter(r=>r.goalId===goal.id).map(({snapshot,...round})=>({...round,evidence:snapshot.evidence.map(({content,...e})=>e)}))}
  }
  if(x.budget&&x.action!=='start')throw Error('Set the project budget when starting the goal')
  if(x.nodes&&x.action!=='start')throw Error('Direct graph replacement is not allowed; failure-driven plans require independent review')
  if(!x.operationId||x.expectedRevision===undefined)throw Error('Goal mutation requires operationId and expectedRevision')
  const human=c.trigger.human&&this.host.routerIngress.authority(c.trigger.id).strength==='explicit'
  if((x.details||x.supersedes)&&!human)throw Error('Contract details and replacement require current explicit human input')
  if(x.continueFrom&&!human)throw Error('Workspace continuation requires current explicit human input')
  if(x.details)for(const excerpt of [...(x.details.nonGoals??[]),...(x.details.inputs??[]),...(x.details.deadline?[x.details.deadline]:[])])if(!c.trigger.text.includes(excerpt))throw Error('Contract details must quote the current human request exactly')
  const automation=x.action==='start'&&(this.host.webhooks?.approvedStart(x,c)||this.host.proactive.skillStart(x,c))
  if(!human&&!automation&&this.wake(c.trigger.id)?.goalId!==x.id)throw Error('Autonomous input may only change its own goal')
  if(['start','pause','resume','cancel'].includes(x.action)||x.maxTurns!==undefined||x.maxParallel!==undefined||x.maxRepairs!==undefined||x.maxReplans!==undefined||x.nodes!==undefined)if(!human&&!automation)throw Error('This goal change requires a current explicit human input')
  const store=this.host.store,key=stableDigest([c.route.scopeId,c.route.entryId,c.actor,x.operationId]),fingerprint=stableDigest(x)
  const result=store.atomic(()=>{
   const receipt=store.get<any>('goal-receipt',key)
   if(receipt){if(receipt.fingerprint!==fingerprint)throw Error('operationId reused with different content');const current=this.list(c).find(g=>g.id===receipt.goalId);if(!current)throw Error('Goal receipt unavailable');return current}
   const candidate=x.supersedes?this.get(x.supersedes.goalId):undefined
   const prior=candidate&&this.accessible(candidate,c)?candidate:undefined
   if(x.supersedes){
    if(!prior||prior.supersededBy||terminal.has(prior.state))throw Error('Replacement goal is unavailable or already ended')
    if(this.triggerIdsForGoal(prior).includes(c.trigger.id))throw Error('Replacement requires a new explicit human request')
    if(prior.revision!==x.supersedes.expectedRevision)throw Error('Replaced goal revision conflict')
    for(const ticketId of this.taskIdsForGoal(prior))if(!store.tickets.get(ticketId)?.ended)this.host.scopes.checkTask(ticketId,c,true)
   }
   const saved=x.id?this.get(x.id):undefined
   let g=saved&&this.accessible(saved,c,x.action==='cancel')?saved:undefined
   if(x.action!=='start'&&!g)throw Error('Goal unavailable')
   if(x.action!=='start'&&(x.objective!==undefined||x.criteria!==undefined)&&g?.contract)throw Error('Original goal objective and acceptance criteria are immutable; use a new explicitly authorized goal')
   if((g?.revision??0)!==x.expectedRevision)throw Error('Goal revision conflict')
   if(x.action==='start'){
    if(g)throw Error('Goal already exists')
    if(!x.objective||!x.criteria)throw Error('Starting a goal requires objective and criteria')
    if(!x.authorizationQuote||!c.trigger.text.includes(x.authorizationQuote))throw Error('authorizationQuote must be an exact excerpt from the current user request')
    if(this.forInput(c.trigger.id))throw Error('This input already owns a goal; update it instead')
    if(new Set(x.criteria.map(c=>c.id)).size!==x.criteria.length||x.criteria.some(c=>c.id==='__goal__'))throw Error('Criterion IDs must be unique and not reserved')
    validateGraph(x.nodes??[],x.criteria)
    if(x.criteria.some(cr=>cr.check?.kind==='xlsx_cell_equals'))store.requireWorkflowSchema()
    const scope=this.host.scopes.scope(c.route.scopeId)
    const workers=skill?{...workerPermissions(this.host.config,(x.nodes??[]).flatMap(n=>n.workerId?[n.workerId]:[])),skill}:this.host.webhooks?.permissions(c.trigger.id)??{workerIds:scope.workerIds,backendIds:scope.backendIds}
    for(const n of x.nodes??[])if(n.workerId&&!scope.workerIds.includes(n.workerId))throw Error('Goal Worker is outside scope')
    const remoteIds=(x.nodes??[]).flatMap(n=>n.teamTargetId?[n.teamTargetId]:[]),teamTargets=this.host.delegation.goalTasks.capture(c,remoteIds)
    for(const n of x.nodes??[])if(n.teamTargetId)this.host.delegation.goalTasks.artifacts({criteria:x.criteria},{...n,state:'pending',repairs:0,recoveries:0})
    if(remoteIds.length)store.db.exec('PRAGMA user_version='+Math.max(DELEGATED_GOALS_DB_SCHEMA,Number(store.db.prepare('PRAGMA user_version').get()!.user_version)))
    g={id:'goal-'+key,scopeId:c.route.scopeId,entryId:c.route.entryId,discussion:c.route.discussion,actor:c.actor,triggerId:c.trigger.id,bindingRevision:this.host.scopes.binding(c.route.entryId).revision,revision:0,title:x.title??x.objective.slice(0,100),objective:x.objective,criteria:x.criteria,plan:x.plan??[],state:'active',taskIds:[],nextAction:x.nextAction??'Plan and execute the next unfinished step',nextAt:this.now()+60000,turns:0,maxTurns:x.maxTurns??200,failures:0,lastFingerprint:stableDigest([]),at:this.now(),nodes:x.nodes?.map(n=>({...n,state:'pending',repairs:0,recoveries:0})),maxParallel:x.maxParallel??2,maxRepairs:x.maxRepairs??2,managed:!!x.nodes,maxReplans:x.maxReplans??2,replans:0,planRevision:0,...(prior?{supersedes:prior.id}:{}),contract:{...(x.details?{details:x.details}:{}),objective:x.objective,criteria:x.criteria,triggerId:c.trigger.id,triggerHash:stableDigest(c.trigger),mandate:this.host.routerIngress.authority(c.trigger.id),...workers,...(teamTargets.length?{teamTargets}:{})}}
    const source=this.host.sources.get(c.trigger.source)!.config
    startCodeProject(source,g)
    const localChatWorkspace=this.host.chat.hasContext({triggerId:c.trigger.id})&&source.kind==='local'&&
     source.sandbox==='workspace-write'&&source.workspace?.mode!=='source'&&!g.project&&g.nodes?.some(n=>n.workerId)
    if(localChatWorkspace)g.workspace=x.continueFrom?this.continueWorkspace(x.continueFrom,c):{id:g.id}
    else if(x.continueFrom)throw Error('Retained workspaces require local Chat goal nodes')
    if(g.nodes?.some(n=>n.workspace&&(!g?.workspace||!n.workerId)))throw Error('Choose a workspace mode only for a local Chat goal node')
    if(x.budget){
     if(!g.project||!human)throw Error('A project budget requires an explicitly requested local code project')
     const policy=g.project.policy.budget??={}
     if(x.budget.maxMinutes!==undefined){
      if(policy.maxMinutes!==undefined&&x.budget.maxMinutes>policy.maxMinutes)throw Error('Project time budget exceeds this entry’s configured maximum')
      policy.maxMinutes=x.budget.maxMinutes
     }
     if(x.budget.maxUsd!==undefined){
      if(!policy.cost||x.budget.maxUsd>policy.cost.maxUsd)throw Error('Set model rates and a sufficient cost ceiling on the code entry')
      policy.cost.maxUsd=x.budget.maxUsd
     }
    }
    if(g.project)store.requireCodeProjectSchema()
    if(g.project?.policy.budget&&x.maxReplans===undefined)g.maxReplans=undefined
   }else if(!g)throw Error('Goal unavailable')
   if(!this.sourcesValid(g)&&!['pause','cancel'].includes(x.action)){
    if(g.nodes?.length)throw Error('Changed structured goal sources require a new explicitly authorized goal; prior node instructions cannot be reused')
    if(x.action!=='resume'||!x.objective||!x.title||!x.criteria||!x.authorizationQuote||!c.trigger.text.includes(x.authorizationQuote))throw Error('Changed goal sources require resume with a fresh explicit objective, title and criteria')
    g={...g,title:x.title,objective:x.objective,criteria:x.criteria,plan:x.plan??[],checks:undefined,contextIds:[]}
   }
   if(g.project?.review?.state==='pending'&&!['cancel','pause','resume'].includes(x.action)&&x.action!=='start')throw Error('The submitted commit is awaiting a human review')
   if(g.state==='completed'&&x.action==='complete')return this.list(c).find(item=>item.id===g!.id)
   if(terminal.has(g.state))throw Error('Ended goal requires a new explicit goal')
   if(x.action==='complete'){
    if(!x.checks||g.criteria.some(cr=>x.checks!.filter(ch=>ch.criterionId===cr.id).length!==1)||x.checks.length!==g.criteria.length)throw Error('Every acceptance criterion needs one verification')
    const round=g.finalRoundId?store.get<VerificationRound>('goal-verification',g.finalRoundId):undefined
    if(!round||round.state!=='passed'||!this.host.verification.current(round,g))throw Error('Independent goal acceptance has not passed; Worker ready reports cannot complete this goal')
    throw Error('The host settles verified goals automatically')
   }else if(x.action==='pause'||x.action==='cancel'){
    g={...g,state:x.action==='pause'?'paused':'cancelled',nextAt:undefined,reason:x.reason??'User requested '+x.action}
    if(x.action==='pause'&&store.list<import('./delegation/manager.ts').OutboundTask>('delegation-outbound').some(t=>t.goal?.goalId===g!.id&&t.desired==='running'&&!['ready','cancelled'].includes(t.remote?.state??'unknown')))throw Error('Remote execution pause is unsupported; cancel the goal or wait for the candidate before pausing verification')
    if(g.project&&x.action==='pause'){
     for(const node of g.nodes??[]){
      if(node.ticketId&&this.host.executionActive(node.ticketId))node.pausedAssignment=store.get<Run>('run',node.ticketId)?.assignmentId
     }
     this.host.stopProject(g,'User requested '+x.action)
    }
    if(x.action==='cancel'){
     const taskIds=this.taskIdsForGoal(g)
     for(const ticketId of taskIds){
      const ticket=store.tickets.get(ticketId)
      if(!ticket||ticket.ended)continue
      this.host.scopes.checkTask(ticketId,c,true,true)
      if(store.get<Run>('run',ticketId)?.phase==='merging')throw Error('Reconcile the submitted merge before cancelling the goal')
     }
     g={...g,taskIds,cancelledByUser:true}
     this.fenceCancelled(g)
    }
   }else if(x.action==='wait'){
    if(!x.reason)throw Error('Waiting needs a concrete reason')
    g={...g,state:x.needsHuman?'needs_input':'waiting',reason:x.reason,nextAt:x.needsHuman?undefined:this.now()+(x.wakeAfterSeconds??60)*1000}
   }else{
    if(x.action==='resume'){
     // A human may resume an automation, but cannot silently turn its machine
     // identity into a new human anchor or bypass an expired/revoked grant.
     const automationOrigin=g.contract?.triggerId&&(this.host.webhooks.ownsTrigger(g.contract.triggerId)||this.host.proactive.runForTrigger(g.contract.triggerId)?.spec.skill)?g.contract.triggerId:undefined
     if(automationOrigin)this.host.routerIngress.authority(automationOrigin)
     if(g.project&&!g.project.triggerIds.includes(c.trigger.id))g.project.triggerIds.push(c.trigger.id)
     g.replanId=undefined
     for(const node of g.nodes??[]){
      const run=node.ticketId?store.get<Run>('run',node.ticketId):undefined
      const pausedAssignment=node.pausedAssignment??(g.project&&g.state==='paused'&&node.state==='running'&&run?.phase==='idle'?run.assignmentId:undefined)
      if(pausedAssignment&&node.ticketId){
       const task=store.tickets.get(node.ticketId)
       if(task&&!task.ended&&task.assignments.at(-1)?.id===pausedAssignment&&!store.get('goal-delivery',task.id)){
        if(!this.effectsSettled(task.id))throw Error('Reconcile the current task or its effects before resuming')
        this.host.scopes.checkTask(task.id,c,true)
        const prior=task.inputs.map(i=>i.id)
        this.host.engine.note(task.id,'The project resumed after this turn was paused. Inspect the retained workspace, thread and tool receipts before continuing the existing assignment.')
        allowNewTaskInputs(store,task.id,prior)
       }
       delete node.pausedAssignment
       continue
      }
      if(node.state!=='held'||!node.ticketId)continue
      const task=store.tickets.get(node.ticketId),report=task?.assignments.at(-1)?.report
      if(!task||task.ended||!report||!['blocked','failed'].includes(report.state)||store.get('goal-delivery',task.id))continue
      this.host.scopes.checkTask(task.id,c,true)
      const needsRecovery=node.failure?.kind==='uncertain'||run?.phase==='uncertain'||run?.failure?.readOnlyHistory
      const recovered=needsRecovery&&!task.undelivered.length?this.interruptedRead(task,run,true):undefined
      if(needsRecovery&&!recovered)throw Error('Reconcile the current task or its effects before resuming')
      if(recovered)this.settleInterruptedRead(recovered,c,'requested')
      if(!this.effectsSettled(task.id))throw Error('Reconcile the current task or its effects before resuming')
      if(task.undelivered.length)continue // Consume the already queued continuation once.
      const prior=task.inputs.map(i=>i.id)
      this.host.scopes.noteInput(task.id,c);this.host.memory.moveTaskContext(task.id,c)
      this.host.retry(task.id)
      const continuation=recovered?readContinuation(recovered.proof):{
       instruction:'The host has resumed this goal. Continue this node’s assigned work from its retained files and receipts. Goal revisions and resume commands belong to the Router. Report the evidence for the node’s acceptance criteria or its remaining concrete blocker.'
      }
      this.host.engine.note(task.id,JSON.stringify({...continuation,previousReport:report.summary,userInput:c.trigger.text}))
      allowNewTaskInputs(store,task.id,prior)
     }
     for(const id of [g.finalRoundId,...(g.nodes??[]).map(n=>n.roundId)].filter((id):id is string=>!!id)){const round=store.get<VerificationRound>('goal-verification',id);if(round?.state==='errored'){store.put('goal-verification',id,{...round,state:'pending',error:undefined,finishedAt:undefined});store.jobState('goal-verify:'+id,'pending')}}
     g={...g,acceptanceOverflow:undefined,triggerId:automationOrigin??c.trigger.id,bindingRevision:this.host.scopes.binding(c.route.entryId).revision,failures:0,turns:0,recovery:undefined,recoveryAttempts:0,nodes:g.nodes?.map(n=>n.state==='held'?{...n,state:n.ticketId||n.delegationId?'running' as const:'pending' as const,reason:undefined,retryAt:undefined,recoveries:0,failure:undefined}:n)}
    }
    g={...g,state:'active',reason:undefined,nextAt:this.now()+(x.wakeAfterSeconds??60)*1000}
   }
   g={...g,revision:g.revision+1,plan:x.plan??g.plan,nextAction:x.action==='cancel'?'No further work':x.nextAction??g.nextAction,maxTurns:x.maxTurns??g.maxTurns,maxParallel:x.maxParallel??g.maxParallel,maxRepairs:x.maxRepairs??g.maxRepairs,maxReplans:x.maxReplans??g.maxReplans,contextIds:[...new Set([...(g.contextIds??[]),...(manifest&&x.action!=='cancel'?[manifest.id]:[])])]}
   if(g.project?.review?.state==='pending'&&x.action==='resume')g={...g,state:'needs_input',reason:'等待人工验收',nextAt:undefined}
   if(prior){
    // All new-contract validation completed before cancelling any execution.
    store.requireGoalReplacementSchema()
    const stopped={...prior,taskIds:this.taskIdsForGoal(prior),state:'cancelled' as const,revision:prior.revision+1,nextAt:undefined,supersededBy:g.id,reason:'Replaced by a new explicitly authorized goal'}
    store.put('router-goal',prior.id,stopped)
    this.fenceCancelled(stopped)
   }
   store.put('router-goal',g.id,g);store.put('goal-receipt',key,{scopeId:g.scopeId,entryId:g.entryId,triggerId:c.trigger.id,goalId:g.id,fingerprint,result:g})
   return this.list(c).find(item=>item.id===g.id)!
  })
  // Stop executors after the state and its receipt commit. Startup and duplicate
  // commands finish a cancellation interrupted between these steps.
  if(x.supersedes){
   const old=this.get(x.supersedes.goalId)
   if(old?.supersededBy===result?.id&&old?.state==='cancelled')this.finishCancellation(old)
  }else if(x.action==='cancel'&&result?.cancelledByUser){
   const cancelled=this.get(result.id)
   if(cancelled)this.finishCancellation(cancelled)
  }
  return result
 }
}
