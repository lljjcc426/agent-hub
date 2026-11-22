import {useRef,useState,type ReactNode} from 'react'
import type {BusinessDecisionView} from '../../src/business-decisions.ts'
import {ApprovalFrame,QuestionCard} from './approval-card.tsx'
import {Button} from '../ui/controls.tsx'
import {DecisionSubmission,type DecisionAttempt} from './decision-state.ts'
type Props={readonly:boolean;item:BusinessDecisionView;L:(en:string,zh:string)=>string;send:(body:DecisionAttempt)=>Promise<unknown>;refresh:()=>Promise<void>;footer?:ReactNode}
export function WorkerQuestion({item,L,send,refresh,readonly,footer}:Props){
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 const attempt=useRef(new DecisionSubmission())
 const {status}=item
 async function submit(value:string){
  if(readonly || busy)return
  setBusy(true);setError('')
  try{await attempt.current.run(item,value,send);await refresh()}
  catch{setError(L('Your answer has not been confirmed. You can resend the same answer.','答复尚未确认保存，可以重试发送同一份答复。'))}
  finally{setBusy(false)}
 }
 const terms=[item.target.amount&&item.target.amount.value+' '+item.target.amount.currency,item.target.recipient?.label].filter(Boolean)
 const question=terms.length?item.question+' ('+terms.join(' · ')+')':item.question
 const missing=item.fileHandoff?.state==='missing'?item.fileHandoff.missing:[]
 return <section className="review-question" aria-label={L('Worker question','Worker 提问')}>
  {status==='pending'||status==='answered'?<QuestionCard L={L} id={item.id} question={question} options={[]} custom maxLength={10000}
    answer={item.answer?.text} disabled={busy||readonly||!!error} onAnswer={v=>void submit(v)} footer={footer}
    outcome={missing.length>0&&<div className="chat-approval-outcome" role="status">
      <strong>{L('Missing original files','缺少原始文件')}</strong>
      <ul>{missing.map(path=><li key={path}>{path}</li>)}</ul>
    </div>}/>:
   <ApprovalFrame L={L} kind="choice" id={item.id} title={question} result="closed"
      status={({expired:L('Question expired','问题已过期'),stale:L('The task changed','任务已变更'),unavailable:L('Question unavailable','问题暂不可用'),withdrawn:L('Question withdrawn','问题已撤回')})[status]}/>}
  {status==='pending'&&error&&<div role="alert">{error} <Button disabled={busy||readonly} onClick={()=>{const a=attempt.current.pending;if(a)void submit(a.text)}}>{L('Resend','重试发送')}</Button></div>}
 </section>
}
