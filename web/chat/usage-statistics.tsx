import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { ArrowUpRight, X } from 'lucide-react'
import { Button, ChoiceGroup } from '../ui/controls.tsx'
import type { UsageDay, UsagePeriod, UsageStatistics, UsageVolume } from '../../src/usage-contract.ts'
import './usage-statistics.css'

type Language = 'en' | 'zh-CN'
type Metric = 'tokens' | 'calls'
type Labels = (en: string, zh: string) => string
type FormatCount = (value: number) => string
type UsageResult = {period: UsagePeriod; request: number; data?: UsageStatistics}

const dateOf = (date: string) => new Date(date + 'T00:00:00Z')
const valueOf = (volume: UsageVolume, metric: Metric) => metric === 'calls' ? volume.calls : volume.tokens?.total ?? null

function scaleTicks(highest: number) {
  if (highest <= 3) return Array.from({length: Math.max(1, highest) + 1}, (_, index) => index).reverse()
  const target = highest / 3
  const magnitude = 10 ** Math.floor(Math.log10(target))
  const size = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(candidate => candidate * magnitude >= target) ?? 10
  const step = Math.ceil(size * magnitude)
  return [step * 3, step * 2, step, 0]
}

function UsageSummary({ data, count, compact, L }: {
  data?: UsageStatistics; count: FormatCount; compact: FormatCount; L: Labels
}) {
  const cells = [
    {label: L('Recorded tokens', '已记录 Token'), value: data?.total.tokens?.total ?? (data?.total.calls === 0 ? 0 : null), format: compact},
    {label: L('Model calls', '模型调用'), value: data?.total.calls ?? null, format: compact},
    {label: L('Active days', '活跃天数'), value: data?.days.filter(day => day.calls > 0).length ?? null, format: count},
  ]
  return (
    <dl className="usage-stats-summary" aria-hidden={!data || undefined}>
      {cells.map(({label, value, format}) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd title={value === null ? undefined : count(value)}>
            {data ? (value === null ? '—' : format(value)) : <span className="usage-stats-skeleton" />}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function UsageChart({ days, metric, selected, select, dayIdPrefix, language, count, compact, L }: {
  days: UsageDay[]; metric: Metric; selected: string | null; select: (date: string | null) => void
  dayIdPrefix: string; language: Language; count: FormatCount; compact: FormatCount; L: Labels
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const [hovered, setHovered] = useState<number | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  const [tabStop, setTabStop] = useState(days.length - 1)
  const selectedIndex = selected ? days.findIndex(day => day.date === selected) : -1
  const hoveredIndex = hovered ?? focused
  const marker = hoveredIndex ?? selectedIndex
  const hoveredDay = hoveredIndex === null ? undefined : days[hoveredIndex]
  const hoverValue = hoveredDay ? valueOf(hoveredDay, metric) : null
  const labelValues = days.map(day => valueOf(day, metric))
  const ticks = scaleTicks(Math.max(0, ...labelValues.map(value => value ?? 0)))
  const max = ticks[0]!
  const {formatDate, detailDate} = useMemo(() => ({
    formatDate: new Intl.DateTimeFormat(language, {month: 'numeric', day: 'numeric', timeZone: 'UTC'}).format,
    detailDate: new Intl.DateTimeFormat(language, {month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC'}).format,
  }), [language])
  const metricLabel = metric === 'calls' ? L('Calls', '调用') : 'Token'
  const unknown = L('Unavailable', '未记录')
  const dateLabels = days.length === 7 ? [0, 1, 2, 3, 4, 5, 6] : [0, 7, 14, 21, 29]
  const noTokens = metric === 'tokens' && labelValues.every(value => value === null)

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const target = ({ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: days.length - 1})[event.key]
    if (target === undefined) return
    event.preventDefault()
    buttons.current[Math.max(0, Math.min(days.length - 1, target))]?.focus()
  }

  return (
    <div className="usage-chart-frame" data-period={days.length} style={{'--usage-days': days.length} as CSSProperties}>
      <div className="usage-chart-plot" role="group" aria-label={L('Daily usage', '每日用量')}
        onPointerLeave={() => setHovered(null)}>
        <div className="usage-chart-grid" aria-hidden="true">
          {ticks.map(tick => (
            <div className="usage-chart-tick" key={tick} style={{top: (1 - tick / max) * 100 + '%'}}>
              <span>{compact(tick)}</span>
            </div>
          ))}
        </div>
        <span className="usage-chart-marker" aria-hidden="true" data-visible={marker >= 0}
          style={{'--usage-marker': Math.max(0, marker)} as CSSProperties} />
        <div className="usage-chart-columns">
          {days.map((day, index) => {
            const value = labelValues[index] ?? null
            const split = metric === 'tokens' ? day.tokens : null
            const unavailable = value === null && day.calls > 0
            const valueLabel = value === null ? (day.calls ? unknown : '0') : count(value)
            const height = value ? value / max : 0
            return (
              <button key={day.date} id={dayIdPrefix + day.date} type="button" className="usage-chart-day"
                ref={node => {buttons.current[index] = node}}
                tabIndex={tabStop === index ? 0 : -1}
                aria-label={detailDate(dateOf(day.date)) + ' · ' + metricLabel + ' ' + valueLabel}
                aria-pressed={day.date === selected} data-highlight={marker === index}
                onPointerEnter={event => {if (event.pointerType !== 'touch') setHovered(index)}}
                onFocus={() => {setTabStop(index); setFocused(index)}}
                onBlur={() => setFocused(null)}
                onKeyDown={event => moveFocus(event, index)}
                onClick={() => select(day.date === selected ? null : day.date)}>
                <span className="usage-chart-bar" data-empty={!value} data-unknown={unavailable}
                  style={{'--usage-height': height} as CSSProperties} aria-hidden="true">
                  {split && split.total > 0 ? <>
                    {split.input > 0 && <i data-part="input" style={{flexGrow: split.input}} />}
                    {split.output > 0 && <i data-part="output" style={{flexGrow: split.output}} />}
                    {split.unsplit > 0 && <i data-part="unsplit" style={{flexGrow: split.unsplit}} />}
                  </> : <i data-part="input" />}
                </span>
              </button>
            )
          })}
        </div>
        {noTokens && !hoveredDay && <div className="usage-chart-no-tokens">{L('No token counts reported', '暂无 Token 用量')}</div>}
        {hoveredDay && <div className="usage-chart-tooltip" aria-hidden="true"
          style={{'--usage-tip': ((marker + 0.5) / days.length) * 100 + '%'} as CSSProperties}>
          <span>{detailDate(dateOf(hoveredDay.date))}</span>
          <strong>{metricLabel} {hoverValue === null ? (hoveredDay.calls ? unknown : '0') : count(hoverValue)}</strong>
        </div>}
      </div>
      <div className="usage-chart-dates" aria-hidden="true">
        {dateLabels.map(index => (
          <span key={index} style={{gridColumn: index + 1}} data-today={index === days.length - 1}>
            {formatDate(dateOf(days[index]!.date))}
          </span>
        ))}
      </div>
    </div>
  )
}

function ModelBreakdown({ data, selected, clear, metric, language, count, compact, L }: {
  data: UsageStatistics; selected?: UsageDay; clear: () => void; metric: Metric
  language: Language; count: FormatCount; compact: FormatCount; L: Labels
}) {
  const [expanded, setExpanded] = useState(false)
  const total = valueOf(selected ?? data.total, metric) ?? 0
  const models = (selected?.models ?? data.models).toSorted((a, b) =>
    (valueOf(b, metric) ?? -1) - (valueOf(a, metric) ?? -1) || b.calls - a.calls ||
    (a.model ?? '').localeCompare(b.model ?? ''))
  const date = selected && new Intl.DateTimeFormat(language, {month: 'short', day: 'numeric', timeZone: 'UTC'})
    .format(dateOf(selected.date))
  return (
    <section className="usage-models" aria-label={L('Model breakdown', '模型分布')}>
      <div className="usage-stats-section-heading">
        <h2>{L('Model breakdown', '模型分布')}</h2>
        {date && <Button className="usage-date-clear" tone="quiet" onClick={clear}
          aria-label={L('Clear day filter', '清除日期筛选')}>
          {date}<X size={13} aria-hidden="true" />
        </Button>}
      </div>
      {models.length ? <ul className="usage-model-list">
        {(expanded ? models : models.slice(0, 5)).map(model => {
          const label = model.model ?? L('Model not recorded', '未记录模型')
          const value = valueOf(model, metric)
          return (
            <li key={model.model === null ? '' : model.model}>
              <div className="usage-model-row">
                <span title={label}>{label}</span>
                <strong title={value === null ? L('No token counts reported', '未返回 Token') : count(value)}>
                  {value === null ? '—' : compact(value)}
                </strong>
              </div>
              <div className="usage-model-track" aria-hidden="true">
                <span style={{'--usage-share': total && value !== null ? value / total : 0} as CSSProperties} />
              </div>
            </li>
          )
        })}
      </ul> : <p className="usage-model-empty">{L('No calls on this day', '当天没有模型调用')}</p>}
      <div className="usage-model-actions">
        {models.length > 5 && <Button tone="quiet" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
          {expanded ? L('Show fewer', '收起') : L('Show all', '查看全部')}
        </Button>}
        <a href="/configure#execution" className="rp-button" data-tone="quiet">
          {L('View model calls', '查看模型调用')}<ArrowUpRight size={15} aria-hidden="true" />
        </a>
      </div>
    </section>
  )
}

export function UsageStatisticsPage({ language }: { language: Language }) {
  const [period, setPeriod] = useState<UsagePeriod>(7)
  const [metric, setMetric] = useState<Metric>('tokens')
  const [selected, setSelected] = useState<string | null>(null)
  const [request, setRequest] = useState(0)
  const [result, setResult] = useState<UsageResult>()
  const sectionId = useId()
  const dayIdPrefix = sectionId + '-day-'
  const L: Labels = (en, zh) => language === 'zh-CN' ? zh : en
  const count = new Intl.NumberFormat(language).format
  const compact = new Intl.NumberFormat(language, {notation: 'compact', maximumFractionDigits: 1}).format
  const response = result?.period === period && result.request === request ? result : undefined
  const data = response?.data
  const selectedDay = data?.days.find(day => day.date === selected)
  const loading = !response

  function clearDay() {
    if (selected) document.getElementById(dayIdPrefix + selected)?.focus({preventScroll: true})
    setSelected(null)
  }

  useEffect(() => {
    const controller = new AbortController()
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const query = new URLSearchParams({days: String(period), timeZone})
    const timeout = window.setTimeout(() => controller.abort(), 12_000)
    let mounted = true
    void fetch('/api/usage-statistics?' + query, {signal: controller.signal, cache: 'no-store'})
      .then(response => {
        if (!response.ok) throw Error('Usage statistics request failed')
        return response.json() as Promise<UsageStatistics>
      })
      .then(data => {if (mounted) setResult({period, request, data})})
      .catch(() => {if (mounted) setResult({period, request})})
      .finally(() => clearTimeout(timeout))
    return () => {
      mounted = false
      clearTimeout(timeout)
      controller.abort()
    }
  }, [period, request])

  return (
    <section className="settings-directory roppo-ui usage-stats" aria-labelledby="page-title">
      <header className="usage-stats-heading">
        <h1 id="page-title" tabIndex={-1}>{L('Usage statistics', '使用统计')}</h1>
        <ChoiceGroup label={L('Date range', '时间范围')} value={period === 7 ? '7' : '30'} choices={[
          {value: '7', label: L('Last 7 days', '近 7 天')},
          {value: '30', label: L('Last 30 days', '近 30 天')},
        ]} onChange={value => {setPeriod(value === '30' ? 30 : 7); setSelected(null); setRequest(value => value + 1)}} />
      </header>
      <div aria-busy={loading || undefined}>
        {(loading || data) && <UsageSummary data={data} count={count} compact={compact} L={L} />}
        {data?.watchdogUnavailable && <p className="usage-stats-notice" role="status">
          {L('Some usage could not be read.', '部分用量暂时无法读取。')}
        </p>}
        {loading ? <div className="usage-stats-placeholder" role="status">
          <span className="usage-stats-skeleton" aria-hidden="true" />
          <span className="usage-stats-sr">{L('Loading usage statistics…', '正在读取使用统计…')}</span>
        </div> : !data ? <div className="usage-stats-empty" role="alert">
          <p>{L('Could not load usage statistics.', '无法读取使用统计。')}</p>
          <Button onClick={() => setRequest(value => value + 1)}>{L('Try again', '重试')}</Button>
        </div> : data.total.calls === 0 ? <div className="usage-stats-empty">
          <p>{L('No model calls in this period.', '这段时间没有模型调用。')}</p>
          <a href="/configure#execution" className="rp-button" data-tone="quiet">
            {L('View model calls', '查看模型调用')}<ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </div> : <div className="usage-stats-board">
          <section className="usage-trend" aria-labelledby={sectionId}>
            <div className="usage-stats-section-heading">
              <h2 id={sectionId}>{L('Daily trend', '使用趋势')}</h2>
              <ChoiceGroup label={L('Chart measure', '图表指标')} value={metric} choices={[
                {value: 'tokens', label: 'Token'},
                {value: 'calls', label: L('Calls', '调用')},
              ]} onChange={setMetric} />
            </div>
            <div className="usage-chart-legend">
              {metric === 'tokens' && <>
                <span><i data-part="input" />{L('Input', '输入')}</span>
                <span><i data-part="output" />{L('Output', '输出')}</span>
                {!!data.total.tokens?.unsplit && <span><i data-part="unsplit" />{L('Total only', '仅总量')}</span>}
                {data.total.incompleteCalls > 0 && <span className="usage-coverage">
                  {L(`Incomplete usage for ${count(data.total.incompleteCalls)} calls`, `${count(data.total.incompleteCalls)} 次用量不全`)}
                </span>}
              </>}
            </div>
            <UsageChart days={data.days} metric={metric} selected={selected} select={setSelected} dayIdPrefix={dayIdPrefix}
              language={language} count={count} compact={compact} L={L} />
          </section>
          <ModelBreakdown data={data} selected={selectedDay} clear={clearDay}
            metric={metric} language={language} count={count} compact={compact} L={L} />
        </div>}
      </div>
    </section>
  )
}
