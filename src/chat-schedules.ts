import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { timingInputSchema } from './schedule-time.ts'
import type { ChatDelivery } from './chat-deliveries.ts'
import type { RouterProactive, ScheduledRun } from './router-proactive.ts'

const command = z.object({
  id: z.string().min(1).max(300),
  operationId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
})
export const chatScheduleChange = z.union([
  command.extend({ active: z.boolean() }).strict(),
  command.extend({ timing: timingInputSchema }).strict(),
])
export type ChatScheduleChange = z.infer<typeof chatScheduleChange>
export type ScheduleEdit = { active: boolean } | { timing: z.infer<typeof timingInputSchema> }
type Plan = ReturnType<RouterProactive['chatSchedules']>[number]
type RunInfo = { id: string; state: ScheduledRun['state']; at: number }
export type ChatSchedule<File = ChatDelivery> = Pick<Plan, 'id'|'name'|'prompt'|'timing'|'active'|'revision'> & {
  nextAt?: number
  closed?: 'cancelled' | 'promoted'
  lastRun: RunInfo | null
  lastResult: { at: number; messageId: string; text: string; files: File[] } | null
}

/** Follow the saved private entry and the occurrence that actually published each message. */
export function chatScheduleCards(db: DatabaseSync, conversation: string, plans: Plan[]): ChatSchedule[] {
  if (!plans.length) return []
  const scope = `FROM records r JOIN records anchor ON anchor.kind='chat-run' AND anchor.id=json_extract(r.body,'$.spec.triggerId')
    WHERE r.kind='router-schedule-run' AND json_extract(r.body,'$.scopeId')=?
      AND json_extract(r.body,'$.spec.entryId')=? AND json_extract(r.body,'$.scheduleId')=?
      AND json_extract(anchor.body,'$.conversationId')=?`
  const outputs = `m.kind='chat-message' AND json_extract(m.body,'$.conversationId')=? AND json_extract(m.body,'$.status')='complete'
    AND (m.id GLOB 'reply:*' OR json_array_length(m.body,'$.deliveries')>0)`
  const published = "coalesce(json_extract(m.body,'$.fileReview.resolvedAt'),json_extract(m.body,'$.createdAt'))"
  const latestRun = db.prepare(`SELECT r.id, json_extract(r.body,'$.state') AS state,
    coalesce(json_extract(r.body,'$.startedAt'),json_extract(r.body,'$.createdAt')) AS at ${scope}
    ORDER BY json_extract(r.body,'$.createdAt') DESC,r.rowid DESC LIMIT 1`)
  const lastOutput = db.prepare(`SELECT json_extract(m.body,'$.runId') AS triggerId FROM records m WHERE ${outputs}
    AND json_extract(m.body,'$.runId') IN (SELECT json_extract(r.body,'$.triggerId') ${scope})
    ORDER BY ${published} DESC,json_extract(m.body,'$.sequence') DESC LIMIT 1`)
  const messages = db.prepare(`SELECT m.id, json_extract(m.body,'$.text') AS text, ${published} AS at,
    json_extract(m.body,'$.deliveries') AS files FROM records m WHERE ${outputs} AND json_extract(m.body,'$.runId')=?
    ORDER BY at DESC,json_extract(m.body,'$.sequence') DESC`)
  return plans.map(({id, name, prompt, timing, active, nextAt, revision, scopeId, entryId, cancelledAt, promotion}) => {
    const args = [scopeId, entryId, id, conversation]
    const lastRun = latestRun.get(...args) as RunInfo | undefined
    const receipt = lastRun && lastOutput.get(conversation, ...args)
    const rows = receipt ? messages.all(conversation, receipt.triggerId!) : []
    const message = rows.find(row => String(row.id).startsWith('reply:')) ?? rows[0]
    const files = rows.flatMap(row => row.files ? JSON.parse(String(row.files)) as ChatDelivery[] : [])
    return {
      id, name, prompt, timing, active, revision, nextAt: active ? nextAt : undefined,
      closed: promotion ? 'promoted' : cancelledAt!==undefined ? 'cancelled' : undefined, lastRun: lastRun ?? null,
      lastResult: message ? { at: Number(rows[0]!.at), messageId: String(message.id), text: String(message.text).slice(0,240), files } : null,
    }
  })
}
