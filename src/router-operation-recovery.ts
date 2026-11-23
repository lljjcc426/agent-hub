import { savedChatPlan } from './backend-receipt-recovery.ts'
import { isRouterRead, type RecordedRouterCall } from './backends/opencode-read-recovery.ts'
import { operationResult, type PermissionAction, type ToolResult } from './chat-permissions.ts'
import { publicPlanSchema } from './chat-workflow.ts'
import { splitPendingNotice } from './chat-pending-notice.ts'
import { goalCommandSchema, type RouterGoal } from './router-goals.ts'
import type { ScopeContext } from './router-scope.ts'
import { bodyDigest, stableDigest } from './sources.ts'
import type { Store } from './store.ts'
import { workerCommandSchema } from './worker-manager.ts'

const textResult = (value: unknown, success = true): ToolResult => ({
  success, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
})

type Origin = { activity?: string; triggerId: string; discussion: string; scoped?: ScopeContext }

function uncertain(result: ToolResult) {
  if (result.permission === 'uncertain') return true
  const item = result.contentItems?.[0]
  return item?.type === 'inputText' && (
    item.text === 'Operation is in progress.' ||
    !result.success && /outcome (?:is )?(?:uncertain|unknown)|requires reconciliation|unconfirmed/i.test(item.text ?? '')
  )
}

function operationArgs(name: string, args: unknown) {
  try { return splitPendingNotice(name, args) } catch { return undefined }
}

/** Use the original outcome or an independent host receipt for the exact
 * saved call. Reading these records never invokes the operation again. */
export function reconcileRouterCall(store: Store, origin: Origin, call: RecordedRouterCall): ToolResult | undefined {
  const { name, receipt } = call
  if (receipt.state === 'complete' && receipt.result && !uncertain(receipt.result)) return receipt.result
  const parsed = operationArgs(name, call.args)
  if (!parsed) return
  const raw = parsed.args
  if (name === 'superagent_plan' && publicPlanSchema.safeParse(raw).success) {
    const saved = !!(origin.activity && savedChatPlan(store, origin.activity, raw))
    return textResult({ ok: saved }, saved)
  }
  if (name === 'router_goal' && origin.scoped) {
    const x = goalCommandSchema.safeParse(raw), { route, actor } = origin.scoped
    if (x.success && x.data.operationId) {
      const key = stableDigest([route.scopeId, route.entryId, actor, x.data.operationId])
      const saved = store.get<{ scopeId: string; entryId: string; triggerId: string; fingerprint: string; result: RouterGoal }>('goal-receipt', key)
      if (saved?.scopeId === route.scopeId && saved.entryId === route.entryId && saved.triggerId === origin.triggerId &&
          saved.fingerprint === stableDigest(x.data) && saved.result?.id) return textResult(saved.result)
    }
  }
  if (name === 'worker_manage') {
    const x = workerCommandSchema.safeParse(raw)
    if (x.success && x.data.requestId) {
      const key = bodyDigest([origin.discussion, x.data.requestId])
      const saved = store.get<{ scopeId?: string; status: string; fingerprint: string; result: unknown }>('worker-command', key)
      if (saved?.status === 'completed' && saved.scopeId === origin.scoped?.route.scopeId &&
          saved.fingerprint === bodyDigest(x.data) && saved.result !== undefined) return textResult(saved.result)
    }
  }
  const actions = store.db.prepare(`SELECT body FROM records WHERE kind='chat-permission'
    AND json_extract(body,'$.actor.triggerId')=? AND json_extract(body,'$.tool')=?
    AND json_extract(body,'$.actor.ticketId') IS NULL`).all(origin.triggerId, name)
  const matches = actions.map(row => JSON.parse(String(row.body)) as PermissionAction)
    .filter(action => stableDigest(action.args) === stableDigest(raw))
  if (matches.length === 1) {
    const action = matches[0]!
    if (action.phase === 'complete' && action.receipt && !uncertain(action.receipt)) {
      return action.automatic ? operationResult(action.receipt) : action.receipt
    }
    return
  }
  if (isRouterRead(name, raw)) return textResult({ status: 'interrupted_read' }, false)
}

export type HeldRouterAction = { tool?: string; receiptId?: string; targets: string[] }

export function routerActionTargets(store: Pick<Store, 'get'>, name: string, args: unknown): string[] {
  const raw = operationArgs(name, args)?.args
  if (name === 'router_goal') {
    const x = goalCommandSchema.safeParse(raw)
    if (!x.success) return []
    const ids = [x.data.id, x.data.supersedes?.goalId, x.data.continueFrom?.goalId, ...(x.data.targets ?? []).map(target => target.id)].filter((id): id is string => !!id)
    return [...new Set(ids.flatMap(id => {
      const goal = store.get<RouterGoal>('router-goal', id)
      return ['goal:' + id, ...(goal?.taskIds ?? []).map(ticket => 'task:' + ticket)]
    }))]
  }
  if (name === 'worker_manage') {
    const x = workerCommandSchema.safeParse(raw)
    if (x.success && x.data.ticketId && ['send', 'cancel', 'migrate', 'rebuild'].includes(x.data.action)) {
      return ['task:' + x.data.ticketId]
    }
  }
  return []
}

export function blockedByRouterRecovery(store: Pick<Store, 'get'>, holds: HeldRouterAction[], name: string, args: unknown) {
  if (!holds.length || isRouterRead(name, args)) return
  const targets = routerActionTargets(store, name, args)
  return holds.find(hold => !hold.targets.length || !targets.length || hold.targets.some(target => targets.includes(target)))
}
