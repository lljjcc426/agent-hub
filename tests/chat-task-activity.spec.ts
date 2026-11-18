import { describe, expect, it } from 'vitest'
import { taskActivities } from '../web/chat/task-activity.ts'

type Input = Parameters<typeof taskActivities>[0]
const empty: Input = { plans: [], tasks: [], publicPlans: [] }
const done = { id: 'review', title: 'Delegate the review', state: 'completed' as const }
const checklist = { id: 'plan:release', runId: 'turn-1', title: 'Release guide', steps: [done], live: false }
const ticket = (id: string, state: string, parentPlanId?: string): Input['tasks'][number] => ({
  id, parentPlanId, workerId: 'reviewer', title: 'Review the draft', state, reviewing: false, updatedAt: 12,
})

describe('session task activity', () => {
  it('shows no activity for a conversation without recorded work', () => {
    expect(taskActivities(empty)).toEqual([])
  })

  it('keeps independent assignments separate even with the same title and assignee', () => {
    const tasks = [ticket('one', 'completed'), ticket('two', 'waiting')]
    expect(taskActivities({ ...empty, tasks }).map(a => a.id)).toEqual(['ticket:one', 'ticket:two'])
  })

  it('updates a single checklist across delegation, waiting and completion', () => {
    for (const state of ['queued', 'running', 'waiting', 'completed']) {
      const tasks = [ticket('one', state, checklist.id)]
      const workerPlan = { ...checklist, id: 'worker-plan', runId: 'turn-2', workerId: 'reviewer', ticketId: 'one' }
      const items = taskActivities({ ...empty, publicPlans: [checklist, workerPlan], tasks })
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ id: checklist.id, state, tickets: tasks, updatedAt: 12 })
    }
  })

  it('collects related tickets and their checklists under the durable goal, including across turns', () => {
    const plans: Input['plans'] = [{
      id: 'g', runId: 'turn-2', createdAt: 1, title: 'Ship', objective: 'Publish the guide',
      nextAction: 'Check release artifacts', state: 'active', steps: [], ticketIds: ['one', 'two'],
    }]
    const tasks = [ticket('one', 'completed', checklist.id), ticket('two', 'completed')]
    const items = taskActivities({ plans, tasks, publicPlans: [checklist] })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'goal:g', state: 'active', tickets: tasks })
    const independent = ticket('three', 'waiting', 'unrelated')
    const extra = { ...checklist, id: 'unrelated', runId: 'turn-2' }
    expect(taskActivities({ plans, tasks: [...tasks, independent], publicPlans: [checklist, extra] })
      .map(item => item.id)).toEqual(['goal:g', 'unrelated'])
  })
})
