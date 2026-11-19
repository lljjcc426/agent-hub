import type { ChatPlan, goalPlan } from './chat-workflow.ts'

type Step = { id: string; title: string; state?: string }
type Plan = Omit<ChatPlan, 'conversationId' | 'activityId'>

export interface ChatTask {
  id: string
  workerId: string
  title: string
  state: string
  reviewing: boolean
  updatedAt: number
  parentPlanId?: string
  question?: string
  summary?: string
  failed?: boolean
}

export interface TaskActivity {
  id: string
  title: string
  state: string
  objective?: string
  nextAction?: string
  updatedAt: number
  steps: Step[]
  tickets: ChatTask[]
}

interface ActivityInput {
  plans: ReturnType<typeof goalPlan>[]
  publicPlans: Plan[]
  sessionRouterPlans?: Plan[]
  tasks: ChatTask[]
}

export function taskActivities({ plans, publicPlans, sessionRouterPlans, tasks }: ActivityInput): TaskActivity[] {
  const activities: TaskActivity[] = []
  const tasksById = new Map(tasks.map(task => [task.id, task]))
  const goalTickets = new Set<string>()
  const goalRuns = new Set(plans.map(goal => goal.runId))
  const goalPlanIds = new Set<string>()
  for (const goal of plans) {
    const tickets: ChatTask[] = []
    for (const id of goal.ticketIds) {
      goalTickets.add(id)
      const ticket = tasksById.get(id)
      if (ticket) {
        tickets.push(ticket)
        if (ticket.parentPlanId) goalPlanIds.add(ticket.parentPlanId)
      }
    }
    activities.push({
      id: 'goal:' + goal.id, title: goal.title, state: goal.state, objective: goal.objective,
      nextAction: goal.nextAction, updatedAt: goal.createdAt, steps: goal.steps, tickets,
    })
  }

  const routerPlans = new Map<string, TaskActivity>()
  const standalonePlans = new Set(tasks.filter(task => !goalTickets.has(task.id)).map(task => task.parentPlanId))
  for (const plan of sessionRouterPlans ?? publicPlans) {
    // Worker plans describe their ticket. A Router checklist can also describe a durable goal.
    if (plan.ticketId || plan.workerId) continue
    if (!standalonePlans.has(plan.id) && (goalRuns.has(plan.runId) || goalPlanIds.has(plan.id))) continue
    const state = plan.steps.every(s => s.state === 'completed') ? 'completed'
      : plan.steps.some(s => s.state === 'blocked') ? 'blocked'
      : plan.steps.some(s => s.state === 'running') ? 'running' : 'planned'
    const activity: TaskActivity = {
      id: plan.id, title: plan.title, state, updatedAt: plan.updatedAt ?? plan.createdAt ?? 0,
      steps: plan.steps, tickets: [],
    }
    routerPlans.set(plan.id, activity)
    activities.push(activity)
  }

  for (const ticket of tasks) {
    if (goalTickets.has(ticket.id)) continue
    const plan = ticket.parentPlanId && routerPlans.get(ticket.parentPlanId)
    if (plan) plan.tickets.push(ticket)
    else activities.push({
      id: 'ticket:' + ticket.id, title: ticket.title, state: ticket.reviewing ? 'reviewing' : ticket.state,
      updatedAt: ticket.updatedAt, steps: [], tickets: [ticket],
    })
  }
  for (const plan of routerPlans.values()) {
    if (plan.state !== 'completed') continue
    // Finishing a checklist's delegation step does not finish the work it assigned.
    const states = new Set(plan.tickets.map(ticket => ticket.reviewing ? 'reviewing' : ticket.state))
    plan.state = ['waiting', 'running', 'reviewing', 'queued', 'cancelled'].find(state => states.has(state)) ?? plan.state
  }
  for (const activity of activities) {
    for (const ticket of activity.tickets) activity.updatedAt = Math.max(activity.updatedAt, ticket.updatedAt)
  }
  return activities.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}
