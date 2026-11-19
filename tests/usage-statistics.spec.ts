import { describe, expect, it } from 'vitest'
import { aggregateUsage, isUsageTimeZone, usageCalendar } from '../src/usage-statistics.ts'
import type { UsageRecord } from '../src/usage-ledger.ts'

function call(id: string, at: string, steps: UsageRecord['steps'], model?: string): UsageRecord {
  return {id, model, at: Date.parse(at), steps, state: 'completed', purpose: 'router', role: 'router'}
}

describe('usage statistics', () => {
  it('groups calls by local calendar date across a daylight saving change', () => {
    const calendar = usageCalendar(7, 'America/New_York', Date.parse('2026-03-09T12:00:00Z'))
    const snapshot = aggregateUsage([
      call('old', '2026-03-03T04:59:00Z', {}),
      call('first', '2026-03-03T05:00:00Z', {}),
      call('before-midnight', '2026-03-09T03:59:59Z', {}),
      call('midnight', '2026-03-09T04:00:00Z', {}),
      call('future', '2026-03-09T12:00:01Z', {}),
    ], calendar)
    expect(snapshot.days.map(day => [day.date, day.calls])).toEqual([
      ['2026-03-03', 1], ['2026-03-04', 0], ['2026-03-05', 0], ['2026-03-06', 0],
      ['2026-03-07', 0], ['2026-03-08', 1], ['2026-03-09', 1],
    ])
    expect(snapshot.total).toEqual({calls: 3, incompleteCalls: 3, tokens: null})
    expect(isUsageTimeZone('Asia/Shanghai')).toBe(true)
    expect(isUsageTimeZone('Asia/Unknown')).toBe(false)
  })

  it('groups recorded token portions and keeps missing usage separate from zero', () => {
    const at = '2026-11-18T10:00:00Z'
    const calendar = usageCalendar(30, 'Pacific/Kiritimati', Date.parse('2026-11-19T14:00:00Z'))
    const snapshot = aggregateUsage([
      call('split', at, {
        '0:step': {id: 'step', inputTokens: 100, cachedInputTokens: 75, outputTokens: 20, reasoningOutputTokens: 5},
        '1:step': {id: 'step', totalTokens: 50},
      }, 'model-a'),
      call('partial', at, {'0:step': {id: 'step', inputTokens: 40}}, 'model-a'),
      call('old-record', at, {}, 'model-b'),
      call('zero', at, {'0:step': {id: 'step', inputTokens: 0, outputTokens: 0}}),
    ], calendar)
    const allTokens = {total: 210, input: 140, output: 20, unsplit: 50}
    expect(snapshot.total).toEqual({calls: 4, incompleteCalls: 2, tokens: allTokens})
    expect(snapshot.days).toHaveLength(30)
    expect(snapshot.days.find(day => day.date === '2026-11-19')?.tokens).toEqual(allTokens)
    expect(snapshot.days.at(-1)?.date).toBe('2026-11-20')
    expect(snapshot.models).toEqual([
      {model: 'model-a', calls: 2, incompleteCalls: 1, tokens: allTokens},
      {model: 'model-b', calls: 1, incompleteCalls: 1, tokens: null},
      {model: null, calls: 1, incompleteCalls: 0, tokens: {total: 0, input: 0, output: 0, unsplit: 0}},
    ])
  })
})
