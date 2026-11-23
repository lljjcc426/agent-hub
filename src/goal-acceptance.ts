import type { RouterGoal } from './router-goals.ts'
import type { GoalNode } from './goal-contract.ts'
import type { GoalDelivery, VerificationRound } from './goal-verification.ts'
import type { TaskOwnership } from './router-scope.ts'
import type { Run, Store } from './store.ts'
import type { Ticket } from './vendor/dsh-core/index.ts'

export type EvidenceOverflow = {
  bytes: number
  limitBytes: number
  largest: { key: string; bytes: number }
}

export class AcceptanceEvidenceTooLarge extends Error {
  constructor(readonly overflow: EvidenceOverflow) {
    super(`Acceptance evidence exceeds ${overflow.limitBytes / 1024 / 1024} MiB; declare smaller artifacts`)
  }
}

export type AcceptanceRetryStatus =
  | { state: 'held'; revision: number; reason: 'size' | 'verification'; overflow?: EvidenceOverflow }
  | { state: 'queued' | 'running' }

export type AcceptanceRetryResult =
  | { state: 'queued' | 'running'; roundId: string }
  | { state: 'held'; overflow: EvidenceOverflow }

type GoalStore = Pick<Store, 'get'>

export function retainedGoalDelivery(store: GoalStore, goal: RouterGoal, ticketId: string) {
  const proposal = store.get<GoalDelivery>('goal-delivery', ticketId)
  const ticket = store.get<Ticket>('ticket', ticketId)
  const owner = store.get<TaskOwnership>('task-ownership', ticketId)
  const run = store.get<Run>('run', ticketId)
  if (!proposal || proposal.goalId !== goal.id || proposal.scopeId !== goal.scopeId ||
      proposal.ticketId !== ticketId || !(proposal.report?.state === 'ready' ||
        proposal.report?.state === 'blocked' && proposal.retainedOutputs?.digest && goal.nodes?.some(n =>
          n.ticketId === ticketId && n.derivedFrom && n.outputReviewDigest === proposal.retainedOutputs!.digest)) ||
      !ticket || ticket.ended || ticket.attention || ticket.undelivered.length ||
      owner?.state !== 'active' || owner.scopeId !== goal.scopeId || owner.discussion !== goal.discussion ||
      proposal.assignmentId !== ticket.assignments.at(-1)?.id ||
      proposal.inputRevision !== (owner.dataRevision ?? 1) ||
      run?.phase !== 'idle' || run.assignmentId !== proposal.assignmentId) return
  return proposal
}

export function acceptanceRetryTarget(store: GoalStore, goal: RouterGoal): {
  node?: GoalNode
  reason: 'size' | 'verification'
} | undefined {
  const nodes = goal.nodes ?? []
  if (goal.state !== 'held' || !goal.managed || !goal.objective || goal.supersededBy ||
      !nodes.length || nodes.some(node => node.teamTargetId) || goal.project?.review?.state === 'pending') return
  const size = !!goal.acceptanceOverflow ||
    /^Error: Acceptance evidence exceeds (?:512 KiB|2 MiB); declare smaller artifacts$/.test(goal.reason ?? '')
  const failed = (roundId: string | undefined, nodeId?: string) => {
    const round = roundId && store.get<VerificationRound>('goal-verification', roundId)
    return round && round.goalId === goal.id && round.nodeId === nodeId &&
      (round.state === 'errored' || round.state === 'stale')
  }
  if (nodes.every(node => node.state === 'passed')) {
    if ((size || failed(goal.finalRoundId)) &&
        nodes.every(node => node.ticketId && retainedGoalDelivery(store, goal, node.ticketId)))
      return { reason: size ? 'size' : 'verification' }
    return
  }
  const node = nodes.find(node => node.ticketId && node.state !== 'passed' &&
    node.dependsOn.every(id => nodes.some(dependency => dependency.id === id && dependency.state === 'passed')) &&
    (size && ['running', 'verifying', 'held'].includes(node.state) || failed(node.roundId, node.id)) &&
    retainedGoalDelivery(store, goal, node.ticketId))
  if (node) return { node, reason: size ? 'size' : 'verification' }
}
