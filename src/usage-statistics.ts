import { normalizeUsage } from './model-usage.ts'
import type { ModelUsageVolume, UsageDay, UsagePeriod, UsageStatistics, UsageVolume } from './usage-contract.ts'
import type { UsageRecord } from './usage-ledger.ts'

export function isUsageTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', {timeZone: value})
    return true
  } catch {
    return false
  }
}

const dayMs = 86_400_000

export function usageCalendar(period: UsagePeriod, timeZone: string, now: number) {
  const formatter = new Intl.DateTimeFormat('en', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'})
  const localDate = (at: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]))
    return parts.year + '-' + parts.month + '-' + parts.day
  }
  const first = Date.parse(localDate(now) + 'T00:00:00Z') - (period - 1) * dayMs
  const dates = Array.from({length: period}, (_, index) => new Date(first + index * dayMs).toISOString().slice(0, 10))
  // Calendar keys, not elapsed 24-hour windows. Pad the SQL cutoff for the local offset.
  return {localDate, dates, since: first - dayMs, now}
}

const emptyVolume = (): UsageVolume => ({calls: 0, incompleteCalls: 0, tokens: null})
const emptyTokens = () => ({total: 0, input: 0, output: 0, unsplit: 0})

function callVolume(record: UsageRecord): UsageVolume {
  const steps = Object.values(record.steps ?? {})
  const volume: UsageVolume = {calls: 1, incompleteCalls: steps.length ? 0 : 1, tokens: null}
  for (const step of steps) {
    const usage = normalizeUsage(step)
    if (usage?.totalTokens === undefined) volume.incompleteCalls = 1
    if (!usage || (usage.totalTokens === undefined && usage.inputTokens === undefined && usage.outputTokens === undefined)) continue
    const tokens = volume.tokens ??= emptyTokens()
    tokens.total += usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))
    // Cached input and reasoning output are already part of their parent counts.
    if (usage.totalTokens === undefined || (usage.inputTokens !== undefined && usage.outputTokens !== undefined)) {
      tokens.input += usage.inputTokens ?? 0
      tokens.output += usage.outputTokens ?? 0
    } else {
      tokens.unsplit += usage.totalTokens
    }
  }
  return volume
}

function addVolume(target: UsageVolume, addition: UsageVolume) {
  target.calls += addition.calls
  target.incompleteCalls += addition.incompleteCalls
  if (addition.tokens) {
    const tokens = target.tokens ??= emptyTokens()
    tokens.total += addition.tokens.total
    tokens.input += addition.tokens.input
    tokens.output += addition.tokens.output
    tokens.unsplit += addition.tokens.unsplit
  }
}

function addModel(models: Map<string | null, ModelUsageVolume>, model: string | null, volume: UsageVolume) {
  let entry = models.get(model)
  if (!entry) models.set(model, entry = {model, ...emptyVolume()})
  addVolume(entry, volume)
}

function safeVolume(volume: UsageVolume) {
  if (volume.tokens && !Number.isSafeInteger(volume.tokens.total)) {
    volume.tokens = null
    volume.incompleteCalls = volume.calls
  }
}

export function aggregateUsage(records: UsageRecord[], calendar: ReturnType<typeof usageCalendar>): UsageStatistics {
  const total = emptyVolume()
  const models = new Map<string | null, ModelUsageVolume>()
  const days = new Map(calendar.dates.map(date => [date, {
    volume: {date, ...emptyVolume(), models: []} satisfies UsageDay,
    models: new Map<string | null, ModelUsageVolume>(),
  }]))
  for (const record of records) {
    if (!Number.isFinite(record.at) || record.at < calendar.since || record.at > calendar.now) continue
    const day = days.get(calendar.localDate(record.at))
    if (!day) continue
    const volume = callVolume(record)
    const model = record.model?.trim().slice(0, 200) || null
    addVolume(day.volume, volume)
    addVolume(total, volume)
    addModel(day.models, model, volume)
    addModel(models, model, volume)
  }
  safeVolume(total)
  for (const volume of models.values()) safeVolume(volume)
  return {
    total,
    days: Array.from(days.values(), ({volume, models}) => {
      safeVolume(volume)
      for (const model of models.values()) safeVolume(model)
      return {...volume, models: [...models.values()]}
    }),
    models: [...models.values()],
  }
}
