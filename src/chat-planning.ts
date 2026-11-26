import { z } from 'zod'
import { decisionSchema } from './chat-workflow.ts'

export const planningQuestionCount = 2

export interface ChatPlanning {
  id: string
  conversationId: string
  turns: string[]
  answered: number
  state: 'drafting' | 'question' | 'review' | 'failed' | 'approved' | 'cancelled'
  messageId?: string
  executionId?: string
}

export function activePlanning(plan: ChatPlanning | undefined): plan is ChatPlanning {
  return !!plan && plan.state !== 'approved' && plan.state !== 'cancelled'
}

export const planningQuestion = decisionSchema.pick({ question: true, options: true })
export const planningProposal = z.object({
  title: z.string().trim().min(1).max(240),
  objective: z.string().trim().min(1).max(1200),
  steps: z.array(z.string().trim().min(1).max(700)).min(1).max(12),
  deliverable: z.string().trim().min(1).max(1200),
}).strict()

export function proposalText(plan: z.infer<typeof planningProposal>, chinese: boolean) {
  return [
    '### ' + plan.title, plan.objective,
    plan.steps.map((step, index) => (index + 1) + '. ' + step).join('\n'),
    '**' + (chinese ? '交付与验收' : 'Deliverable and acceptance') + '**\n\n' + plan.deliverable,
  ].join('\n\n')
}

export const planningAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), messageId: z.string().min(1).max(500) }).strict(),
  z.object({ action: z.literal('cancel'), planId: z.string().uuid() }).strict(),
])
