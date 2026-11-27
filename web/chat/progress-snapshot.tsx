import {useEffect,useState} from 'react'
import { Activity, Clock3, MessageCircle } from 'lucide-react'
import { Disclosure } from '../ui'
import { originalTaskHref, workDate, workHref } from './work-items.ts'
import type {ProgressResponse,ProgressSnapshot} from '../../src/progress-snapshot.ts'
import {useWorkspaceTransport} from './workspace-context.tsx'

type Language='en'|'zh-CN'
const fields=['activity','result','commit','push','check','deployment','acceptance'] as const
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
type EvidenceKey=typeof fields[number]
type Evidence=ProgressSnapshot['sections'][EvidenceKey]
type Change={key:EvidenceKey;before:Evidence;after:Evidence}|{key:'artifacts'}
const states=new Set(['queued','waiting','stopped','ended','interrupted','uncertain','unverified','recorded','passed','failed','insufficient','errored','stale','pending','running'])
const time=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=8640000000000000
function snapshotValid(value:ProgressSnapshot|undefined):value is ProgressSnapshot{
 const sections=value?.sections
 return !!value&&value.schema===1&&id(value.revision)&&time(value.observedAt)&&!!sections&&fields.every(key=>{
  const row=sections[key]
  return !!row&&states.has(row.state)&&(row.head===null||typeof row.head==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.head))&&
   (row.observedAt===null||time(row.observedAt))&&(row.matchesCurrent===null||typeof row.matchesCurrent==='boolean')
 })&&Array.isArray(sections.artifacts)&&sections.artifacts.every(a=>!!a&&id(a.id)&&Number.isSafeInteger(a.version)&&a.version>=1&&(a.observedAt===null||time(a.observedAt)))
}
function snapshotChanges(previous:ProgressSnapshot,next:ProgressSnapshot):Change[]{
 const changes:Change[]=[]
 for(const key of fields){
  const before=previous.sections[key],after=next.sections[key]
  if(before.state!==after.state||before.head!==after.head||before.observedAt!==after.observedAt||before.matchesCurrent!==after.matchesCurrent)changes.push({key,before,after})
 }
 const old=previous.sections.artifacts,files=next.sections.artifacts
 if(old.length!==files.length||old.some((a,i)=>a.id!==files[i]?.id||a.version!==files[i]?.version||a.observedAt!==files[i]?.observedAt))changes.push({key:'artifacts'})
 return changes
}
export function TaskProgressSnapshot({ticketId,language,question,createdAt}:{ticketId:string;language:Language;question?:string;createdAt?:string}){
 const {binding,contextKey,readSignal}=useWorkspaceTransport()
 const [current,setCurrent]=useState<{context:string;ticket:string;signal:AbortSignal;value:ProgressSnapshot;changes:Change[]}|null>(null),[unavailable,setUnavailable]=useState(false)
 const L=(en:string,zh:string)=>language==='en'?en:zh
 const labels={activity:L('Execution','执行'),result:L('Task result','任务结果'),commit:L('Commit','提交'),push:L('Remote push','远端推送'),check:L('Tests','测试'),deployment:L('Deployment','部署'),acceptance:L('Verification record','验收记录'),artifacts:L('Delivered files','交付文件')}
 useEffect(()=>{
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,readSignal])
  let previous:ProgressSnapshot|undefined,busy=false
  const hidden=()=>document.visibilityState==='hidden'
  const read=async()=>{
   if(signal.aborted||busy||hidden())return
   busy=true
   try{
    const query=new URLSearchParams({ticketId,...(previous?{revision:previous.revision}:{})})
    const response=await binding.request<ProgressResponse>('/api/execution-trace/progress?'+query,undefined,false,undefined,signal)
    if(signal.aborted||hidden())return
    if(response?.schema!==1)throw Error('Unknown progress format')
    if(response.unchanged){
     if(!previous||response.revision!==previous.revision)throw Error('Unknown progress revision')
     return
    }
    const value=response.snapshot
    if(!snapshotValid(value))throw Error('Unknown progress snapshot')
    if(previous?.revision===value.revision)return
    const changes=previous?snapshotChanges(previous,value):[]
    previous=value
    setCurrent({context:contextKey,ticket:ticketId,signal:readSignal,value,changes})
    setUnavailable(false)
   }catch{
    if(!signal.aborted){previous=undefined;setCurrent(null);setUnavailable(true)}
   }finally{busy=false}
  }
  setCurrent(null);setUnavailable(false)
  void read()
  const timer=setInterval(()=>void read(),5000)
  const onVisible=()=>void read()
  document.addEventListener('visibilitychange',onVisible)
  return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',onVisible)}
 },[binding,contextKey,ticketId,readSignal])
 if(readSignal.aborted)return null
 const visible=current?.context===contextKey&&current.ticket===ticketId&&current.signal===readSignal?current:null
 const snapshot=visible?.value
 const stamp=(at:number)=><time dateTime={new Date(at).toISOString()}>{workDate(at,language)}</time>
 if(!snapshot)return <p role="status">{unavailable?L('Progress unavailable','暂时无法读取进度'):L('Loading progress…','正在读取进度…')}</p>
 const names={queued:L('Queued','已排队'),waiting:L('Waiting','等待处理'),stopped:L('Stopped','已停止'),ended:L('Ended','已结束'),interrupted:L('Interrupted','已中断'),uncertain:L('Needs review','结果待核对'),unverified:L('No record','暂无记录'),recorded:L('Recorded','已记录'),passed:L('Passed','通过'),failed:L('Failed','未通过'),insufficient:L('Evidence incomplete','记录不足'),errored:L('Check failed','检查出错'),stale:L('Out of date','记录已过期'),pending:L('Pending','待确认'),running:L('In progress','执行中')}
 const describe=(row:Evidence,key:EvidenceKey)=>{
   if(row.state==='stale'||row.state==='unverified'||key==='activity'||key==='result')return names[row.state]
   const version=row.matchesCurrent===false?L('earlier version','较早版本'):row.matchesCurrent===null?L('version unconfirmed','版本待核对'):''
   return [names[row.state],version].filter(Boolean).join(' · ')
 }
 const activity=snapshot.sections.activity
 const waiting=activity.state==='waiting' && !!question
 const Icon=waiting?MessageCircle:activity.state==='queued'?Clock3:Activity
 const observed=fields.filter(key=>key!=='activity' && snapshot.sections[key].state!=='unverified')
 const missing=fields.filter(key=>key!=='activity' && snapshot.sections[key].state==='unverified')
 return <section aria-label={L('Task progress snapshot','任务进展快照')} className="progress-content">
   <div className="progress-current"><div className="progress-current-top"><div><Icon size={21} aria-hidden="true"/><strong>{waiting?L('Waiting for your reply','等你回复'):names[activity.state]}</strong></div>
     {waiting && <a className="rp-button" data-tone="secondary" href={originalTaskHref(ticketId)}>{L('Open task','打开原任务')}</a>}</div>
     {waiting&&<p>{question}</p>}</div>
   <h3>{L('Task record','进度记录')}</h3>
   <div role="status" aria-live="polite">{visible?.changes.length ? <ul className="progress-changes">{visible.changes.map(change=>{
     if(change.key==='artifacts')return <li key="artifacts">{L('Delivered files updated','交付文件已更新')}</li>
     const from=describe(change.before,change.key),to=describe(change.after,change.key)
     return <li key={change.key}>{labels[change.key]} · {from===to?to:from+' → '+to}</li>
   })}</ul>:null}</div>
   {(createdAt || observed.length>0) ? <ul className="progress-events">
     {createdAt && <li><span className="progress-event-dot" aria-hidden="true"/><div><strong>{L('Task created','已创建任务')}</strong></div><time dateTime={createdAt}>{workDate(createdAt,language)}</time></li>}
     {observed.map(key=>{
     const datum=snapshot.sections[key]
     return <li key={key}><span className="progress-event-dot" aria-hidden="true"/><div><strong>{labels[key]}</strong><span>{describe(datum,key)}</span>
       {datum.head&&<code title={datum.head}>{datum.head.slice(0,12)}</code>}</div>{datum.observedAt!==null&&stamp(datum.observedAt)}</li>
   })}</ul>:<p className="work-empty-line">{L('No results recorded yet','尚无结果记录')}</p>}
   {snapshot.sections.artifacts.length>0 && <section><h3>{labels.artifacts}</h3><ul className="work-files">{snapshot.sections.artifacts.filter(a=>id(a.id)).map(a=><li key={a.id}><a href={workHref('artifact/'+a.id)} onClick={event=>{if(readSignal.aborted)event.preventDefault()}}>{L('Open file','打开文件')} · v{a.version}</a>{a.observedAt!==null&&stamp(a.observedAt)}</li>)}</ul></section>}
   {missing.length>0&&<Disclosure title={L('Steps without a record','尚无记录的环节')+' ('+missing.length+')'}><ul className="progress-missing">{missing.map(key=><li key={key}>{labels[key]}</li>)}</ul></Disclosure>}
 </section>
}
