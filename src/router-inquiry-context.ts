import type { RouterGoal } from './router-goals.ts'
import type { Ticket } from './vendor/dsh-core/index.ts'
import { protocolBytes } from './context-budget.ts'
import { previewText } from './working-context.ts'

export interface InquiryTask {
  ticketId: string
  workerId: string
  title: string
  ended?: Ticket['ended']
  report?: {state:string; summary:string; at:string}
}
interface WorkerName { id:string; label?:string }
export interface StatusQuestion { contact:boolean; workerIds:string[]; ticketId?:string }

const contactZh = /^(?:请|麻烦)?(?:你)?(?:帮我|替我)?(?:去)?(?:和@(?:沟通|联系|核对|确认)(?:一下|下)?|(?:问问|问一下|问下|询问|联系)@)(?:一下|下)?(?:看看|问问|确认|了解|查下)?(?:他的|它的|该任务的|的)?(?:最新|当前|现在|目前)?(?:任务|工作)?(?:进度|进展)(?:如何|怎么样|到哪了)?$/u
const statusZh = /^(?:请)?(?:帮我)?(?:看看|查一下|查下|查看|告诉我|更新一下)?@?(?:的)?(?:最新|当前|现在|目前)?(?:任务|工作)?(?:进度|进展)(?:如何|怎么样|到哪了)?$/u
const contactEn = /^(?:please )?(?:ask|check with|contact) @ (?:for |about |on )?(?:its |their |the |a )?(?:latest |current )?(?:progress|status)(?: update)?$/u
const statusEn = /^(?:please )?(?:(?:check|show|give me) |what(?:'s| is) )?(?:(?:the|a|current|latest|task) )*(?:@(?:'s)? )?(?:progress|status)(?: update)?(?: (?:of|on|for) @)?$/u

function mode(value:string) {
  const compact=value.replace(/[\s,，、]+/gu,'')
  if(contactZh.test(compact)||contactEn.test(value)||
    /^(?:请|麻烦)?(?:帮我|替我)?(?:问问|问一下|问下)(?:最新|当前|目前)?(?:进展|进度)$/u.test(compact)||
    /^(?:please )?ask (?:for |about )?(?:a |the )?(?:progress|status) update$/u.test(value))return true
  if(statusZh.test(compact)||statusEn.test(value))return false
}

/** Recognize only a complete status question. Every other utterance stays on the ordinary Router path. */
export function statusQuestion(text:string, workers:readonly WorkerName[], tasks:readonly InquiryTask[]):StatusQuestion|undefined {
  if(text.length>300)return
  const normalize=(s:string)=>s.normalize('NFKC').toLowerCase().trim()
  const body=normalize(text).replace(/[。.!?！？]+$/u,'').trim()
  if(body.includes('@')||!body)return
  const plain=mode(body)
  if(plain!==undefined)return {contact:plain,workerIds:[]}
  const matched=new Set<string>()
  let contact:boolean|undefined, ticketId:string|undefined
  for(const task of tasks){
    if(!body.includes(task.ticketId))continue
    const value=mode(body.replace(task.ticketId,'@'))
    if(value!==undefined){ticketId=task.ticketId;contact=value;matched.add(task.workerId)}
  }
  for(const worker of workers){
    for(const alias of new Set([worker.id,worker.label])){
      if(!alias)continue
      const name=normalize(alias)
      if(!name||!body.includes(name))continue
      const value=mode(body.replace(name,'@'))
      if(value!==undefined){contact=value;matched.add(worker.id)}
    }
  }
  if(contact!==undefined)return {contact,workerIds:[...matched],ticketId}
}

export const inquiryInventoryBytes = 24 * 1024
const inquiryHistoryBytes = 12 * 1024

export function inquiryInventory(tasks:readonly InquiryTask[], goals:readonly RouterGoal[], question:StatusQuestion,
  workers:readonly WorkerName[], revision:number) {
  const labels=new Map(workers.map(w=>[w.id,w.label??w.id]))
  const topic=(title:string)=>{
    if(title.startsWith('{'))try{
      const data=JSON.parse(title)
      if(typeof data.node?.title==='string')return data.node.title
      if(typeof data.objective==='string')return data.objective
    }catch{/* A task title may be arbitrary user text. */}
    return title
  }
  return {
    tasks:tasks.map(t=>{
      const relevant=!question.workerIds.length||question.workerIds.includes(t.workerId)
      return {ticketId:t.ticketId,workerId:t.workerId,workerLabel:labels.get(t.workerId),title:previewText(topic(t.title),240),
        ended:t.ended?{by:t.ended.by,outcome:t.ended.outcome}:undefined,
        report:t.report&&{state:t.report.state,at:t.report.at,summary:previewText(t.report.summary,relevant?1100:160)}}
    }),
    goals:goals.map(g=>({id:g.id,title:previewText(g.title,240),state:g.state,revision:g.revision,taskIds:g.taskIds,
      nextAction:g.nextAction&&previewText(g.nextAction,180),
      nodes:['completed','cancelled'].includes(g.state)?undefined:g.nodes?.map(n=>({
        id:n.id,ticketId:n.ticketId,title:previewText(n.title,180),state:n.state,workerId:n.workerId,dependsOn:n.dependsOn,
      }))})),

    workerStatus:{revision,contactRequested:question.contact,
      notice:'This authorized index includes the current Worker management revision. Match the task by its goal node title and state: a passed node and a running node can both have waiting Worker reports. For a status question use its dated report. For a request to ask the Worker, send the original question to the matching ticket now with worker_manage send, expectReply=true, this revision and a stable requestId. Read list or inspect when the index does not resolve the target or evidence. Original records remain available with worker_manage result, router_goal inspect and router_read.'},
  }
}

/** Keep the newest complete events and a reference to a large boundary event. Originals remain in the scoped journal. */
export function inquiryHistory<T extends {id:string;kind:string;text:string}>(events:readonly T[]) {
  let left=inquiryHistoryBytes
  const recent:(T|{id:string;kind:string;text:string;resource:string;partial:true})[]=[]
  for(let i=events.length-1;i>=0;i--){
    const e=events[i]!,size=protocolBytes(e)+1
    if(size<=left){recent.push(e);left-=size;continue}
    const ref={id:e.id,kind:e.kind,text:previewText(e.text,Math.min(480,Math.max(0,Math.floor(left/5)))),resource:'journal/'+e.id,partial:true as const}
    if(protocolBytes(ref)+1<=left)recent.push(ref)
    return {history:recent.reverse(),archive:{resource:'journal',requirements:'journal/requirements',total:events.length,
      notice:'Earlier messages are available by authorized paged read. Current requirements and recovery evidence are attached separately.'}}
  }
  return {history:events}
}
