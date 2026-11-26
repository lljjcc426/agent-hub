import type {Runtime} from './runtime.ts'
import type {WorkerEventReceipt} from './async-worker-inbox.ts'
import type {Ticket,WorkerReport} from './vendor/dsh-core/index.ts'
import {stableDigest} from './sources.ts'
import {allowNewTaskInputs} from './task-context.ts'

export interface ChatResultReview {
 id:string;ticketId:string;assignmentId:string;attemptId?:string;triggerId:string;inputDigest:string;summary:string;reportedState:WorkerReport['state'];question?:string;askedBy?:string;decision?:Decision;nextStep?:string;reviewedAnswer?:string;
}
type Decision='answer'|'continue'|'ask_user'|'retain_blocked'
function alreadyRequested(host:Runtime,r:ChatResultReview,nextStep:string){
 return host.store.db.prepare(`SELECT 1 FROM records WHERE kind='chat-result-review'
  AND json_extract(body,'$.ticketId')=? AND json_extract(body,'$.assignmentId')=?
  AND json_extract(body,'$.triggerId')=? AND json_extract(body,'$.decision')='continue'
  AND json_extract(body,'$.summary')=? AND json_extract(body,'$.nextStep')=? LIMIT 1`).get(r.ticketId,r.assignmentId,r.triggerId,r.summary,nextStep)
}

export function priorWorkerChecks(host:Runtime,ticketId:string,assignmentId:string,triggerId:string){
 const rows=host.store.db.prepare(`SELECT body FROM records WHERE kind='chat-result-review'
  AND json_extract(body,'$.ticketId')=? AND json_extract(body,'$.assignmentId')=? AND json_extract(body,'$.triggerId')=?
  AND json_extract(body,'$.decision')='continue' ORDER BY rowid DESC LIMIT 3`).all(ticketId,assignmentId,triggerId)
 return rows.flatMap(row=>{
  const r=JSON.parse(String(row.body)) as ChatResultReview
  return r.nextStep&&!host.memory.cleanup.blocked('chat-result-review',r.id,r)?[r.nextStep]:[]
 })
}

export const reviewSchema={type:'object',properties:{
 reply:{type:'string'},decision:{type:'string',enum:['answer','continue','ask_user']},
 nextStep:{type:'string',description:'For continue, the specific in-scope next check for the same Worker. Otherwise empty.'},
},required:['reply','decision','nextStep'],additionalProperties:false}

function canReview(host:Runtime,ticketId:string,assignmentId:string){
 return !host.goals.forTask(ticketId)&&!host.permissions.hasUnconfirmedEffect(ticketId)&&
  !host.permissions.forWorker(ticketId).length&&!host.approvals.waiting(ticketId)&&!host.workflows.unsettled(ticketId)&&
  !host.browser.waiting(ticketId,assignmentId)&&!host.webhooks.continuations.pending(ticketId,assignmentId)&&
  host.webhooks.continuations.readyAllowed(ticketId)&&!host.work.active(ticketId,assignmentId).length
}

export function proposeChatResult(host:Runtime,event:WorkerEventReceipt,report:WorkerReport,text:string){
 const id='chat-result-review:'+event.id,ticket=host.store.tickets.get(event.ticketId)!
 const assignment=host.store.get<{reviewResult?:true;parentTrigger?:string;discussion:string}>('worker-assignment',ticket.id)
 const channel=host.store.triggers.get(ticket.origin.triggerId)?.channel
 if(ticket.ended||ticket.attention||!assignment?.reviewResult||!assignment.parentTrigger||!channel||channel.address.routerInbox!==assignment.discussion||
    !host.chat.binding(assignment.parentTrigger)||!canReview(host,ticket.id,event.assignmentId))return
 // A Worker may propose a human step after a Router-requested check. Review alternate evidence first.
 // Original human decisions and explicitly versioned approvals keep their own delivery and answer contract.
 if(report.question&&!priorWorkerChecks(host,ticket.id,event.assignmentId,assignment.parentTrigger).length)return
 const review:ChatResultReview={id,ticketId:ticket.id,assignmentId:event.assignmentId,attemptId:event.attemptId,triggerId:assignment.parentTrigger,
  inputDigest:stableDigest(ticket.inputs.map(i=>i.id)),summary:report.summary,reportedState:report.state,...(report.question?{question:report.question,askedBy:report.askedBy}:{})}
 host.store.requireChatResultReviewSchema()
 host.engine.report(ticket.id,{state:'waiting',summary:report.summary,question:null})
 host.store.put('chat-result-review',id,review)
 host.store.outbox.send({id,channel,ticketId:ticket.id,kind:'reply',text})
 return id
}

export function chatReviewInProgress(host:Runtime,ticket:Ticket){
 const current=host.store.get<{assignmentId:string;attemptId:string}>('async-worker-current',ticket.id)
 if(!current||current.assignmentId!==ticket.assignments.at(-1)?.id)return false
 const terminal=host.store.get<{eventId:string}>('async-worker-terminal',current.attemptId)
 if(!terminal)return false
 const id='chat-result-review:'+terminal.eventId,review=host.store.get<ChatResultReview>('chat-result-review',id)
 if(!review||review.ticketId!==ticket.id||review.assignmentId!==current.assignmentId)return false
 return review.decision==='continue'?ticket.undelivered.length>0:!review.decision&&!host.store.get('router-read',id)
}

export function currentReview(host:Runtime,r:ChatResultReview){
 const t=host.store.tickets.get(r.ticketId),assignment=t?.assignments.at(-1)
 const stored=host.store.get<ChatResultReview>('chat-result-review',r.id)
 return !!stored&&!stored.decision&&!host.store.get('router-read',r.id)&&!!t&&!t.ended&&!t.attention&&!t.undelivered.length&&assignment?.id===r.assignmentId&&assignment.report?.state==='waiting'&&
  stableDigest(t.inputs.map(i=>i.id))===r.inputDigest&&canReview(host,t.id,r.assignmentId)&&!host.memory.cleanup.blocked('chat-result-review',r.id,r)
}

/** The Router decision and its one effect commit with the inbox acknowledgement. */
export function decideChatResult(host:Runtime,r:ChatResultReview,decision:Decision,nextStep:string,reply:string,reviewedAnswer?:string){
 if(!currentReview(host,r))throw Error('Worker result was superseded')
 if(reviewedAnswer!==undefined&&(decision!=='answer'||reviewedAnswer!==reply||!reply.trim()))throw Error('Invalid independently reviewed answer')
 if(decision==='continue'){
  if(!nextStep.trim()||alreadyRequested(host,r,nextStep.trim()))
   throw Error('Choose a new check grounded in this report or answer from the available evidence')
  const t=host.store.tickets.get(r.ticketId)!,prior=t.inputs.map(i=>i.id)
  host.engine.note(t.id,nextStep.trim())
  allowNewTaskInputs(host.store,t.id,prior)
 }else{
  if(!reply.trim())throw Error('Reviewed Chat result requires a visible answer')
  if(decision==='answer')host.commitChatReview(r.ticketId,{state:'ready',summary:reply,question:null})
  else if(decision==='ask_user')host.commitChatReview(r.ticketId,{state:'blocked',summary:r.summary,question:reply,askedBy:r.askedBy})
  else if(decision==='retain_blocked'&&r.reportedState==='blocked')host.commitChatReview(r.ticketId,{state:'blocked',summary:r.summary,question:null})
  else throw Error('Invalid Chat result decision')
 }
 host.store.put('chat-result-review',r.id,{...r,decision,...(reviewedAnswer!==undefined?{reviewedAnswer}:{}),...(decision==='continue'?{nextStep:nextStep.trim()}:{})})
}
