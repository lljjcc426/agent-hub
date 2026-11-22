import {useEffect,useRef,useState,type ReactNode} from 'react'
import type {BusinessDecisionView} from '../../src/business-decisions.ts'
import {ApprovalFrame,QuestionCard} from './approval-card.tsx'
import {Button} from '../ui/controls.tsx'
import {decisionStatus,DecisionSubmission,type DecisionAttempt} from './decision-state.ts'
type Props={readonly:boolean;item:BusinessDecisionView;L:(en:string,zh:string)=>string;send:(body:DecisionAttempt)=>Promise<unknown>;refresh:()=>Promise<void>;footer?:ReactNode}
export function WorkerQuestion({item,L,send,refresh,readonly,footer}:Props){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[now,setNow]=useState(Date.now)
 const attempt=useRef(new DecisionSubmission())
 useEffect(()=>{
  if(item.status!=='pending')return
  const time=Date.now()
  setNow(time)
  if(time>=item.expiresAt)return
  const timer=setTimeout(()=>setNow(Date.now()),item.expiresAt-time)
  return ()=>clearTimeout(timer)
 },[item.status,item.expiresAt])
 const status=decisionStatus(item,now)
 async function submit(action:'renew'|'answer',value=''){
  if(readonly || busy)return
  setBusy(true);setError('')
  try{await attempt.current.run(item,action,value,send);await refresh()}
  catch{setError(L('Could not confirm. Retry the same response.','未确认保存，可重试这次答复。'))}
  finally{setBusy(false)}
 }
 const target=[item.target.label,item.target.version,item.target.amount&&item.target.amount.value+' '+item.target.amount.currency,item.target.recipient?.label].filter(Boolean).join(' · ')
 return <section className="review-question" aria-label={L('Worker question','Worker 提问')}>
  {status==='pending'||status==='answered'?<QuestionCard L={L} id={item.id} question={item.question} notice={target} options={[]} custom maxLength={10000}
    answer={item.answer?.text} disabled={busy||readonly} onAnswer={v=>void submit('answer',v)} footer={footer}/>:
   <ApprovalFrame L={L} kind="choice" id={item.id} title={item.question} notice={target} result="closed"
      status={({expired:L('Question expired','问题已过期'),stale:L('The task changed','任务已变更'),unavailable:L('Question unavailable','问题暂不可用'),withdrawn:L('Question withdrawn','问题已撤回')})[status]}>
    {(status==='expired'||status==='stale')&&<Button disabled={busy||readonly} onClick={()=>void submit('renew')}>{L('Request a new question','重新提问')}</Button>}
   </ApprovalFrame>}
  {error&&<div role="alert">{error} <Button disabled={busy||readonly} onClick={()=>{const a=attempt.current.pending;if(a)void submit(a.action,a.text)}}>{L('Retry','重试')}</Button></div>}
 </section>
}
