import {createHash} from 'node:crypto'
import {constants,type BigIntStats} from 'node:fs'
import {open,realpath,lstat,type FileHandle} from 'node:fs/promises'
import {basename,join,resolve} from 'node:path'
import {z} from 'zod'
import type {WorkerAttempt,WorkerEventReceipt} from './async-worker-inbox.ts'
import type {ContextManifest} from './router-memory.ts'
import {chatDownloadMaxBytes} from './execution-limits.ts'
import {reportedFileVersions} from './chat-file-pickup.ts'
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
const artifactId=z.string().max(800).regex(/^(?:[a-f\d-]{36}(?:\.[a-f\d]{64})?|report\.[a-z0-9_-]+\.[a-f\d]{64})$/i)
export const findChatArtifactInput=z.object({query:z.string().trim().max(180).optional(),ticketId:z.string().min(1).max(200).optional()}).strict()
export const deliverChatArtifactInput=z.object({id:artifactId}).strict()

export const chatArtifactFind='chat_artifact_find'
export const chatArtifactDeliver='chat_artifact_deliver'
export const chatArtifactSpecs:ToolSpec[]=[
 {type:'function',name:chatArtifactFind,description:'Find already published files and verifiable candidates handed back by the requesting Chat’s original Worker. A worker-candidate is a draft, never acceptance evidence. Search by distinctive filename or platform, such as Windows, or the original task ID. Items include the ID needed to attach the original file. Check this before asking for a repeat upload or delegating retrieval of an existing file.',inputSchema:z.toJSONSchema(findChatArtifactInput,{target:'draft-7',io:'input'})},
 {type:'function',name:chatArtifactDeliver,description:'Attach the exact existing file returned by chat_artifact_find to the current private Chat. Use this when the human asks for that file and its version is clear. On success, point the user to the file card. If local is true, the card reveals the original in Finder on this Mac and offers Download separately.',inputSchema:z.toJSONSchema(deliverChatArtifactInput,{target:'draft-7',io:'input'})},
]

type Conversation={id:string;owner:string;project?:string;discussion:string;sourceId:string;actor:string}
type ChatRun={conversationId:string;cancelled?:boolean;cancelRequested?:boolean}
type Context={chat:Conversation;trigger:Trigger;scoped?:ScopeContext}
type Delivery=ChatDelivery&{published?:boolean;originalPath?:string}
type Transcript={ticketId:string;turnId:string;text:string;status?:string}
type Item={id:string;name:string;size:number;sha256?:string;ticketId?:string;kind?:string}
type Candidate={item:Item;delivery?:Delivery;savedCopy?:boolean;original?:{ticketId:string;path:string;sha256:string}}
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
  const run=store.get<Run>('run',ticketId)
  if(run&&this.host.memory.cleanup.blocked('run',ticketId,run))return false
  const source=run?.workspaceSource
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
  if(!chat||!Number.isSafeInteger(delivery.size)||delivery.size<0||delivery.size>chatDownloadMaxBytes||!delivery.mime||delivery.retained||this.host.memory.cleanup.blocked('chat-delivery',delivery.id,delivery))return []
  if(delivery.ticketId){
   if(!this.taskAllowed(c,chat,delivery.ticketId))return []
  }else{
   if(!delivery.runId||this.host.store.get<ChatRun>('chat-run',delivery.runId)?.conversationId!==chat.id)return []
   try{this.host.routerIngress.authority(delivery.runId,chat.discussion)}catch{return []}
  }
  let candidateOnly=false
  if(!delivery.published){
   // Only drafts the owner can already download through independent acceptance may be picked up.
   if(chat.id!==c.chat.id||!delivery.ticketId)return []
   const goal=this.host.goals.forTask(delivery.ticketId)
   if(!goal||this.host.chat.reviewableFile(chat.id,chat.owner,goal.id,delivery.id)!==delivery.ticketId)return []
   candidateOnly=true
  }
  const candidates:Candidate[]=[{delivery,item:{id:delivery.id,name:delivery.name,size:delivery.size,ticketId:delivery.ticketId,...(candidateOnly?{kind:'worker-candidate'}:{})}}]
  if(delivery.ticketId&&delivery.originalPath&&validRetainedPath(delivery.originalPath)&&delivery.sha256&&hash.safeParse(delivery.sha256).success){
   const candidate=candidates[0]!
   candidate.original={ticketId:delivery.ticketId,path:delivery.originalPath,sha256:delivery.sha256}
   candidate.item.sha256=delivery.sha256
   candidate.savedCopy=true
  }
  if(candidateOnly||!delivery.ticketId||!delivery.name.toLowerCase().endsWith('.json')||delivery.size>maxManifestBytes)return candidates
  const row=this.host.store.db.prepare('SELECT bytes FROM chat_delivery_bytes WHERE id=? AND length(bytes)<=?').get(delivery.id,maxManifestBytes)
  if(!row)return candidates
  let value:unknown
  try{value=JSON.parse(Buffer.from(row.bytes as Uint8Array).toString('utf8'))}catch{return candidates}
  const manifest=manifestSchema.safeParse(value)
  if(!manifest.success||!this.taskAllowed(c,chat,manifest.data.sourceTicketId,true))return candidates
  for(const file of manifest.data.artifacts){
   if(file.bytes>chatDownloadMaxBytes)continue
   const sha256=file.sha256.toLowerCase(),ticketId=manifest.data.sourceTicketId
   const id=delivery.id+'.'+stableDigest([ticketId,file.originalRelativePath,sha256,file.bytes])
   candidates.push({delivery,original:{ticketId,path:file.originalRelativePath,sha256},
    item:{id,name:basename(file.originalRelativePath),size:file.bytes,sha256,ticketId,kind:file.kind}})
  }
  return candidates
 }

 private reported(c:Context,transcript:Transcript):Candidate[]{
  const {ticketId,turnId,text,status}=transcript,store=this.host.store
  if(status==='stale'||!text||!turnId)return []
  const versions=reportedFileVersions(text).filter(v=>validRetainedPath(v.path)&&v.bytes<=chatDownloadMaxBytes)
  if(!versions.length||!this.taskAllowed(c,c.chat,ticketId)||store.get<Run>('run',ticketId)?.phase==='human'||
   this.host.memory.cleanup.blocked('transcript',turnId,transcript))return []
  const row=store.db.prepare(`SELECT body FROM records WHERE kind='async-worker-event' AND json_extract(body,'$.ticketId')=?
    AND json_extract(body,'$.kind')='result' AND json_extract(body,'$.nativeTurnDigest')=?`).get(ticketId,stableDigest(turnId))
  if(!row)return []
  const receipt:WorkerEventReceipt=JSON.parse(String(row.body)),attempt=store.get<WorkerAttempt>('async-worker-attempt',receipt.attemptId)
  // A historical delivery can outlive its Worker assignment. Its source and current read authority must both survive.
  if(!attempt||attempt.ticketId!==ticketId||attempt.assignmentId!==receipt.assignmentId||receipt.disposition!=='applied'||
   receipt.source!=='host_worker_report'||receipt.payloadDigest!==stableDigest(text)||store.get('async-worker-revoked',receipt.attemptId)||
   this.host.memory.cleanup.blocked('async-worker-event',receipt.id,receipt)||
   stableDigest(attempt.basis)!==stableDigest(receipt.basis)||store.get<{eventId:string}>('async-worker-terminal',receipt.attemptId)?.eventId!==receipt.id)return []
  const correctionKey=ticketId+':'+receipt.assignmentId
  const correction=store.get<{ticketId:string;assignmentId:string;eventId?:string}>('chat-file-correction',correctionKey)
  if(!correction||correction.ticketId!==ticketId||correction.assignmentId!==receipt.assignmentId||
   this.host.memory.cleanup.blocked('chat-file-correction',correctionKey,correction))return []
  // Legacy capture wrote its correction and terminal event in the same transaction. Only recover an
  // unambiguous adjacent pair corroborated by the host's dated capture-error note on this ticket.
  if(correction.eventId?correction.eventId!==receipt.id:
    !(store.db.prepare(`SELECT 1 FROM records c JOIN records e ON e.rowid=c.rowid+1 WHERE
       c.kind='chat-file-correction' AND c.id=? AND e.kind='async-worker-event' AND e.id=?`).get(correctionKey,receipt.id)&&
      store.tickets.get(ticketId)?.inputs.some(i=>i.kind==='note'&&i.text.startsWith('File delivery failed:')&&Date.parse(i.at)>=receipt.observedAt)))return []
  const owner=this.host.scopes.ownership(ticketId)
  if((owner?.ownerEpoch??null)!==receipt.basis.ownerEpoch)return []
  const goal=receipt.basis.goalId?this.host.goals.get(receipt.basis.goalId):undefined
  if(receipt.basis.goalId&&(!goal||goal.supersededBy||goal.cancelledByUser||!goal.taskIds.includes(ticketId)||
    this.host.memory.cleanup.blocked('router-goal',goal.id,goal)||stableDigest(goal.contract)!==receipt.basis.contractDigest))return []
  const context=store.get<{manifest:ContextManifest}>('task-context',ticketId)
  try{if(context)this.host.memory.validate(context.manifest)}catch{return []}
  const prefix='report.'+Buffer.from(turnId).toString('base64url')+'.'
  return versions.map(v=>({item:{id:prefix+stableDigest([ticketId,v.path,v.sha256,v.bytes]),name:v.name,size:v.bytes,sha256:v.sha256,ticketId,kind:'worker-candidate'},
   original:{ticketId,path:v.path,sha256:v.sha256}}))
 }

 find(triggerId:string,input:unknown,currentChatOnly=false){
  const maxItems=currentChatOnly?maxCatalogRows:20
  const {query,ticketId}=findChatArtifactInput.parse(input),c=this.context(triggerId)
  const store=this.host.store,terms=words(query??'')
  const rows=store.db.prepare(`SELECT r.body FROM records r
   WHERE r.kind='chat-delivery' AND json_type(r.body,'$.retained') IS NULL
   AND (json_extract(r.body,'$.published')=1 OR (json_extract(r.body,'$.conversationId')=? AND json_extract(r.body,'$.published')=0 AND EXISTS (
     SELECT 1 FROM records proposal WHERE proposal.kind='goal-delivery' AND proposal.id=json_extract(r.body,'$.ticketId'))))
   AND (json_extract(r.body,'$.conversationId')=? OR (? IS NOT NULL AND EXISTS (
    SELECT 1 FROM records chat WHERE chat.kind='chat-conversation' AND chat.id=json_extract(r.body,'$.conversationId')
    AND json_extract(chat.body,'$.owner')=? AND json_extract(chat.body,'$.project')=?)))
   ORDER BY json_extract(r.body,'$.conversationId')=? DESC,r.rowid DESC LIMIT ?`)
   .all(c.chat.id,c.chat.id,!currentChatOnly&&c.scoped?c.chat.project??null:null,c.chat.owner,c.chat.project??null,c.chat.id,maxCatalogRows+1)
  // Search declared outputs of failed handbacks in this conversation, never enumerate workspace directories.
  const reports=store.db.prepare(`SELECT t.body FROM records t JOIN records a
   ON a.kind='worker-assignment' AND a.id=json_extract(t.body,'$.ticketId')
   WHERE t.kind='transcript' AND json_extract(a.body,'$.discussion')=? AND (? IS NULL OR a.id=?)
   AND json_type(t.body,'$.status') IS NULL AND CASE WHEN json_valid(json_extract(t.body,'$.text')) THEN
     json_extract(json_extract(t.body,'$.text'),'$.state')='ready' AND json_array_length(json_extract(t.body,'$.text'),'$.files')>0 ELSE 0 END
   AND EXISTS (SELECT 1 FROM records f WHERE f.kind='chat-file-correction' AND f.id GLOB a.id||':*')
   ORDER BY t.rowid DESC LIMIT ?`).all(c.chat.discussion,ticketId??null,ticketId??null,maxCatalogRows+1)
  const seen=new Set<string>(),items:Item[]=[]
  let more=rows.length>maxCatalogRows||reports.length>maxCatalogRows
  const add=({item,original,delivery}:Candidate)=>{
   if(ticketId&&item.ticketId!==ticketId&&delivery?.ticketId!==ticketId)return
   const label=words([item.name,item.kind,original?.path].filter(Boolean).join(' ')).join(' ')
   if(terms.some(term=>!label.includes(term)))return
   const fingerprint=original?stableDigest([original.ticketId,original.path,original.sha256]):item.id
   if(seen.has(fingerprint))return
   if(items.length===maxItems){more=true;return}
   seen.add(fingerprint);items.push(item)
  }
  for(const row of rows.slice(0,maxCatalogRows))for(const candidate of this.candidates(c,JSON.parse(String(row.body))))add(candidate)
  for(const row of reports.slice(0,maxCatalogRows))for(const candidate of this.reported(c,JSON.parse(String(row.body))))add(candidate)
  return {items,more}
 }

 private resolve(triggerId:string,id:string){
  const c=this.context(triggerId),[deliveryId,turn]=artifactId.parse(id).split('.')
  let candidates:Candidate[]=[]
  if(deliveryId==='report'&&turn){
   const transcript=this.host.store.get<Transcript>('transcript',Buffer.from(turn,'base64url').toString())
   if(transcript)candidates=this.reported(c,transcript)
  }else{
   const delivery=this.host.store.get<Delivery>('chat-delivery',deliveryId!)
   if(delivery)candidates=this.candidates(c,delivery)
  }
  const candidate=candidates.find(r=>r.item.id===id)
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
  if(!candidate.delivery)throw unavailable()
  const row=this.host.store.db.prepare('SELECT bytes FROM chat_delivery_bytes WHERE id=? AND length(bytes)=?')
   .get(candidate.delivery.id,candidate.item.size)
  if(!row)throw unavailable()
  return row.bytes as Uint8Array
 }

 async prepare(triggerId:string,id:string,signal?:AbortSignal){
  const candidate=this.resolve(triggerId,id)
  let reference:RetainedChatFile
  if(candidate.original){
   try{
    const source=await this.file(candidate)
    try{
     const digest=createHash('sha256')
     for await(const bytes of source.handle.createReadStream({autoClose:false,signal}))digest.update(bytes)
     await source.verify()
     const sha256=digest.digest('hex')
     if(sha256!==candidate.original.sha256)throw unavailable()
     reference={id,sha256,signature:source.signature}
    }finally{await source.handle.close().catch(()=>{})}
   }catch{
    signal?.throwIfAborted()
    if(!candidate.savedCopy)throw unavailable()
    const sha256=createHash('sha256').update(this.bytes(candidate)).digest('hex')
    if(sha256!==candidate.original.sha256)throw unavailable()
    reference={id,sha256}
   }
  }else {
   reference={id,sha256:createHash('sha256').update(this.bytes(candidate)).digest('hex')}
  }
  signal?.throwIfAborted()
  this.resolve(triggerId,id)
  return {reference,item:candidate.item,local:!!reference.signature}
 }

 async access(triggerId:string,reference:RetainedChatFile){
  const candidate=this.resolve(triggerId,reference.id)
  if(candidate.original&&(reference.signature||!candidate.savedCopy)){
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
