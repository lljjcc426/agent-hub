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
}
export const decisionTool: ToolSpec = {
  type: 'function',
  name: 'chat_request_decision',
  description:
    'When progress genuinely depends on a user preference, present one concrete question and distinct choices in their language. A custom reply is also possible. The selection arrives as a new quoted user message. After presenting it, end this turn without guessing or repeating the question. Do routine work autonomously. This is not a permission grant.',
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
  return { id: goal.id, runId: goal.triggerId, title: goal.title, state: goal.state, steps }
}
export interface NativeQuestion {
  id: string
  question: string
  options?: { label: string; description?: string }[]
  isOther?: boolean
  isSecret?: boolean
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
    id: a.id,
    ticketId: a.ticketId,
    runId: a.chat!.runId,
    workerId: a.chat!.workerId,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    state: a.status === 'resolved' ? (a.outcome ?? ('resolved' as const)) : a.status,
    method,
    facts,
    questions,
  }
}
