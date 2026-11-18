import { useId, useMemo, useState, type FormEvent } from 'react'
import type { Timing } from '../../src/schedule-time.ts'
import { localDateTime, nextTime, wallInstant } from '../../src/schedule-calendar.ts'
import { Button } from './controls.tsx'
import type { Localize } from '../chat/composer-commands.tsx'

const week = [1, 2, 3, 4, 5, 6, 0]
const presets = { workdays: [1, 2, 3, 4, 5], weekend: [6, 0] }
type Frequency = Timing['kind'] | keyof typeof presets
function frequency(t: Timing): Frequency {
  if (t.kind !== 'weekly') return t.kind
  return (Object.keys(presets) as (keyof typeof presets)[]).find(key =>
    week.every(day => presets[key].includes(day) === t.weekdays!.includes(day))) ?? 'weekly'
}

function frequencies(L: Localize): Record<Frequency, string> {
  return { once: L('Once', '单次'), interval: L('Fixed interval', '固定间隔'), daily: L('Daily', '每天'),
    workdays: L('Weekdays', '工作日'), weekend: L('Weekends', '周末'), weekly: L('Selected weekdays', '每周自选') }
}
function dayLabel(day: number, lang: string) {
  return new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 7 + day))
}
export function scheduleDate(at: number, zone: string, lang: string) {
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'medium', timeZone: zone }).format(at)
}
function intervalUnit(seconds: number) { return seconds % 3600 === 0 ? 3600 : seconds % 60 === 0 ? 60 : 1 }
export function scheduleCadence(t: Timing, lang: string, L: Localize) {
  const f = frequency(t)
  if (f === 'interval') {
    const seconds = t.intervalSeconds!, unit = intervalUnit(seconds), n = seconds / unit
    return unit === 3600 ? L('Every '+n+' h', '每 '+n+' 小时') : unit === 60 ? L('Every '+n+' min', '每 '+n+' 分钟') : L('Every '+n+' s', '每 '+n+' 秒')
  }
  if (f === 'weekly') return week.filter(d => t.weekdays!.includes(d)).map(d => dayLabel(d, lang)).join(' · ')+' '+t.time
  return frequencies(L)[f] + (t.time && f !== 'once' ? ' '+t.time : '')
}
const zones = ['UTC', ...Intl.supportedValuesOf('timeZone')]
function dateValue(text: string, zone: string, originalZone: string, original?: string) {
  const normalized = text.length === 16 ? text+':00' : text
  if (original && zone === originalZone && normalized === localDateTime(Date.parse(original), zone)) return original
  const at = wallInstant(normalized, zone)
  return at === undefined ? undefined : new Date(at).toISOString()
}

export function ScheduleEditor({ timing, active, lang, L, busy, stale, reload, save }: {
  timing: Timing; active: boolean; lang: string; L: Localize; busy: boolean; stale: boolean
  reload: () => void; save: (value: Timing) => Promise<void>
}) {
  const [kind, setKind] = useState(frequency(timing)), [zone, setZone] = useState(timing.timezone)
  const [start, setStart] = useState(() => localDateTime(Date.parse(timing.startAt), timing.timezone))
  const [end, setEnd] = useState(() => timing.endAt ? localDateTime(Date.parse(timing.endAt), timing.timezone) : '')
  const [time, setTime] = useState(timing.time ?? start.slice(11, 16))
  const [days, setDays] = useState(timing.weekdays ?? [1])
  const initialUnit = intervalUnit(timing.intervalSeconds ?? 3600)
  const [unit, setUnit] = useState(initialUnit), [count, setCount] = useState(String((timing.intervalSeconds ?? 3600) / initialUnit))
  const zoneList = useId()
  const draft = useMemo((): { value?: Timing; next?: number; error?: string } => {
    try { new Intl.DateTimeFormat('en', { timeZone: zone }) } catch { return { error: L('Choose a valid time zone.', '请选择有效时区。') } }
    const startAt = dateValue(start, zone, timing.timezone, timing.startAt)
    const endAt = end ? dateValue(end, zone, timing.timezone, timing.endAt) : undefined
    if (!startAt || (end && !endAt)) return { error: L('This local date or time does not exist in this zone.', '这个日期或时间在所选时区不存在。') }
    if (endAt && Date.parse(endAt) <= Date.parse(startAt)) return { error: L('End must be after the start.', '结束时间须晚于开始时间。') }
    const value: Timing = { timezone: zone, startAt, ...(endAt ? { endAt } : {}), kind: kind === 'workdays' || kind === 'weekend' ? 'weekly' : kind }
    if (kind === 'interval') {
      const seconds = Number(count) * unit
      if (!Number.isSafeInteger(seconds) || seconds < 60) return { error: L('Use an interval of at least one minute.', '间隔至少为一分钟。') }
      value.intervalSeconds = seconds
    }
    if (value.kind === 'weekly') {
      value.weekdays = kind === 'workdays' || kind === 'weekend' ? presets[kind] : week.filter(day => days.includes(day))
      if (!value.weekdays.length) return { error: L('Select a weekday.', '请至少选择一天。') }
    }
    if (value.kind === 'weekly' || value.kind === 'daily') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: L('Choose a time.', '请选择执行时间。') }
      value.time = time
    }
    const next = nextTime(value, Date.now())
    return next === undefined ? { error: L('No future occurrence in this time range.', '这个时间范围内没有下一次执行。') } : { value, next }
  }, [kind, zone, start, end, time, count, unit, days, timing, L])
  const same = draft.value && (['kind','timezone','startAt','endAt','intervalSeconds','time'] as const).every(k => draft.value![k] === timing[k])
    && week.every(d => !!draft.value!.weekdays?.includes(d) === !!timing.weekdays?.includes(d))
  const dates = (once: boolean) => <div className="rp-schedule-fields">
    <label>{once ? L('Run at', '执行日期与时间') : L('Start', '开始时间')}<input type="datetime-local" step="1" value={start} onChange={e=>setStart(e.target.value)} required/></label>
    {!once && <label>{L('End (optional)', '结束时间（可选）')}<input type="datetime-local" step="1" value={end} onChange={e=>setEnd(e.target.value)}/></label>}
  </div>
  function submit(e: FormEvent) { e.preventDefault(); if (draft.value && !same && !stale && !busy) void save(draft.value) }
  return <form className="rp-schedule-form" onSubmit={submit}>
    <div className="rp-schedule-fields">
      <label>{L('Frequency', '频率')}<select value={kind} onChange={e=>setKind(e.target.value as Frequency)}>
        {Object.entries(frequencies(L)).map(([key, label])=><option value={key} key={key}>{label}</option>)}
      </select></label>
      <label>{L('Time zone', '时区')}<input list={zoneList} value={zone} onChange={e=>setZone(e.target.value)} autoComplete="off" required/>
        <datalist id={zoneList}>{(zone && !zones.includes(zone) ? [zone,...zones] : zones).map(z=><option value={z} key={z}/>)}</datalist>
      </label>
    </div>
    {kind === 'weekly' && <fieldset className="rp-weekdays"><legend>{L('Days of the week', '执行日')}</legend>
      {week.map(d=><button key={d} type="button" aria-pressed={days.includes(d)} onClick={()=>setDays(old=>old.includes(d)?old.filter(n=>n!==d):[...old,d])}>{dayLabel(d,lang)}</button>)}
    </fieldset>}
    {kind === 'once' ? dates(true) : <>
      {kind === 'interval' ? <div className="rp-schedule-fields">
        <label>{L('Repeat every', '每隔')}<input type="number" min={1} step={1} value={count} onChange={e=>setCount(e.target.value)}/></label>
        <label>{L('Unit', '单位')}<select value={unit} onChange={e=>setUnit(Number(e.target.value) as typeof unit)}>
          <option value={60}>{L('Minutes', '分钟')}</option><option value={3600}>{L('Hours', '小时')}</option><option value={1}>{L('Seconds', '秒')}</option>
        </select></label>
      </div> : <label>{L('Local time', '执行时间')}<input type="time" value={time} onChange={e=>setTime(e.target.value)} required/></label>}
      <details><summary>{L('Date range', '日期范围')}</summary>{dates(false)}</details>
    </>}
    <div className="rp-schedule-save">
      <small aria-live="polite">{stale ? L('This schedule was changed elsewhere.', '排期已在其他窗口更改。') : draft.error ??
        (draft.next !== undefined ? (active ? L('Next · ', '下次 · ') : L('After resuming · ', '恢复后 · ')) + scheduleDate(draft.next, zone, lang) : '')}</small>
      {stale ? <Button onClick={reload}>{L('Reload schedule', '载入最新排期')}</Button>
        : <Button tone="primary" type="submit" busy={busy} disabled={!draft.value || same}>{L('Save schedule', '保存排期')}</Button>}
    </div>
  </form>
}
