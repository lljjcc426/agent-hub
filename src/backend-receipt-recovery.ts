import { stoppedOpenCodeCallbacks } from './backends/opencode-read-recovery.ts'
import type { PluginThread } from './backends/plugin-process.ts'
import { browserToolSchema } from './browser-contract.ts'
import { publicPlanSchema, type ChatPlan } from './chat-workflow.ts'
import type { ExecutionContext } from './execution-activity.ts'
import { stableDigest } from './sources.ts'
import type { Run, Store } from './store.ts'
import type { UsageRecord } from './usage-ledger.ts'
import type { WorkItem } from './work.ts'

type RecoveryStore = Pick<Store, 'db' | 'get' | 'list'>
type Session = ExecutionContext & { threadId: string; cwd: string; ephemeral: boolean; activity: string }
type Callback = ReturnType<typeof stoppedOpenCodeCallbacks>[number]
type Recovery =
  | { reason: 'interrupted_chat_plan'; confirmed: boolean }
  | { reason: 'interrupted_browser_snapshot'; confirmed: false }
type RetainedReceipt = Callback & { recovery?: Recovery }

export function savedChatPlan(store: Pick<Store, 'list'>, activityId: string, args: unknown) {
  const plan = publicPlanSchema.safeParse(args)
  if (!plan.success) return
  const fingerprint = stableDigest(plan.data)
  return store.list<ChatPlan>('chat-plan').find(saved =>
    saved.activityId === activityId && stableDigest({ title: saved.title, steps: saved.steps }) === fingerprint)
}

function stoppedSession(store: RecoveryStore, thread: PluginThread): Session | undefined {
  const session = store.get<Session>('model-session', thread.id)
  if (session?.threadId !== thread.id || session.cwd !== thread.cwd || session.ephemeral !== false ||
      !session.activity || !session.triggerId || !session.sourceId) return
  const usage = store.get<UsageRecord>('model-usage', session.activity)
  if (usage?.id !== session.activity || usage.state !== 'failed' || !usage.endedAt ||
      !thread.lastFailure?.at || usage.endedAt < thread.lastFailure.at ||
      usage.triggerId !== session.triggerId || usage.sourceId !== session.sourceId ||
      usage.ticketId !== session.ticketId || usage.agentId !== session.agentId) return

  if (usage.role === 'subagent' && session.ticketId && session.agentId) {
    const work = store.get<WorkItem>('work', session.agentId)
    if (work?.id === session.agentId && work.kind === 'agent' && work.state === 'failed' &&
        work.endedAt !== undefined && work.endedAt >= usage.endedAt &&
        work.ticketId === session.ticketId && work.threadId === thread.id && work.cwd === session.cwd) return session
  }
  if (usage.role === 'worker' && session.ticketId && !session.agentId) {
    const run = store.get<Run>('run', session.ticketId)
    if (run?.ticketId === session.ticketId && run.phase === 'idle' && run.prepared && !run.waitingForWriter &&
        run.threadId === thread.id && run.turnId === thread.turnId && run.backendId === thread.backendId &&
        run.cwd === session.cwd) return session
  }
  if (usage.role === 'router' && !session.ticketId && !session.agentId &&
      store.db.prepare(`SELECT 1 FROM records WHERE kind='router-session'
        AND json_extract(body,'$.threadId')=? AND json_extract(body,'$.triggerId')=?
        AND json_extract(body,'$.source')=? LIMIT 1`).get(thread.id, session.triggerId, session.sourceId)) return session
}

function recoverableResult(store: RecoveryStore, session: Session, call: Callback): Recovery | undefined {
  if (call.name === 'superagent_plan' && !session.ticketId) {
    const plan = publicPlanSchema.safeParse(call.args)
    if (!plan.success) return
    // This callback only writes the local Chat plan. Preserve its current
    // value, and acknowledge publication only with the exact saved plan.
    const confirmed = !!savedChatPlan(store, session.activity, plan.data)
    return { reason: 'interrupted_chat_plan', confirmed }
  }
  if (call.name === 'superagent_browser' && session.agentId) {
    const input = browserToolSchema.safeParse(call.args)
    if (input.success && input.data.action === 'snapshot') {
      return { reason: 'interrupted_browser_snapshot', confirmed: false }
    }
  }
}

/** Preserve the adapter's existing replay fence for any effect whose result
 * cannot be recovered. A stopped callback can survive a host replacement. */
export function retainedBackendReceipts(store: RecoveryStore, stateDir: string): RetainedReceipt[] {
  const rows = store.db.prepare(`SELECT id FROM records WHERE kind='backend-plugin-tool'
    AND json_extract(body,'$.state')='running'`).all()
  if (!rows.length) return []
  const owners = new Map<string, PluginThread | null | undefined>(rows.map(({ id }) => [String(id), undefined]))
  for (const { id, body } of store.db.prepare("SELECT id,body FROM records WHERE kind='backend-plugin-thread'").all()) {
    const thread = JSON.parse(String(body)) as PluginThread
    if (!Array.isArray(thread.effectIds)) continue
    for (const effectId of thread.effectIds) {
      if (!owners.has(effectId)) continue
      owners.set(effectId, owners.get(effectId) === undefined && thread.id === id ? thread : null)
    }
  }
  const threads = new Set(owners.values())
  const retained: RetainedReceipt[] = []
  for (const thread of threads) {
    if (!thread) continue
    const session = stoppedSession(store, thread)
    if (!session) continue
    for (const call of stoppedOpenCodeCallbacks(store, stateDir, thread)) {
      if (owners.get(call.id) !== thread) continue
      retained.push({ ...call, recovery: recoverableResult(store, session, call) })
    }
  }
  return retained
}

export function reconcileBackendReceipts(store: Store, stateDir: string) {
  store.atomic(() => {
    for (const { id, threadId, turnId, receipt, recovery } of retainedBackendReceipts(store, stateDir)) {
      if (!recovery) continue
      const { reason, confirmed } = recovery
      const result = {
        success: confirmed,
        contentItems: [{
          type: 'inputText' as const,
          text: reason === 'interrupted_chat_plan'
            ? JSON.stringify({ ok: confirmed, ...(!confirmed ? { status: 'publication_unconfirmed' } : {}) })
            : 'The interrupted browser snapshot returned no confirmed result.',
        }],
      }
      const reconciliation = { reason, threadId, turnId, at: Date.now() }
      store.put('backend-plugin-tool', id, { ...receipt, state: 'complete', result, reconciliation })
      store.audit({ type: 'backend.tool.reconciled', receiptId: id, ...reconciliation, confirmed })
    }
  })
}
