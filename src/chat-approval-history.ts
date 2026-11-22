import type {Store} from './store.ts'
import type {Approval} from './approvals.ts'
import {publicApproval,type ChatDecision} from './chat-workflow.ts'
import type {BusinessDecisionView} from './business-decisions.ts'
import {permissionCard, type PermissionAction} from './chat-permissions.ts'
import type {FileReview} from './chat.ts'
import {ChatError} from './chat-errors.ts'

export type HistoryCursor = {at:number; id:string}
export type HistoryResult = 'approved'|'denied'|'answered'|'closed'
export type HistoryFilter = {query?:string; result?:HistoryResult}
const pageSize = 20
const nativeScope = "kind='approval' AND json_extract(body,'$.chat.conversationId')=?"
const managedScope = "kind='chat-permission' AND json_extract(body,'$.actor.conversationId')=?"
const human = "coalesce(json_extract(body,'$.automatic'),0)=0"
const created = "json_extract(body,'$.createdAt')"
const completedPermissions = `((${nativeScope} AND json_extract(body,'$.status')!='pending' AND ${human}) OR
  (${managedScope} AND json_extract(body,'$.phase')!='pending'))`

export function pendingChatApprovals(store:Store, conversation:string) {
  const records = store.db.prepare(`SELECT kind,body FROM records WHERE
    (${nativeScope} AND ${human} AND json_extract(body,'$.status')='pending') OR
    (${managedScope} AND json_extract(body,'$.phase')='pending')`).all(conversation,conversation)
  const native:Approval[] = [], managed:PermissionAction[] = []
  for(const row of records){
    const body=JSON.parse(String(row.body))
    if(row.kind==='approval')native.push(body)
    else managed.push(body)
  }
  return {native,managed}
}

export function transcriptApprovals(store:Store, conversation:string, window:{from:number;until:number;worker?:string;run?:string}) {
  // The message page's time window determines which approval notices belong in the transcript.
  const rows=store.db.prepare(`SELECT kind,body FROM records WHERE ${completedPermissions}
    AND (${human} OR json_extract(body,'$.phase')='uncertain' OR json_extract(body,'$.receipt.success')=0
      OR EXISTS(SELECT 1 FROM records job WHERE job.kind='work' AND job.id=json_extract(records.body,'$.jobId') AND json_extract(job.body,'$.state')='failed'))
    AND ${created} BETWEEN ? AND ?
    AND (? IS NULL OR coalesce(json_extract(body,'$.chat.workerId'),json_extract(body,'$.actor.workerId'))=?)
    AND (? IS NULL OR coalesce(json_extract(body,'$.chat.runId'),json_extract(body,'$.actor.runId'))=?)
    ORDER BY ${created} DESC,id DESC`).iterate(conversation,conversation,window.from,window.until,
      window.worker??null,window.worker??null,window.run??null,window.run??null)
  return Array.from(rows,row=>{
    const request=row.kind==='approval'?publicApproval(JSON.parse(String(row.body))):permissionCard(JSON.parse(String(row.body)),store)
    // The transcript only needs the sentence. Full command text is fetched on opening an archive item.
    const facts:Record<string,string>={}
    for(const key of ['tool','reason','target'])if(request.facts[key])facts[key]=request.facts[key]!.slice(0,360)
    if(request.facts.command)facts.command='…'
    return {...request,facts}
  })
}

type StoredMessage = {id:string;text:string;createdAt:number;fileReview?:FileReview;decision?:ChatDecision}
function entry(store:Store,kind:string,body:string) {
  if(kind==='chat-message'){
    const message:StoredMessage=JSON.parse(body)
    if(message.decision?.answer)return {kind:'choice' as const,id:message.id,createdAt:message.createdAt,decision:message.decision}
    return {kind:'file' as const,id:message.id,name:message.text,createdAt:message.createdAt,review:message.fileReview!}
  }
  if(kind==='business-decision'){
    const {id,createdAt}:Pick<BusinessDecisionView,'id'|'createdAt'>=JSON.parse(body)
    return {kind:'question' as const,id,createdAt}
  }
  const request=kind==='approval'?publicApproval(JSON.parse(body)):permissionCard(JSON.parse(body),store)
  return {kind:'approval' as const,id:request.id,createdAt:request.createdAt,request}
}

const archiveScope = `(
  (${completedPermissions} AND ${human} AND
    (coalesce(json_extract(body,'$.native.method'),'')!='item/tool/requestUserInput' OR json_extract(body,'$.outcome')='answered'))
  OR (kind='chat-message' AND json_extract(body,'$.conversationId')=? AND id NOT GLOB 'card-preview:*'
    AND (json_extract(body,'$.fileReview.state') IN ('approved','denied','superseded','cancelled')
      OR length(json_extract(body,'$.decision.answer'))>0))
  OR (kind='business-decision' AND json_extract(body,'$.status')='answered'
    AND EXISTS(SELECT 1 FROM records action JOIN records run
      ON run.kind='chat-run' AND run.id=json_extract(action.body,'$.triggerId')
      WHERE action.kind='business-decision-action' AND json_extract(action.body,'$.decisionId')=records.id
        AND json_extract(run.body,'$.conversationId')=?
        AND json_extract(run.body,'$.decisionTicketId')=json_extract(records.body,'$.ticketId')))
)`
const state = `coalesce(json_extract(body,'$.phase'),json_extract(body,'$.outcome'),
  json_extract(body,'$.fileReview.state'),CASE WHEN length(json_extract(body,'$.decision.answer'))>0 THEN 'answered' END,
  json_extract(body,'$.status'))`
const label = `coalesce(json_extract(body,'$.notice'),json_extract(body,'$.native.params.reason'),
  json_extract(body,'$.native.params.questions[0].question'),json_extract(body,'$.fileReview.notice'),
  json_extract(body,'$.decision.question'),json_extract(body,'$.question'),
  CASE WHEN kind='chat-message' THEN json_extract(body,'$.text') END,'')`
const result = `CASE WHEN state IN ('denied','answered') THEN state
  WHEN state IN ('cancelled','expired','superseded','resolved') THEN 'closed' ELSE 'approved' END`

// Use the immutable creation time and ID so simultaneous requests and concurrent decisions cannot shift offsets.
export function approvalHistory(store:Store, conversation:string, cursor?:HistoryCursor, filter:HistoryFilter={}) {
  const rows=store.db.prepare(`WITH archive AS (
    SELECT kind,id,${created} AS at,${label} AS label,${state} AS state,
      CASE WHEN json_extract(body,'$.fileReview.state') IS NOT NULL THEN json_extract(body,'$.text') END AS name,
      coalesce(json_extract(body,'$.tool'),json_extract(body,'$.native.method'),'') AS tool
    FROM records WHERE ${archiveScope} AND (${created},id)<(?,?)
  ) SELECT *,${result} AS result FROM archive
    WHERE (? IS NULL OR ${result}=?)
      AND instr(lower(label||' '||coalesce(name,'')||' '||tool),lower(?))>0
    ORDER BY at DESC,id DESC LIMIT ?`).all(
      conversation,conversation,conversation,conversation,
      cursor?.at??Number.MAX_SAFE_INTEGER,cursor?.id??'',filter.result??null,filter.result??null,filter.query??'',pageSize+1)
  const items=rows.slice(0,pageSize).map(row=>({
    id:String(row.id),createdAt:Number(row.at),kind:String(row.kind),state:String(row.state),result:row.result as HistoryResult,
    label:String(row.name||row.label||'').slice(0,360),tool:String(row.tool||''),
  }))
  const last=items.at(-1)
  return {items,next:rows.length>pageSize && last ? {at:last.createdAt,id:last.id} : null}
}

export function approvalHistoryItem(store:Store, conversation:string, id:string) {
  const row=store.db.prepare(`SELECT kind,body FROM records WHERE id=? AND ${archiveScope}`).get(id,conversation,conversation,conversation,conversation)
  if(!row)throw new ChatError('approval_missing','Approval record not found.',404)
  return entry(store,String(row.kind),String(row.body))
}
