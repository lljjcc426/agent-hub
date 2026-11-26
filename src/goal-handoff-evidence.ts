import type {Runtime} from './runtime.ts'
import type {RouterGoal} from './router-goals.ts'
import type {ScopeContext} from './router-scope.ts'
import type {ChatConversation,ChatMessage,ChatRun} from './chat.ts'
import type {ActorRef,Trigger} from './vendor/dsh-core/index.ts'
import {bodyDigest,stableDigest} from './sources.ts'
import {retainedFileHandoffSchema,type HandoffMaterial} from './chat-file-handoff.ts'

interface Handoff {
 ticketId:string;conversationId:string;triggerId:string;outcome?:{state:string;missing:string[]}
 sourceTicketId?:string;files?:{path:string;bytes:number;sha256:string}[];paths?:string[];question?:string
}
interface AnswerReceipt {ticketId:string;questionId:string;triggerId:string;actor:ActorRef;answerDigest:string}

function visible<T>(h:Runtime,kind:string,id:string){
 const value=h.store.get<T>(kind,id)
 return value&&!h.memory.cleanup.blocked(kind,id,value)?value:undefined
}
function sameActor(actor:ActorRef|undefined,chat:ChatConversation){
 return actor?.id===chat.actor&&actor.source===chat.sourceId
}
function humanRun(h:Runtime,id:string,chat:ChatConversation){
 const run=visible<ChatRun>(h,'chat-run',id),trigger=visible<Trigger>(h,'trigger',id)
 if(run?.conversationId!==chat.id||run.id!==id||run.triggerId!==id||run.cancelled||run.cancelRequested||
    !trigger?.human||trigger.meta.delegatedBy||!sameActor(trigger.actor,chat))return
 try{h.routerIngress.authority(id,chat.discussion)}catch{return}
 return {run,trigger}
}

function answeredExchange(h:Runtime,chat:ChatConversation,ticketId:string,decisionId:string){
 if(!visible(h,'business-decision',decisionId))return
 const decision=h.chat.businessDecisions(chat.id,chat.owner,{questionId:decisionId})[0]
 if(decision?.ticketId!==ticketId||decision.status!=='answered'||!decision.answer||!decision.answerMessageId||
    !humanRun(h,decision.runId,chat))return
 const receiptId=bodyDigest([ticketId,decisionId]),receipt=visible<AnswerReceipt>(h,'question-answer',receiptId)
 if(receipt?.questionId!==decisionId||receipt.ticketId!==ticketId||!sameActor(receipt.actor,chat)||
    receipt.answerDigest!==bodyDigest(decision.answer.text))return
 const reply=humanRun(h,receipt.triggerId,chat)
 const answer=visible<ChatMessage>(h,'chat-message',decision.answerMessageId)
 if(reply?.run.decisionTicketId!==ticketId||reply.trigger.text!==decision.answer.text||answer?.id!=='user:'+receipt.triggerId||
    answer.role!=='user'||answer.conversationId!==chat.id||answer.runId!==receipt.triggerId||answer.text!==decision.answer.text)return
 const rows=h.store.db.prepare(`SELECT id FROM records WHERE kind='chat-message'
  AND json_extract(body,'$.conversationId')=? AND json_extract(body,'$.ticketId')=?
  AND json_extract(body,'$.runId')=? AND json_extract(body,'$.text')=?
  AND json_extract(body,'$.role')='assistant' AND json_extract(body,'$.speaker.kind')='worker'
  AND json_extract(body,'$.status')='complete' LIMIT 2`).all(chat.id,ticketId,decision.runId,decision.question)
 if(rows.length!==1)return
 const id=String(rows[0]!.id),question=visible<ChatMessage>(h,'chat-message',id)
 if(question?.id!==id||question.sequence>=answer.sequence)return
 const message=(m:ChatMessage)=>({messageId:m.id,runId:m.runId,role:m.role,createdAt:m.createdAt,text:m.text})
 return {decisionId,answerReceiptId:receiptId,question:{...message(question),workerId:question.speaker!.id,status:question.status},answer:message(answer)}
}

/** Only the original, actor-bound Chat exchange and files actually retained for this task. */
export function goalHandoffEvidence(h:Runtime,goal:RouterGoal,ticketId:string,context:ScopeContext){
 if(!goal.managed||goal.project||!goal.taskIds.includes(ticketId)||h.store.get('task-continuation',ticketId))return []
 const receipts=h.store.db.prepare(`SELECT id FROM records WHERE kind='chat-file-handoff'
  AND json_extract(body,'$.ticketId')=? AND json_extract(body,'$.outcome.state')='ready' ORDER BY rowid`).all(ticketId)
 if(!receipts.length)return []
 const run=visible<ChatRun>(h,'chat-run',goal.triggerId),chat=run&&visible<ChatConversation>(h,'chat-conversation',run.conversationId)
 if(!chat||chat.id!==run.conversationId||chat.discussion!==goal.discussion||goal.scopeId!=='@chat:'+stableDigest(chat.owner)||
    context.route.scopeId!==goal.scopeId||context.route.entryId!==goal.entryId||context.actor!==goal.actor||goal.actor!==JSON.stringify([chat.sourceId,chat.actor])||
    h.scopes.binding(goal.entryId).privateActor!==goal.actor||!humanRun(h,goal.triggerId,chat))return []
 const targetOwner=h.scopes.ownership(ticketId)
 if(!targetOwner)return []
 try{
  h.scopes.checkTask(ticketId,context)
  h.scopes.checkTaskEntry(targetOwner,context.route.entryId,'result')
 }catch{return []}
 const materials=h.store.db.prepare("SELECT id FROM records WHERE kind='asset' AND json_extract(body,'$.kind')='task-handoff' AND json_extract(body,'$.ticketId')=? ORDER BY id").all(ticketId)
  .flatMap(row=>{const id=String(row.id),m=visible<HandoffMaterial>(h,'asset',id);return m?.id===id?[m]:[]})
 return receipts.flatMap(row=>{
  const id=String(row.id),r=visible<Handoff>(h,'chat-file-handoff',id)
  if(!r||r.conversationId!==chat.id||r.outcome?.missing?.length!==0||!humanRun(h,r.triggerId,chat))return []
  const files=materials.filter(m=>m.id===stableDigest(['task-handoff',id,m.relativePath]))
  const sourceTicketId=files[0]?.sourceTicketId
  if(!sourceTicketId||sourceTicketId===ticketId||files.some(m=>m.sourceTicketId!==sourceTicketId))return []
  const owner=h.scopes.ownership(sourceTicketId)
  if(!owner)return []
  try{h.goals.checkWorkspaceSource({ticketId:sourceTicketId,ownerEpoch:owner.ownerEpoch,dataRevision:owner.dataRevision??1},context)}
  catch{return []}
  // An operator restore is content-addressed. Legacy Chat receipts were keyed by the answered decision.
  let exchanges:NonNullable<ReturnType<typeof answeredExchange>>[]=[]
  if(r.files){
   const parsed=retainedFileHandoffSchema.safeParse({ticketId,sourceTicketId:r.sourceTicketId,files:r.files})
   if(!parsed.success||r.sourceTicketId!==sourceTicketId||id!==stableDigest(['retained-files',chat.id,parsed.data])||
      files.length!==r.files.length||!r.files.every(f=>files.some(m=>m.relativePath===f.path&&m.sha256===f.sha256&&m.bytes===f.bytes)))return []
  }else{
   if(!r.paths?.length||!r.paths.every(path=>files.some(m=>m.relativePath===path)))return []
   const exchange=answeredExchange(h,chat,ticketId,id)
   if(exchange&&r.question===exchange.question.text&&r.triggerId===exchange.answer.runId)exchanges=[exchange]
  }
  return [{receiptId:id,triggerId:r.triggerId,conversationId:chat.id,ticketId,sourceTicketId,state:'ready',
   files:files.map(({id,relativePath,path,bytes,sha256})=>({resource:'asset/'+id,relativePath,path,bytes,sha256})),exchanges}]
 })
}
