import type {Run,Store} from './store.ts'
import type {Ticket} from './vendor/dsh-core/index.ts'

/** Live steering can deliver a group of inputs before its queue entry is claimed. */
export function consumedInputWake(jobId:string,assignmentId:string,ticket:Ticket|undefined,run:Run|undefined){
 if(!ticket||ticket.undelivered.length||run?.ticketId!==ticket.id||run.assignmentId!==assignmentId||
   run.phase!=='idle'||!run.prepared||run.waitingForWriter||ticket.assignments.at(-1)?.id!==assignmentId)return false
 const prefix='execute:'+assignmentId+':'
 return jobId.startsWith(prefix)&&/^[a-f0-9]{64}$/.test(jobId.slice(prefix.length))
}

/** These unclaimed jobs only ask execute() to read the current undelivered
 * inputs. Their payload carries no tool command or earlier input to replay. */
export function retainedInputWakes(store:Pick<Store,'db'>,run:Run){
 const rows=store.db.prepare(`SELECT id,kind,state,attempts,json_extract(payload,'$.ticketId') AS ticket,
  json_extract(payload,'$.assignmentId') AS assignment FROM jobs WHERE state IN ('pending','running','blocked','uncertain')
  AND (json_extract(payload,'$.ticketId')=? OR json_extract(payload,'$.assignmentId')=?)`).all(run.ticketId,run.assignmentId)
 const prefix='execute:'+run.assignmentId+':'
 if(rows.every(row=>row.kind==='execute'&&row.state==='pending'&&row.attempts===0&&row.ticket===run.ticketId&&
    row.assignment===run.assignmentId&&String(row.id).startsWith(prefix)&&/^[a-f0-9]{64}$/.test(String(row.id).slice(prefix.length))))return rows.map(row=>String(row.id))
}

/** A projection for a fresh session. The core ticket and its immutable Mandate
 * remain the audit record; quarantined text is never silently re-authorized. */
export interface TaskContinuation {
 ticketId:string;triggerId:string;discussion:string;text:string;at:number;
 inputIds:string[];priorAssignments:string[];priorReports:{id:string;at?:string}[];priorJobs:string[];priorMessages:string[];priorToolCalls:string[];
 previousThread?:string;workspaceReviewed:boolean
}
export function taskView(store:Store,ticket:Ticket):Ticket {
 const c=store.get<TaskContinuation>('task-continuation',ticket.id)
 if(!c)return ticket
 return {...ticket,title:c.text.slice(0,100),attention:undefined,execution:undefined,delivery:undefined,answers:[],ended:ticket.ended?{...ticket.ended,reason:undefined}:undefined,mandate:{...ticket.mandate,scope:c.text},
  origin:{...ticket.origin,triggerId:c.triggerId,triggerIds:[c.triggerId]},follows:[],
  inputs:ticket.inputs.filter(i=>c.inputIds.includes(i.id)),undelivered:ticket.undelivered.filter(id=>c.inputIds.includes(id)),
  assignments:ticket.assignments.map(a=>({...a,endedReason:undefined,report:c.priorReports.some(p=>p.id===a.id&&p.at===a.report?.at)?undefined:a.report}))}
}
export function allowNewTaskInputs(store:Store,ticketId:string,previous:string[]){
 const c=store.get<TaskContinuation>('task-continuation',ticketId),ticket=store.tickets.get(ticketId)
 if(c&&ticket)store.put('task-continuation',ticketId,{...c,inputIds:[...new Set([...c.inputIds,...ticket.inputs.filter(i=>!previous.includes(i.id)).map(i=>i.id)])]})
}
