import { useId, useState, type ComponentProps } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { TaskActivity } from '../../src/chat-task-activity.ts'
import { TaskActivityRow } from '../ui/task-activity.tsx'

const recentTaskCount = 20

export function TaskActivityList({ activities, lang, L, openTask, ...row }: {
  activities: TaskActivity[]
  lang: string
  openTask?: (activity: TaskActivity, source: HTMLButtonElement) => void
} & Pick<ComponentProps<typeof TaskActivityRow>, 'agentName' | 'onAgent' | 'L'>) {
  const [showOlder, setShowOlder] = useState(false)
  const olderId = useId()
  const dayLabel = new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric' })
  const groups = new Map<string, { at: number; older: boolean; items: TaskActivity[] }>()
  for (const [index, activity] of activities.entries()) {
    const at = activity.updatedAt
    const date = new Date(at)
    const key = at > 0 && Number.isFinite(date.valueOf())
      ? [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(part => String(part).padStart(2, '0')).join('-')
      : ''
    const group = groups.get(key)
    if (group) group.items.push(activity)
    else groups.set(key, { at, older: index >= recentTaskCount, items: [activity] })
  }
  const days = [...groups]
  const closed = days.findIndex(([, group]) => group.older)
  const recent = closed < 0 ? days : days.slice(0, closed)
  const older = closed < 0 ? [] : days.slice(closed)
  const renderDay = ([key, { at, items }]: typeof days[number]) => (
    <details className="task-activity-day" open key={key}>
      <summary>
        <ChevronRight size={14} aria-hidden="true" />
        {key ? <time dateTime={key}>{dayLabel.format(at)}</time> : L('Date unknown', '日期未知')}
      </summary>
      {items.map(activity =>
        <TaskActivityRow key={activity.id} activity={activity} L={L} {...row}
          onOpen={openTask ? source => openTask(activity, source) : undefined} />)}
    </details>
  )
  return (
    <div className="task-activity-list">
      {recent.map(renderDay)}
      {!!older.length && <>
        <button type="button" className="team-show-older" aria-controls={olderId}
          aria-expanded={showOlder} onClick={() => setShowOlder(previous => !previous)}>
          <ChevronDown size={15} aria-hidden="true" />
          {showOlder ? L('Hide older tasks', '收起更早任务') : L('Show older tasks', '展开更早任务')}
        </button>
        <div id={olderId} hidden={!showOlder}>{showOlder && older.map(renderDay)}</div>
      </>}
    </div>
  )
}
