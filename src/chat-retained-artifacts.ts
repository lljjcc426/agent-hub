import {createHash} from 'node:crypto'
import {constants,type BigIntStats} from 'node:fs'
import {open,realpath,lstat,type FileHandle} from 'node:fs/promises'
import {basename,join,resolve} from 'node:path'
import {z} from 'zod'
import type {Runtime} from './runtime.ts'
import type {Run} from './store.ts'
import type {ChatDelivery} from './chat-deliveries.ts'
import {ChatError} from './chat-errors.ts'
import {stableDigest} from './sources.ts'
import {managedWorkspacePath} from './workspace.ts'
import {projectWorkspace} from './project-code.ts'
import {isHostPrivateFile} from './private-files.ts'
import {validRetainedPath} from './chat-file-handoff.ts'
import type {ScopeContext} from './router-scope.ts'
import {type Trigger} from './vendor/dsh-core/index.ts'
import type {ToolSpec} from './model.ts'

const hash=z.string().regex(/^[a-f\d]{64}$/i)
const manifestSchema=z.object({
 sourceTicketId:z.string().min(1).max(200),
 artifacts:z.array(z.object({
  originalRelativePath:z.string().refine(validRetainedPath),bytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256:hash,kind:z.string().max(120).optional(),
 })).max(128),
})
const maxManifestBytes=1024*1024
const maxCatalogRows=240
const artifactId=z.string().regex(/^[a-f\d-]{36}(?:\.[a-f\d]{64})?$/i)
export const findChatArtifactInput=z.object({query:z.string().trim().max(180).optional(),ticketId:z.string().min(1).max(200).optional()}).strict()
export const deliverChatArtifactInput=z.object({id:artifactId}).strict()

export const chatArtifactFind='chat_artifact_find'
export const chatArtifactDeliver='chat_artifact_deliver'
export const chatArtifactSpecs:ToolSpec[]=[
 {type:'function',name:chatArtifactFind,description:'Find existing files already available to the requesting Chat. Search by distinctive filename or platform, such as Windows, or the original task ID. Items include the ID needed to attach the original file. Check this before asking for a repeat upload or delegating retrieval of an existing file.',inputSchema:z.toJSONSchema(findChatArtifactInput,{target:'draft-7',io:'input'})},
 {type:'function',name:chatArtifactDeliver,description:'Attach the exact existing file returned by chat_artifact_find to the current private Chat. Use this when the human asks for that file and its version is clear. On success, point the user to the file card. If local is true, the card reveals the original in Finder on this Mac and offers Download separately.',inputSchema:z.toJSONSchema(deliverChatArtifactInput,{target:'draft-7',io:'input'})},
]

type Conversation={id:string;owner:string;project?:string;discussion:string;sourceId:string;actor:string}
type ChatRun={conversationId:string;cancelled?:boolean;cancelRequested?:boolean}
type Context={chat:Conversation;trigger:Trigger;scoped?:ScopeContext}
type Delivery=ChatDelivery&{published?:boolean}
type Item={id:string;name:string;size:number;sha256?:string;ticketId?:string;kind?:string}
type Candidate={item:Item;delivery:Delivery;original?:{ticketId:string;path:string;sha256:string}}
export type RetainedChatFile={id:string;signature?:string;sha256:string}

const unavailable=()=>new ChatError('artifact_unavailable','The file is unavailable in this Chat.',404)
const signature=(stat:BigIntStats)=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':')
const words=(value:string)=>value.normalize('NFKC').toLowerCase().match(/\p{Script=Han}+|[\p{L}\d]+/gu)??[]

export class ChatRetainedArtifacts {
 constructor(private host:Runtime){}

 private context(triggerId:string):Context {
  const store=this.host.store,trigger=store.triggers.get(triggerId),run=store.get<ChatRun>('chat-run',triggerId)
  const chat=run&&store.get<Conversation>('chat-conversation',run.conversationId)
  if(!trigger?.human||!run||run.cancelled||run.cancelRequested||!chat||chat.sourceId!==trigger.source||chat.actor!==trigger.actor.id||
   this.host.memory.cleanup.blocked('chat-conversation',chat.id,chat))throw unavailable()
  try{
   this.host.routerIngress.authority(triggerId,chat.discussion)
   const scoped=this.host.scopes.context(trigger,chat.discussion)
   if(scoped)this.host.scopes.assertCurrent(scoped)
   else if(this.host.scopes.enabled())throw unavailable()
   return {chat,trigger,scoped}
  }catch{throw unavailable()}
 }

 private sourceChat(c:Context,id:string){
  const chat=this.host.store.get<Conversation>('chat-conversation',id)
  if(!chat||chat.owner!==c.chat.owner||chat.sourceId!==c.chat.sourceId||chat.actor!==c.chat.actor||
   (chat.id!==c.chat.id&&(!c.scoped||!chat.project||chat.project!==c.chat.project))||
   this.host.memory.cleanup.blocked('chat-conversation',id,chat))return
  return chat
 }

 private taskAllowed(c:Context,chat:Conversation,ticketId:string,closed=false){
  const store=this.host.store,ticket=store.tickets.get(ticketId),authority=this.host.taskAuthority(ticketId)
  if(!ticket||closed&&!ticket.ended||ticket.mandate.actor?.id!==c.trigger.actor.id||ticket.mandate.actor?.source!==c.trigger.actor.source||
   !authority?.parentTrigger||authority.discussion!==chat.discussion||
   store.get<ChatRun>('chat-run',authority.parentTrigger)?.conversationId!==chat.id||
   this.host.memory.cleanup.blocked('ticket',ticketId,ticket))return false
  const source=store.get<Run>('run',ticketId)?.workspaceSource
  if(source&&!c.scoped)return false
  try{
   this.host.routerIngress.authority(authority.parentTrigger,chat.discussion)
   if(c.scoped){
    this.host.scopes.checkTask(ticketId,c.scoped)
    this.host.scopes.checkTaskEntry(this.host.scopes.ownership(ticketId)!,c.scoped.route.entryId,'result')
    if(source)this.host.goals.checkWorkspaceSource(source,c.scoped)
   }
   return true
  }catch{return false}
 }

 private candidates(c:Context,delivery:Delivery):Candidate[]{
  const chat=this.sourceChat(c,delivery.conversationId)
  if(!chat||!delivery.published||!delivery.mime||delivery.retained||this.host.memory.cleanup.blocked('chat-delivery',delivery.id,delivery))return []
  if(delivery.ticketId){
   if(!this.taskAllowed(c,chat,delivery.ticketId))return []
  }else{
   if(!delivery.runId||this.host.store.get<ChatRun>('chat-run',delivery.runId)?.conversationId!==chat.id)return []
   try{this.host.routerIngress.authority(delivery.runId,chat.discussion)}catch{return []}
  }
  const candidates:Candidate[]=[{delivery,item:{id:delivery.id,name:delivery.name,size:delivery.size,ticketId:delivery.ticketId}}]
  if(!delivery.ticketId||!delivery.name.toLowerCase().endsWith('.json')||delivery.size>maxManifestBytes)return candidates
  const row=this.host.store.db.prepare('SELECT bytes FROM chat_delivery_bytes WHERE id=? AND length(bytes)<=?').get(delivery.id,maxManifestBytes)
  if(!row)return candidates
  let value:unknown
  try{value=JSON.parse(Buffer.from(row.bytes as Uint8Array).toString('utf8'))}catch{return candidates}
  const manifest=manifestSchema.safeParse(value)
  if(!manifest.success||!this.taskAllowed(c,chat,manifest.data.sourceTicketId,true))return candidates
  for(const file of manifest.data.artifacts){
   const sha256=file.sha256.toLowerCase(),ticketId=manifest.data.sourceTicketId
   const id=delivery.id+'.'+stableDigest([ticketId,file.originalRelativePath,sha256,file.bytes])
   candidates.push({delivery,original:{ticketId,path:file.originalRelativePath,sha256},
    item:{id,name:basename(file.originalRelativePath),size:file.bytes,sha256,ticketId,kind:file.kind}})
  }
  return candidates
 }

 find(triggerId:string,input:unknown){
  const {query,ticketId}=findChatArtifactInput.parse(input),c=this.context(triggerId)
  const terms=words(query??'')
  const rows=this.host.store.db.prepare(`SELECT r.body FROM records r
   WHERE r.kind='chat-delivery' AND json_extract(r.body,'$.published')=1 AND json_type(r.body,'$.retained') IS NULL
   AND (json_extract(r.body,'$.conversationId')=? OR (? IS NOT NULL AND EXISTS (
    SELECT 1 FROM records chat WHERE chat.kind='chat-conversation' AND chat.id=json_extract(r.body,'$.conversationId')
    AND json_extract(chat.body,'$.owner')=? AND json_extract(chat.body,'$.project')=?)))
   ORDER BY json_extract(r.body,'$.conversationId')=? DESC,r.rowid DESC LIMIT ?`)
   .all(c.chat.id,c.scoped?c.chat.project??null:null,c.chat.owner,c.chat.project??null,c.chat.id,maxCatalogRows+1)
  const seen=new Set<string>(),items:Item[]=[]
  let more=rows.length>maxCatalogRows
  for(const row of rows.slice(0,maxCatalogRows)){
   for(const {item,original,delivery} of this.candidates(c,JSON.parse(String(row.body)))){
    if(ticketId&&item.ticketId!==ticketId&&delivery.ticketId!==ticketId)continue
    const label=words([item.name,item.kind,original?.path].filter(Boolean).join(' ')).join(' ')
    if(terms.length&&terms.some(term=>!label.includes(term)))continue
    const fingerprint=original?stableDigest([original.ticketId,original.path,original.sha256]):item.id
    if(seen.has(fingerprint))continue
    if(items.length===20){more=true;break}
    seen.add(fingerprint);items.push(item)
   }
   if(items.length===20&&more)break
  }
  return {items,more}
 }

 private resolve(triggerId:string,id:string){
  const c=this.context(triggerId),[deliveryId]=artifactId.parse(id).split('.')
  const delivery=this.host.store.get<Delivery>('chat-delivery',deliveryId!)
  const candidate=delivery&&this.candidates(c,delivery).find(r=>r.item.id===id)
  if(!candidate)throw unavailable()
  return candidate
 }

 private async file(candidate:Candidate,wanted?:string){
  const source=candidate.original
  if(!source)throw unavailable()
  const run=this.host.store.get<Run>('run',source.ticketId),cwd=run?.cwd
  const state=this.host.config.stateDir
  if(!cwd||![managedWorkspacePath(state,run.workspaceId??source.ticketId),projectWorkspace(state,source.ticketId)].some(root=>resolve(root)===resolve(cwd)))throw unavailable()
  let descriptor:FileHandle|undefined
  try{
   const root=join(await realpath(state),'work',basename(cwd)),path=join(root,source.path)
   if(await realpath(cwd)!==root||await realpath(root)!==root)throw unavailable()
   if(isHostPrivateFile(path)||await realpath(path)!==path)throw unavailable()
   descriptor=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
   const handle=descriptor,stat=await handle.stat({bigint:true}),initial=signature(stat)
   if(!stat.isFile()||stat.nlink!==1n||stat.size!==BigInt(candidate.item.size)||wanted&&wanted!==initial)throw unavailable()
   const verify=async()=>{
    if(signature(await handle.stat({bigint:true}))!==initial||signature(await lstat(path,{bigint:true}))!==initial||
     await realpath(path)!==path)throw unavailable()
   }
   await verify()
   return {handle,path,verify,signature:initial}
  }catch{
   await descriptor?.close().catch(()=>{})
   throw unavailable()
  }
 }

 private bytes(candidate:Candidate){
  const row=this.host.store.db.prepare('SELECT bytes FROM chat_delivery_bytes WHERE id=? AND length(bytes)=?')
   .get(candidate.delivery.id,candidate.item.size)
  if(!row)throw unavailable()
  return row.bytes as Uint8Array
 }

 async prepare(triggerId:string,id:string,signal?:AbortSignal){
  const candidate=this.resolve(triggerId,id)
  let reference:RetainedChatFile
  if(candidate.original){
   const source=await this.file(candidate)
   try{
    const digest=createHash('sha256')
    for await(const bytes of source.handle.createReadStream({autoClose:false,signal}))digest.update(bytes)
    await source.verify()
    const sha256=digest.digest('hex')
    if(sha256!==candidate.original.sha256)throw unavailable()
    reference={id,sha256,signature:source.signature}
   }catch{
    signal?.throwIfAborted()
    throw unavailable()
   }finally{await source.handle.close().catch(()=>{})}
  }else {
   reference={id,sha256:createHash('sha256').update(this.bytes(candidate)).digest('hex')}
  }
  signal?.throwIfAborted()
  this.resolve(triggerId,id)
  return {reference,item:candidate.item,local:!!candidate.original}
 }

 async access(triggerId:string,reference:RetainedChatFile){
  const candidate=this.resolve(triggerId,reference.id)
  if(candidate.original){
   if(reference.sha256!==candidate.original.sha256||!reference.signature)throw unavailable()
   const file=await this.file(candidate,reference.signature)
   try{this.resolve(triggerId,reference.id);return {file} as const}
   catch(error){await file.handle.close().catch(()=>{});throw error}
  }
  const bytes=this.bytes(candidate)
  if(createHash('sha256').update(bytes).digest('hex')!==reference.sha256)throw unavailable()
  return {bytes} as const
 }
}
