import {z} from 'zod'
import {execFileSync} from 'node:child_process'
import {readdirSync,realpathSync} from 'node:fs'
import {dirname,isAbsolute,resolve} from 'node:path'
import type {ReplanRound} from './goal-replanning.ts'
import {archivedWorkerCheckpoint} from './backends/opencode-read-recovery.ts'
import type {Runtime} from './runtime.ts'
import type {GoalNode,IndependentOpinion} from './goal-contract.ts'
import type {RouterGoal} from './router-goals.ts'
import type {Run,Store} from './store.ts'
import type {Ticket} from './vendor/dsh-core/index.ts'
import type {VerificationRound} from './goal-verification.ts'
import {evidenceAccess,evidenceMetadata} from './goal-evidence.ts'
import {evidenceBytes} from './goal-artifacts.ts'
import {scopeBudget,textPage} from './context-budget.ts'
import {stableDigest} from './sources.ts'
import {workerProfiles} from './worker-pool.ts'
import {retainedBackendReceipts} from './backend-receipt-recovery.ts'
import {repositoryEffectsSettled} from './repository-source.ts'
import {unsettledTaskEffects} from './artifact-read-recovery.ts'
import {allowNewTaskInputs,retainedInputWakes} from './task-context.ts'
import {hasOutstandingQuestion} from './business-decisions.ts'
import type {TaskOwnership} from './router-scope.ts'
import type {WorkerAttempt,WorkerEventReceipt} from './async-worker-inbox.ts'
import type {ModelRequest} from './model.ts'

export const dependencyChanged='A prerequisite changed after acceptance; reconcile downstream work before resuming'
export const reviewPolicy='Independently inspect the current version and return an evidence-backed opinion. Return necessary changes to their producer. The host retains your report. All review access is read-only.'
export function reviewNode(n:Pick<GoalNode,'purpose'|'title'|'id'>|undefined){
 if(!n)return false
 // Old plans did not have a purpose field. Only a recognizable review stage is upgraded.
 return n.purpose==='review'||/^(independent[-_ ](?:code[-_ ])?review|独立(?:代码)?审查|独立复核)(?:$|[-_ ：:]|并|及)/i.test(n.id)||
  /^(?:independent(?:ly)? (?:code )?review\b|独立(?:代码)?审查|独立复核)/i.test(n.title)
}
export function selectReviewer(h:Runtime,g:RouterGoal,n:GoalNode,exclude?:string){
 const producers=new Set<string|undefined>([exclude,n.supervision?.priorWorker])
 const visit=(id:string,seen:Set<string>)=>{if(seen.has(id))return;seen.add(id);const dep=g.nodes?.find(d=>d.id===id);if(dep){producers.add(dep.workerId);for(const parent of dep.dependsOn)visit(parent,seen)}}
 const seen=new Set<string>();for(const id of n.dependsOn)visit(id,seen)
 const candidates=workerProfiles(h.config).filter(p=>(!p.state||p.state==='enabled')&&!producers.has(p.id))
 for(const p of candidates.sort((a,b)=>Number(b.id===n.workerId)-Number(a.id===n.workerId))){
  try{h.replanning.assertWorker(g,p.id);return p.id}catch{/* Try the next authorized profile. */}
 }
}
function dependencies(h:Runtime,g:RouterGoal,n:GoalNode){
 return n.dependsOn.map(id=>{
  const dep=g.nodes?.find(item=>item.id===id),round=dep?.roundId&&h.store.get<VerificationRound>('goal-verification',dep.roundId)
  if(!dep||dep.state!=='passed'||!round||round.state!=='passed'||round.nodeId!==id||round.goalId!==g.id)throw Error('Prerequisite acceptance is pending')
  return round
 })
}
export function dependencyBrief(h:Runtime,g:RouterGoal,n:GoalNode){
 const rounds=dependencies(h,g,n),items=rounds.flatMap(r=>r.snapshot.evidence.filter(e=>e.kind!=='execution'))
 if(!reviewNode(n)&&Buffer.byteLength(JSON.stringify(items))<=8192)return items
 return rounds.map(r=>({node:r.nodeId,round:r.id,resource:'goal-evidence/'+r.id,
  files:r.snapshot.evidence.filter(e=>e.kind==='file').map(e=>({path:e.key,resource:'goal-evidence/'+r.id+'/'+e.id})),
  notice:'Use superagent_read on each file resource for its accepted original contents. The host retains independent review reports at these resources even when the workspace has no physical copy.'}))
}
export function readDependency(h:Runtime,ticket:string,resource:string){
 const g=h.goals.forTask(ticket),n=g?.nodes?.find(n=>n.ticketId===ticket)
 if(!g||!n||!['active','waiting'].includes(g.state))throw Error('No current goal assignment')
 h.scopes.checkTask(ticket,h.goals.context(g),true)
 const [,roundId,id,...extra]=resource.split('/')
 const round=dependencies(h,g,n).find(r=>r.id===roundId)
 if(extra.length||!round||!h.verification.current(round,g,{readOnly:true}))throw Error('Prerequisite evidence changed')
 if(!id)return JSON.stringify(round.snapshot.evidence.map(evidenceMetadata))
 const e=round.snapshot.evidence.find(e=>e.id===id)
 if(!e)throw Error('Evidence is outside the assigned prerequisites')
 return e.provider?h.verification.providerContent(e):e.content
}
function reportPath(g:RouterGoal,n:GoalNode){
 if(n.reviewReport)return n.reviewReport
 const paths=g.criteria.filter(c=>n.criterionIds.includes(c.id)&&c.check?.kind==='file_exists').map(c=>c.check!.path).filter(p=>/\.(?:md|txt)$/i.test(p))
 if(paths.length===1)return paths[0]
}
const directorySchema=z.object({directory:z.string().max(256).regex(/^(?:\.|[\w.-]+(?:\/[\w.-]+)*)$/)}).strict()
// Paginate one directory without following links or exposing Git internals.
function directoryEntries(root:string,path:string,offset:number){
 if(isAbsolute(path)||path.split(/[\\/]/).some(p=>!p||p==='..'||p==='.git'))throw Error('Read a directory inside the workspace')
 const cwd=resolve(realpathSync(root),path)
 if(realpathSync(cwd)!==cwd)throw Error('Workspace symlinks are not allowed')
 const entries=readdirSync(cwd,{withFileTypes:true}).filter(entry=>entry.name!=='.git'&&(entry.isFile()||entry.isDirectory()))
  .map(entry=>entry.name+(entry.isDirectory()?'/':'')).sort()
 const end=Math.min(entries.length,offset+64)
 return {directory:path,entries:entries.slice(offset,end),nextOffset:end<entries.length?end:null}
}
function reviewRevision(root:string,directory:string){
 if(directory.split('/').includes('..'))throw Error('Read a repository inside the workspace')
 const base=realpathSync(root),cwd=resolve(base,directory)
 if(realpathSync(cwd)!==cwd)throw Error('Repository symlinks are not allowed')
 const out=execFileSync('git',['--no-optional-locks','rev-parse','--show-toplevel','HEAD^{commit}'],{cwd,
  env:{PATH:process.env.PATH,LANG:'C',GIT_CEILING_DIRECTORIES:base,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},
  stdio:['ignore','pipe','pipe'],maxBuffer:8192,timeout:3000,encoding:'utf8'}).trim().split('\n')
 if(out[0]!==cwd||!out[1]||!/^[a-f0-9]{40,64}$/.test(out[1]))throw Error('Use the repository root directory')
 return out[1]
}
function reviewedInputsCurrent(cwd:string,opinion:IndependentOpinion){
 try{
  for(const [path,hash] of Object.entries(opinion.files)){
   const bytes=evidenceBytes(cwd,path,4*1024*1024)
   if(!bytes||stableDigest(bytes.toString('utf8'))!==hash)return false
  }
  return Object.entries(opinion.revisions??{}).every(([dir,sha])=>reviewRevision(cwd,dir)===sha)
 }catch{return false}
}
export function originalReviewReport(g:RouterGoal,n:GoalNode,path:string,cwd:string){
 if(!reviewNode(n)||reportPath(g,n)!==path)return
 const opinion=n.opinion,inputs=n.dependsOn.map(id=>g.nodes?.find(dep=>dep.id===id)?.roundId)
 if(opinion?.verdict==='approved'&&inputs.every(Boolean)&&opinion.version===stableDigest(inputs)&&reviewedInputsCurrent(cwd,opinion))return {content:opinion.report}
 return {content:'',missing:true}
}
export class ReviewFeedbackError extends Error {}
const reviewSchema=z.object({verdict:z.enum(['approved','changes_requested','insufficient']),report:z.string().trim().min(1).max(24000),evidenceIds:z.array(z.string()).min(1).max(100),owners:z.array(z.string()).max(50)}).strict()
const fileSchema=z.object({path:z.string().min(1).max(1000),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(16000).default(8000)}).strict()

/** The reviewer gets host readers only. No native tools, shell grant, arbitrary connector or writing backend thread is reused. */
export function prepareIndependentReview(h:Runtime,g:RouterGoal,n:GoalNode,run:Run,attemptCurrent:()=>boolean){
 const rounds=dependencies(h,g,n)
 const version=stableDigest(rounds.map(r=>r.id))
 const current=()=>{
  const latest=h.goals.get(g.id),node=latest?.nodes?.find(item=>item.id===n.id)
  if(!attemptCurrent()||!latest||!node||latest.state!=='active'&&latest.state!=='waiting'||node?.workerId!==run.workerId||
    node.ticketId!==run.ticketId||node.state!=='running'||stableDigest(dependencies(h,latest,node).map(r=>r.id))!==version)throw Error('Review assignment changed')
  h.scopes.checkTask(run.ticketId,h.goals.context(latest),true)
 }
 const evidence=[...new Map(rounds.flatMap(r=>r.snapshot.evidence).map(e=>[e.id,e])).values()]
 const files:Record<string,string>=Object.create(null),revisions:Record<string,string>=Object.create(null)
 const access=evidenceAccess(evidence,Math.min(24000,scopeBudget(h.scopes.scope(g.scopeId).contextBytes).toolReserveBytes),current,0,e=>h.verification.providerContent(e))
 const reads=new Set<string>()
 const onTool:NonNullable<ModelRequest['onTool']>=async(name,args,id)=>{
  current()
  if(name==='goal_evidence')return access.onTool(name,args,id)
  if(name==='review_directory'){
   const x=fileSchema.parse(args)
   return {success:true,contentItems:[{type:'inputText',text:JSON.stringify(directoryEntries(run.cwd,x.path,x.offset))}]}
  }
  if(name==='review_revision'){
   const {directory}=directorySchema.parse(args),sha=reviewRevision(run.cwd,directory),ref='git:'+directory+'@'+sha
   if(revisions[directory]&&sha!==revisions[directory])throw Error('Reviewed commit changed')
   revisions[directory]=sha;reads.add(ref)
   return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({id:ref,directory,sha})}]}
  }
  if(name!=='review_file')throw Error('Only read-only review tools are available')
  const x=fileSchema.parse(args)
  if(x.path.split(/[\\/]/).some(p=>p==='.git'||p==='..'||p===''))throw Error('Read a regular workspace file')
  const bytes=evidenceBytes(run.cwd,x.path,4*1024*1024)
  if(!bytes){
   const parent=dirname(x.path)
   return {success:false,contentItems:[{type:'inputText',text:JSON.stringify({error:'File unavailable',...directoryEntries(run.cwd,parent,0)})}]}
  }
  if(bytes.includes(0))throw Error('A text file is required')
  const hash=stableDigest(bytes.toString('utf8'))
  if(files[x.path]&&files[x.path]!==hash)throw Error('Reviewed file changed')
  files[x.path]=hash
  const ref='file:'+x.path
  reads.add(ref)
  return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({id:ref,...textPage(bytes.toString('utf8'),x.offset,x.limit)})}]}
 }
 const diffs=evidence.filter(e=>e.kind==='file'&&!e.missing&&/\.(?:patch|diff)$/i.test(e.key))
 const available=evidence.filter(e=>e.kind==='file'||e.kind==='report').map(e=>({id:e.id,path:e.key,kind:e.kind}))
 // Keep archived tool output on its original task. Only the reviewer can request the selected bytes.
 const input={kind:'independent_review',objective:g.objective,criteria:h.verification.criteria(g,n),scope:n.title,
  reviewedNodes:n.dependsOn,version,files:available,requiredDiffs:diffs.map(e=>e.id),
  receipts:evidence.filter(e=>e.kind==='execution').map(e=>({id:e.id,key:e.key})),priorJobs:h.work.list(run.ticketId).slice(0,8).map(j=>({id:j.id,command:j.command?.slice(0,280),state:j.state,exitCode:j.exitCode})),workspace:'.'}
 const request={input:JSON.stringify(input),schema:z.toJSONSchema(reviewSchema,{target:'draft-7'}),instructions:reviewPolicy+' The assignment instructions describe the scope; route any requested edits to the producer. For code, use review_revision to identify the current commit and inspect the actual diff and test results. Use review_directory to discover actual source or test log names before opening them. Reuse evidence already read. Use the earlier report as historical evidence when its version differs. For other materials inspect their current contents. Use goal_evidence for immutable deliveries, review_file for scoped source or test logs, and cite the returned evidence or file IDs. For changes_requested identify the responsible reviewedNodes in owners. Before approval read and cite every requiredDiffs entry in full using goal_evidence. Use empty owners for approval. Distinguish an existing baseline limitation from a regression. Describe actual evidence and remaining risks in the report.',
  tools:[...access.tools,{type:'function' as const,name:'review_directory',description:'List one workspace directory, using path and optional offset, to locate files and saved test results.',inputSchema:z.toJSONSchema(fileSchema.pick({path:true,offset:true}),{target:'draft-7',io:'input'})},{type:'function' as const,name:'review_revision',description:'Read the exact local Git commit for a repository directory inside the assigned workspace.',inputSchema:z.toJSONSchema(directorySchema,{target:'draft-7'})},{type:'function' as const,name:'review_file',description:'Read a bounded page of a regular text file in the assigned workspace.',inputSchema:z.toJSONSchema(fileSchema,{target:'draft-7',io:'input'})}],onTool:async(name:string,args:unknown,id:string)=>{
   try{return await onTool(name,args,id)}catch(error){current();return {success:false,contentItems:[{type:'inputText' as const,text:String(error).slice(0,350)}]}}
  }}
 const finish=(raw:string):IndependentOpinion=>{
  current()
  let parsed:unknown
  try{parsed=JSON.parse(raw)}catch{throw new ReviewFeedbackError('Return one JSON opinion matching the review schema')}
  const response=reviewSchema.safeParse(parsed)
  if(!response.success)throw new ReviewFeedbackError('Include a verdict, report, inspected evidence IDs and responsible owners')
  const result=response.data
  if(result.evidenceIds.some(id=>!access.read.has(id)&&!reads.has(id))||result.owners.some(id=>!n.dependsOn.includes(id))||
    result.verdict==='approved'&&result.owners.length||result.verdict==='changes_requested'&&!result.owners.length)throw new ReviewFeedbackError('Review needs inspected evidence and a current producer for each change')
  if(result.verdict==='approved'&&diffs.some(e=>!access.read.has(e.id)||!result.evidenceIds.includes(e.id)))throw new ReviewFeedbackError('Approval requires the complete retained diff')
  const opinion={...result,version,workerId:run.workerId!,at:Date.now(),files,revisions}
  if(!reviewedInputsCurrent(run.cwd,opinion))throw Error('Reviewed version changed')
  if(rounds.some(r=>!h.verification.current(r,g,{readOnly:true})))throw Error('Review input changed before completion')
  return opinion
 }
 return {request,finish,current,inspected:()=>[...access.read,...reads]}
}

type CheckStore=Pick<Store,'get'|'db'|'list'>
// A reviewed, applied plan may explicitly give a correction step ownership of
// an earlier step's files. Only a new passed version differing in those files
// can release its checkpoint. Unrelated changes require ordinary reconciliation.
function approvedAddition(store:CheckStore,g:RouterGoal,n:GoalNode){
 if(!n.derivedFrom||!n.ticketId||!n.outputs?.length||n.recoveries>=5)return false
 const plans=store.list<ReplanRound>('goal-replan').filter(r=>r.goalId===g.id&&r.state==='applied'&&r.review?.approved&&
   r.snapshot.planRevision+1===g.planRevision&&r.scopeId===g.scopeId&&r.entryId===g.entryId)
 if(plans.length!==1)return false
 const plan=plans[0]!,addition=plan.proposal?.additions.find(a=>a.id===n.id)
 if(!addition||addition.derivedFrom!==n.derivedFrom||addition.workerId!==n.workerId||addition.instruction!==n.instruction||
   stableDigest(addition.dependsOn)!==stableDigest(n.dependsOn)||stableDigest(addition.outputs)!==stableDigest(n.outputs)||
   stableDigest(plan.snapshot.contract)!==stableDigest(g.contract)||stableDigest(plan.snapshot)!==plan.snapshotHash)return false
 return plan
}
export function matchesOutsideOutputs(left:VerificationRound['snapshot'],right:VerificationRound['snapshot'],owner:string,paths:string[]){
 const take=(snapshot:VerificationRound['snapshot'])=>{
  const {evidence,...rest}=snapshot
  return {...rest,evidence:evidence.map(e=>e.kind==='file'&&e.ticketId===owner&&!e.missing&&paths.includes(e.key)
   ?{kind:e.kind,ticketId:e.ticketId,key:e.key,criterionIds:e.criterionIds}:e)}
 }
 return stableDigest(take(left))===stableDigest(take(right))
}
export function amendingWorker(h:Runtime,g:RouterGoal,parent:GoalNode,round:VerificationRound){
 if(!parent.ticketId||!(g.planRevision??0))return
 const candidates=g.nodes?.filter(n=>n.state==='running'&&n.dependsOn.includes(parent.id)&&n.ticketId&&approvedAddition(h.store,g,n)&&
  h.store.get<Run>('run',n.ticketId)?.cwd===h.store.get<Run>('run',parent.ticketId!)?.cwd&&
  h.verification.current(round,g,{readOnly:true,changedFiles:{ticketId:parent.ticketId!,paths:n.outputs!}}))
 return candidates?.length===1?candidates[0]:undefined
}
function acceptedAmendment(store:CheckStore,g:RouterGoal,n:GoalNode){
 const plan=approvedAddition(store,g,n)
 if(!plan)return false
 let changed=false
 for(const id of n.dependsOn){
  const parent=g.nodes?.find(p=>p.id===id),prior=plan.snapshot.nodes.find(p=>p.id===id)
  if(parent?.state!=='passed'||!parent.roundId||prior?.state!=='passed'||!prior.roundId)return false
  const previous=store.get<VerificationRound>('goal-verification',prior.roundId),current=store.get<VerificationRound>('goal-verification',parent.roundId)
  if(!previous||!current||[previous,current].some(r=>r.goalId!==g.id||r.nodeId!==id||r.state!=='passed'))return false
  if(previous.id===current.id)continue
  if(!parent.ticketId||!matchesOutsideOutputs(previous.snapshot,current.snapshot,parent.ticketId,n.outputs!))return false
  changed=true
 }
 return changed
}
/** A dependency hold carries no authority to resume an explicitly stopped goal. Every queued job must be a receipt-only input wake. */
export function dependencyCheckpoint(store:CheckStore,g:RouterGoal,stateDir?:string){
 const nodes=g.nodes??[],held=nodes.filter(n=>n.state==='held')
 if(!g.managed||!g.contract||g.project||g.replanId||g.acceptanceOverflow||g.supersededBy||g.cancelledByUser||
   g.state!=='held'||g.nextAt!==undefined||!held.length||held.some(n=>n.reason!==dependencyChanged)||
   g.reason!==held.map(n=>n.title+': '+dependencyChanged).join('; ')||!held.some(n=>reviewNode(n)&&n.ticketId)||
   nodes.some(n=>n.teamTargetId||n.delegationId||!['passed','held','pending'].includes(n.state)))return
 const repairs=held.filter(n=>n.ticketId&&!reviewNode(n))
 if(repairs.some(n=>!acceptedAmendment(store,g,n)))return
 const ids=nodes.flatMap(n=>n.ticketId?[n.ticketId]:[]),jobs:string[]=[]
 if(ids.length!==g.taskIds.length||g.taskIds.some(id=>!ids.includes(id)))return
 for(const n of nodes){
  if(!n.ticketId)continue
  const id=n.ticketId,t=store.get<Ticket>('ticket',id),run=store.get<Run>('run',id),a=t?.assignments.at(-1)
  const ownership=store.get<TaskOwnership>('task-ownership',id),assigned=store.get<{ticketId:string;workerId:string;discussion:string}>('worker-assignment',id)
  if(ownership?.scopeId!==g.scopeId||ownership?.originEntry!==g.entryId||assigned?.ticketId!==id||assigned.workerId!==n.workerId||assigned.discussion!==g.discussion)return
  if(!t||t.ended||t.attention||!run||!a||a.id!==run.assignmentId||a.state!=='running'||run.phase!=='idle'||!run.prepared||
    !repositoryEffectsSettled(store,id)||unsettledTaskEffects(store,id,0))return
  const wakes=retainedInputWakes(store,run)
  if(!wakes)return
  jobs.push(...wakes)
  if(repairs.includes(n)&&(!stateDir||!archivedWorkerCheckpoint(store,stateDir,run)||store.get('goal-delivery',id)))return
  if(n.state==='passed'){const round=n.roundId&&store.get<VerificationRound>('goal-verification',n.roundId)
   if(!round||round.goalId!==g.id||round.nodeId!==n.id||round.state!=='passed'||!store.get('goal-delivery',id))return
  }else{
   const ptr=store.get<{attemptId:string;assignmentId:string}>('async-worker-current',id)
   const end=ptr&&store.get<{eventId:string}>('async-worker-terminal',ptr.attemptId)
   const attempt=ptr&&store.get<WorkerAttempt>('async-worker-attempt',ptr.attemptId)
   const event=end&&store.get<WorkerEventReceipt>('async-worker-event',end.eventId)
   if(!ptr||ptr.assignmentId!==a.id||!event||!attempt||attempt.basis.goalId!==g.id||attempt.basis.ownerEpoch!==(ownership.ownerEpoch??1)||event.id!==end!.eventId||stableDigest(attempt.basis)!==stableDigest(event.basis)||event.ticketId!==id||event.assignmentId!==a.id||event.attemptId!==ptr.attemptId||
     store.get('async-worker-paused',ptr.attemptId)||store.get('async-worker-revoked',ptr.attemptId)||
     !((event.disposition==='archived'&&['authority_changed','basis_changed'].includes(event.reason))||event.disposition==='applied'))return
  }
  const unresolved=store.db.prepare(`SELECT s.id AS session,e.value AS effect FROM records s JOIN records b ON b.kind='backend-plugin-thread' AND b.id=s.id
    JOIN json_each(b.body,'$.effectIds') e LEFT JOIN records r ON r.kind='backend-plugin-tool' AND r.id=e.value
    WHERE s.kind='model-session' AND json_extract(s.body,'$.ticketId')=? AND json_extract(r.body,'$.state') IS NOT 'complete'`).all(id)
  if(unresolved.length){
   // A finished producer can have a retired, replay-fenced backend session. The
   // review only consumes its accepted version and never resumes that session.
   if(n.state!=='passed'||!stateDir)return
   const fenced=new Set(retainedBackendReceipts(store,stateDir).map(r=>r.id))
   if(unresolved.some(row=>row.session===run.threadId||!fenced.has(String(row.effect))))return
  }
 }
 return {ids,jobs,receipts:[],...(repairs.length?{repairNodes:repairs.map(n=>n.id)}:{})}
}
export function superviseDependencies(h:Runtime,g:RouterGoal){
 if(!h.config.work.autoRecover||g.state!=='held'||g.turns>=g.maxTurns||g.failures>=3)return false
 const checkpoint=dependencyCheckpoint(h.store,g,h.config.stateDir)
 if(!checkpoint)return false
 const c=h.goals.context(g)
 const chat=h.store.get<{cancelled?:boolean;cancelRequested?:boolean}>('chat-run',g.triggerId)
 if(chat?.cancelled||chat?.cancelRequested)return false
 for(const id of checkpoint.ids){
  h.scopes.checkTask(id,c,true)
  if(h.executionActive(id)||!h.goals.effectsSettled(id)||hasOutstandingQuestion(h,h.store.tickets.get(id)!))return false
 }
 const nodes=g.nodes!
 for(const n of nodes.filter(n=>n.state==='passed')){const round=h.store.get<VerificationRound>('goal-verification',n.roundId!)!;if(!h.verification.current(round,g,{readOnly:true}))return false}
 const held=nodes.filter(n=>n.state==='held')
 const ready=(n:GoalNode)=>n.dependsOn.every(dep=>nodes.find(d=>d.id===dep)?.state==='passed')
 const repairs=held.filter(n=>checkpoint.repairNodes?.includes(n.id))
 const assignments=held.filter(n=>n.ticketId&&reviewNode(n)&&ready(n)).map(n=>{
  const run=h.store.get<Run>('run',n.ticketId!)!
  const prior=run.workspaceMode!=='read-only'?run.workerId:n.supervision?.priorWorker
  const reviewer=selectReviewer(h,g,n,prior)
  return {n,run,prior,reviewer}
 })
 if(assignments.some(item=>!item.reviewer))return false
 for(const n of repairs){
  const run=h.store.get<Run>('run',n.ticketId!)!
  h.replanning.assertWorker(g,n.workerId)
  if(!h.scopes.taskRunnable(n.ticketId!)||!h.webhooks.taskExecutionAllowed(n.ticketId!)||h.webhooks.continuations.pending(n.ticketId!,run.assignmentId))return false
 }
 h.store.atomic(()=>{
  g.state='active';g.reason=undefined;g.finalRoundId=undefined;g.revision++
  for(const n of held){
   n.reason=undefined;n.failure=undefined;n.roundId=undefined;n.opinion=undefined
   n.state=n.ticketId?(ready(n)?'running':'waiting_dependency'):'pending'
  }
  for(const n of repairs){
   const id=n.ticketId!,run=h.store.get<Run>('run',id)!,task=h.store.tickets.get(id)!,inputs=task.inputs.map(i=>i.id)
   const key=stableDigest([g.id,n.id,run.assignmentId,g.planRevision,n.dependsOn.map(dep=>nodes.find(p=>p.id===dep)!.roundId)])
   if(h.store.get('context-handoff',key))throw Error('This dependency checkpoint was already delivered')
   h.store.put('context-handoff',key,{ticketId:id,previousThread:run.threadId,previousTurn:run.turnId,backendId:run.backendId,model:run.model,reason:'approved_outputs_reverified',at:Date.now()})
   const {threadId,turnId,toolsDigest,toolsVersion,error,failure,result,...retained}=run
   h.store.put('run',id,{...retained,phase:'idle',rebuild:key} satisfies Run)
   h.scopes.noteInput(id,c);h.memory.moveTaskContext(id,c)
   h.engine.report(id,{state:'waiting',summary:'上一步的补丁已重新核验，正在接续原工单。',question:null})
   h.engine.note(id,JSON.stringify({instruction:'Finish this approved correction on the same branch. Inspect the retained files and jobs before doing anything else. Preserve completed changes and report exactly what the authorized environment could verify.',outputs:n.outputs,prerequisites:dependencyBrief(h,g,n)}))
   allowNewTaskInputs(h.store,id,inputs)
   const updated=h.store.tickets.get(id)!
   h.store.enqueue('execute:'+run.assignmentId+':'+stableDigest(updated.undelivered),'execute',{ticketId:id,assignmentId:run.assignmentId})
   n.recoveries++;h.store.audit({type:'goal.amendment_resumed',goalId:g.id,nodeId:n.id,ticketId:id,assignmentId:run.assignmentId,key})
  }
  for(const {n,run,prior,reviewer} of assignments){
   const id=run.ticketId,workerId=reviewer!,key=stableDigest([g.id,n.id,run.assignmentId,...n.dependsOn.map(dep=>nodes.find(d=>d.id===dep)?.roundId)])
   const old=h.store.get<{workerId:string}>('worker-assignment',id)!
   n.workerId=workerId;n.purpose='review';n.supervision={id:key,action:'review',priorWorker:prior,at:Date.now()}
   h.store.put('worker-assignment',id,{...old,workerId})
   h.store.put('run',id,{ticketId:id,assignmentId:run.assignmentId,cwd:run.cwd,workspaceId:run.workspaceId,workspaceSource:run.workspaceSource,workspaceMode:'read-only',phase:'idle',prepared:true,workerId} satisfies Run)
   const task=h.store.tickets.get(id)!,inputs=task.inputs.map(i=>i.id)
   h.scopes.noteInput(id,c);h.memory.moveTaskContext(id,c)
   h.engine.report(id,{state:'waiting',summary:'正在核对更新后的交付版本。',question:null})
   h.engine.note(id,reviewPolicy);allowNewTaskInputs(h.store,id,inputs)
   const updated=h.store.tickets.get(id)!
   h.store.enqueue('execute:'+run.assignmentId+':'+stableDigest(updated.undelivered),'execute',{ticketId:id,assignmentId:run.assignmentId})
   h.store.audit({type:'goal.review_resumed',goalId:g.id,nodeId:n.id,ticketId:id,assignmentId:run.assignmentId,from:prior,workerId,key})
  }
  h.store.put('router-goal',g.id,g)
 })
 return true
}
