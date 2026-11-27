import {chatUploadLimits,maxInlineImageBytes} from './execution-limits.ts'
import {createHash} from 'node:crypto'
import {attachmentArtifactRegistration,type ArtifactRegistration} from './artifact-registry.ts'
import type {ChatArtifactReference} from './artifact-reference.ts'
import {constants,closeSync,fstatSync,openSync,readSync,createWriteStream,copyFileSync,mkdirSync,readFileSync,rmSync} from 'node:fs'
import {dirname,extname,join} from 'node:path'
import {pipeline} from 'node:stream/promises'
import type {Runtime} from './runtime.ts'
import {ChatError} from './chat-errors.ts'
import {stableDigest} from './sources.ts'
import {imagePreviewMime} from './chat-images.ts'

export {chatUploadLimits} from './execution-limits.ts'
export interface ChatAttachment {id:string;name:string;mimeType:string;bytes:number;url:string;previewUrl?:string;reference?:ChatArtifactReference;registration?:Extract<ArtifactRegistration,{kind:'chat-attachment'}>}
interface Upload {id:string;kind:'chat-upload';conversationId:string;name:string;mimeType:string;bytes:number;path:string;createdAt:number;state:'uploading'|'ready';triggerId?:string;previewType?:string;sha256?:string}
interface Conversation {id:string;owner:string;discussion:string;archived:boolean}

export class ChatAttachments {
  constructor(private host:Runtime,private conversation:(id:string,owner:string)=>Conversation){
    for(const row of host.store.list<Upload>('asset'))if(row.kind==='chat-upload'&&row.state==='uploading')this.discard(row)
  }
  private discard(row:Upload){rmSync(dirname(row.path),{recursive:true,force:true});this.host.store.db.prepare("DELETE FROM records WHERE kind='asset' AND id=?").run(row.id)}
  private public(row:Upload,includeRegistration=false):ChatAttachment {
    const url='/api/chat/conversations/'+row.conversationId+'/attachments/'+row.id
    const reference:ChatArtifactReference={schema:1,kind:'chat-attachment',id:row.sha256?stableDigest(['chat-attachment-version',row.id,row.sha256]):row.id,version:row.sha256?1:null,sha256:row.sha256??null,visibility:'conversation',retention:'subject_to_history_cleanup',publication:'not_tracked'}
    const candidate=includeRegistration?attachmentArtifactRegistration(reference,{conversationId:row.conversationId,uploadId:row.id}):null
    const registration=candidate?.kind==='chat-attachment'?candidate:undefined
    return {reference,...(registration?{registration}:{}),id:row.id,name:row.name,mimeType:row.mimeType,bytes:row.bytes,url,...(row.previewType?{previewUrl:url+'?preview=1'}:{})}
  }
  private row(id:string,conversationId:string){
    const row=this.host.store.get<Upload>('asset',id)
    if(row?.kind!=='chat-upload'||row.conversationId!==conversationId||row.state!=='ready'||this.host.memory.cleanup.blocked('asset',id,row))throw new ChatError('attachment_missing','File not found.',404)
    return row
  }
  drafts(id:string,owner:string){
    this.conversation(id,owner)
    return this.host.store.list<Upload>('asset').filter(row=>row.kind==='chat-upload'&&row.conversationId===id&&row.state==='ready'&&!row.triggerId&&!this.host.memory.cleanup.blocked('asset',row.id,row)).map(row=>this.public(row,true))
  }
  async upload(conversationId:string,owner:string,id:string,input:{name:string;mimeType:string},body:AsyncIterable<Uint8Array>,authorize:()=>void=()=>{}){
    const conversation=this.conversation(conversationId,owner)
    if(conversation.archived)throw new ChatError('conversation_archived','Restore this conversation before uploading.')
    const drafts=this.host.store.list<Upload>('asset').filter(row=>row.kind==='chat-upload'&&row.conversationId===conversationId&&!row.triggerId)
    if(drafts.length>=chatUploadLimits.maxFiles)throw new ChatError('attachment_limit','Send or remove existing files first.',413)
    if(this.host.store.get('asset',id))throw new ChatError('attachment_conflict','Upload identity already exists.')
    const directory=join(this.host.config.stateDir,'assets',id),path=join(directory,'upload'+extname(input.name).replace(/[^.a-z0-9]/gi,'').slice(0,20))
    const row:Upload={id,kind:'chat-upload',conversationId,name:input.name,mimeType:input.mimeType,bytes:0,path,createdAt:Date.now(),state:'uploading'}
    mkdirSync(directory,{recursive:true,mode:0o700});this.host.store.put('asset',id,row)
    const hash=createHash('sha256'),header=Buffer.alloc(12)
    let headerBytes=0
    try{
      // Open before the producer starts so a rejected stream cannot race file creation during cleanup.
      const output=createWriteStream(path,{fd:openSync(path,'wx',0o600),autoClose:true})
      await pipeline(body,async function*(source){
        for await(const chunk of source){
          row.bytes+=chunk.byteLength
          if(row.bytes>chatUploadLimits.maxBytes)throw new ChatError('attachment_too_large','File exceeds 100 MiB.',413)
          const prefix=chunk.subarray(0,header.length-headerBytes)
          header.set(prefix,headerBytes);headerBytes+=prefix.length
          hash.update(chunk);yield chunk
        }
      },output)
      authorize();this.conversation(conversationId,owner)
      if(!this.host.store.get('asset',id))throw new ChatError('attachment_missing','Upload was removed.',404)
      row.previewType=imagePreviewMime(header.subarray(0,headerBytes))
      if(row.previewType)row.mimeType=row.previewType
      row.sha256=hash.digest('hex');row.state='ready';this.host.store.put('asset',id,row)
      return this.public(row,true)
    }catch(error){this.discard(row);throw error}
  }
  remove(conversationId:string,owner:string,id:string){
    this.conversation(conversationId,owner);const row=this.host.store.get<Upload>('asset',id)
    if(row?.kind!=='chat-upload'||row.conversationId!==conversationId)throw new ChatError('attachment_missing','File not found.',404)
    if(row.triggerId)throw new ChatError('attachment_sent','Sent files are part of the conversation.')
    this.discard(row);return {removed:true}
  }
  download(conversationId:string,owner:string,id:string){this.conversation(conversationId,owner);return this.row(id,conversationId)}
  /** Return the same bounded bytes that were hashed, never an unverified path or a newer upload. */
  downloadVersion(conversationId:string,owner:string,id:string,sha256:string){
    try{return this.host.scopes.readOnly(()=>this.host.memory.readOnly(()=>{
      this.conversation(conversationId,owner)
      const file=this.row(id,conversationId)
      if(!/^[a-f0-9]{64}$/.test(sha256)||file.sha256!==sha256||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>chatUploadLimits.maxBytes)throw Error('unavailable')
      const fd=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
      try{
        const before=fstatSync(fd)
        if(!before.isFile()||before.size!==file.bytes)throw Error('unavailable')
        const buffer=Buffer.alloc(file.bytes+1);let size=0,count=0
        while(size<buffer.length&&(count=readSync(fd,buffer,size,buffer.length-size,size))>0)size+=count
        const after=fstatSync(fd),content=buffer.subarray(0,size)
        if(size!==file.bytes||before.mtimeMs!==after.mtimeMs||after.size!==file.bytes||createHash('sha256').update(content).digest('hex')!==sha256)throw Error('unavailable')
        return {file,content}
      }finally{closeSync(fd)}
    }))}catch{throw new ChatError('attachment_version_unavailable','This retained file version is unavailable.',404)}
  }
  resolve(conversationId:string,owner:string,ids:string[]){
    this.conversation(conversationId,owner)
    if(ids.length>chatUploadLimits.maxFiles||new Set(ids).size!==ids.length)throw new ChatError('attachment_limit','Select up to 32 different files.',400)
    return ids.map(id=>{const row=this.row(id,conversationId);if(row.triggerId)throw new ChatError('attachment_sent','This file was already sent.');return this.public(row)})
  }
  bind(ids:string[],triggerId:string){for(const id of ids){const row=this.host.store.get<Upload>('asset',id)!;this.host.store.put('asset',id,{...row,triggerId})}}
  private taskCopy(row:Upload,ticketId:string){const id=stableDigest(['chat-attachment',ticketId,row.id]);return {id,path:join(this.host.config.stateDir,'assets',id,'upload'+extname(row.path))}}
  private materialize(row:Upload,ticketId:string){
    const copy=this.taskCopy(row,ticketId)
    if(!this.host.store.get('asset',copy.id)){
      mkdirSync(dirname(copy.path),{recursive:true,mode:0o700});copyFileSync(row.path,copy.path)
      this.host.store.put('asset',copy.id,{...this.public(row),...copy,ticketId,uploadId:row.id,resource:'asset/'+copy.id})
    }
    return copy
  }
  taskInputFiles(ticketId:string,triggerIds:string[]){
    const parent=this.host.taskAuthority(ticketId)?.parentTrigger
    if(!parent||!this.host.store.get('chat-run',parent))return []
    return [...new Set([parent,...triggerIds])].flatMap(id=>{
      const message=this.host.store.get<{attachments?:ChatAttachment[]}>('chat-message','user:'+id)
      return (message?.attachments??[]).map(file=>{
        const row=this.authorize(file.id,{ticketId}),copy=this.materialize(row,ticketId)
        return {name:row.name,path:copy.path,resource:'asset/'+file.id}
      })
    })
  }
  /** Declare the same exact paths to the model that managed shell grants on resource reads. */
  taskPaths(ticketId:string){
    const authority=this.host.taskAuthority(ticketId),run=authority?.parentTrigger?this.host.store.get<{conversationId:string}>('chat-run',authority.parentTrigger):undefined
    if(!run)return []
    return this.host.store.list<Upload>('asset').filter(row=>row.kind==='chat-upload'&&row.conversationId===run.conversationId&&row.state==='ready'&&row.triggerId&&!this.host.memory.cleanup.blocked('asset',row.id,row)).map(row=>this.taskCopy(row,ticketId).path)
  }
  /** A task may read this Chat's files only while its current reply authority belongs to this Chat. */
  authorize(id:string,principal:{ticketId?:string;chatTriggerId?:string}){
    const authority=principal.ticketId?this.host.taskAuthority(principal.ticketId):undefined
    const triggerId=principal.chatTriggerId??authority?.parentTrigger
    const run=triggerId?this.host.store.get<{conversationId:string}>('chat-run',triggerId):undefined
    if(!run)throw new ChatError('attachment_scope','File is outside this conversation.',403)
    const stored=this.host.store.get<Conversation>('chat-conversation',run.conversationId)!
    const conversation=this.conversation(stored.id,stored.owner),row=this.row(id,conversation.id)
    if(!row.triggerId)throw new ChatError('attachment_unsent','File has not been sent.',403)
    this.host.routerIngress.authority(triggerId!,conversation.discussion)
    this.host.routerIngress.authority(row.triggerId,conversation.discussion)
    if(authority&&authority.discussion!==conversation.discussion)throw new ChatError('attachment_scope','File is outside this task.',403)
    return row
  }
  read(id:string,principal:{ticketId?:string;chatTriggerId?:string}){
    const row=this.authorize(id,principal)
    let path:string|undefined,resource='asset/'+id
    if(principal.ticketId){
      const copy=this.materialize(row,principal.ticketId)
      path=copy.path;resource='asset/'+copy.id
    }
    if(row.previewType){
      if(row.bytes<=maxInlineImageBytes)return {kind:'image',mimeType:row.previewType,data:readFileSync(row.path).toString('base64')}
    }else{
      const bytes=readFileSync(row.path)
      if(!bytes.includes(0)&&bytes.subarray(0,5).toString()!=='%PDF-'){
        try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{/* Workers can process binary attachments. */}
      }
    }
    return {name:row.name,mimeType:row.mimeType,bytes:row.bytes,resource,...(path?{path}:{processing:'Use a Worker to process the original file with task tools.'})}
  }
}
