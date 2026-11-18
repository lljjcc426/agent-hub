import {useEffect,useRef,useState} from 'react'
import type {BusinessDecisionView} from '../../src/business-decisions.ts'
import {DecisionCard} from '../ui/agent-decisions.tsx'
import {Button} from '../ui/controls.tsx'
import {decisionStatus,DecisionSubmission,type DecisionAttempt} from './decision-state.ts'
type Props={item:BusinessDecisionView;L:(en:string,zh:string)=>string;send:(body:DecisionAttempt)=>Promise<unknown>;refresh:()=>Promise<void>}
export function WorkerQuestion({item,L,send,refresh}:Props){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[now,setNow]=useState(Date.now)
 const attempt=useRef(new DecisionSubmission())
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[])
 const status=decisionStatus(item,now)
 async function submit(action:'renew'|'answer',value=''){
  setBusy(true);setError('')
  try{await attempt.current.run(item,action,value,send);await refresh()}
  catch{setError(L('Could not confirm. Retry the same response.','未确认保存，可重试这次答复。'))}
  finally{setBusy(false)}
 }
 return <section className="review-question" aria-label={L('Worker question','Worker 提问')}>
  <p className="review-target"><strong>{item.target.label}</strong> · {item.target.version}
   {item.target.amount&&<> · {item.target.amount.value} {item.target.amount.currency}</>}
   {item.target.recipient&&<> · {item.target.recipient.label}</>}
  </p>
  {status==='pending'||status==='answered'?<DecisionCard L={L} question={item.question} options={[]} answer={item.answer?.text??null} disabled={busy} onAnswer={v=>void submit('answer',v)}/>:
   <div><strong>{item.question}</strong><p>{({expired:L('Question expired','问题已过期'),stale:L('The task changed','任务已变更'),unavailable:L('Question unavailable','问题暂不可用'),withdrawn:L('Question withdrawn','问题已撤回')})[status]}</p>{(status==='expired'||status==='stale')&&<Button disabled={busy} onClick={()=>void submit('renew')}>{L('Request a new question','重新提问')}</Button>}</div>}
  {error&&<div role="alert">{error} <Button disabled={busy} onClick={()=>{const a=attempt.current.pending;if(a)void submit(a.action,a.text)}}>{L('Retry','重试')}</Button></div>}
 </section>
}
