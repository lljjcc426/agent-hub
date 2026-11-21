import {z} from 'zod'
import type {Runtime} from './runtime.ts'

const intervalMinutes = 30
const intervalMs = intervalMinutes * 60_000
const scheduleKind = 'heartbeat-schedule'
const scheduleId = 'local'
const runKind = 'heartbeat-run'
const historyLimit = 100

type Schedule = {active: boolean; revision: number; nextAt: number | null}
const inactive: Schedule = {active: false, revision: 0, nextAt: null}

export const heartbeatChange = z.object({
  active: z.boolean(),
  expectedRevision: z.number().int().nonnegative(),
}).strict()
export type HeartbeatChange = z.infer<typeof heartbeatChange>

export type HeartbeatIssue =
  | {check: 'chat'; code: string}
  | {check: 'watchdog'; code: 'missing' | 'stale'}
  | {check: 'feishu'; source: string; code: 'missing' | 'stale' | 'retrying' | 'error'}
  | {check: 'heartbeat'; code: 'check_failed'}

export interface HeartbeatRun {
  id: string
  scheduledAt: number
  ranAt: number
  state: 'success' | 'failed'
  issues: HeartbeatIssue[]
}

export interface HeartbeatStatus extends Schedule {
  intervalMinutes: number
  hostPaused: boolean
  runs: HeartbeatRun[]
}

type HeartbeatHost = Pick<Runtime, 'config' | 'store' | 'isPaused'> & {
  chat: Pick<Runtime['chat'], 'readiness'>
}

export class Heartbeat {
  constructor(
    private readonly host: HeartbeatHost,
    private readonly now: () => number,
  ) {}

  private schedule() {
    return this.host.store.get<Schedule>(scheduleKind, scheduleId) ?? inactive
  }

  snapshot(): HeartbeatStatus {
    return {
      ...this.schedule(),
      intervalMinutes,
      hostPaused: this.host.isPaused,
      runs: this.host.store.list<HeartbeatRun>(runKind).reverse(),
    }
  }

  change(input: HeartbeatChange) {
    const {store} = this.host
    return store.atomic(() => {
      const plan = this.schedule()
      if (plan.revision !== input.expectedRevision) return null
      if (plan.active !== input.active) {
        const next: Schedule = {
          active: input.active,
          revision: plan.revision + 1,
          nextAt: input.active ? this.now() : null,
        }
        store.put(scheduleKind, scheduleId, next)
      }
      return this.snapshot()
    })
  }

  tick() {
    if (this.host.isPaused) return
    const {store} = this.host
    const plan = this.schedule()
    const now = this.now()
    if (!plan.active || plan.nextAt === null || plan.nextAt > now) return
    // One occurrence after downtime. Store its result and advance the schedule together.
    const scheduledAt = plan.nextAt + Math.floor((now - plan.nextAt) / intervalMs) * intervalMs
    const id = plan.revision + ':' + scheduledAt
    let issues: HeartbeatIssue[]
    try {
      issues = this.check(now)
    } catch {
      issues = [{check: 'heartbeat', code: 'check_failed'}]
    }
    const run: HeartbeatRun = {
      id, scheduledAt, ranAt: now, state: issues.length ? 'failed' : 'success', issues,
    }
    store.atomic(() => {
      store.put(runKind, id, run)
      store.put(scheduleKind, scheduleId, {...plan, nextAt: scheduledAt + intervalMs})
      store.db.prepare(`
        DELETE FROM records WHERE kind = ? AND id IN (
          SELECT id FROM records WHERE kind = ? ORDER BY rowid DESC LIMIT -1 OFFSET ?
        )
      `).run(runKind, runKind, historyLimit)
    })
  }

  private check(now: number): HeartbeatIssue[] {
    const {store, config, chat} = this.host
    const issues: HeartbeatIssue[] = []
    const readiness = chat.readiness()
    if (!readiness.ready) issues.push({check: 'chat', code: readiness.code})

    if (config.watchdog.enabled) {
      const beat = store.get<{receivedAt?: number}>('health', 'watchdog')?.receivedAt
      const limit = Math.max(120_000, 3 * Math.min(60_000, config.watchdog.intervalMs))
      if (typeof beat !== 'number' || !Number.isFinite(beat)) issues.push({check: 'watchdog', code: 'missing'})
      else if (now - beat > limit || beat > now + 5_000) issues.push({check: 'watchdog', code: 'stale'})
    }

    for (const source of config.sources) {
      if (source.kind !== 'feishu' || !source.enabled || !source.capabilities.events) continue
      const health = store.get<{at: number; status: 'ok' | 'retrying' | 'error'}>('source-health', source.id)
      const limit = Math.max(180_000, 3 * source.pollSeconds * 1000)
      const code = !health || !Number.isFinite(health.at) ? 'missing'
        : now - health.at > limit || health.at > now + 5_000 ? 'stale' : health.status
      if (code !== 'ok') issues.push({check: 'feishu', source: source.label ?? source.id, code})
    }
    return issues
  }
}
