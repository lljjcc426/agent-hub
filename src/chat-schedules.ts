import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { timingSchema, type Timing } from './schedule-time.ts'
import type { ChatDelivery } from './chat-deliveries.ts'
import type { RouterProactive, ScheduledRun } from './router-proactive.ts'

const command = z.object({
  id: z.string().min(1).max(300),
  operationId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
})
export const chatScheduleChange = z.union([
  command.extend({ active: z.boolean() }).strict(),
  command.extend({ timing: timingSchema }).strict(),
])
export type ScheduleEdit = { active: boolean } | { timing: Timing }
type Plan = ReturnType<RouterProactive['chatSchedules']>[number]
type RunInfo = { id: string; state: ScheduledRun['state']; at: number }
export type ChatSchedule = Pick<Plan, 'id'|'name'|'prompt'|'timing'|'active'|'revision'> & {
  nextAt?: number
  lastRun: RunInfo | null
  lastResult: { at: number; messageId: string; text: string; files: ChatDelivery[] } | null
}

export function chatScheduleCards(db: DatabaseSync, conversation: string, plans: Plan[]): ChatSchedule[] {
  if (!plans.length) return []
  const runQuery = `SELECT r.id, json_extract(r.body,'$.triggerId') AS triggerId,
      json_extract(r.body,'$.state') AS state, json_extract(r.body,'$.scheduledAt') AS at
    FROM records r JOIN records anchor ON anchor.kind='chat-run' AND anchor.id=json_extract(r.body,'$.spec.triggerId')
    WHERE r.kind='router-schedule-run' AND json_extract(r.body,'$.scopeId')=?
      AND json_extract(r.body,'$.spec.entryId')=? AND json_extract(r.body,'$.scheduleId')=?
      AND json_extract(anchor.body,'$.conversationId')=?`
  const newest = " ORDER BY json_extract(r.body,'$.createdAt') DESC, r.rowid DESC LIMIT 1"
  const outputs = `m.kind='chat-message' AND json_extract(m.body,'$.conversationId')=? AND json_extract(m.body,'$.status')='complete'
    AND (m.id GLOB 'reply:*' OR json_array_length(m.body,'$.deliveries')>0)`
  const latest = db.prepare(runQuery + newest)
  const delivered = db.prepare(runQuery + ` AND EXISTS (SELECT 1 FROM records m WHERE ${outputs}
    AND json_extract(m.body,'$.runId')=json_extract(r.body,'$.triggerId'))` + newest)
  const messages = db.prepare(`SELECT m.id, json_extract(m.body,'$.text') AS text,
    json_extract(m.body,'$.createdAt') AS at, json_extract(m.body,'$.deliveries') AS files
    FROM records m WHERE ${outputs} AND json_extract(m.body,'$.runId')=? ORDER BY json_extract(m.body,'$.sequence') DESC`)
  return plans.map(({id, name, prompt, timing, active, nextAt, revision, scopeId, entryId}) => {
    const args = [scopeId, entryId, id, conversation]
    const run = latest.get(...args) as (RunInfo & {triggerId: string | null}) | undefined
    const receipt = run && delivered.get(...args, conversation)
    const rows = receipt ? messages.all(conversation, receipt.triggerId!) : []
    const message = rows.find(row => String(row.id).startsWith('reply:')) ?? rows[0]
    const files = rows.flatMap(row => row.files ? JSON.parse(String(row.files)) as ChatDelivery[] : [])
    return {
      id, name, prompt, timing, active, revision, nextAt: active ? nextAt : undefined,
      lastRun: run ? { id: run.id, at: run.at, state: run.state } : null,
      lastResult: message ? { at: Number(rows[0]!.at), messageId: String(message.id), text: String(message.text).slice(0,240), files } : null,
    }
  })
}
