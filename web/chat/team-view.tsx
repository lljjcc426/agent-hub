import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  CalendarClock,
  Check,
  ChevronRight,
  Folder,
  Globe,
  List,
  Pause,
  Pencil,
  Play,
  Users,
  X,
} from 'lucide-react'
import type { ChatSessions } from '../../src/chat.ts'
import type { ChatDelivery } from '../../src/chat-deliveries.ts'
import type { Timing } from '../../src/schedule-time.ts'
import { deliveryFile } from './delivery-links.ts'
import { DeliveryFileCard } from '../ui/delivery-files.tsx'
import { AgentAvatar } from './agent-avatar.tsx'
import { TaskActivityRow } from '../ui/task-activity.tsx'
import { taskActivities } from './task-activity.ts'

type View = ReturnType<ChatSessions['view']>
type Localize = (en: string, zh: string) => string
export type TeamTab = 'activity' | 'agents' | 'schedules'
type Schedule = View['schedules'][number]
const tabs = [
  { id: 'activity', Icon: List },
  { id: 'agents', Icon: Users },
  { id: 'schedules', Icon: CalendarClock },
] as const
export const teamName = (label: string) => (label.replace(/(?:^Router$| · Router$)/, '').trim() || 'Roppo')

export function scheduleLabel(t: Timing, lang: string, L: Localize) {
  if (t.kind === 'once')
    return new Intl.DateTimeFormat(lang, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: t.timezone,
    }).format(new Date(t.startAt))
  if (t.kind === 'interval') {
    const n = t.intervalSeconds ?? 60
    if (n % 3600 === 0) return L('Every ' + n / 3600 + ' h', '每 ' + n / 3600 + ' 小时')
    return n % 60 === 0
      ? L('Every ' + n / 60 + ' min', '每 ' + n / 60 + ' 分钟')
      : L('Every ' + n + ' s', '每 ' + n + ' 秒')
  }
  const days = (t.weekdays ?? []).map((d) =>
    new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 7 + d)),
  )
  return (t.kind === 'weekly' ? days.join('、') : L('Daily', '每天')) + ' ' + t.time + ' · ' + t.timezone
}

interface TeamOverviewProps {
  cards?: ReactNode
  focusOnOpen: boolean
  snapshot: View | null
  participants: View['participants']
  routerLabel: string
  lang: string
  L: Localize
  tab: TeamTab
  setTab: (tab: TeamTab) => void
  close: () => void
  select: (id: string) => void
  openFile: (file: ChatDelivery) => void
  resource: (kind: 'browser' | 'files') => void
  changeSchedule: (plan: Schedule) => Promise<void>
}
export function TeamOverview({
  cards,
  focusOnOpen,
  snapshot,
  participants,
  routerLabel,
  lang,
  L,
  tab,
  setTab,
  close,
  select,
  openFile,
  resource,
  changeSchedule,
}: TeamOverviewProps) {
  const [busy, setBusy] = useState<string[]>([]),
    [error, setError] = useState('')
  const titles = { activity: L('Overview', '概览'), agents: 'Agents', schedules: L('Schedules', '定时') }
  const activities = snapshot ? taskActivities(snapshot) : []
  const files = snapshot?.deliveries ?? [],
    plans = snapshot?.schedules ?? []
  const toggle = async (plan: Schedule) => {
    setBusy((ids) => [...ids, plan.id])
    setError('')
    try {
      await changeSchedule(plan)
    } catch {
      setError(
        L('Could not change this schedule. Check its latest state.', '未能修改定时任务，请查看最新状态。'),
      )
    } finally {
      setBusy((ids) => ids.filter((id) => id !== plan.id))
    }
  }
  return (
    <>
      <div className="team-drawer-head">
        <div className="team-profile">
          <span className="team-portrait">
            <AgentAvatar size={54} />
          </span>
          <div>
            <div className="team-profile-name">
              <strong>{teamName(routerLabel)}</strong>
              <a
                className="icon-button"
                href="/configure#execution/configuration/router"
                aria-label={L('Edit profile', '编辑资料')}
                title={L('Edit profile', '编辑资料')}
              >
                <Pencil size={13} />
              </a>
            </div>
          </div>
        </div>
        <button
          className="icon-button"
          autoFocus={focusOnOpen}
          aria-label={L('Close panel', '收起面板')}
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      <div className="team-tabs" role="tablist" aria-label={L('Team views', '团队视图')} data-tab={tab}>
        {tabs.map(({ id, Icon }, i) => (
          <button
            key={id}
            id={'team-tab-' + id}
            role="tab"
            tabIndex={tab === id ? 0 : -1}
            aria-selected={tab === id}
            aria-controls="team-tab-content"
            onClick={() => setTab(id)}
            onKeyDown={(e) => {
              const n =
                e.key === 'ArrowRight'
                  ? (i + 1) % 3
                  : e.key === 'ArrowLeft'
                    ? (i + 2) % 3
                    : e.key === 'Home'
                      ? 0
                      : e.key === 'End'
                        ? 2
                        : -1
              if (n < 0) return
              e.preventDefault()
              const target = tabs[n]!.id
              setTab(target)
              document.getElementById('team-tab-' + target)?.focus()
            }}
          >
            <Icon size={15} />
            {titles[id]}
          </button>
        ))}
      </div>
      <div
        id="team-tab-content"
        className="team-tab-content"
        role="tabpanel"
        aria-labelledby={'team-tab-' + tab}
        key={tab}
      >
        {tab === 'activity' ? (
          <>
            {cards && <div className="roppo-ui team-card-stack">{cards}</div>}
            <h3>{L('Tasks', '任务动态')}</h3>
            {activities.length ? (
              activities.map(activity => (
                <TaskActivityRow key={activity.id} activity={activity} L={L} onAgent={select}
                  agentName={id => participants.find(p => p.id === id)?.label ?? id}/>
              ))
            ) : (
              <p>{L('No tasks yet', '暂无任务')}</p>
            )}
            <h3>{L('Delivered files', '交付文件')}</h3>
            {files.length ? (
              files.map((f) => <DeliveryFileCard file={deliveryFile(f)} key={f.id} onOpen={() => openFile(f)} L={L} />)
            ) : (
              <p>{L('No delivered files yet', '暂无交付文件')}</p>
            )}
          </>
        ) : tab === 'agents' ? (
          <>
            <h3>Agents</h3>
            {participants.map((a) => (
              <button className="team-row" key={a.id} onClick={() => select(a.id)}>
                <AgentAvatar id={a.id} kind={a.kind} size={34} />
                <span>
                  <strong>{a.kind === 'router' ? teamName(a.label) : a.label}</strong>
                  <small>{a.latestMessage?.text || L('No messages yet', '暂无消息')}</small>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
          </>
        ) : (
          <>
            <h3>{L('Scheduled tasks', '定时任务')}</h3>
            {plans.length ? (
              plans.map((p) => {
                const finished =
                  (!!p.timing.endAt && Date.parse(p.timing.endAt) <= Date.now()) ||
                  (p.timing.kind === 'once' &&
                    (!p.active || p.nextAt === undefined) &&
                    Date.parse(p.timing.startAt) <= Date.now())
                const status = finished ? L('Ended', '已结束') : !p.active ? L('Paused', '已暂停') : ''
                return (
                  <div className="team-row team-plan" key={p.id}>
                    <CalendarClock size={20} />
                    <span>
                      <strong>{p.name}</strong>
                      <small>
                        {scheduleLabel(p.timing, lang, L)}
                        {status ? ' · ' + status : ''}
                      </small>
                    </span>
                    {finished ? (
                      <Check size={16} />
                    ) : (
                      <button
                        className="icon-button"
                        disabled={busy.includes(p.id)}
                        onClick={() => void toggle(p)}
                        aria-label={(p.active ? L('Pause ', '暂停 ') : L('Resume ', '恢复 ')) + p.name}
                        title={p.active ? L('Pause', '暂停') : L('Resume', '恢复')}
                      >
                        {p.active ? <Pause size={16} /> : <Play size={16} />}
                      </button>
                    )}
                  </div>
                )
              })
            ) : (
              <p>
                {snapshot && !snapshot.schedulingAvailable
                  ? L('Scheduling is unavailable on this deployment', '当前部署未启用定时任务')
                  : L('No scheduled tasks', '暂无定时任务')}
              </p>
            )}
            {error ? <p role="alert">{error}</p> : null}
          </>
        )}
      </div>
      <footer className="team-drawer-foot">
        <button onClick={() => resource('files')}>
          <Folder size={16} />
          {L('Files', '文件')}
        </button>
        <button onClick={() => resource('browser')}>
          <Globe size={16} />
          {L('Browser', '浏览器')}
        </button>
      </footer>
    </>
  )
}
