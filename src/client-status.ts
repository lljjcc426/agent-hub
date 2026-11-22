import type {Runtime} from './runtime.ts'
import type {RouterGoal} from './router-goals.ts'
import type {Run} from './store.ts'
import {ticketStage,type Ticket} from './vendor/dsh-core/index.ts'

type Filter={discussion?:string;requestId?:string}
type RouterResult={discussion:string;reply:string;threadId?:string;turnId?:string}

/** Select the compact view at the store so polling never hydrates the operator history. */
export function clientStatus(host:Runtime,filter:Filter={}){
 const {store}=host,db=store.db,discussion=filter.discussion??null
 const filtered=!!(filter.discussion||filter.requestId),replyLimit=filtered?4000:1000
 const requestSuffix=filter.requestId?':'+filter.requestId:null
 const wanted=filtered?db.prepare(`SELECT e.id FROM records AS e WHERE e.kind='trigger'
   AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(e.body,'$.threads') AS t WHERE json_extract(t.value,'$.id')=?))
   AND (? IS NULL OR substr(e.id,-length(?))=?)`).all(discussion,discussion,requestSuffix,requestSuffix,requestSuffix).map(r=>String(r.id)):[]
 const ids=JSON.stringify(wanted)
 const selected=filtered?db.prepare(`
   WITH wanted AS (SELECT value FROM json_each(?))
   SELECT t.body,count(*) OVER () AS matching FROM records AS t WHERE t.kind='ticket'
     AND (json_extract(t.body,'$.origin.triggerId') IN wanted
       OR EXISTS(SELECT 1 FROM json_each(t.body,'$.inputs') AS i WHERE json_extract(i.value,'$.kind')='trigger'
         AND json_extract(i.value,'$.triggerId') IN wanted))
   ORDER BY t.rowid DESC LIMIT 10`).all(ids)
   :db.prepare("SELECT body,(SELECT count(*) FROM records WHERE kind='ticket') AS matching FROM records WHERE kind='ticket' ORDER BY rowid DESC LIMIT 5").all()
 const totalMatching=Number(selected[0]?.matching??0)
 const tickets=selected.map(row=>{
  const t=JSON.parse(String(row.body)) as Ticket,run=store.get<Run>('run',t.id),origin=store.triggers.get(t.origin.triggerId)
  return {id:t.id,title:t.title.slice(0,160),origin:{triggerId:t.origin.triggerId},discussion:origin?.threads[0]?.id,stage:ticketStage(t),ended:t.ended,attention:t.attention?{question:t.attention.question.slice(0,1000)}:undefined,resultResource:'ticket/'+t.id+'/result',...(run?{run:{phase:run.phase,result:run.result?.slice(0,replyLimit),replyTruncated:!!run.result&&run.result.length>replyLimit,error:run.error,threadId:run.threadId,turnId:run.turnId,backendId:run.backendId,backendKind:run.backendKind,...((!run.backendKind||run.backendKind==='codex')?{nativeThreadId:run.threadId,nativeTurnId:run.turnId}:{})}}:{})}
 })
 const matchesDiscussion=`(? IS NULL OR json_extract(body,'$.discussion')=? OR substr(json_extract(body,'$.discussion'),-length(?))=?)`
 const discussionValues=[discussion,discussion,discussion===null?null:':'+discussion,discussion===null?null:':'+discussion] as const
 const recent=db.prepare(`SELECT body FROM records WHERE kind=? AND ${matchesDiscussion} ORDER BY rowid DESC LIMIT 10`)
 const recentRecords=<T>(kind:string)=>recent.all(kind,...discussionValues).reverse().map(r=>JSON.parse(String(r.body)) as T)
 const routerResults=recentRecords<RouterResult>('router-result').map(r=>({discussion:r.discussion,reply:r.reply.slice(0,replyLimit),threadId:r.threadId,turnId:r.turnId}))
 const routerErrors=recentRecords<unknown>('router-error')
 const candidates=db.prepare(`SELECT body FROM records WHERE kind='router-goal' AND ${matchesDiscussion}
   AND (? IS NULL OR json_extract(body,'$.triggerId') IN (SELECT value FROM json_each(?))) ORDER BY rowid`)
   .all(...discussionValues,requestSuffix,ids).map(r=>JSON.parse(String(r.body)) as RouterGoal)
 const goals=host.goals.snapshot(candidates).slice(-20).map(g=>({id:g.id,triggerId:g.triggerId,discussion:g.discussion,title:g.title,state:g.state,nextAction:g.nextAction,reason:g.reason,nextAt:g.nextAt,turns:g.turns,maxTurns:g.maxTurns,taskIds:g.taskIds,criteria:g.criteria,checks:g.checks,finalRoundId:g.finalRoundId,planRevision:g.planRevision,replans:g.replans,maxReplans:g.maxReplans,replanId:g.replanId,recovery:g.recovery,...(g.project?{project:{base:g.project.base,integration:g.project.integration,review:g.project.review,budget:g.project.policy.budget}}:{}),nodes:g.nodes?.map(n=>({id:n.id,title:n.title,state:n.state,ticketId:n.ticketId,dependsOn:n.dependsOn,roundId:n.roundId,repairs:n.repairs,recoveries:n.recoveries,retryAt:n.retryAt,reason:n.reason}))}))
 return {routerResults,routerErrors,goals,paused:host.isPaused,active:host.activeExecutions,tickets,totalMatching,more:totalMatching>tickets.length,catalog:'catalog',detail:'Use agent_read with a task resource for history, files or the complete result. Goals remain unresolved until state=completed; held/needs_input are not success.'}
}
