import { stableDigest } from './sources.ts'
import type { Store } from './store.ts'
import type { ToolContent } from './model.ts'
import type { ApprovalOrigin } from './approvals.ts'
import { desktopNeedsApproval } from './cua-desktop.ts'

export type ApprovalMode = 'ask' | 'full'
export type PermissionActor = ApprovalOrigin & {
  triggerId: string
  ticketId?: string
  agentId?: string
  mode: ApprovalMode
}
export type ToolResult = {
  success: boolean
  permission?: 'pending' | 'denied' | 'uncertain' | 'cancelled'
  contentItems: ToolContent[]
}
type Phase = 'pending' | 'approved' | 'denied' | 'executing' | 'complete' | 'uncertain' | 'cancelled'
export interface PermissionAction {
  id: string
  actor: PermissionActor
  tool: string
  args: Record<string, unknown>
  facts: Record<string, string>
  phase: Phase
  createdAt: number
  notice?: string
  jobId?: string
  automatic: boolean
  approved?: boolean
  receipt?: ToolResult
  supersededByInput?: string
}
export const permissionInstructions =
  'The host enforces the permission mode. A pending approval defers only that operation. Continue independent steps within your role while the action awaits a decision. Return waiting only when the remaining work depends on a decision. Never poll or resubmit a pending operation. After denial do not perform the operation another way. For Chat tools with pendingNotice, author the notice with the operation before requesting it; the host displays it only if a decision is needed. For native requests give a concise user-facing reason or question in their language and use the appropriate word for approval or answer in that sentence. Do not repeat the notice in a second message. On your next user-facing reply after an approval decision, mention its observed outcome once, in one natural sentence in the user’s language. Approval alone does not establish execution success. If denied, failed, pending or unconfirmed, accurately state that result. Use the actual execution receipt. Explicit requests to review a file or make a user choice still apply.'
export const nativePermissionInstructions =
  'Native permission requests defer the current attempt while the request is in Pending items; the provider withholds that attempt. On a native_permission_decision input, repeat the exact native operation once if approved, or leave it undone if declined.'
const kind = 'chat-permission'
export const unconfirmedEffectMessage = 'An external operation is awaiting confirmation. Verify its saved receipt before completing or retrying this task.'
const result = (state: Phase, id: string, extra?: string): ToolResult => ({
  permission:
    state === 'pending' || state === 'denied' || state === 'uncertain' || state === 'cancelled'
      ? state
      : undefined,
  success: !['denied', 'uncertain', 'cancelled'].includes(state),
  contentItems: [
    {
      type: 'inputText',
      text: JSON.stringify({ permission: state, id, ...(extra ? { message: extra } : {}) }),
    },
  ],
})

/** Expose an operation's outcome while keeping the host's decision and deduplication receipt private. */
export function operationResult(value: ToolResult): ToolResult {
  const {permission,...operation}=value
  const [item]=operation.contentItems
  if(operation.contentItems.length===1&&item?.type==='inputText'){
    const decision=/^\{"permission":"(pending|approved|denied|executing|complete|uncertain|cancelled)","id":"permission:[a-f0-9]{64}"/.exec(item.text??'')?.[1]
    if(decision){
      const text=decision==='complete'?(value.success?'Operation completed.':'Operation failed.'):
        decision==='executing'?'Operation is in progress.':
        decision==='uncertain'?'Operation outcome is uncertain. Check the actual result before retrying.':
        'Operation is unavailable for this request.'
      return {success:(decision==='complete'||decision==='executing')&&value.success,contentItems:[{type:'inputText',text}]}
    }
  }
  return operation
}

/** A decision authorizes one immutable operation at a particular task origin. No effect runs on the HTTP response path. */
export class ChatPermissions {
  constructor(private store: Store) {
    for (const action of store.list<PermissionAction>(kind))
      if (action.phase === 'executing') this.save({ ...action, phase: 'uncertain' })
  }
  private save(action: PermissionAction) {
    this.store.put(kind, action.id, action)
    return action
  }
  get(id: string) {
    return this.store.get<PermissionAction>(kind, id)
  }
  forChat(id: string) {
    return this.store.db
      .prepare(
        "SELECT body FROM records WHERE kind='chat-permission' AND json_extract(body,'$.actor.conversationId')=? ORDER BY rowid"
      )
      .all(id)
      .map((r) => JSON.parse(String(r.body)) as PermissionAction)
  }
  forWorker(ticketId: string) {
    return this.store.db
      .prepare(
        "SELECT body FROM records WHERE kind='chat-permission' AND json_extract(body,'$.actor.ticketId')=? AND json_extract(body,'$.phase') IN ('pending','approved')"
      )
      .all(ticketId)
      .map((r) => JSON.parse(String(r.body)) as PermissionAction)
  }
  effectStates(ticketId: string): Phase[] {
    return this.store.db.prepare(
      "SELECT json_extract(body,'$.phase') AS phase FROM records WHERE kind='chat-permission' AND json_extract(body,'$.actor.ticketId')=? AND json_extract(body,'$.phase') IN ('executing','uncertain','complete')"
    ).all(ticketId).map(row => row.phase as Phase)
  }
  hasUnconfirmedEffect(ticketId: string): boolean {
    return this.effectStates(ticketId).some(phase => phase !== 'complete')
  }
  confirmEffect(id: string, receipt: ToolResult): boolean {
    return this.store.atomic(() => {
      const action = this.get(id)
      if (action?.phase !== 'uncertain' || !receipt.success || receipt.permission) return false
      this.save({ ...action, phase: 'complete', receipt })
      this.store.audit({type:'permission.reconciled',id,ticketId:action.actor.ticketId,tool:action.tool})
      return true
    })
  }
  decide(id: string, accept: boolean, wake: (action: PermissionAction) => void) {
    return this.store.atomic(() => {
      const action = this.get(id)
      if (!action || action.phase === 'cancelled') throw Error('Approval is no longer active')
      if (action.phase !== 'pending') {
        if (action.approved === accept) return
        throw Error('This operation already has a different decision')
      }
      const next = this.save({ ...action, phase: accept ? 'approved' : 'denied', approved: accept })
      wake(next)
    })
  }
  async run(
    actor: PermissionActor,
    tool: string,
    args: Record<string, unknown>,
    facts: Record<string, string>,
    perform: (id: string) => Promise<ToolResult>,
    expectedId?: string,
    notice?: string
  ): Promise<ToolResult> {
    // Transport retry IDs carry no authority. A retry with a fresh requestId cannot repeat the same effect.
    const { requestId, operationId, yieldMs, ...effect } = args
    const { change, ...boundFacts } = facts
    let id =
      'permission:' +
      stableDigest([
        actor.conversationId,
        actor.runId,
        actor.triggerId,
        actor.ticketId,
        actor.workerId,
        actor.agentId,
        tool,
        effect,
        boundFacts,
      ])
    let action = this.get(id)
    // A revised Router may propose the same unexecuted action again. Older approval jobs stay bound to their own decision.
    while (action?.phase === 'cancelled' && action.supersededByInput) {
      id = 'permission:' + stableDigest([id,action.supersededByInput])
      action = this.get(id)
    }
    if (expectedId && expectedId !== id) {
      this.cancel(expectedId)
      return result('cancelled', expectedId, 'The target or revision changed; request a new decision.')
    }
    const automatic=actor.mode==='full'
    if (!action) {
      action = this.save({
        id,
        actor,
        tool,
        args,
        facts,
        ...(notice&&!automatic ? {notice} : {}),
        phase: automatic ? 'approved' : 'pending',
        automatic,
        approved: automatic ? true : undefined,
        createdAt: Date.now(),
      })
    }else if(automatic&&action.phase==='pending'){
      action=this.save({...action,actor,notice:undefined,automatic:true,phase:'approved',approved:true})
    }
    if (action.phase !== 'approved') return action.receipt ?? result(action.phase, id)
    this.save({ ...action, phase: 'executing' })
    try {
      const receipt = await perform(id)
      // Retain the outcome, not a second copy of images or full external documents.
      const short =
        JSON.stringify(receipt).length <= 12000 &&
        receipt.contentItems.every((item) => item.type === 'inputText')
          ? receipt
          : { ...result('complete', id), success: receipt.success }
      const shell = shellReceipt({...action, receipt})
      this.save({ ...action, phase: receipt.permission==='uncertain'?'uncertain':'complete', receipt: short, ...(shell?.id ? {jobId:shell.id} : {}) })
      return receipt
    } catch (error) {
      this.save({ ...action, phase: 'uncertain' })
      throw error
    }
  }
  cancel(id: string) {
    const a = this.get(id)
    if (a && ['pending', 'approved'].includes(a.phase)) this.save({ ...a, phase: 'cancelled' })
  }
  supersedeRouterProposals(conversationId:string,runId:string,inputId:string){
    for(const action of this.forChat(conversationId)){
      if(action.actor.runId===runId&&!action.actor.ticketId&&!action.actor.agentId&&['pending','approved'].includes(action.phase)){
        this.save({...action,phase:'cancelled',supersededByInput:inputId})
      }
    }
  }
}

type ShellOutcome = {id?:string; ticketId?:string; state?:string; exitCode?:number}
function shellReceipt(a: PermissionAction): ShellOutcome | undefined {
  if (a.tool !== 'superagent_shell') return
  try { return JSON.parse(a.receipt?.contentItems[0]?.text ?? 'null') ?? undefined } catch { return }
}
export function permissionCard(a: PermissionAction, store?:Store) {
  let executionState:Phase|'failed' = a.phase === 'complete' && a.receipt?.success === false ? 'failed' : a.phase
  if (a.phase === 'complete' && a.tool === 'superagent_shell') {
    const receipt = shellReceipt(a)
    const jobId = a.jobId ?? receipt?.id
    const job = jobId && store?.get<ShellOutcome>('work',jobId)
    const shell = job && job.ticketId === a.actor.ticketId ? job : receipt
    if (shell?.state === 'interrupted') executionState = 'uncertain'
    else if (shell?.state === 'cancelled') executionState = 'cancelled'
    else if (shell?.state === 'failed' || (typeof shell?.exitCode === 'number' && shell.exitCode !== 0)) executionState = 'failed'
    else if (shell?.state === 'running' || shell?.state === 'starting') executionState = 'executing'
  }
  const state =
    a.phase === 'pending'
      ? 'pending'
      : a.phase === 'denied'
        ? 'denied'
        : a.phase === 'cancelled'
          ? 'expired'
          : 'approved'
  return {
    id: a.id,
    ticketId: a.actor.ticketId ?? a.actor.runId,
    runId: a.actor.runId,
    workerId: a.actor.workerId,
    createdAt: a.createdAt,
    executionState,
    automatic:a.automatic,
    notice: a.notice,
    state: state as 'pending' | 'approved' | 'denied' | 'expired',
    method: 'roppo/tool',
    facts: { tool: a.tool, ...a.facts } as Record<string, string>,
    questions: [],
    expiresAt: null,
  }
}

const interactiveBrowser = new Set(['click', 'fill', 'press', 'login'])
const routerActions: Readonly<Record<string, ReadonlySet<string>>> = {
  workspace_browser: interactiveBrowser,
  worker_manage: new Set(['destroy', 'cancel', 'retire', 'rebuild']),
  router_knowledge: new Set(['delete', 'restore']),
  router_manage: new Set(['run.cancel']),
  router_goal: new Set(['cancel']),
}
export function routerRisk(tool: string, args: Record<string, unknown>) {
  if (routerActions[tool]?.has(String(args.action))) return actionFacts(tool, args)
}
export function actionFacts(tool: string, args: Record<string, unknown>): Record<string, string> {
  const { requestId, operationId, yieldMs, ...argsToShow } = args
  const facts: Record<string, string> = { tool }
  if (typeof args.action === 'string') facts.action = args.action
  if (tool === 'workspace_browser' || tool === 'superagent_browser') {
    for (const field of ['sessionId', 'tabId', 'ref', 'revision', 'key'])
      if (args[field] != null) facts[field] = String(args[field])
  } else if (tool === 'superagent_desktop') {
    const target = args.arguments as Record<string,unknown> | undefined
    for (const field of ['app','pid','window_id'])
      if (typeof target?.[field] === 'string' || typeof target?.[field] === 'number') facts[field] = String(target[field])
    if(args.action==='start_recording')facts.target='Primary display'
  } else {
    facts.change = JSON.stringify(argsToShow, (key, value) =>
      /^(password|token|api[_-]?key|authorization|secret|cookie|headers)$/i.test(key) ? '•••' : value
    )
  }
  return facts
}
export function workerRisk(tool: string, args: Record<string, unknown>) {
  if (
    ['superagent_publish', 'superagent_review'].includes(tool) ||
    (tool === 'superagent_desktop' && desktopNeedsApproval(args.action)) ||
    (tool === 'superagent_browser' && interactiveBrowser.has(String(args.action)))
  )
    return actionFacts(tool, args)
}
