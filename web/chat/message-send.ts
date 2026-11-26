import {useCallback,useEffect,useRef,useState} from 'react'
import type {CompleteAttachment} from '@assistant-ui/react'
import type {ChatQuote} from '../../src/chat-interactions.ts'
import type {ChatSkillRef} from '../../src/chat-skills.ts'
import type {DraftQuote} from './message-interactions.tsx'

export function read(key:string,fallback=''){
  try{return localStorage.getItem(key)??fallback}catch{return fallback}
}
export function write(key:string,value:string){
  try{localStorage.setItem(key,value)}catch{}
}
export const draftKey=(id:string|null)=>'roppo.chat.draft.'+(id??'new')
export const skillDraftKey=(id:string|null)=>'roppo.chat.draft.skill.'+(id??'new')
export const planDraftKey=(id:string|null)=>'roppo.chat.draft.plan.'+(id??'new')
export const planBindingKey=(id:string|null)=>'roppo.chat.draft.plan-binding.'+(id??'new')
export function savedDraftSkill(id:string|null):ChatSkillRef|null {
  try{
    const value=JSON.parse(read(skillDraftKey(id),'null'))
    return typeof value?.id==='string'&&typeof value.name==='string'?value:null
  }catch{return null}
}
export function carryInitialDraft(id:string){
  const text=read(draftKey(null)),skill=savedDraftSkill(null),plan=read(planDraftKey(null))
  if((!text&&!skill&&!plan)||read(draftKey(id))||savedDraftSkill(id)||read(planDraftKey(id)))return
  write(draftKey(id),text)
  write(draftKey(null),'')
  write(skillDraftKey(id),JSON.stringify(skill))
  write(skillDraftKey(null),'null')
  write(planDraftKey(id),plan)
  write(planDraftKey(null),'')
}
const pendingKey=(id:string|null)=>'roppo.chat.pending.'+(id??'new')
type Pending={id:string;conversationId:string|null;text:string;attachments?:string[];quote?:ChatQuote;draftQuote?:DraftQuote;skill?:ChatSkillRef;startPlan?:true;planningId?:string}

export function savedPending(id:string|null):Pending|null {
  try{
    const value=JSON.parse(read(pendingKey(id),'null'))
    return value&&typeof value.text==='string'&&typeof value.id==='string'&&value.conversationId===id?value:null
  }catch{return null}
}
export function forgetPending(id:string|null,messageId:string){
  if(savedPending(id)?.id===messageId)write(pendingKey(id),'null')
}

type MessageInput={text:string;attachments:string[];quote?:ChatQuote;skillId?:string;startPlan?:true;planningId?:string;locale:string;timeZone:string;openingLocale:'en'|'zh-CN'}
type Draft={input:MessageInput;files:readonly CompleteAttachment[];quote:DraftQuote|null;skill?:ChatSkillRef;conversationId:string|null}
export type OutgoingMessage=Draft&{id:string;createdAt:number;stage:'initial'|'sending'|'slow'|'unconfirmed'|'rejected'|'accepted';error?:string}
type Transport={
  open:(signal:AbortSignal)=>Promise<string>
  post:(id:string,input:MessageInput&{clientMessageId:string},signal:AbortSignal)=>Promise<unknown>
  rejection:(error:unknown)=>string|undefined
}

// An outgoing message belongs to the app so creating the initial conversation can remount Chat.
export function useMessageSend(transport:Transport,adopt:(id:string)=>void){
  const entries=useRef(new Map<string,OutgoingMessage>())
  const attempts=useRef(new Map<string,AbortController>())
  const [messages,setMessages]=useState<OutgoingMessage[]>([])
  const publish=useCallback(()=>setMessages([...entries.current.values()]),[])
  const has=useCallback((id:string)=>entries.current.has(id),[])
  const hasAttachment=useCallback((id:string)=>[...entries.current.values()].some(message=>message.input.attachments.includes(id)),[])

  const clear=useCallback(()=>{
    for(const controller of attempts.current.values())controller.abort()
    attempts.current.clear()
    entries.current.clear()
  },[])
  useEffect(()=>clear,[clear])
  const reset=useCallback(()=>{clear();publish()},[clear,publish])
  const confirm=useCallback((conversationId:string,ids:Set<string>)=>{
    let changed=false
    for(const id of ids){
      const message=entries.current.get(id)
      if(message?.conversationId!==conversationId)continue
      forgetPending(conversationId,id)
      attempts.current.get(id)?.abort()
      attempts.current.delete(id)
      entries.current.delete(id)
      changed=true
    }
    if(changed)publish()
  },[publish])

  const transmit=useCallback(async(original:OutgoingMessage)=>{
    const {id,input}=original
    attempts.current.get(id)?.abort()
    const controller=new AbortController(),{signal}=controller
    attempts.current.set(id,controller)
    let message=original
    const update=(patch:Partial<OutgoingMessage>)=>{
      message={...message,...patch}
      entries.current.set(id,message)
      publish()
    }
    const remember=()=>write(pendingKey(message.conversationId),JSON.stringify({id,conversationId:message.conversationId,
      text:input.text,attachments:input.attachments,quote:input.quote,draftQuote:message.quote??undefined,skill:message.skill,
      startPlan:input.startPlan,planningId:input.planningId} satisfies Pending))
    update({stage:'initial',error:undefined})
    remember()
    const sending=setTimeout(()=>{if(!signal.aborted)update({stage:'sending'})},2000)
    const slow=setTimeout(()=>{if(!signal.aborted)update({stage:'slow'})},10000)
    try{
      const target=message.conversationId??await transport.open(signal)
      if(signal.aborted)return
      if(message.conversationId===null){
        forgetPending(null,id)
        update({conversationId:target})
        remember()
      }
      adopt(target)
      await transport.post(target,{...input,clientMessageId:id},signal)
      if(signal.aborted)return
      forgetPending(target,id)
      update({stage:'accepted'})
    }catch(error){
      if(signal.aborted)return
      const code=transport.rejection(error)
      update({stage:code?'rejected':'unconfirmed',error:code})
    }finally{
      clearTimeout(sending)
      clearTimeout(slow)
      if(attempts.current.get(id)===controller)attempts.current.delete(id)
    }
  },[adopt,publish,transport])

  function begin(draft:Draft){
    if([...entries.current.values()].some(m=>m.conversationId===draft.conversationId&&m.stage!=='accepted'))return false
    const saved=savedPending(draft.conversationId),{input}=draft
    const same=saved?.text===input.text&&saved.skill?.id===input.skillId&&saved.startPlan===input.startPlan&&saved.planningId===input.planningId&&
      JSON.stringify(saved.attachments??[])===JSON.stringify(input.attachments)&&
      JSON.stringify(saved.quote??null)===JSON.stringify(input.quote??null)
    void transmit({...draft,id:same?saved.id:crypto.randomUUID(),createdAt:Date.now(),stage:'initial'})
    return true
  }
  function retry(id:string){
    const message=entries.current.get(id)
    if(message&&(message.stage==='slow'||message.stage==='unconfirmed'))void transmit(message)
  }
  function edit(id:string){
    const message=entries.current.get(id)
    if(message?.stage!=='rejected')return
    entries.current.delete(id)
    publish()
    return message
  }
  const recoverInitial=useCallback((id:string)=>{
    const saved=savedPending(null)
    if(!saved||has(saved.id)||savedPending(id))return
    write(pendingKey(id),JSON.stringify({...saved,conversationId:id}))
    forgetPending(null,saved.id)
  },[has])

  return {messages,begin,retry,edit,confirm,has,hasAttachment,reset,recoverInitial}
}
