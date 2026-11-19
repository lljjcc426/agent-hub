import type { TaskActivity } from './chat-task-activity.ts'
import type { ChatDecision, ChatPlan } from './chat-workflow.ts'
import type { ExecutionCall } from './execution-activity.ts'
import type { Store } from './store.ts'
import type { Ticket } from './vendor/dsh-core/index.ts'

export interface TaskExecutionEvent {
  id: string
  kind: 'created' | 'received' | 'started' | 'plan' | 'report' | 'closed' | 'result' | 'files' | 'reply' | 'opening'
  at: number
  ticketId?: string
  state?: string
  waitMs?: number
}

export type TaskExecutionCall = Pick<ExecutionCall,
  'id' | 'kind' | 'name' | 'action' | 'trace' | 'ticketId' | 'workerId' | 'agentId' |
  'state' | 'permission' | 'startedAt' | 'endedAt' | 'backend' | 'model'
> & { reported?: true }

export interface TaskExecutionDetail {
  activity: TaskActivity
  events: TaskExecutionEvent[]
  calls: TaskExecutionCall[]
  callsTruncated: boolean
  span: { from: number; to: number; complete: boolean } | null
}

export const taskCallLimit = 200
type Visible = (kind: 'chat-call' | 'chat-message' | 'ticket', id: string, value: unknown) => boolean
type Milestone = { id: string; runId: string; ticketId?: string; createdAt: number; role: 'user' | 'assistant';
  opening?: string; handoff?: 'result' | 'files'; decision?: ChatDecision }

const ms = (value?: string) => value === undefined ? NaN : Date.parse(value)
const valid = (value?: number): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

function ticketEvents(ticket: Ticket): TaskExecutionEvent[] {
  const ticketId = ticket.id
  const events: TaskExecutionEvent[] = [
    { id: 'created:' + ticketId, kind: 'created', at: ms(ticket.createdAt), ticketId },
  ]
  for (const assignment of ticket.assignments) {
    if (assignment.startedAt) {
      const at = ms(assignment.startedAt), queued = ms(assignment.createdAt)
      events.push({ id: 'started:' + assignment.id, kind: 'started', at, ticketId,
        waitMs: valid(queued) && queued <= at ? at - queued : undefined })
    }
    if (assignment.report) {
      events.push({ id: 'report:' + assignment.id, kind: 'report', at: ms(assignment.report.at),
        state: assignment.report.state, ticketId })
    }
  }
  if (ticket.ended) events.push({ id: 'closed:' + ticketId, kind: 'closed', at: ms(ticket.ended.at),
    state: ticket.ended.by === 'human' ? 'cancelled' : ticket.ended.outcome, ticketId })
  return events
}

export function taskExecutionDetail(store: Store, conversationId: string, activity: TaskActivity, source: {
  plan?: ChatPlan
  planTurn?: string
  goalCreatedAt?: number
}, visible: Visible): TaskExecutionDetail {
  const { plan, planTurn, goalCreatedAt } = source
  const tickets = activity.tickets.flatMap(task => {
    const ticket = store.tickets.get(task.id)
    return ticket && visible('ticket', ticket.id, ticket) ? [ticket] : []
  })
  const ticketIds = JSON.stringify(tickets.map(ticket => ticket.id))
  const turns = new Set(planTurn ? [planTurn] : [])
  if (plan) {
    for (const row of store.db.prepare(`SELECT body FROM records WHERE kind='chat-message'
      AND json_extract(body,'$.conversationId')=? AND json_extract(body,'$.decision.planId')=?
      AND json_type(body,'$.decision.replyRunId')='text'`).iterate(conversationId,plan.id)) {
      const message = JSON.parse(String(row.body)) as { id: string; decision: { replyRunId: string } }
      if (visible('chat-message',message.id,message)) turns.add(message.decision.replyRunId)
    }
  }
  const turnIds = JSON.stringify([...turns])
  const events = tickets.flatMap(ticketEvents)
  const createdAt = plan?.createdAt ?? goalCreatedAt
  if (valid(createdAt)) events.push({ id: 'created:' + activity.id, kind: 'created', at: createdAt })
  if (valid(plan?.updatedAt) && plan.updatedAt !== createdAt) {
    events.push({ id: 'plan:' + activity.id, kind: 'plan', at: plan.updatedAt })
  }
  let awaitingAnswer = false
  for (const row of store.db.prepare(`SELECT body FROM records WHERE kind='chat-message'
    AND id NOT GLOB 'card-preview:*' AND json_extract(body,'$.conversationId')=?
    AND ((json_extract(body,'$.handoff') IN ('result','files')
        AND json_extract(body,'$.status')='complete'
        AND json_extract(body,'$.ticketId') IN (SELECT value FROM json_each(?)))
      OR (json_extract(body,'$.runId') IN (SELECT value FROM json_each(?))
        AND json_extract(body,'$.recipient') IS NULL AND json_extract(body,'$.ticketId') IS NULL
        AND (json_extract(body,'$.role')='user' OR json_extract(body,'$.status')='complete')))`)
    .iterate(conversationId,ticketIds,turnIds)) {
    const message = JSON.parse(String(row.body)) as Milestone
    if (!visible('chat-message',message.id,message)) continue
    const kind = message.handoff ?? (message.role === 'user' ? 'received' : message.opening ? 'opening' : 'reply')
    events.push({id:message.id,kind,at:message.createdAt,ticketId:message.ticketId})
    const decision = message.decision
    if (turns.has(message.runId) && decision && !decision.closed && !decision.replyRunId && !decision.defaultOption) {
      const run = store.get<{cancelRequested?: boolean; cancelled?: boolean}>('chat-run',message.runId)
      if (run && !run.cancelRequested && !run.cancelled) awaitingAnswer = true
    }
  }

  // Ticket IDs cover continuations and older calls without a runId. Router
  // calls come from the plan's publishing activation or its exact original turn.
  const rows = store.db.prepare(`WITH RECURSIVE router_calls(id) AS (
    SELECT id FROM records WHERE kind='chat-call' AND json_extract(body,'$.conversationId')=?
      AND json_extract(body,'$.ticketId') IS NULL
      AND (id=? OR (json_extract(body,'$.triggerId')=json_extract(body,'$.runId')
        AND json_extract(body,'$.runId') IN (SELECT value FROM json_each(?))))
    UNION
    SELECT child.id FROM records child JOIN router_calls parent ON json_extract(child.body,'$.parentId')=parent.id
    WHERE child.kind='chat-call' AND json_extract(child.body,'$.conversationId')=?
      AND json_extract(child.body,'$.ticketId') IS NULL
  ) SELECT body FROM records WHERE kind='chat-call' AND json_extract(body,'$.conversationId')=?
    AND (json_extract(body,'$.ticketId') IN (SELECT value FROM json_each(?))
      OR id IN (SELECT id FROM router_calls))
    ORDER BY json_extract(body,'$.startedAt') DESC,id DESC`)
    .iterate(conversationId,plan?.activityId??null,turnIds,conversationId,conversationId,ticketIds)
  const calls: TaskExecutionCall[] = []
  let callsTruncated = false
  for (const row of rows) {
    const call = JSON.parse(String(row.body)) as ExecutionCall
    if (!valid(call.startedAt) || !visible('chat-call',call.id,call)) continue
    if (calls.length === taskCallLimit) { callsTruncated = true; break }
    const { id, kind, name, action, trace, ticketId, workerId, agentId,
      state, permission, startedAt, endedAt, backend, model } = call
    // Native OpenCode progress is recorded only when a tool reports its outcome.
    const reported = kind === 'tool' && name.startsWith('opencode/')
    calls.push({ id, kind, name, action, trace, ticketId, workerId, agentId,
      state, permission, startedAt, endedAt: valid(endedAt) && endedAt >= startedAt ? endedAt : undefined,
      backend, model, reported: reported || undefined })
  }
  calls.reverse()
  const ordered = events.filter(event => valid(event.at)).sort((a,b) => a.at-b.at)
  const times = [...ordered.map(event => event.at), ...calls.flatMap(call =>
    [call.startedAt, call.state === 'interrupted' || call.reported ? undefined : call.endedAt].filter(valid))]
  const ticket = activity.id.startsWith('ticket:') && tickets.length === 1 ? tickets[0] : undefined
  const from = ms(ticket?.createdAt), to = ms(ticket?.ended?.at)
  const span = valid(from) && valid(to) && from <= to ? {from,to,complete:true}
    : times.length > 1 ? {from:Math.min(...times),to:Math.max(...times),complete:false} : null
  const needsInput = awaitingAnswer && ['planned','running'].includes(activity.state)
    && !activity.tickets.some(ticket => ['queued','running'].includes(ticket.state))
    && !calls.some(call => call.state === 'running')
  return { activity:needsInput ? {...activity,state:'needs_input'} : activity, events:ordered, calls, callsTruncated, span }
}
