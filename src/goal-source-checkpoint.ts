import type {Store,Run} from './store.ts'
import type {Ticket} from './vendor/dsh-core/index.ts'
import type {TaskOwnership} from './router-scope.ts'
import type {PluginThread} from './backends/plugin-process.ts'
import {repositoryEffectsSettled} from './repository-source.ts'

// A source hold parks even a previously queued start. Recognize only a start
// matching its pending assignment, or a host-cancelled attempt with every
// backend effect accounted for. No job, callback or attempt is settled here.
export function sourceHeldNode(store:Pick<Store,'db'|'get'|'list'>,ticket:Ticket,run:Run,owner:TaskOwnership):'start'|'interrupted'|undefined{
 const id=ticket.id,assignment=ticket.assignments.at(-1)
 const thread=run.threadId?store.get<PluginThread>('backend-plugin-thread',run.threadId):undefined
 const session=thread&&store.get<{ticketId?:string}>('model-session',thread.id)
 if(!assignment||!thread||session?.ticketId!==id||thread.cwd!==run.cwd||!repositoryEffectsSettled(store,id)||
   !Array.isArray(thread.effectIds)||thread.effectIds.some(key=>{
    const effect=store.get<{state:string;result?:{permission?:string}}>('backend-plugin-tool',key)
    return effect?.state!=='complete'||!effect.result||effect.result.permission==='uncertain'
   }))return
 const attempt=store.get<{attemptId:string;assignmentId:string}>('async-worker-current',id)
 if(!attempt||attempt.assignmentId!==run.assignmentId)return
 const terminal=store.get<{ticketId:string;assignmentId:string}>('async-worker-terminal',attempt.attemptId)
 if(owner.state==='active'&&assignment.state==='pending'&&!assignment.report&&assignment.id!==run.assignmentId&&
  thread.state==='completed'&&terminal?.ticketId===id&&terminal.assignmentId===run.assignmentId&&
  ticket.assignments.some(a=>a.id===run.assignmentId&&a.state==='ended')&&
  store.db.prepare("SELECT 1 FROM jobs WHERE id=? AND kind='start' AND state='pending' AND json_extract(payload,'$.ticketId')=? AND json_extract(payload,'$.assignmentId')=?").get('start:'+assignment.id,id,assignment.id))return 'start'
 const hold=store.get<{reason:string;state:string;threadId:string;previousContext:string}>('context-rebuild',id)
 const context=store.get<{manifest:{id:string}}>('task-context',id)
 const activation=store.get<{ticketId:string;assignmentId:string;causeJobId?:string}>('async-worker-attempt',attempt.attemptId)
 if(owner.state==='held'&&owner.reason==='context_permissions_changed'&&hold?.state==='held'&&hold.reason===owner.reason&&
  context?.manifest.id&&context.manifest.id===hold.previousContext&&hold.threadId===run.threadId&&thread.state==='interrupted'&&
  thread.lastFailure?.code==='cancelled'&&assignment.id===run.assignmentId&&assignment.state==='running'&&
  assignment.report?.state==='blocked'&&!terminal&&activation?.ticketId===id&&activation.assignmentId===run.assignmentId&&
  activation.causeJobId&&store.db.prepare("SELECT 1 FROM jobs WHERE id=? AND kind='execute' AND state='done' AND json_extract(payload,'$.ticketId')=? AND json_extract(payload,'$.assignmentId')=?").get(activation.causeJobId,id,assignment.id))return 'interrupted'
}
