import type { Runtime } from './runtime.ts'
import type { WorkerEventReceipt } from './async-worker-inbox.ts'
import type { Delivery } from './store.ts'
import type { TicketInput } from './vendor/dsh-core/index.ts'
import { stableDigest } from './sources.ts'

export interface WorkerInquiry {
  id: string
  ticketId: string
  triggerId: string
  discussion: string
  latestMessageId?: string
  delivered?: boolean
}
interface InquiryReply { inquiryId: string; text: string }
interface OpenInquiries { ticketId: string; ids: string[] }

// The open list is written in the same transaction as the question or the visible Chat reply.
export function recordInquiry(host: Runtime, inquiry: WorkerInquiry) {
  const open = host.store.get<OpenInquiries>('worker-inquiry-open', inquiry.ticketId)
  const ids = open?.ids ?? []
  host.store.put('worker-inquiry', inquiry.id, inquiry)
  host.store.put('worker-inquiry-open', inquiry.ticketId, {ticketId:inquiry.ticketId, ids:[...ids, inquiry.id]})
}

export function finishInquiry(host: Runtime, inquiry: WorkerInquiry) {
  const open = host.store.get<OpenInquiries>('worker-inquiry-open', inquiry.ticketId)
  host.store.put('worker-inquiry', inquiry.id, {...inquiry, delivered:true})
  if (open) host.store.put('worker-inquiry-open', inquiry.ticketId, {...open, ids:open.ids.filter(id => id !== inquiry.id)})
}

export function inquiryForInput(host: Runtime, input: TicketInput) {
  if (input.kind !== 'trigger' || !input.triggerId.startsWith('router-followup:')) return
  const inquiry = host.store.get<WorkerInquiry>('worker-inquiry', input.triggerId)
  if (!inquiry?.delivered) return inquiry
}

function authorizedQuestion(host: Runtime, inquiry: WorkerInquiry) {
  const origin = host.store.triggers.get(inquiry.triggerId)
  const run = host.store.get<{cancelled?: boolean; cancelRequested?: boolean}>('chat-run', inquiry.triggerId)
  if (!origin || !run || run.cancelled || run.cancelRequested || host.taskAuthority(inquiry.ticketId)?.discussion !== inquiry.discussion) return
  try {
    host.routerIngress.authority(inquiry.triggerId, inquiry.discussion)
    const scope = host.scopes.contextForTask(origin, inquiry.discussion, inquiry.ticketId)
    if (scope) host.scopes.checkTask(inquiry.ticketId, scope)
    return origin
  } catch { return }
}

/** Only offer earlier questions still visible in this authorized projection of the same ticket. */
export function unansweredInquiries(host: Runtime, ticketId: string, visibleInputs: TicketInput[], newInputs: TicketInput[]) {
  const open = host.store.get<OpenInquiries>('worker-inquiry-open', ticketId)
  if (!open?.ids.length) return []
  const previous = new Set(open.ids)
  for (const input of newInputs) if (input.kind === 'trigger') previous.delete(input.triggerId)
  if (!previous.size) return []
  return visibleInputs.flatMap(input => {
    if (input.kind !== 'trigger' || !previous.has(input.triggerId)) return []
    const inquiry = inquiryForInput(host, input)
    if (!inquiry || !authorizedQuestion(host, inquiry)) return []
    const followup = host.store.triggers.get(inquiry.id)
    return followup ? [{ inquiryId: inquiry.id, text: followup.text }] : []
  })
}

/** Called inside the accepted Worker result transaction. The model supplies content, never the reply route. */
export function queueInquiryReplies(host: Runtime, event: WorkerEventReceipt, inputs: TicketInput[],
  previous: {inquiryId: string}[], explicit: InquiryReply[] | undefined, plainReply: string) {
  const inquiries = [...inputs.flatMap(input => inquiryForInput(host, input) ?? []),
    ...previous.flatMap(q => host.store.get<WorkerInquiry>('worker-inquiry', q.inquiryId) ?? [])]
  const substantive = inputs.filter(input => input.kind !== 'trigger' || !input.context)
  const unambiguous = inquiries.length === 1 && !previous.length && substantive.length === 1
  for (const inquiry of inquiries) {
    if (inquiry.ticketId !== event.ticketId || inquiry.delivered) continue
    let text = unambiguous ? plainReply : ''
    if (explicit) {
      const matches = explicit.filter(reply => reply.inquiryId === inquiry.id)
      if (matches.length !== 1) continue
      text = matches[0]!.text
    }
    if (!text.trim()) continue
    const id = 'worker-inquiry-reply:' + stableDigest([inquiry.id, event.id])
    if (host.store.get('router-inbox', id)) continue
    const origin = authorizedQuestion(host, inquiry)
    if (!origin) continue
    const message: Delivery = {
      id, ticketId: event.ticketId, inquiryId: inquiry.id, kind: 'reply', text,
      channel: { source: origin.source, thread: inquiry.discussion, address: { routerInbox: inquiry.discussion } },
      status: 'sent', attempts: 0, nextAt: 0,
    }
    host.store.put('async-worker-message', id, { ticketId: event.ticketId, eventId: event.id, attemptId: event.attemptId })
    host.store.put('worker-inquiry', inquiry.id, {...inquiry, latestMessageId:id})
    host.store.put('router-inbox', id, message)
    host.store.enqueue('router:result:' + id, 'router', { discussion: inquiry.discussion, triggerId: inquiry.triggerId, messageId: id })
  }
}
