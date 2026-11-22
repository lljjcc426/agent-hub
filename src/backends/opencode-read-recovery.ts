import {createHash} from 'node:crypto'
import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,realpathSync,statSync} from 'node:fs'
import {join} from 'node:path'
import {z} from 'zod'
import {maxWireBytes,toolParallelism} from '../execution-limits.ts'
import {githubReadSchema} from '../github-read.ts'
import {readSchema} from '../resources.ts'
import {stableDigest} from '../sources.ts'
import type {Run,Store} from '../store.ts'
import type {ThreadStore} from './api.ts'
import {bundledEngineId} from './bundled-opencode.ts'
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
type GithubRead={id:string;receipt:PluginToolEffect}
type InterruptedRead={kind:'github';interrupted:GithubRead[]}
 |{kind:'web_batch';replay:WebBatchReplay;urls:string[];batches:string[][];interrupted:GithubRead[]}
 |{kind:'read_only'}

type RouterReadCall={name:string;args:unknown;receiptId:string;receipt:PluginToolEffect}
export type InterruptedRouterTurn=
 |{kind:'read_only';threadId:string;turnId:string;reads:RouterReadCall[]}
 |{kind:'unverified';threadId:string;turnId:string;tool?:string;receiptId?:string}

function isRouterRead(name:string,args:unknown){
 const action=(args as {action?:unknown}|null)?.action
 switch(name){
  case 'router_read':return readSchema.safeParse(args).success
  case 'github_read':return githubReadSchema.safeParse(args).success
  case 'worker_manage':return action==='list'
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

function stoppedWriter(root:string){
 const path=join(root,'writer.lock')
 if(!lstatSync(path,{throwIfNoEntry:false}))return true
 const pid=Number(privateText(path,32))
 if(!Number.isSafeInteger(pid)||pid<2)return false
 try{process.kill(pid,0);return false}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH'}
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
  return settled?.reason==='interrupted_github_read_failed'&&settled.ticketId===run.ticketId&&settled.threadId===id&&settled.turnId===previous.turnId
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
 if(!thread||thread.state==='completed'||!thread.turnId)return
 const binding=store.get<{id:string;harness?:string;harnessDigest?:string}>('backend-binding',owner.threadId)
 const model=store.get<{threadId:string;cwd:string;ephemeral:boolean;triggerId:string;sourceId:string;scopeId:string;contextId:string;ticketId?:string}>('model-session',owner.threadId)
 if(thread.id!==owner.threadId||thread.pluginId!=='opencode-cli'||thread.stateVersion!==1||binding?.harness!==bundledEngineId||
  binding.id!==thread.backendId||binding.harnessDigest!==thread.digest||model?.threadId!==thread.id||
  model.ticketId||model.ephemeral!==false||model.triggerId!==owner.triggerId||model.sourceId!==owner.sourceId||
  model.scopeId!==owner.scopeId||model.contextId!==owner.contextId)return
 const unverified:InterruptedRouterTurn={kind:'unverified',threadId:thread.id,turnId:thread.turnId}
 try{
  if(realpathSync(owner.cwd)!==thread.cwd||realpathSync(model.cwd)!==thread.cwd)return unverified
  const location=sessionRoot(stateDir,thread)
  if(!location||!stoppedWriter(location.root))return unverified
  const {root,folder}=location
  const session=sessionSchema.parse(JSON.parse(privateText(join(root,'session.json'))))
  const last=session.turns.at(-1)!
  if(session.folder!==folder||session.nativeId!==thread.nativeId||session.cwd!==thread.cwd||
   last.id!==thread.turnId)return unverified
  if(last.state==='completed')return
  const journal=operations(root,last.id)
  if(!last.tools.length&&!journal.length&&(thread.effectIds.length===0||thread.lastFailure?.diagnostic?.effectFree))return
  if(last.nativeToolsDisabled?journal.length>0:privateText(join(root,last.id+'.ready'),32)!=='ready')return unverified
  const failed=thread.lastFailure
  if(thread.state==='failed'&&!['outcome_unknown','process_failed','transient'].includes(failed?.code??'')&&!failed?.diagnostic?.readOnlyHistory)return unverified
  const unsafe=journal.find(op=>!openCodeReadOnlyTools.has(op.tool))
  if(unsafe)return {...unverified,tool:'opencode/'+unsafe.tool,receiptId:unsafe.id}
  const nativeCalls=new Map(journal.map(op=>[op.id,op.tool]))
  if(nativeCalls.size!==journal.length)return unverified
  const effects=new Set(thread.effectIds),turns=new Set<string>(),reads:RouterReadCall[]=[]
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
    const evidence={...unverified,tool:call.name,receiptId:id}
    if(!effects.delete(id)||!receipt||receipt.fingerprint!==stableDigest([call.name,call.args]))return evidence
    if(turn!==last){
     if(receipt.state!=='complete'||!call.result)return evidence
     continue
    }
    if(!isRouterRead(call.name,call.args))return evidence
    if(receipt.state==='complete'&&!receipt.result||receipt.state==='running'&&(call.result||receipt.result))return evidence
    reads.push({name:call.name,args:call.args,receiptId:id,receipt})
   }
  }
  if(effects.size||!stoppedWriter(root))return unverified
  return {kind:'read_only',threadId:thread.id,turnId:last.id,reads}
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
export function proveInterruptedOpenCodeRead(store:Pick<ThreadStore,'get'>,stateDir:string,run:Run):InterruptedRead|undefined{
 if(run.phase!=='uncertain'&&!run.failure?.readOnlyHistory||!run.prepared||!run.threadId||!run.turnId||!run.backendId)return
 const thread=store.get<PluginThread>('backend-plugin-thread',run.threadId)
 const binding=store.get<{id:string;harness?:string;harnessDigest?:string}>('backend-binding',run.threadId)
 const model=store.get<{ticketId?:string;threadId:string;cwd:string;ephemeral:boolean}>('model-session',run.threadId)
 if(!thread||thread.id!==run.threadId||thread.turnId!==run.turnId||thread.state==='completed'||
  thread.state==='failed'&&(!thread.lastFailure||!['outcome_unknown','process_failed','transient'].includes(thread.lastFailure.code)&&!thread.lastFailure.diagnostic?.readOnlyHistory)||
  thread.pluginId!=='opencode-cli'||thread.stateVersion!==1||thread.backendId!==run.backendId||
  binding?.harness!==bundledEngineId||binding.id!==thread.backendId||binding.harnessDigest!==thread.digest||
  model?.ticketId!==run.ticketId||model.threadId!==run.threadId||model.cwd!==run.cwd||model.ephemeral!==false)return

 try{
  if(realpathSync(run.cwd)!==thread.cwd||!statSync(run.cwd).isDirectory())return
  const location=sessionRoot(stateDir,thread)
  if(!location||!stoppedWriter(location.root))return
  const {root,folder}=location
  const session=sessionSchema.parse(JSON.parse(privateText(join(root,'session.json'))))
  const last=session.turns.at(-1)!
  if(session.folder!==folder||session.nativeId!==thread.nativeId||session.cwd!==thread.cwd||
   last.id!==run.turnId||last.state==='completed')return
  const effects=new Set(thread.effectIds),turnIds=new Set<string>()
  if(effects.size!==thread.effectIds.length)return
  const interrupted:GithubRead[]=[]
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
