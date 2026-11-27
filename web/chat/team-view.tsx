import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  CalendarClock,
  ChevronRight,
  List,
  Pencil,
  Users,
  X,
} from 'lucide-react'
import type { ChatSessions } from '../../src/chat.ts'
import type { ChatDelivery } from '../../src/chat-deliveries.ts'
import type { ScheduleEdit } from '../../src/chat-schedules.ts'
import { ScheduleCard } from '../ui/schedule-card.tsx'
import { deliveryFile } from './delivery-links.ts'
import { DeliveryFileCard } from '../ui/delivery-files.tsx'
import { TaskActivityList } from './task-activity-list.tsx'
import { AgentAvatar, teamName } from './agent-avatar.tsx'
import { RoppoCharacter } from './roppo-character.tsx'
import { taskActivities, type TaskActivity } from '../../src/chat-task-activity.ts'
import type { TeamTab } from './chat-panel-state.ts'

type View = ReturnType<ChatSessions['view']>
type Localize = (en: string, zh: string) => string
const tabs = [
  { id: 'activity', Icon: List },
  { id: 'agents', Icon: Users },
  { id: 'schedules', Icon: CalendarClock },
] as const


interface TeamOverviewProps {
  active: boolean
  cards?: ReactNode
  heartbeat: ReactNode
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
  openTask?: (activity: TaskActivity, source: HTMLButtonElement) => void
  openFile: (file: ChatDelivery) => void
  browsers: ReactNode
  locateMessage: (id: string) => void
  changeSchedule: (id: string, revision: number, change: ScheduleEdit) => Promise<void>
}
export function SessionSchedules({heartbeat,snapshot,lang,L,changeSchedule,locateMessage,openFile}:
  Pick<TeamOverviewProps,'heartbeat'|'snapshot'|'lang'|'L'|'changeSchedule'|'locateMessage'|'openFile'>){
  return <>
    <div className="roppo-ui rp-schedule-stack">
      {heartbeat}
      {snapshot?.schedules?.map(plan=><ScheduleCard key={plan.id} plan={plan} lang={lang} L={L}
        onChange={(revision,patch)=>changeSchedule(plan.id,revision,patch)}
        onMessage={locateMessage} onFile={openFile}/>)}
    </div>
    {snapshot && !snapshot.schedulingAvailable &&
      <p>{L('Conversation schedules are unavailable on this deployment', '当前部署的会话定时任务不可用')}</p>}
  </>
}

export function TeamOverview({
  active,
  cards,
  heartbeat,
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
  openTask,
  openFile,
  browsers,
  changeSchedule, locateMessage,
}: TeamOverviewProps) {
  const [greeting, setGreeting] = useState(0)
  const wasActive = useRef(false)
  const closeButton = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const opened = active && !wasActive.current
    wasActive.current = active
    if (!opened) return
    setGreeting(previous => previous + 1)
    if (focusOnOpen) closeButton.current?.focus({ preventScroll: true })
  }, [active, focusOnOpen])
  const titles = { activity: L('Overview', '概览'), agents: 'Agents', schedules: L('Schedules', '定时') }
  const activities = snapshot ? taskActivities(snapshot) : []
  const files = snapshot?.deliveries ?? []
  return (
    <>
      <div className="team-drawer-head">
        <div className="team-profile">
          <button type="button" className="team-portrait" aria-label={L('Greet Roppo', '和 Roppo 打招呼')}
            onClick={() => setGreeting(previous => previous + 1)}>
            <RoppoCharacter phase="idle" greeting={greeting} />
          </button>
          <strong>{teamName(routerLabel)}</strong>
          <a className="team-profile-edit" href="/configure#execution/configuration/router">
            <Pencil size={12} aria-hidden="true" />
            {L('Edit profile', '编辑资料')}
          </a>
        </div>
        <button
          ref={closeButton}
          type="button"
          className="icon-button"
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
              <TaskActivityList activities={activities} lang={lang} L={L} onAgent={select}
                openTask={openTask} agentName={id => participants.find(p => p.id === id)?.label ?? id}/>
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
            {browsers}
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
            <SessionSchedules {...{heartbeat,snapshot,lang,L,changeSchedule,locateMessage,openFile}}/>
          </>
        )}
      </div>
    </>
  )
}
