import type { Store } from './store.ts'
import type { UsageRecord } from './usage-ledger.ts'

export function contextReading(usage?: UsageRecord, attempt?: number) {
  const attempts = Object.keys(usage?.attempts ?? {}).map(Number)
  const selected = attempt ?? (attempts.length ? Math.max(...attempts) : undefined)
  const last = Object.entries(usage?.steps ?? {}).findLast(([key]) => selected === undefined || key.startsWith(selected + ':'))
  return {
    inputTokens: last?.[1].inputTokens ?? null,
    capacity: last?.[1].contextWindowTokens ?? null,
    reportedAt: last && usage?.latestReading?.key === last[0] ? usage.latestReading.at : null,
  }
}

/** Chat-call lineage is immutable. A later task reassignment must never move old readings across conversations. */
export function teamContext(store: Store, conversationId: string) {
  // Restrict by conversation first, then read only the newest call in each model session of each task.
  const rows = store.db.prepare(`WITH ranked AS (
    SELECT c.id, json_extract(c.body,'$.workerId') AS workerId, json_extract(c.body,'$.ticketId') AS ticketId,
      json_extract(c.body,'$.kind') AS role, json_extract(c.body,'$.model') AS model,
      json_extract(c.body,'$.backend') AS backend, json_extract(c.body,'$.startedAt') AS startedAt,
      json_extract(c.body,'$.state') AS state, json_extract(u.body,'$.sessionKey') AS sessionKey,
      row_number() OVER (PARTITION BY json_extract(c.body,'$.kind'),json_extract(c.body,'$.workerId'),
        json_extract(c.body,'$.ticketId'),coalesce(json_extract(u.body,'$.sessionKey'),c.id)
        ORDER BY json_extract(c.body,'$.startedAt') DESC,c.rowid DESC) AS rank
    FROM records c LEFT JOIN records u ON u.kind='model-usage' AND u.id=c.id
    WHERE c.kind='chat-call' AND json_extract(c.body,'$.conversationId')=?
      AND json_extract(c.body,'$.kind') IN ('router','worker')
  ) SELECT r.*,u.body AS usage FROM ranked r LEFT JOIN records u ON u.kind='model-usage' AND u.id=r.id
    WHERE r.rank=1 ORDER BY r.startedAt DESC,r.id DESC`).all(conversationId)
  return rows.map(row => {
    const usage: UsageRecord | undefined = row.usage ? JSON.parse(String(row.usage)) : undefined
    return {
      activity: String(row.id), workerId: row.role === 'worker' && row.workerId ? String(row.workerId) : null,
      role: String(row.role), ticketId: row.ticketId ? String(row.ticketId) : null,
      session: row.sessionKey ? String(row.sessionKey) : null,
      model: usage?.model ?? (row.model ? String(row.model) : null),
      backend: usage?.backend ?? (row.backend ? String(row.backend) : null),
      startedAt: Number(row.startedAt), state: String(row.state), ...contextReading(usage),
    }
  })
}
