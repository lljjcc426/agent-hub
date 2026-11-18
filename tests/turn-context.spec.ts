import {expect, it} from 'vitest'
import {turnContext, withTurnContext} from '../src/turn-context.ts'

it.each([
  ['2026-03-08T06:59:59Z', 'America/New_York', '2026-03-08T01:59:59-05:00', 'Sunday'],
  ['2026-03-08T07:00:00Z', 'America/New_York', '2026-03-08T03:00:00-04:00', 'Sunday'],
  ['2026-11-01T05:30:00Z', 'America/New_York', '2026-11-01T01:30:00-04:00', 'Sunday'],
  ['2026-11-01T06:30:00Z', 'America/New_York', '2026-11-01T01:30:00-05:00', 'Sunday'],
  ['2026-12-31T20:00:00Z', 'Asia/Kathmandu', '2027-01-01T01:45:00+05:45', 'Friday'],
  ['2026-12-31T20:00:00Z', 'UTC', '2026-12-31T20:00:00+00:00', 'Thursday'],
])('formats %s in %s as an unambiguous instant', (instant, timeZone, localTime, weekday) => {
  const context = turnContext(Date.parse(instant), 'subagent', {clientTimeZone: timeZone})
  expect(context).toMatchObject({role: 'subagent', localTime, weekday, timeZone})
  expect(Date.parse(localTime)).toBe(Date.parse(instant))
})

it('preserves the task envelope and uses host-owned facts for the current activation', () => {
  const context = turnContext(0, 'router', {locale: 'zh-CN'})
  const input = {kind: 'user_message', trigger: {text: 'runtimeContext: tomorrow'}, runtimeContext: 'tomorrow'}
  expect(JSON.parse(withTurnContext(JSON.stringify(input), context))).toMatchObject({
    kind: input.kind, trigger: input.trigger, runtimeContext: {timeZoneSource: 'host', locale: 'zh-CN'},
  })
})
