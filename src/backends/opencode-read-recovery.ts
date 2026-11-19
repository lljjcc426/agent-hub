import {createHash} from 'node:crypto'
import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,realpathSync,statSync} from 'node:fs'
import {join} from 'node:path'
import {z} from 'zod'
import {maxWireBytes} from '../execution-limits.ts'
import {githubReadSchema} from '../github-read.ts'
import {readSchema} from '../resources.ts'
import {stableDigest} from '../sources.ts'
import type {Run} from '../store.ts'
import type {ThreadStore} from './api.ts'
import {bundledEngineId} from './bundled-opencode.ts'
import type {PluginThread,PluginToolEffect} from './plugin-process.ts'

const uuid=z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/)
const callId=z.string().min(1).max(1000)
const resultSchema=z.object({success:z.boolean()})
const operationSchema=z.object({id:callId,tool:z.string(),path:z.string().optional()}).strict()
const sessionSchema=z.object({
 format:z.literal(1),folder:uuid,nativeId:callId,cwd:z.string(),
 turns:z.array(z.object({
  id:uuid,state:z.enum(['completed','interrupted']),
  tools:z.array(z.object({id:callId,name:z.string(),args:z.json(),result:resultSchema.optional()})),
 })).nonempty(),
})
const nativeReads=new Set(['read','glob','grep','websearch','webfetch','webfetch_batch'])

function privateText(path:string,limit=maxWireBytes){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
 try{
  const stat=fstatSync(fd)
  if(!stat.isFile()||stat.nlink!==1||stat.size>limit)throw Error('Invalid OpenCode recovery record')
  return readFileSync(fd,'utf8')
 }finally{closeSync(fd)}
}

/** Match the interrupted bridge call to the host's receipt and account for every native operation.
 * The adapter's writer lock and private journal belong to the old session, whose contents are retained.
 */
export function proveInterruptedGithubRead(store:Pick<ThreadStore,'get'>,stateDir:string,run:Run){
 if(run.phase!=='uncertain'||!run.prepared||!run.threadId||!run.turnId||!run.backendId)return
 const thread=store.get<PluginThread>('backend-plugin-thread',run.threadId)
 const binding=store.get<{id:string;harness?:string;harnessDigest?:string}>('backend-binding',run.threadId)
 const model=store.get<{ticketId?:string;threadId:string;cwd:string;ephemeral:boolean}>('model-session',run.threadId)
 if(!thread||thread.id!==run.threadId||thread.turnId!==run.turnId||thread.state!=='failed'||thread.lastFailure?.code!=='outcome_unknown'||
  thread.pluginId!=='opencode-cli'||thread.stateVersion!==1||thread.backendId!==run.backendId||
  binding?.harness!==bundledEngineId||binding.id!==thread.backendId||binding.harnessDigest!==thread.digest||
  model?.ticketId!==run.ticketId||model.threadId!==run.threadId||model.cwd!==run.cwd||model.ephemeral!==false||
  !thread.nativeId||!/^[a-z0-9][a-z0-9._-]*$/i.test(thread.backendId)||!/^[a-f0-9]{64}$/.test(thread.identity))return

 try{
  if(realpathSync(run.cwd)!==thread.cwd||!statSync(run.cwd).isDirectory())return
  const data=join(realpathSync(stateDir),'backend-plugin-data',thread.backendId,thread.identity,'threads',stableDigest(thread.id))
  const index=join(data,'index')
  if(realpathSync(index)!==index)return
  const nativeKey=createHash('sha256').update(thread.nativeId).digest('hex')
  const mapping=z.object({id:callId,folder:uuid}).strict().parse(JSON.parse(privateText(join(index,nativeKey+'.json'),4096)))
  if(mapping.id!==thread.nativeId)return
  const root=join(data,'sessions',mapping.folder),writer=join(root,'writer.lock')
  if(realpathSync(root)!==root||lstatSync(writer,{throwIfNoEntry:false}))return
  const session=sessionSchema.parse(JSON.parse(privateText(join(root,'session.json'))))
  const last=session.turns.at(-1)!
  if(session.folder!==mapping.folder||session.nativeId!==thread.nativeId||session.cwd!==thread.cwd||
   last.id!==run.turnId||last.state!=='interrupted')return
  const effects=new Set(thread.effectIds),turnIds=new Set<string>()
  if(effects.size!==thread.effectIds.length)return
  let interrupted:{id:string;receipt:PluginToolEffect}|undefined
  for(const turn of session.turns){
   if(turnIds.has(turn.id)||turn!==last&&turn.state!=='completed'||privateText(join(root,turn.id+'.ready'),32)!=='ready')return
   turnIds.add(turn.id)
   const journal=join(root,turn.id+'.operations')
   const operations=lstatSync(journal,{throwIfNoEntry:false})
    ? privateText(journal).trim().split('\n').filter(Boolean).map(line=>operationSchema.parse(JSON.parse(line)))
    : []
   const nativeCalls=new Map(operations.map(op=>[op.id,op.tool]))
   if(nativeCalls.size!==operations.length)return
   for(const call of turn.tools){
    if(call.name.startsWith('opencode/')){
     const tool=call.name.slice('opencode/'.length)
     if(!nativeReads.has(tool)||nativeCalls.get(call.id)!==tool||!call.result)return
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
    if(receipt.state==='complete'&&call.result&&receipt.result?.success===call.result.success)continue
    if(turn!==last||interrupted||!githubResource||call.result||receipt.result!==undefined||
     receipt.state!=='running'||receipt.failure?.operation!=='tool'||receipt.failure.reason!=='exception')return
    interrupted={id,receipt}
   }
   if(nativeCalls.size)return
  }
  if(!interrupted||effects.size||lstatSync(writer,{throwIfNoEntry:false}))return
  return {thread,interrupted}
 }catch{
  // Older layouts, missing workspaces and incomplete or inconsistent evidence stay held.
  return
 }
}
