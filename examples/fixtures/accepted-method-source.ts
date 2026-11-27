import type {Runtime} from '../../src/runtime.ts'
import type {ScopeContext} from '../../src/router-scope.ts'
import type {z} from 'zod'
import type {automationTemplateSchema} from '../../src/webhooks.ts'
import type {RouterGoal} from '../../src/router-goals.ts'

/** Local example data. The host builds the evidence snapshot; the independent review is simulated. */
export async function acceptedMethodSource(host:Runtime, context:ScopeContext,template?:z.input<typeof automationTemplateSchema>) {
 const workerId=host.scopes.scope(context.route.scopeId).workerIds[0]!
 const title=template?.title??'周报校对 · 示例方法'
 const goal=host.goals.command({action:'start',operationId:'example-method-source',expectedRevision:0,title,
  objective:'核对周报中的结论和引用',authorizationQuote:context.trigger.text,
  criteria:[{id:'sources',description:'结论与来源逐项对应'}],
  nodes:[{id:'check',title:'核对引用',instruction:'逐项核对周报中的结论与引用。',workerId,criterionIds:['sources']}],...template},context) as RouterGoal
 return acceptExampleGoal(host,context,goal)
}

export async function acceptExampleGoal(host:Runtime,context:ScopeContext,goal:RouterGoal){
 const workerId=goal.nodes![0]!.workerId!
 const existing=host.goals.get(goal.id)!
 if(existing.finalRoundId)return {goalId:goal.id,acceptanceId:existing.finalRoundId}
 const assignment=await host.manager.call({action:'assign',id:workerId,revision:host.settings.current().revision,requestId:'example-method-task:'+goal.id,text:goal.title},
  {discussion:context.route.discussion,trigger:context.trigger,scoped:context})
 const ticket=host.store.tickets.get(assignment.ticketId)!,last=ticket.assignments.at(-1)!
 host.engine.assignmentStarted(ticket.id,last.id)
 goal.taskIds=[ticket.id]
 const node=goal.nodes![0]!
 node.ticketId=ticket.id
 node.state='passed'
 host.store.put('router-goal',goal.id,goal)
 host.verification.capture(ticket.id,{state:'ready',summary:'本地样例中两处引用均已核对。'},'引用与周报结论一致。')
 const round=host.verification.ensure(goal)
 const evidenceIds=round.snapshot.evidence.filter(item=>item.key==='delivery').map(item=>item.id)
 if(!evidenceIds.length)throw Error('Example method lacks a recorded delivery')
 host.store.put('goal-verification',round.id,{...round,state:'passed',finishedAt:Date.now(),
  checks:[...goal.criteria.map(cr=>cr.id),'__goal__'].map(criterionId=>({criterionId,verdict:'passed',method:'agent',evidenceIds,explanation:'本地演示验收记录。'}))})
 host.store.put('router-goal',goal.id,{...goal,state:'completed',finalRoundId:round.id})
 return {goalId:goal.id,acceptanceId:round.id}
}

export async function acceptedExampleMethod(host:Runtime,context:ScopeContext,template?:z.input<typeof automationTemplateSchema>){
 const {goalId}=await acceptedMethodSource(host,context,template)
 const draft=host.skills.command({action:'draft',goalId},context)
 const saved=host.skills.command({action:'save',goalId,expectedVersion:0,template:draft.template},context)
 return {id:saved.id,version:saved.version}
}
