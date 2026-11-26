import type {PermissionAction} from '../chat-permissions.ts'
import type {WorkerAttempt,WorkerEventReceipt} from '../async-worker-inbox.ts'
import {createHash} from 'node:crypto'
import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,realpathSync,statSync} from 'node:fs'
import {join} from 'node:path'
import {z} from 'zod'
import {maxWireBytes,toolParallelism} from '../execution-limits.ts'
import {githubReadSchema} from '../github-read.ts'
import {readSchema} from '../resources.ts'
import {knowledgeCommandSchema} from '../knowledge.ts'
import {skillReadSchema} from '../saved-skills.ts'
import {observationRequest} from '../goal-observation.ts'
import {findChatArtifactInput} from '../chat-retained-artifacts.ts'
import {bodyDigest,stableDigest} from '../sources.ts'
import type {Run,Store} from '../store.ts'
import type {Ticket} from '../vendor/dsh-core/index.ts'
import {jobInput,type WorkItem} from '../work.ts'
import type {ThreadStore} from './api.ts'
import {bundledEngineId} from './bundled-opencode.ts'
import {retryableInferenceStatus} from './api-errors.ts'
import {openCodeReadOnlyTools} from '../../plugins/backend-opencode/native-tools.ts'
import type {PluginThread,PluginToolEffect} from './plugin-process.ts'
import {maxWebPageCheckpointBytes,maxWebReplayPages,webBatchUrls,webPageCheckpointSchema,webPageDirectory,webPageFile,
 type WebBatchReplay,type WebBatchReplayRef,type WebPageCheckpoint} from './opencode-web-checkpoint.ts'

const uuid=z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/)
const callId=z.string().min(1).max(1000)
const resultSchema=z.object({success:z.boolean()})
const operationSchema=z.object({id:callId,tool:z.string(),path:z.string().optional(),urls:z.array(z.string()).max(toolParallelism).optional()}).strict()
const sessionSchema=z.object({
 format:z.literal(1),folder:uuid,nativeId:callId,cwd:z.string(),
 turns:z.array(z.object({
  id:uuid,state:z.enum(['completed','interrupted','running']),nativeToolsDisabled:z.literal(true).optional(),
  tools:z.array(z.object({id:callId,name:z.string(),args:z.json(),result:resultSchema.optional()})),
 })).nonempty(),
})
type InterruptedCallback={id:string;receipt:PluginToolEffect}
type InterruptedRead={kind:'github';interrupted:InterruptedCallback[]}
 |{kind:'web_batch';replay:WebBatchReplay;urls:string[];batches:string[][];interrupted:InterruptedCallback[]}
 |{kind:'read_only'}

export type RecordedRouterCall={name:string;args:unknown;receiptId:string;receipt:PluginToolEffect}
type ArtifactReconciliation={reason:'interrupted_artifact_read';ticketId:string;assignmentId:string;threadId:string;turnId:string;at:number}
export type ArtifactReadProof={
 receiptId:string;artifactId:string;threadId:string;turnId:string;
 receipt:PluginToolEffect&{reconciliation?:ArtifactReconciliation}
}
export type InterruptedRouterTurn=
 |{kind:'stopped';threadId:string;turnId:string;calls:RecordedRouterCall[]}
 |{kind:'unverified';threadId:string;turnId:string;tool?:string;receiptId?:string}

export function isRouterRead(name:string,args:unknown){
 const action=(args as {action?:unknown}|null)?.action
 switch(name){
  case 'router_skill':return skillReadSchema.safeParse(args).success
  case 'router_knowledge':return ['list','read','search','versions'].includes(String(action))&&knowledgeCommandSchema.safeParse(args).success
  case 'router_read':return readSchema.safeParse(args).success
  case 'chat_artifact_find':return findChatArtifactInput.safeParse(args).success
  case 'github_read':return githubReadSchema.safeParse(args).success
  case 'worker_manage':return action==='list'||action==='inspect'||action==='result'
  case 'router_goal':return action==='list'||action==='inspect'
  case 'router_journal':return action==='read'
  case 'workspace_browser':return action==='snapshot'
  case 'chat_opening':case 'superagent_status':return true
  default:return false
 }
}

function privateText(path:string,limit=maxWireBytes){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
 try{
  const stat=fstatSync(fd)
  if(!stat.isFile()||stat.nlink!==1||stat.size>limit)throw Error('Invalid OpenCode recovery record')
  return readFileSync(fd,'utf8')
 }finally{closeSync(fd)}
}

function sessionRoot(stateDir:string,thread:PluginThread){
 if(!thread.nativeId||!/^[a-z0-9][a-z0-9._-]*$/i.test(thread.backendId)||!/^[a-f0-9]{64}$/.test(thread.identity))return
 const data=join(realpathSync(stateDir),'backend-plugin-data',thread.backendId,thread.identity,'threads',stableDigest(thread.id))
 const index=join(data,'index')
 if(realpathSync(index)!==index)return
 const nativeKey=createHash('sha256').update(thread.nativeId).digest('hex')
 const mapping=z.object({id:callId,folder:uuid}).strict().parse(JSON.parse(privateText(join(index,nativeKey+'.json'),4096)))
 if(mapping.id!==thread.nativeId)return
 const root=join(data,'sessions',mapping.folder)
 if(realpathSync(root)!==root)return
 return {root,folder:mapping.folder}
}

/** Match legacy direct evidence reads to their original host results. A Code Mode
 * cell's transformed return value is not the provider response. */
export function legacyEvidenceReads(store:Pick<ThreadStore,'get'>,stateDir:string,thread:PluginThread){
 const reads:{id:string;name:string;args:unknown;digest:string;turnIndex:number;turnCount:number}[]=[]
 const binding=store.get<{id:string;harness?:string;harnessDigest?:string}>('backend-binding',thread.id)
 if(thread.pluginId!=='opencode-cli'||thread.stateVersion!==1||binding?.harness!==bundledEngineId||
    binding.id!==thread.backendId||binding.harnessDigest!==thread.digest)return reads
 try{
  const loc=sessionRoot(stateDir,thread)
  if(!loc||!stoppedWriter(loc.root))return reads
  const session=sessionSchema.parse(JSON.parse(privateText(join(loc.root,'session.json'))))
  if(session.folder!==loc.folder||session.nativeId!==thread.nativeId||session.cwd!==thread.cwd)return reads
  const owned=new Set(thread.effectIds)
  if(new Set(session.turns.map(turn=>turn.id)).size!==session.turns.length)return reads
  for(const [turnIndex,turn] of session.turns.entries())for(const call of turn.tools){
   if(call.name==='github_read'?!githubReadSchema.safeParse(call.args).success:!observationRequest(call.name,call.args))continue
   const id=stableDigest([thread.id,turn.id,call.id])
   if(!owned.has(id))continue
   const effect=store.get<PluginToolEffect>('backend-plugin-tool',id)
   if(effect?.state==='complete'&&effect.result&&effect.fingerprint===stableDigest([call.name,call.args])&&call.result?.success===effect.result.success&&
      (call.name==='github_read'||effect.result.contentItems.every(item=>item.type==='inputText')))
    reads.push({id,name:call.name,args:call.args,digest:stableDigest(effect.result),turnIndex,turnCount:session.turns.length})
  }
  return stoppedWriter(loc.root)?reads:[]
 }catch{return []}
}

function stoppedWriter(root:string){
 const path=join(root,'writer.lock')
 if(!lstatSync(path,{throwIfNoEntry:false}))return true
 const pid=Number(privateText(path,32))
 if(!Number.isSafeInteger(pid)||pid<2)return false
 try{process.kill(pid,0);return false}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH'}
}

/** Identify incomplete host callbacks in a stopped, pinned native turn. This
 * proves which call needs reconciliation, not what the operation did. */
export function stoppedOpenCodeCallbacks(store:Pick<ThreadStore,'get'>,stateDir:string,thread:PluginThread){
 if(thread.state!=='failed'||thread.lastFailure?.code!=='outcome_unknown'||thread.pluginId!=='opencode-cli'||
  thread.stateVersion!==1||!thread.turnId||new Set(thread.effectIds).size!==thread.effectIds.length)return []
 const binding=store.get<{id:string;harness?:string;harnessDigest?:string}>('backend-binding',thread.id)
 if(binding?.id!==thread.backendId||binding.harness!==bundledEngineId||binding.harnessDigest!==thread.digest)return []
 try{
  const location=sessionRoot(stateDir,thread)
  if(!location||!stoppedWriter(location.root))return []
  const session=sessionSchema.parse(JSON.parse(privateText(join(location.root,'session.json'))))
  const turn=session.turns.at(-1)!
  if(session.folder!==location.folder||session.nativeId!==thread.nativeId||session.cwd!==thread.cwd||
   new Set(session.turns.map(item=>item.id)).size!==session.turns.length||
   turn.id!==thread.turnId||turn.state!=='interrupted'||new Set(turn.tools.map(call=>call.id)).size!==turn.tools.length||
   !stoppedWriter(location.root))return []
  const effects=new Set(thread.effectIds)
  return turn.tools.flatMap(call=>{
   if(call.result||call.name.startsWith('opencode/'))return []
   const id=stableDigest([thread.id,turn.id,call.id])
   if(!effects.has(id))return []
   const receipt=store.get<PluginToolEffect>('backend-plugin-tool',id)
   if(receipt?.state!=='running'||receipt.result!==undefined||receipt.failure?.operation!=='tool'||
    receipt.failure.reason!=='exception'||receipt.fingerprint!==stableDigest([call.name,call.args]))return []
   return [{id,threadId:thread.id,turnId:turn.id,name:call.name,args:call.args,receipt}]
  })
 }catch{return []}
}
export function previouslyRecoveredRead(store:Pick<Store,'get'|'db'>,stateDir:string,run:Run,id:string):boolean {
 const previous=store.get<PluginThread>('backend-plugin-thread',id)
 const current=store.get<PluginThread>('backend-plugin-thread',run.threadId!)
 const session=store.get<{threadId:string;cwd:string;ephemeral:boolean;ticketId?:string;readRecovery?:{turnId:string}}> ('model-session',id)
 if(!previous?.turnId||previous.id!==id||previous.state!=='failed'||previous.pluginId!=='opencode-cli'||
  previous.cwd!==run.cwd||previous.backendId!==run.backendId||previous.identity!==current?.identity||
  session?.threadId!==id||session.ticketId!==run.ticketId||session.cwd!==run.cwd||session.ephemeral!==false)return false
 const receipts=previous.effectIds.map(effect=>store.get<PluginToolEffect&{reconciliation?:{reason:string;ticketId:string;threadId:string;turnId:string}}>('backend-plugin-tool',effect))
 if(receipts.some(receipt=>receipt?.state!=='complete'))return false
 const recorded=session.readRecovery?.turnId===previous.turnId||receipts.some(receipt=>{
  const settled=receipt?.reconciliation
  return settled&&['interrupted_github_read_failed','shell_not_dispatched'].includes(settled.reason)&&settled.ticketId===run.ticketId&&settled.threadId===id&&settled.turnId===previous.turnId
 })||store.db.prepare(`SELECT 1 FROM audit WHERE json_extract(body,'$.type')='opencode.web_batch.recovered'
  AND json_extract(body,'$.ticketId')=? AND json_extract(body,'$.threadId')=? AND json_extract(body,'$.turnId')=? LIMIT 1`).get(run.ticketId,id,previous.turnId)
 if(!recorded)return false
 try{const location=sessionRoot(stateDir,previous);return !!location&&stoppedWriter(location.root)}catch{return false}
}

function operations(root:string,turnId:string){
 const journal=join(root,turnId+'.operations')
 return lstatSync(journal,{throwIfNoEntry:false})
  ? privateText(journal).trim().split('\n').filter(Boolean).map(line=>operationSchema.parse(JSON.parse(line)))
  : []
}

/** Prove a stopped bundled Router turn from the native journal and host receipts. */
export function inspectInterruptedRouterTurn(store:Pick<ThreadStore,'get'>,stateDir:string,
 owner:{threadId:string;triggerId:string;sourceId:string;scopeId?:string;contextId?:string;cwd:string}):InterruptedRouterTurn|undefined{
 const thread=store.get<PluginThread>('backend-plugin-thread',owner.threadId)
 if(!thread||thread.pluginId!=='opencode-cli'||thread.state==='completed'||!thread.turnId)return
 const unverified:InterruptedRouterTurn={kind:'unverified',threadId:owner.threadId,turnId:thread.turnId}
 const binding=store.get<{id:string;harness?:string;harnessDigest?:string}>('backend-binding',owner.threadId)
 const model=store.get<{threadId:string;cwd:string;ephemeral:boolean;triggerId:string;sourceId:string;scopeId:string;contextId:string;ticketId?:string}>('model-session',owner.threadId)
 if(thread.id!==owner.threadId||thread.pluginId!=='opencode-cli'||thread.stateVersion!==1||binding?.harness!==bundledEngineId||
  binding.id!==thread.backendId||binding.harnessDigest!==thread.digest||model?.threadId!==thread.id||
  model.ticketId||model.ephemeral!==false||model.triggerId!==owner.triggerId||model.sourceId!==owner.sourceId||
  model.scopeId!==owner.scopeId||model.contextId!==owner.contextId)return unverified
 try{
  if(realpathSync(owner.cwd)!==thread.cwd||realpathSync(model.cwd)!==thread.cwd)return unverified
  const location=sessionRoot(stateDir,thread)
  if(!location||!stoppedWriter(location.root))return unverified
  const {root,folder}=location
  const session=sessionSchema.parse(JSON.parse(privateText(join(root,'session.json'))))
  const last=session.turns.at(-1)!
  if(session.folder!==folder||session.nativeId!==thread.nativeId||session.cwd!==thread.cwd||
   last.id!==thread.turnId)return unverified
  const journal=operations(root,last.id)
  if(!last.tools.length&&!journal.length&&(thread.effectIds.length===0||thread.lastFailure?.diagnostic?.effectFree))
   return {kind:'stopped',threadId:thread.id,turnId:last.id,calls:[]}
  if(last.nativeToolsDisabled?journal.length>0:privateText(join(root,last.id+'.ready'),32)!=='ready')return unverified
  const failed=thread.lastFailure
  if(thread.state==='failed'&&!['outcome_unknown','process_failed','transient'].includes(failed?.code??'')&&!failed?.diagnostic?.readOnlyHistory)return unverified
  const unsafe=journal.find(op=>!openCodeReadOnlyTools.has(op.tool))
  if(unsafe)return {...unverified,tool:'opencode/'+unsafe.tool,receiptId:unsafe.id}
  const nativeCalls=new Map(journal.map(op=>[op.id,op.tool]))
  if(nativeCalls.size!==journal.length)return unverified
  const effects=new Set(thread.effectIds),turns=new Set<string>(),calls:RecordedRouterCall[]=[]
  if(effects.size!==thread.effectIds.length)return unverified
  for(const turn of session.turns){
   if(turns.has(turn.id)||turn!==last&&turn.state!=='completed'&&(turn.tools.length||operations(root,turn.id).length))return unverified
   turns.add(turn.id)
   for(const call of turn.tools){
    if(call.name.startsWith('opencode/')){
     if(turn===last&&(nativeCalls.get(call.id)!==call.name.slice('opencode/'.length)||!call.result))return unverified
     continue
    }
    const id=stableDigest([thread.id,turn.id,call.id])
    const receipt=store.get<PluginToolEffect>('backend-plugin-tool',id)
    // The native journal can contain a callback that the host never admitted.
    if(turn===last&&!receipt&&!call.result&&!effects.has(id))continue
    const evidence={...unverified,tool:call.name,receiptId:id}
    if(!effects.delete(id)||!receipt||receipt.fingerprint!==stableDigest([call.name,call.args]))return evidence
    if(turn!==last){
     if(receipt.state!=='complete'||!call.result)return evidence
     continue
    }
    if(receipt.state==='complete'&&(!receipt.result||call.result&&receipt.result.success!==call.result.success)||
     receipt.state==='running'&&(call.result||receipt.result))return evidence
    calls.push({name:call.name,args:call.args,receiptId:id,receipt})
   }
  }
  if(effects.size||!stoppedWriter(root))return unverified
  return {kind:'stopped',threadId:thread.id,turnId:last.id,calls}
 }catch{return unverified}
}

/** Read the saved excerpts only for the authorized task's planned batch. */
type PageOwner={ticketId:string;backendId:string;identity:string;cwd:string}
function retainedBatchPages(store:Pick<ThreadStore,'get'>,stateDir:string,replay:WebBatchReplayRef,owner:PageOwner):WebPageCheckpoint[]{
 const thread=store.get<PluginThread>('backend-plugin-thread',replay.threadId)
 const model=store.get<{ticketId?:string;threadId:string;ephemeral:boolean}>('model-session',replay.threadId)
 if(!thread||thread.id!==replay.threadId||thread.turnId!==replay.turnId||thread.state!=='failed'||thread.pluginId!=='opencode-cli'||
  thread.backendId!==owner.backendId||thread.identity!==owner.identity||thread.cwd!==owner.cwd||
  model?.ticketId!==owner.ticketId||model.threadId!==thread.id||model.ephemeral!==false||!uuid.safeParse(replay.turnId).success)return []
 try{
  const location=sessionRoot(stateDir,thread)
  if(!location||!stoppedWriter(location.root))return []
  const ids=new Set(replay.callIds??[replay.callId])
  if(ids.size>maxWebReplayPages||!ids.has(replay.callId))return []
  const planned=operations(location.root,replay.turnId).filter(op=>ids.has(op.id)&&op.tool==='webfetch_batch')
  const batches=planned.map(op=>webBatchUrls(op.urls))
  if(planned.length!==ids.size||batches.some(batch=>!batch))return []
  const urls=[...new Set(batches.flatMap(batch=>batch!))]
  const directory=webPageDirectory(location.root,replay.turnId)
  if(realpathSync(directory)!==directory)return []
  return urls.slice(0,maxWebReplayPages).flatMap(url=>{
   try{
    const page=webPageCheckpointSchema.parse(JSON.parse(privateText(webPageFile(directory,url),maxWebPageCheckpointBytes)))
    return page.url===url&&page.endedAt>=page.startedAt?[page]:[]
   }catch{return []}
  })
 }catch{return []}
}
export function retainedWebPages(store:Pick<ThreadStore,'get'>,stateDir:string,replay:WebBatchReplay,owner:PageOwner):WebPageCheckpoint[]{
 const pages=new Map<string,WebPageCheckpoint>()
 for(const reference of [replay,...(replay.previous??[]).slice(0,4)])
  for(const page of retainedBatchPages(store,stateDir,reference,owner))
   if(!pages.has(page.url)&&pages.size<maxWebReplayPages)pages.set(page.url,page)
 return [...pages.values()]
}

/** Match the interrupted bridge call to the host's receipt and account for every native operation.
 * The adapter's writer lock and private journal belong to the old session, whose contents are retained.
 */
function boundWorkerSession(store:Pick<ThreadStore,'get'>,stateDir:string,run:Run,liveBoundary=false){
 if(!run.prepared||!run.threadId||!run.turnId||!run.backendId)return
 const thread=store.get<PluginThread>('backend-plugin-thread',run.threadId)
 const binding=store.get<{id:string;harness?:string;harnessDigest?:string}>('backend-binding',run.threadId)
 const model=store.get<{ticketId?:string;threadId:string;cwd:string;ephemeral:boolean}>('model-session',run.threadId)
 if(!thread||thread.id!==run.threadId||thread.turnId!==run.turnId||thread.state==='completed'||
  thread.state==='failed'&&(!thread.lastFailure||!['outcome_unknown','process_failed','transient'].includes(thread.lastFailure.code)&&!thread.lastFailure.diagnostic?.readOnlyHistory)||
  thread.pluginId!=='opencode-cli'||thread.stateVersion!==1||thread.backendId!==run.backendId||
  binding?.harness!==bundledEngineId||binding.id!==thread.backendId||binding.harnessDigest!==thread.digest||
  model?.ticketId!==run.ticketId||model.threadId!==run.threadId||model.cwd!==run.cwd||model.ephemeral!==false)return

 if(realpathSync(run.cwd)!==thread.cwd||!statSync(run.cwd).isDirectory())return
 const location=sessionRoot(stateDir,thread)
 if(!location||!liveBoundary&&!stoppedWriter(location.root))return
 const {root,folder}=location
 const session=sessionSchema.parse(JSON.parse(privateText(join(root,'session.json'))))
 const last=session.turns.at(-1)!
 if(session.folder!==folder||session.nativeId!==thread.nativeId||session.cwd!==thread.cwd||
  last.id!==run.turnId||last.state==='completed')return
 return {thread,root,session,last}
}

/** Old Worker cells recorded admissions before invoking each child but left a
 * throwing read running. A stopped cell has no external effects of its own.
 * Never replay its source or infer a result for an unacknowledged mutation. */
function settleReadBatch(record:PluginToolEffect,callId:string,owner:{attemptId:string;dataRevision:number|null}){
 const children=record.children
 const owned=(a:PluginToolEffect['admission'])=>a?.stage==='admitted'&&a.attemptId===owner.attemptId&&a.dataRevision===owner.dataRevision
 if(record.state!=='running'||record.result||record.failure?.operation!=='tool'||record.failure.reason!=='exception'||
    !owned(record.admission)||!children?.length||!children.some(child=>child.state==='running'))return
 const prefix=callId+':code:'
 if(new Set(children.map(child=>child.id)).size!==children.length||children.some(child=>
    child.name!=='superagent_read'||!child.id.startsWith(prefix)||!/^[1-9]\d*$/.test(child.id.slice(prefix.length))||
    !/^[a-f0-9]{64}$/.test(child.fingerprint)||!owned(child.admission)||child.permission||
    (child.state==='complete'?typeof child.success!=='boolean':child.state!=='running'||child.success!==undefined||!!child.resource)))return
 return {...record,state:'complete',result:{success:false,contentItems:[{type:'inputText',text:'The previous read batch stopped. Reuse the retained child results. Outstanding reads returned no confirmed result.'}]},
  children:children.map(child=>child.state==='running'?{...child,state:'complete',success:false}:child)} satisfies PluginToolEffect
}

/** Compare the native journal and the host ledger before opening a fresh
 * Worker session. Native operations outside the bridge need separate review. */
function accountedWorkerTurn(store:Pick<ThreadStore,'get'>,stateDir:string,run:Run,mode:'cancelled'|'denied_reads'|'provider'|'boundary'|'input'|'read_batch'|'pause',handoffAttempt?:{attemptId:string;dataRevision:number|null}){
 try{
  const boundary=mode==='boundary',checkpoint=boundary||mode==='provider'||mode==='input'||mode==='read_batch'||mode==='pause'
  const bound=boundWorkerSession(store,stateDir,run,boundary)
  if(!bound)return
  const {thread,session,root,last}=bound
  const failure=thread.lastFailure
  if(boundary){
   if(thread.state!=='running'||last.state!=='running')return
  }else if(mode==='cancelled'){
   if(thread.state!=='interrupted'||failure?.code!=='cancelled')return
  }else if(mode==='pause'){
   if(last.state!=='interrupted'||!(thread.state==='interrupted'&&failure?.code==='cancelled'||
      thread.state==='failed'&&failure?.code==='outcome_unknown'&&failure.diagnostic?.operation==='run'&&failure.diagnostic.reason==='exception'))return
  }else{
   if(thread.state!=='failed')return
   if(mode==='denied_reads'&&failure?.code!=='outcome_unknown')return
   if(mode==='read_batch'&&(failure?.code!=='outcome_unknown'||failure.diagnostic?.operation!=='run'||failure.diagnostic.reason!=='exception'))return
   const transport=failure?.diagnostic?.operation==='transport'&&
    (failure.code==='outcome_unknown'&&['timeout','turn_checkpoint'].includes(failure.diagnostic.reason)||
     failure.code==='process_failed'&&failure.diagnostic.reason==='process_exit')
   // A killed writer cannot close its native journal. Its lock, every native
   // operation and every callback must still match the host's durable ledger.
   if(last.state!=='interrupted'&&!((mode==='provider'||mode==='input')&&transport&&last.state==='running'))return
   if(mode==='provider'&&!transport&&(failure?.code!=='transient'||failure.diagnostic?.operation!=='run'||
      failure.diagnostic.reason!=='provider_status'||!retryableInferenceStatus(failure.diagnostic.httpStatus)))return
  }
  const effects=new Set(thread.effectIds),turns=new Set<string>()
  const directEffects=new Map<string,number>()
  const settledBatches=new Map<string,PluginToolEffect>()
  let hostConfirmed=false
  const jobs:{id:string;commandDigest:string}[]=[]
  const calls:{tool:string;effectId:string;success:boolean;callId?:string;action?:string;requestId?:string}[]=[],denied:InterruptedCallback[]=[]
  if(effects.size!==thread.effectIds.length)return
  for(const turn of session.turns){
   if(turns.has(turn.id)||turn!==last&&turn.state!=='completed'||new Set(turn.tools.map(c=>c.id)).size!==turn.tools.length)return
   const journal=operations(root,turn.id),native=new Map(journal.map(op=>[op.id,op.tool]))
   if(native.size!==journal.length||native.size&&(!checkpoint||turn.nativeToolsDisabled))return
   if(!turn.nativeToolsDisabled&&privateText(join(root,turn.id+'.ready'),32)!=='ready')return
   turns.add(turn.id)
   for(const call of turn.tools){
    if(call.name.startsWith('opencode/')){
     const tool=call.name.slice('opencode/'.length)
     if(!call.result||native.get(call.id)!==tool||!openCodeReadOnlyTools.has(tool))return
     native.delete(call.id)
     continue
    }
    const effectId=stableDigest([thread.id,turn.id,call.id])
    let record=store.get<PluginToolEffect>('backend-plugin-tool',effectId)
    if(!effects.delete(effectId)||!record||record.fingerprint!==stableDigest([call.name,call.args]))return
    if(mode==='read_batch'&&turn===last&&!call.result&&call.name==='code_mode'&&handoffAttempt){
     const settled=settleReadBatch(record,call.id,handoffAttempt)
     if(!settled)return
     record=settled
     settledBatches.set(effectId,settled)
    }
    if(record.children&&(call.name!=='code_mode'||new Set(record.children.map(child=>child.id)).size!==record.children.length||
       record.children.some(child=>child.state!=='complete'||typeof child.success!=='boolean'||child.permission==='pending'||child.permission==='uncertain')))return
    if(turn===last&&mode==='input'){
     const action=(call.args as {action?:string}|null)?.action
     const key=inputEffectKey(call.name,action)
     if(key)directEffects.set(key,(directEffects.get(key)??0)+1)
    }
    // The writer may stop after the host commits a result but before the CLI acknowledges it.
    const admission=record.admission
    if(mode==='pause'&&turn===last){
     if(!admission||!handoffAttempt||admission.attemptId!==handoffAttempt.attemptId||admission.dataRevision!==handoffAttempt.dataRevision)return
     if(admission.stage==='not_dispatched'){
      if(record.state!=='complete'||record.result?.success!==false||call.result?.success===true||record.children?.length)return
      continue
     }
     if(admission.stage!=='admitted')return
     if(call.name==='superagent_shell'){
      const command=(call.args as {command?:unknown}|null)?.command
      const returned=record.result?.contentItems.flatMap(item=>{
       try{return item.type==='inputText'?[JSON.parse(item.text??'')]:[]}catch{return []}
      }).find(item=>item?.kind==='shell'&&typeof item.id==='string')
      const job=returned&&store.get<WorkItem>('work',returned.id)
      if(typeof command!=='string'||!job||job.kind!=='shell'||job.agentId||job.ticketId!==run.ticketId||
         job.assignmentId!==run.assignmentId||job.cwd!==run.cwd||job.command!==command)return
      jobs.push({id:job.id,commandDigest:stableDigest(command)})
     }
    }
    const confirmed=(mode==='input'||mode==='pause')&&turn===last&&admission&&handoffAttempt&&admission.attemptId===handoffAttempt.attemptId&&
     admission.dataRevision===handoffAttempt.dataRevision&&record.state==='complete'&&record.result&&
     (admission.stage==='admitted'||admission.stage==='not_dispatched'&&!record.result.success)
    if(confirmed&&(!call.result||admission.stage==='not_dispatched'))hostConfirmed=true
    const result=call.result??(confirmed||settledBatches.has(effectId)?record.result:undefined)
    if(result){
     if(record.state!=='complete'||record.result?.success!==result.success||
       record.result.permission==='pending'||record.result.permission==='uncertain')return
     if(turn===last){
      const args=checkpoint?call.args as Record<string,unknown>|null:null
      calls.push({tool:call.name,effectId,success:result.success,
       ...(checkpoint?{callId:call.id}:{}),
       ...(typeof args?.action==='string'?{action:args.action}:{}),...(typeof args?.requestId==='string'?{requestId:args.requestId}:{})})
     }
     continue
    }
    if(mode==='input'&&turn===last){
     // Earlier releases did not persist admission. Only this structured
     // observation is eligible for the additional chronological proof below.
     const args=z.object({action:z.literal('get_window_state'),requestId:z.string().min(1),
      arguments:z.object({pid:z.number().int().positive(),window_id:z.number().int().positive(),include_screenshot:z.literal(false)}).strict()}).strict().safeParse(call.args)
     if(!args.success||call!==last.tools.at(-1)||call.name!=='superagent_desktop'||record.state!=='running'||record.result||
        record.failure?.operation!=='tool'||record.failure.reason!=='exception'||record.admission)return
     denied.push({id:effectId,receipt:record})
     continue
    }
    if(mode!=='denied_reads'||turn!==last||call.name!=='superagent_job'||record.state!=='running'||record.result||
      record.failure?.operation!=='tool'||record.failure.reason!=='exception')return
    const input=jobInput.safeParse(call.args)
    if(!input.success||input.data.action!=='read')return
    const job=store.get<WorkItem>('work',input.data.id)
    if(!job||job.id!==input.data.id||job.ticketId!==run.ticketId||job.cwd!==run.cwd||job.agentId||
      !job.assignmentId||job.assignmentId===run.assignmentId||!job.endedAt||!['completed','failed'].includes(job.state))return
    denied.push({id:effectId,receipt:record})
   }
   if(native.size)return
  }
  if(!effects.size&&(mode==='input'||mode==='pause'||(mode==='denied_reads'?denied.length:calls.length))&&(boundary||stoppedWriter(root)))return {calls,denied,failure,directEffects,hostConfirmed,settledBatches,jobs}
 }catch{/* Missing history keeps the original reconciliation fence. */}
}

export function pausedOpenCodeTurn(store:Pick<ThreadStore,'get'>,stateDir:string,run:Run,attempt:WorkerAttempt){
 const proof=accountedWorkerTurn(store,stateDir,run,'pause',{attemptId:attempt.id,dataRevision:attempt.basis.dataRevision})
 if(proof)return {calls:proof.calls,jobs:proof.jobs}
}

export function recordedWorkerCalls(store:Pick<ThreadStore,'get'>,stateDir:string,run:Run){
 return accountedWorkerTurn(store,stateDir,run,'cancelled')?.calls
}

// Acknowledgements and status messages do not establish recent task progress.
function recentWorkerProgress(store:Pick<Store,'db'>,activity:string,ticketId:string,start:number,at:number){
 return start<at&&!!store.db.prepare(`SELECT 1 FROM records WHERE kind='execution-call'
  AND json_extract(body,'$.parentId')=? AND json_extract(body,'$.ticketId')=? AND json_extract(body,'$.kind')='tool'
  AND json_extract(body,'$.state')='completed' AND json_extract(body,'$.name') NOT IN ('superagent_ack','superagent_status','superagent_plan')
  AND json_extract(body,'$.endedAt') BETWEEN ? AND ? LIMIT 1`).get(activity,ticketId,start+(at-start)/2,at)
}

/** Preflight at the next inference boundary. Resumption independently requires a stopped writer. */
export function workerCheckpointReady(store:Pick<Store,'get'|'db'>,stateDir:string,run:Run){
 if(run.phase!=='running'||!run.threadId)return false
 const model=store.get<{activity:string}>('model-session',run.threadId)
 const usage=model&&store.get<{at:number}>('model-usage',model.activity)
 return !!model&&!!usage&&recentWorkerProgress(store,model.activity,run.ticketId,usage.at,Date.now())&&
  !!accountedWorkerTurn(store,stateDir,run,'boundary')?.calls.some(call=>call.success)
}

// Old Code Mode cells only stored their outer receipt. Reject transfer if
// any potentially effectful child is not independently present in the journal.
function inputEffectKey(name:string,action?:string){
 if(['superagent_status','superagent_read','code_mode','chat_artifact_find'].includes(name)||
    name==='superagent_desktop'&&action==='get_window_state')return
 return name==='superagent_desktop'?name+':'+action:name
}

function inputHandoff(store:Pick<Store,'db'|'get'>,run:Run,event:WorkerEventReceipt){
 const ticket=store.get<Ticket>('ticket',run.ticketId),owner=store.get<{dataRevision:number;ownerEpoch:number;originEntry:string;scopeId:string}>('task-ownership',run.ticketId)
 const route=store.get<{parentTrigger:string;entryId:string}>('task-routing',run.ticketId)
 if(!event.basis?.goalId)return
 const goal=store.get<{contract:unknown;planRevision:number;entryId:string;actor:string;scopeId:string}>('router-goal',event.basis.goalId)
 if(!ticket||!owner||!route||!goal||route.entryId!==goal.entryId||owner.originEntry!==route.entryId||owner.scopeId!==goal.scopeId||
    !ticket.undelivered.length||ticket.ended||ticket.assignments.at(-1)?.id!==run.assignmentId||
    owner.ownerEpoch!==event.basis.ownerEpoch||stableDigest(goal.contract)!==event.basis.contractDigest||
    stableDigest(ticket.mandate)!==event.basis.mandateDigest||goal.planRevision!==event.basis.planRevision)return
 const binding=store.get<{revision:number;privateActor?:string;scopeId:string}>('entry-binding',route.entryId)
 if(!binding||binding.revision!==event.basis.bindingRevision||binding.privateActor!==goal.actor||binding.scopeId!==goal.scopeId)return
 const parent=store.get<{human:boolean;actor:{source:string;id:string}}>('trigger',route.parentTrigger)
 const chat=store.get<{conversationId:string;cancelled?:boolean;cancelRequested?:boolean}>('chat-run',route.parentTrigger)
 const conversation=chat&&store.get<{sourceId:string;actor:string;discussion:string}>('chat-conversation',chat.conversationId)
 if(!parent?.human||!chat||chat.cancelled||chat.cancelRequested||!conversation||conversation.sourceId!==parent.actor.source||
    conversation.actor!==parent.actor.id||JSON.stringify([parent.actor.source,parent.actor.id])!==goal.actor)return
 const rows=store.db.prepare(`SELECT body FROM records WHERE kind='async-worker-event' AND json_extract(body,'$.ticketId')=?
  AND json_extract(body,'$.assignmentId')=? AND json_extract(body,'$.nativeTurnDigest')=? AND json_extract(body,'$.disposition')='archived'
  AND json_extract(body,'$.reason')='basis_changed' AND json_extract(body,'$.kind')='blocked' LIMIT 2`).all(run.ticketId,run.assignmentId,event.nativeTurnDigest)
 if(rows.length!==1)return
 const old=JSON.parse(String(rows[0]!.body)) as WorkerEventReceipt,attempt=store.get<WorkerAttempt>('async-worker-attempt',old.attemptId)
 if(!attempt||attempt.ticketId!==run.ticketId||attempt.assignmentId!==run.assignmentId||stableDigest(attempt.basis)!==stableDigest(old.basis)||
    store.get<{eventId:string}>('async-worker-terminal',old.attemptId)?.eventId!==old.id||store.get('async-worker-revoked',old.attemptId))return
 const {dataRevision,goalRevision:_,...prior}=old.basis,{dataRevision:current,goalRevision:__,...latest}=event.basis
 // Later follow-ups may already own the route when the scheduler checks the stopped turn.
 // Anchor its invalidation to a queued input admitted during that attempt.
 const pending=ticket.inputs.flatMap(input=>{
  if(input.kind!=='trigger'||!input.human||!ticket.undelivered.includes(input.id)||!input.triggerId.startsWith('router-followup:'))return []
  const cause=store.get<{meta?:{parentTrigger?:string}}>('trigger',input.triggerId)
  const id=cause?.meta?.parentTrigger,original=id&&store.get<{human:boolean;actor:{source:string;id:string}}>('trigger',id)
  const batch=id&&store.get<{conversationId:string;cancelled?:boolean;cancelRequested?:boolean}>('chat-run',id)
  if(!original||!original.human||JSON.stringify([original.actor.source,original.actor.id])!==goal.actor||
     !batch||batch.conversationId!==chat.conversationId||batch.cancelled||batch.cancelRequested)return []
  const command=store.get<{status:string;scopeId:string;result?:{ticketId:string;status:string}}>('worker-command',input.triggerId.slice('router-followup:'.length))
  return command?.status==='completed'&&command.scopeId===goal.scopeId&&command.result?.ticketId===run.ticketId&&
    command.result.status==='queued'?[{parent:id!,at:Date.parse(input.at)}]:[]
 })
 if(!pending.some(input=>input.parent===route.parentTrigger))return
 const admission=pending.find(input=>attempt.startedAt<=input.at&&input.at<=old.observedAt)
 if(!admission)return
 const {at}=admission
 if(event.id!==old.id&&(event.disposition!=='applied'||event.reason!=='current'))return
 if(stableDigest(prior)!==stableDigest(latest)||(dataRevision??1)>=owner.dataRevision||event.id!==old.id&&current!==owner.dataRevision||
    !(attempt.startedAt<=at&&at<=old.observedAt&&old.observedAt<=event.observedAt))return
 return {at,attemptId:old.attemptId,dataRevision,parent:admission.parent}
}

export function settledProviderTurn(store:Pick<Store,'db'|'get'>,stateDir:string,run:Run){
 if(run.phase!=='uncertain'||run.waitingForWriter)return
 const current=store.get<{ticketId:string;assignmentId:string;attemptId:string}>('async-worker-current',run.ticketId)
 const terminal=current&&store.get<{eventId:string}>('async-worker-terminal',current.attemptId)
 const event=terminal&&store.get<WorkerEventReceipt>('async-worker-event',terminal.eventId)
 if(!run.turnId||current?.ticketId!==run.ticketId||current.assignmentId!==run.assignmentId||!event||event.id!==terminal!.eventId||
    event.attemptId!==current.attemptId||event.ticketId!==run.ticketId||event.assignmentId!==run.assignmentId||
    event.kind!=='blocked'||event.nativeTurnDigest!==stableDigest(run.turnId))return
 if(store.db.prepare(`SELECT 1 FROM records WHERE kind IN ('browser-receipt','desktop-receipt','tool-receipt')
    AND json_extract(body,'$.ticketId')=? AND json_extract(body,'$.state') IS NOT 'complete' LIMIT 1`).get(run.ticketId))return
 const provider=event.disposition==='applied'?accountedWorkerTurn(store,stateDir,run,'provider'):undefined
 const attempt=store.get<WorkerAttempt>('async-worker-attempt',event.attemptId)
 const owner=store.get<{ownerEpoch:number;dataRevision:number;state:string}>('task-ownership',run.ticketId)
 const batch=!provider&&!!event.basis&&owner?.state==='active'&&owner.ownerEpoch===event.basis.ownerEpoch&&owner.dataRevision===event.basis.dataRevision&&event.disposition==='applied'&&event.reason==='current'&&attempt?.ticketId===run.ticketId&&
  attempt.assignmentId===run.assignmentId&&stableDigest(attempt.basis)===stableDigest(event.basis)&&!store.get('async-worker-revoked',event.attemptId)
  ?accountedWorkerTurn(store,stateDir,run,'read_batch',{attemptId:event.attemptId,dataRevision:event.basis.dataRevision}):undefined
 const readBatch=batch?.settledBatches.size?batch:undefined
 const handoff=!provider&&!readBatch&&inputHandoff(store,run,event)
 const proof=provider??readBatch??(handoff?accountedWorkerTurn(store,stateDir,run,'input',handoff):undefined)
 if(!proof?.failure)return
 const model=store.get<{activity:string;workerId?:string;agentId?:string;sourceId:string;triggerId:string;scopeId:string;contextId:string}>('model-session',run.threadId!)
 const usage=model&&store.get<{id:string;ticketId:string;role:string;state:string;at:number;endedAt:number;workerId:string;triggerId:string;sourceId:string}>('model-usage',model.activity)
 if(!model?.workerId||model.workerId!==run.workerId||model.agentId||usage?.role!=='worker'||usage.state!=='failed'||
    usage.id!==model.activity||usage.ticketId!==run.ticketId||usage.workerId!==model.workerId||usage.triggerId!==model.triggerId||usage.sourceId!==model.sourceId||
    !(usage.endedAt>=proof.failure.at))return
 const at=proof.failure.at
 if(handoff){
  if(!proof.failure.diagnostic||!(usage.at<=handoff.at&&handoff.at<=at))return
  const legacy=proof.denied.length>0
  if(legacy){
   if(proof.denied.length!==1||proof.failure.diagnostic.operation!=='run'||proof.failure.diagnostic.reason!=='exception')return
   const send=store.db.prepare(`SELECT json_extract(body,'$.endedAt') AS ended FROM records WHERE kind='execution-call'
    AND json_extract(body,'$.triggerId')=? AND json_extract(body,'$.name')='worker_manage' AND json_extract(body,'$.action')='send'
    AND json_extract(body,'$.state')='completed' AND json_extract(body,'$.startedAt')<=? AND json_extract(body,'$.endedAt')>=? LIMIT 2`).all(handoff.parent,handoff.at,handoff.at)
   if(send.length!==1)return
   const traces=store.db.prepare(`SELECT body FROM records WHERE kind='execution-call' AND json_extract(body,'$.parentId')=? AND json_extract(body,'$.kind')='tool'`).all(usage.id)
   const unmatched=new Map(proof.directEffects);let failedReads=0
   for(const row of traces){
    const trace=JSON.parse(String(row.body))
    if(trace.ticketId!==run.ticketId||trace.workerId!==model.workerId||!['completed','failed'].includes(trace.state))return
    const action=trace.name==='superagent_desktop'?trace.action?.replace(/^desktop:/,''):undefined
    const key=inputEffectKey(trace.name,action)
    if(key)unmatched.set(key,(unmatched.get(key)??0)-1)
    if(trace.state==='failed'&&trace.name==='superagent_desktop'&&action==='get_window_state'){
     if(!(Number(send[0]!.ended)<=trace.startedAt&&trace.startedAt<=trace.endedAt&&trace.endedAt<=at))return
     failedReads++
    }
   }
   if(!failedReads||[...unmatched.values()].some(n=>n!==0))return
  }else if(!(proof.failure.diagnostic.operation==='transport'&&['turn_checkpoint','timeout'].includes(proof.failure.diagnostic.reason))&&
    !(proof.hostConfirmed&&proof.failure.diagnostic.operation==='run'&&proof.failure.diagnostic.reason==='exception'))return
 }
 const cause=handoff?'input_superseded' as const:readBatch?'settled_read_batch' as const:proof.failure.diagnostic!.reason
 // A hard turn deadline also ends productive work. Only spend another
 // authorized goal turn when a real tool finished in the latter half.
 const productiveDeadline=(cause==='turn_checkpoint'||cause==='timeout')&&recentWorkerProgress(store,model.activity,run.ticketId,usage.at,at)
 return {calls:proof.calls,model,at,cause,productiveDeadline,settledBatches:proof.settledBatches,undispatched:proof.denied,attemptId:handoff?handoff.attemptId:undefined,retryAfterMs:proof.failure.diagnostic?.retryAfterMs}
}

export function refusedWorkerJobReads(store:Pick<ThreadStore,'get'>,stateDir:string,run:Run){
 if(run.phase!=='uncertain'||run.waitingForWriter)return
 const proof=accountedWorkerTurn(store,stateDir,run,'denied_reads')
 if(proof)return {kind:'denied_job_reads' as const,interrupted:proof.denied,calls:proof.calls}
}

/** Bind the one interrupted host call to its stopped writer, complete journal and audit interval. */
function stoppedWorkerTool(store:Pick<Store,'get'|'db'>,stateDir:string,run:Run,name:'superagent_shell'|'superagent_desktop'){
 if(run.phase!=='uncertain'||run.waitingForWriter)return
 try{
  const bound=boundWorkerSession(store,stateDir,run)
  if(!bound)return
  const {root,thread,session,last}=bound
  if(thread.state!=='failed'||thread.lastFailure?.code!=='outcome_unknown'||last.state!=='interrupted')return
  const model=store.get<{activity:string;agentId?:string;workerId?:string;triggerId:string;sourceId:string}>('model-session',thread.id)
  const usage=model&&store.get<{id:string;role:string;state:string;ticketId?:string;workerId?:string;triggerId:string;sourceId:string;at:number;endedAt:number}>('model-usage',model.activity)
  if(!model?.workerId||model.agentId||model.workerId!==run.workerId||usage?.role!=='worker'||usage.state!=='failed'||
     usage.id!==model.activity||usage.workerId!==model.workerId||usage.triggerId!==model.triggerId||usage.sourceId!==model.sourceId||
     usage.ticketId!==run.ticketId||!(usage.endedAt>=thread.lastFailure.at))return
  const callbacks=stoppedOpenCodeCallbacks(store,stateDir,thread)
  if(callbacks.length!==1||callbacks[0]!.name!==name)return
  const callback=callbacks[0]!
  const remaining=new Set(thread.effectIds)
  if(remaining.size!==thread.effectIds.length||new Set(session.turns.map(turn=>turn.id)).size!==session.turns.length)return
  for(const turn of session.turns){
   if(turn!==last&&turn.state!=='completed'||!turn.nativeToolsDisabled&&privateText(join(root,turn.id+'.ready'),32)!=='ready')return
   const operationsLog=operations(root,turn.id),native=new Map(operationsLog.map(op=>[op.id,op.tool]))
   if(native.size!==operationsLog.length||new Set(turn.tools.map(call=>call.id)).size!==turn.tools.length)return
   for(const call of turn.tools){
    if(call.name.startsWith('opencode/')){
     const tool=call.name.slice('opencode/'.length)
     if(!call.result||!openCodeReadOnlyTools.has(tool)||native.get(call.id)!==tool)return
     native.delete(call.id);continue
    }
    const id=stableDigest([thread.id,turn.id,call.id]),owned=remaining.delete(id)
    const receipt=store.get<PluginToolEffect>('backend-plugin-tool',id)
    if(!owned&&!receipt&&turn===last&&!call.result&&
      (call.name==='superagent_read'&&readSchema.safeParse(call.args).success||
       call.name==='chat_artifact_find'&&findChatArtifactInput.safeParse(call.args).success))continue
    if(!owned||!receipt||receipt.fingerprint!==stableDigest([call.name,call.args]))return
    if(id===callback.id)continue
    if(!call.result||receipt.state!=='complete'||receipt.result?.success!==call.result.success||
       receipt.result.permission==='uncertain'||receipt.result.permission==='pending')return
   }
   if(native.size)return
  }
  if(remaining.size)return
  const calls=store.db.prepare(`SELECT id,json_extract(body,'$.startedAt') AS started,json_extract(body,'$.endedAt') AS ended
   FROM records WHERE kind='execution-call' AND json_extract(body,'$.parentId')=? AND json_extract(body,'$.kind')='tool'
   AND json_extract(body,'$.name')=? AND json_extract(body,'$.ticketId')=? AND json_extract(body,'$.agentId') IS NULL
   AND json_extract(body,'$.workerId')=? AND json_extract(body,'$.triggerId')=? AND json_extract(body,'$.sourceId')=?
   AND json_extract(body,'$.state')='failed'`).all(model.activity,name,run.ticketId,model.workerId,model.triggerId,model.sourceId)
  if(calls.length!==1)return
  const call=calls[0]!,started=Number(call.started),ended=Number(call.ended)
  const assignment=store.get<Ticket>('ticket',run.ticketId)?.assignments.at(-1)
  if(assignment?.id!==run.assignmentId||!assignment.startedAt||!(Date.parse(assignment.startedAt)<=started&&usage.at<=started&&started<=ended&&ended<=usage.endedAt))return
  const trace=store.get<{version:number;installedAt:number}>('execution-trace-meta','current')
  if(trace?.version!==1||!(trace.installedAt<=started))return
  const events=store.db.prepare(`SELECT seq,json_extract(body,'$.state') AS state FROM audit WHERE json_valid(body)
   AND json_extract(body,'$.type')='execution.trace' AND json_extract(body,'$.baseline')=0
   AND json_extract(body,'$.entity')='execution-call' AND json_extract(body,'$.entityId')=?
   AND json_extract(body,'$.ticketId')=? ORDER BY seq`).all(String(call.id),run.ticketId)
  if(events.length!==2||events[0]!.state!=='running'||events[1]!.state!=='failed')return
  const startSeq=Number(events[0]!.seq),endSeq=Number(events[1]!.seq)
  const coverage=store.db.prepare('SELECT count(*) AS n FROM audit WHERE seq BETWEEN ? AND ?').get(startSeq,endSeq)
  if(coverage?.n!==endSeq-startSeq+1)return
  if(stoppedWriter(root))return {callback,activityId:String(call.id),started,ended,startSeq,endSeq}
 }catch{/* An incomplete or ambiguous journal cannot establish non-execution. */}
}

/** A shell command commits its work row and request key before starting a runner. */
export function unstartedWorkerShell(store:Pick<Store,'get'|'db'>,stateDir:string,run:Run){
 const proof=stoppedWorkerTool(store,stateDir,run,'superagent_shell')
 if(!proof)return
 const {callback,activityId,startSeq,endSeq}=proof
 const args=z.object({requestId:z.string().min(1),command:z.string().min(1),yieldMs:z.number().optional()}).strict().safeParse(callback.args)
 if(!args.success)return
 const key=[run.ticketId,run.assignmentId,'root',args.data.requestId].join(':')
  if(store.get('work-request',key)!==undefined||store.db.prepare(`SELECT 1 FROM records WHERE kind='work' AND
    json_extract(body,'$.ticketId')=? AND json_extract(body,'$.assignmentId')=? AND json_extract(body,'$.command')=? LIMIT 1`).get(run.ticketId,run.assignmentId,args.data.command)||
     store.db.prepare(`SELECT 1 FROM audit WHERE seq BETWEEN ? AND ? AND json_extract(body,'$.entity')='work'
      AND json_extract(body,'$.ticketId')=? LIMIT 1`).get(startSeq,endSeq,run.ticketId))return
 return {callback,activityId,requestId:args.data.requestId}
}

/** Older desktop calls rejected host-owned arguments before creating a desktop receipt or contacting the driver. */
export function rejectedDesktopCall(store:Pick<Store,'get'|'db'>,stateDir:string,run:Run){
 const proof=stoppedWorkerTool(store,stateDir,run,'superagent_desktop')
 if(!proof)return
 const input=proof.callback.args
 const parsed=z.object({action:z.literal('launch_app'),requestId:z.string().min(1),arguments:z.record(z.string(),z.unknown())}).strict().safeParse(input)
 if(!parsed.success||typeof parsed.data.arguments.session!=='string')return
 const actions=store.db.prepare(`SELECT body FROM records WHERE kind='chat-permission' AND json_extract(body,'$.actor.ticketId')=?
  AND json_extract(body,'$.tool')='superagent_desktop' AND json_extract(body,'$.phase')='uncertain'`).all(run.ticketId)
 if(actions.length!==1)return
 const action=JSON.parse(String(actions[0]!.body)) as PermissionAction
 if(!action?.id||!action.approved||action.receipt||!action.actor||action.actor.agentId||action.actor.workerId!==run.workerId||
    stableDigest(action.args)!==stableDigest(input)||action.facts?.action!=='launch_app'||
    !(proof.started<=action.createdAt&&action.createdAt<=proof.ended))return
 const receiptId=bodyDigest([run.ticketId,run.assignmentId,'',parsed.data.requestId])
 if(store.get('desktop-receipt',receiptId)!==undefined)return
 return {...proof,action}
}

export function proveInterruptedOpenCodeRead(store:Pick<ThreadStore,'get'>,stateDir:string,run:Run):InterruptedRead|undefined{
 if(run.phase!=='uncertain'&&!run.failure?.readOnlyHistory)return
 try{
  const bound=boundWorkerSession(store,stateDir,run)
  if(!bound)return
  const {thread,root,session,last}=bound
  const effects=new Set(thread.effectIds),turnIds=new Set<string>()
  if(effects.size!==thread.effectIds.length)return
  const interrupted:InterruptedCallback[]=[]
  let lastBatchCalls:ReturnType<typeof operations>=[]
  let nativeRead=false
  for(const turn of session.turns){
   if(turnIds.has(turn.id)||turn!==last&&turn.state!=='completed'||privateText(join(root,turn.id+'.ready'),32)!=='ready')return
   turnIds.add(turn.id)
   const journal=operations(root,turn.id)
   const nativeCalls=new Map(journal.map(op=>[op.id,op]))
   if(nativeCalls.size!==journal.length)return
   for(const call of turn.tools){
    if(call.name.startsWith('opencode/')){
     const tool=call.name.slice('opencode/'.length)
     if(!openCodeReadOnlyTools.has(tool)||nativeCalls.get(call.id)?.tool!==tool||!call.result)return
     nativeCalls.delete(call.id)
     continue
    }
    const id=stableDigest([thread.id,turn.id,call.id])
    const receipt=store.get<PluginToolEffect>('backend-plugin-tool',id)
    if(!effects.delete(id)||!receipt||receipt.fingerprint!==stableDigest([call.name,call.args]))return
    const read=call.name==='superagent_read'?readSchema.safeParse(call.args):undefined
    const githubResource=read?.success&&read.data.resource.startsWith('github/')
    if(!githubResource&&!(read?.success&&read.data.resource==='catalog')&&call.name!=='superagent_status'&&
     !(call.name==='github_read'&&githubReadSchema.safeParse(call.args).success))return
    if(turn===last&&call.name!=='superagent_status')nativeRead=true
    if(receipt.state==='complete'&&call.result&&receipt.result?.success===call.result.success)continue
    if(turn!==last||!githubResource&&call.name!=='github_read'||call.result||receipt.result!==undefined||
     receipt.state!=='running'||receipt.failure?.operation!=='tool'||receipt.failure.reason!=='exception')return
    interrupted.push({id,receipt})
   }
   if(nativeCalls.size&&(turn!==last||[...nativeCalls.values()].some(op=>!openCodeReadOnlyTools.has(op.tool)||op.tool==='webfetch_batch'&&!webBatchUrls(op.urls))))return
   if(turn===last){
    lastBatchCalls=journal.filter(op=>op.tool==='webfetch_batch'&&!!webBatchUrls(op.urls))
    nativeRead||=journal.some(op=>op.tool!=='webfetch_batch'&&openCodeReadOnlyTools.has(op.tool))
   }
  }
  if(effects.size||!stoppedWriter(root))return
  if(interrupted.length&&(last.state!=='interrupted'||thread.lastFailure?.code!=='outcome_unknown'))return
  if(lastBatchCalls.length){
   const callIds=lastBatchCalls.map(op=>op.id),batches=lastBatchCalls.map(op=>webBatchUrls(op.urls)!)
   const urls=[...new Set(batches.flat())]
   if(callIds.length>maxWebReplayPages||urls.length>maxWebReplayPages)return
   return {kind:'web_batch',replay:{threadId:thread.id,turnId:last.id,callId:callIds[0]!,...(callIds.length>1?{callIds}:{})},urls,batches,interrupted}
  }
  if(interrupted.length)return {kind:'github',interrupted}
  if(nativeRead)return {kind:'read_only'}
 }catch{
  // Older layouts, missing workspaces and incomplete or inconsistent evidence stay held.
  return
 }
}

const artifactReadArgs=z.object({id:z.string().min(1).max(1000)}).strict()

/** Prove one failed artifact open from the bundled adapter's private journal.
 * Host callbacks rejected after this failure can appear in history without a receipt.
 */
export function proveInterruptedArtifactRead(store:Pick<ThreadStore,'get'>,stateDir:string,run:Run):ArtifactReadProof|undefined{
 if(run.phase!=='uncertain'&&run.phase!=='idle')return
 try{
  const bound=boundWorkerSession(store,stateDir,run)
  if(!bound)return
  const {thread,root,session,last}=bound
  if(thread.state!=='failed'||thread.lastFailure?.code!=='outcome_unknown'||last.state!=='interrupted'||
   operations(root,last.id).length||privateText(join(root,last.id+'.ready'),32)!=='ready')return
  const remaining=new Set(thread.effectIds),turnIds=new Set<string>()
  if(remaining.size!==thread.effectIds.length)return
  let proof:ArtifactReadProof|undefined
  for(const turn of session.turns){
   if(turnIds.has(turn.id)||turn!==last&&turn.state!=='completed')return
   turnIds.add(turn.id)
   for(const call of turn.tools){
    if(call.name.startsWith('opencode/')){
     if(turn===last||!call.result)return
     continue
    }
    const receiptId=stableDigest([thread.id,turn.id,call.id])
    const receipt=store.get<ArtifactReadProof['receipt']>('backend-plugin-tool',receiptId)
    const scopedRead=call.name==='superagent_status'
     ||call.name==='superagent_read'&&readSchema.safeParse(call.args).success
     ||call.name==='chat_artifact_find'&&findChatArtifactInput.safeParse(call.args).success
    if(turn===last&&proof&&!receipt&&!call.result&&scopedRead&&!remaining.has(receiptId))continue
    if(!remaining.delete(receiptId)||!receipt||receipt.fingerprint!==stableDigest([call.name,call.args]))return
    if(turn===last&&(!scopedRead||proof)){
     const args=artifactReadArgs.safeParse(call.args)
     if(proof||call.name!=='superagent_artifact_read'||!args.success||call.result||
      receipt.failure?.operation!=='tool'||receipt.failure.reason!=='exception')return
     const marker=receipt.reconciliation
     if(run.phase==='uncertain'){
      if(receipt.state!=='running'||receipt.result!==undefined||marker)return
     }else if(receipt.state!=='complete'||receipt.result?.success!==false||marker?.reason!=='interrupted_artifact_read'||
      marker.ticketId!==run.ticketId||marker.assignmentId!==run.assignmentId||marker.threadId!==thread.id||marker.turnId!==turn.id)return
     proof={receiptId,artifactId:args.data.id,threadId:thread.id,turnId:turn.id,receipt}
     continue
    }
    if(receipt.state!=='complete'||!call.result||receipt.result?.success!==call.result.success)return
   }
  }
  if(!remaining.size&&stoppedWriter(root))return proof
 }catch{/* Missing or inconsistent evidence remains unsettled. */}
}
