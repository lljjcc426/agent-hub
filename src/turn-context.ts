import type {ModelRequest} from './model.ts'

export function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', {timeZone: value})
    return !/^[+-]/.test(value)
  } catch {
    return false
  }
}

type TurnOrigin = {
  clientTimeZone?: string
  schedule?: {timeZone: string; dueAt: number}
  locale?: string
  channel?: string
  eventAt?: string
}

/** Snapshot at dispatch. Event and scheduled timestamps retain their original instants. */
export function turnContext(now: number, role: NonNullable<ModelRequest['role']>, origin: TurnOrigin) {
  const timeZone = origin.schedule?.timeZone ?? origin.clientTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  })
  const p = Object.fromEntries(formatter.formatToParts(now).map(({type, value}) => [type, value]))
  const offset = p.timeZoneName!.slice(3) || '+00:00'
  return {
    localTime: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`,
    weekday: p.weekday, timeZone,
    timeZoneSource: origin.schedule ? 'schedule' : origin.clientTimeZone ? 'browser' : 'host',
    role, channel: origin.channel, locale: origin.locale, eventAt: origin.eventAt,
    scheduledFor: origin.schedule ? new Date(origin.schedule.dueAt).toISOString() : undefined,
  }
}

/** Keep the native turn's existing top-level fields and the cacheable instructions intact. */
export function withTurnContext(input: string, context: ReturnType<typeof turnContext>): string {
  let content: unknown
  try { content = JSON.parse(input) } catch { content = input }
  const fields = content !== null && typeof content === 'object' && !Array.isArray(content) ? content : {input: content}
  return JSON.stringify({...fields, runtimeContext: context})
}
