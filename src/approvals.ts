import {hostPrivateFiles} from './private-files.ts'
import {stableDigest} from './sources.ts'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Store } from './store.ts'
import type { NativeRequest } from './model.ts'

export interface ApprovalOrigin {conversationId:string;runId:string;workerId:string}
export interface Approval { decision?:{answers?:Record<string,unknown>};key?:string;delivered?:boolean;automatic?:boolean;chat?:ApprovalOrigin;outcome?:'approved'|'denied'|'answered'; id:string; ticketId:string; native:NativeRequest; createdAt:number; expiresAt:number; status:'pending'|'resolved'|'expired' }
// A native permission grant cannot widen the task's host sandbox. Explicit additional
// work directories go through the managed shell, which mounts only the reviewed directory.
export function withinNativeTask(native:NativeRequest,cwd:string,writable:boolean,network:boolean,privateState:string){
  const {params}=native
  function inside(path:unknown){
    if(typeof path!=='string'||!isAbsolute(path))return false
    const contains=(root:string,file:string)=>{const r=relative(root,file);return r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r)}
    try{
      const target=realpathSync(path)
      return contains(realpathSync(cwd),target)&&![realpathSync(privateState),...hostPrivateFiles()].some(p=>contains(target,p)||contains(p,target))
    }catch{return false}
  }
  if(params.grantRoot&&(!writable||!inside(params.grantRoot)))return false
  if(params.networkApprovalContext&&!network)return false
  const grant=native.method==='item/permissions/requestApproval'?params.permissions:params.additionalPermissions
  if(!grant)return true
  if(Object.keys(grant).some(k=>!['network','fileSystem'].includes(k))||grant.network?.enabled&&!network)return false
  const fs=grant.fileSystem
  if(!fs)return true
  return Object.entries(fs).every(([key,paths])=>(key==='read'||key==='write')&&
    (paths==null||Array.isArray(paths)&&(!paths.length||key==='read'||writable)&&paths.every(inside)))
}
const isQuestion=(request:NativeRequest)=>request.method==='item/tool/requestUserInput'
const hasSecret=(request:NativeRequest)=>isQuestion(request)&&request.params.questions?.some((q:{isSecret?:boolean})=>q.isSecret)
function nativeIdentity(native:NativeRequest){
  const {threadId,turnId,itemId,approvalId,reason,availableDecisions,...operation}=native.params
  // Native file changes can carry only an opaque item ID. Never transfer that consent to another patch.
  const opaque=native.method==='item/fileChange/requestApproval'||native.method==='item/commandExecution/requestApproval'&&!operation.command&&!operation.commandActions
  return opaque?{...operation,threadId,itemId:itemId??native.id}:operation
}
export class Approvals {
  private readonly pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer?:ReturnType<typeof setTimeout>}>()
  private readonly privateAnswers=new Map<string,unknown>()
  constructor(private readonly store:Store){
    for(const value of store.list<Approval>('approval')){
      if(value.status==='pending'&&!value.key)store.put('approval',value.id,{...value,status:'expired'})
      if(value.key&&hasSecret(value.native)&&value.status==='resolved'&&!value.delivered)
        store.put('approval',value.id,{...value,status:'pending',outcome:undefined,decision:undefined})
    }
  }
  private permission(native:NativeRequest,value:'accept'|'decline'){
    if(isQuestion(native))return {answers:{}}
    if(native.method==='item/permissions/requestApproval')return {permissions:value==='accept'?native.params.permissions??{}:{},scope:'turn'}
    return {decision:value}
  }
  waiting(ticketId:string){return this.store.list<Approval>('approval').some(a=>a.ticketId===ticketId&&a.key&&a.status==='pending')}
  request(ticketId:string,native:NativeRequest,chat?:ApprovalOrigin,full=false):Promise<unknown>{
    const durable=!!chat&&['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput'].includes(native.method)
    const key=durable?stableDigest([ticketId,chat,native.method,nativeIdentity(native)]):undefined
    const prior=key?this.store.db.prepare("SELECT body FROM records WHERE kind='approval' AND json_extract(body,'$.key')=? LIMIT 1").get(key):undefined
    const saved:Approval|undefined=prior?JSON.parse(String(prior.body)):undefined
    if(saved?.status==='resolved'){
      if(isQuestion(native)){
        if(!hasSecret(native))return Promise.resolve(saved.decision??{answers:{}})
        const answer=this.privateAnswers.get(saved.id)
        if(answer){this.privateAnswers.delete(saved.id);this.store.put('approval',saved.id,{...saved,delivered:true})}
        return Promise.resolve(answer??{answers:{}})
      }
      const allow=saved.outcome==='approved'&&!saved.delivered
      if(allow)this.store.put('approval',saved.id,{...saved,delivered:true})
      return Promise.resolve(this.permission(native,allow?'accept':'decline'))
    }
    if(saved?.status==='expired')return Promise.resolve(this.permission(native,'decline'))
    const id=saved?.id??randomUUID()
    const item:Approval=saved??{id,ticketId,native,chat,key,createdAt:Date.now(),expiresAt:durable?Number.MAX_SAFE_INTEGER:Date.now()+120000,status:'pending'}
    if(durable&&full&&!saved&&!isQuestion(native)){
      this.store.put('approval',id,{...item,status:'resolved',outcome:'approved',delivered:true,automatic:true})
      return Promise.resolve(this.permission(native,'accept'))
    }
    // The native protocol has no "pending" result. Withhold this attempt while the host
    // keeps the actionable card. The Worker can continue its other tools in the same turn.
    if(durable){
      if(!saved)this.store.put('approval',id,item)
      return Promise.resolve(this.permission(native,'decline'))
    }
    if(this.pending.has(id))return Promise.reject(Error('An identical permission request is already waiting'))
    if(!saved)this.store.put('approval',id,item)
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.expire(id),120000)
      this.pending.set(id,{resolve,reject,timer})
    })
  }
  /** Observation only: persisted metadata alone cannot restore a waiting request. */
  hasLiveRequest(id:string,now=Date.now()):boolean{
    try{
      const item=this.store.get<Approval>('approval',id)
      if(!Number.isSafeInteger(now)||now<0||now>8.64e15||!this.pending.has(id)||item?.id!==id||item.status!=='pending')return false
      if(!item.native||typeof item.native.id!=='string'||typeof item.native.method!=='string'||!item.native.params||typeof item.native.params!=='object'||Array.isArray(item.native.params))return false
      return Number.isSafeInteger(item.createdAt)&&item.createdAt>=0&&item.createdAt<=8.64e15&&Number.isSafeInteger(item.expiresAt)&&item.expiresAt<=8.64e15&&item.createdAt<=now&&item.expiresAt>now&&item.expiresAt>item.createdAt
    }catch{return false}
  }
  answer(id:string,value:unknown):void{
    const item=this.store.get<Approval>('approval',id),pending=this.pending.get(id)
    if(item?.key&&item.status==='resolved'&&((value==='accept'&&item.outcome==='approved')||(value==='decline'&&item.outcome==='denied')))return
    if(item?.key&&item.outcome==='answered'&&item.status==='resolved'&&
      (hasSecret(item.native)||stableDigest(item.decision)===stableDigest({answers:value})))return
    if(!item||item.status!=='pending'||(!pending&&!item.key)||item.expiresAt<=Date.now())throw Error('Approval is expired or no longer active')
    let result:unknown
    if(item.native.method==='item/tool/requestUserInput'){
      const answers=z.record(z.string(),z.object({answers:z.array(z.string()).max(10)}).strict()).parse(value)
      const ids=(item.native.params.questions??[]).map((q:any)=>q.id)
      if(Object.keys(answers).some(k=>!ids.includes(k)))throw Error('Unknown question id')
      if(ids.some((id:string)=>!answers[id]?.answers.length||answers[id]!.answers.some(a=>!a.trim())))throw Error('Answer each question before submitting')
      result={answers}
    }else if(item.native.method==='item/permissions/requestApproval'){
      const decision=z.enum(['accept','decline']).parse(value)
      result={permissions:decision==='accept'?item.native.params.permissions??{}:{},scope:'turn'}
    }else result={decision:z.enum(['accept','decline']).parse(value)}
    let stored=result
    if(item.native.method==='item/tool/requestUserInput'){
      const secret=new Set((item.native.params.questions??[]).filter((q:{isSecret?:boolean})=>q.isSecret).map((q:{id:string})=>q.id))
      stored={answers:Object.fromEntries(Object.entries((result as {answers:Record<string,unknown>}).answers).filter(([id])=>!secret.has(id)))}
    }
    if(item.key&&hasSecret(item.native))this.privateAnswers.set(id,result)
    this.store.put('approval',id,{...item,status:'resolved',outcome:item.native.method==='item/tool/requestUserInput'?'answered':value==='accept'?'approved':'denied',decision:stored,...(item.key&&pending?{delivered:true}:{})})
    if(pending){clearTimeout(pending.timer);this.pending.delete(id);pending.resolve(result)}
  }
  private expire(id:string){
    const item=this.store.get<Approval>('approval',id),pending=this.pending.get(id)
    if(item)this.store.put('approval',id,{...item,status:'expired'})
    if(pending){clearTimeout(pending.timer);this.pending.delete(id);pending.reject(Error('Approval expired'))}
  }
  release(ticketId:string){
    for(const id of this.pending.keys())if(this.store.get<Approval>('approval',id)?.ticketId===ticketId)this.expire(id)
  }
  cancel(ticketId:string){
    for(const item of this.store.list<Approval>('approval'))if(item.ticketId===ticketId){
      this.privateAnswers.delete(item.id)
      if(item.status==='pending')this.expire(item.id)
    }
  }
  close(){
    this.privateAnswers.clear()
    for(const id of this.pending.keys())this.expire(id)
  }
}
