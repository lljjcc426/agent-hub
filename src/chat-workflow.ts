import {pendingNoticeSchema} from './chat-pending-notice.ts'
import { z } from 'zod'
import type { ToolSpec } from './model.ts'
import type { Approval } from './approvals.ts'
import type { RouterGoal } from './router-goals.ts'

const label = z.string().trim().min(1).max(240)
const steps = z
  .array(
    z
      .object({
        id: z.string().min(1).max(80),
        title: label,
        state: z.enum(['pending', 'running', 'completed', 'blocked']),
      })
      .strict(),
  )
  .min(1)
  .max(30)
export const publicPlanSchema = z.object({ title: label, steps }).strict()
export type PublicPlan = z.infer<typeof publicPlanSchema>
export interface ChatPlan extends PublicPlan {
  createdAt?:number
  updatedAt?:number
  id: string
  conversationId: string
  runId: string
  activityId: string
  workerId?: string
  ticketId?: string
}
export const publicPlanTool: ToolSpec = {
  type: 'function',
  name: 'superagent_plan',
  description:
    'For work with several meaningful steps, publish the user-facing plan in their language. Send the full list, keep stable step IDs and update their states as work advances. Use router_goal for durable execution graphs. Skip this for simple replies. Publishing a plan does not execute or authorize steps.',
  inputSchema: z.toJSONSchema(publicPlanSchema, { target: 'draft-7', io: 'input' }),
}
export const decisionSchema = z
  .object({
    question: z.string().trim().min(1).max(1000),
    defaultOption: label.optional(),
    pendingNotice: pendingNoticeSchema,
    options: z
      .array(z.object({ label, detail: z.string().trim().max(500).optional() }).strict())
      .min(2)
      .max(8),
  })
  .strict()
export type ChatDecision = z.infer<typeof decisionSchema> & {
  planId?: string
  answer?: string
  replyRunId?: string
  closed?: boolean
}
export const decisionTool: ToolSpec = {
  type: 'function',
  name: 'chat_request_decision',
  description:
    "For a worthwhile preference, present one concrete question and distinct choices in the user's language. For a reversible choice, set defaultOption to an exact option label and continue using it immediately; the user can steer later. Omit the default when the user explicitly wants to decide or a consequential step genuinely needs their answer. A custom reply is also possible. The selection arrives as a new quoted user message. After presenting it, continue any independent steps. Leave only the work that needs the answer pending. Do not poll or repeat the question. This is not a permission grant.",
  inputSchema: z.toJSONSchema(decisionSchema, { target: 'draft-7', io: 'input' }),
}
export function goalPlan(goal: RouterGoal) {
  const states = {
    passed: 'completed',
    running: 'running',
    verifying: 'running',
    held: 'blocked',
    pending: 'pending',
    waiting_dependency: 'pending',
  } as const
  // An untracked checklist has no per-step completion evidence.
  const steps = goal.nodes?.length
    ? goal.nodes.map((n) => ({ id: n.id, title: n.title, state: states[n.state], workerId: n.workerId }))
    : goal.plan.map((title, i) => ({ id: String(i), title, state: undefined, workerId: undefined }))
  return { id: goal.id, runId: goal.triggerId, createdAt:goal.at, title: goal.title, objective: goal.objective, nextAction: goal.nextAction, state: goal.state, steps,
    ticketIds: [...new Set([...(goal.taskIds ?? []), ...(goal.nodes ?? []).flatMap(node => node.ticketId ? [node.ticketId] : [])])] }
}
export interface NativeQuestion {
  id: string
  question: string
  options?: { label: string; description?: string }[]
  isOther?: boolean
  isSecret?: boolean
}
export function isApprovalPending(approval: { state: string; expiresAt: number | null }, now = Date.now()) {
  return approval.state === 'pending' && (approval.expiresAt === null || approval.expiresAt > now)
}

export function publicApproval(a: Approval) {
  const { method, params } = a.native
  const facts: Record<string, string> = {}
  // Only display the proposed operation. Protocol identifiers and tool outputs stay private.
  for (const key of [
    'command',
    'commandActions',
    'cwd',
    'reason',
    'grantRoot',
    'permissions',
    'additionalPermissions',
    'networkApprovalContext',
    'proposedExecpolicyAmendment',
    'proposedNetworkPolicyAmendments',
  ]) {
    const value = params[key]
    if (value !== undefined && value !== null)
      facts[key] = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }
  const questions =
    method === 'item/tool/requestUserInput'
      ? ((params.questions ?? []) as NativeQuestion[]).map((q) => ({
          id: q.id,
          question: q.question,
          secret: !!q.isSecret,
          custom: !!q.isOther || !q.options?.length,
          options: (q.options ?? []).map((o) => ({ label: o.label, detail: o.description ?? '' })),
        }))
      : []
  return {
    answerText: a.outcome === 'answered' ? questions.flatMap(q => {
      const entry = a.decision?.answers?.[q.id]
      if (q.secret || !entry || typeof entry !== 'object' || !('answers' in entry) || !Array.isArray(entry.answers)) return []
      return entry.answers.filter((value): value is string => typeof value === 'string')
    }).join(' · ') : undefined,
    notice: typeof params.reason === 'string' ? params.reason.slice(0,360) : undefined,
    id: a.id,
    ticketId: a.ticketId,
    runId: a.chat!.runId,
    workerId: a.chat!.workerId,
    createdAt: a.createdAt,
    expiresAt: a.key ? null : a.expiresAt,
    state: a.status === 'resolved' ? (a.outcome ?? ('resolved' as const)) : a.status,
    method,
    facts,
    questions,
  }
}
