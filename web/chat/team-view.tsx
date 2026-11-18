import { useEffect, useRef, type ReactNode } from 'react'
import {
  CalendarClock,
  ChevronRight,
  Folder,
  Globe,
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
import { TaskActivityRow } from '../ui/task-activity.tsx'
import { AgentAvatar, teamName } from './agent-avatar.tsx'
import {TeamContext,type LoadTeamContext} from './team-context.tsx'
import type {Handoff} from './handoff-stage.tsx'
import { taskActivities } from './task-activity.ts'

type View = ReturnType<ChatSessions['view']>
type Localize = (en: string, zh: string) => string
export type TeamTab = 'activity' | 'agents' | 'schedules'
const tabs = [
  { id: 'activity', Icon: List },
  { id: 'agents', Icon: Users },
  { id: 'schedules', Icon: CalendarClock },
] as const


interface TeamOverviewProps {
  readiness?:View['readiness']|null
  loadContext:LoadTeamContext
  connected:boolean
  replay:(events:Handoff[])=>void
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
  locateMessage: (id: string) => void
  changeSchedule: (id: string, revision: number, change: ScheduleEdit) => Promise<void>
}
export function TeamOverview({
  readiness,loadContext,connected,replay,
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
  changeSchedule, locateMessage,
}: TeamOverviewProps) {
  const titles = { activity: L('Overview', '概览'), agents: 'Agents', schedules: L('Schedules', '定时') }
  const activities = snapshot ? taskActivities(snapshot) : []
  const files = snapshot?.deliveries ?? [],
    plans = snapshot?.schedules ?? []
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
                  replayTicket={ticketId=>{const events=snapshot?.handoffs?.filter(h=>h.ticketId===ticketId);return events?.length?()=>replay(events):undefined}}
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
          <TeamContext key={snapshot?.conversation.id} participants={participants} readiness={snapshot?.readiness??readiness} snapshot={snapshot} select={select} load={loadContext} L={L} lang={lang} connected={connected}/>
        ) : (
          <>
            <h3>{L('Scheduled tasks', '定时任务')}</h3>
            {plans.length ? (
              <div className="roppo-ui rp-schedule-stack">
                {plans.map(p => <ScheduleCard key={p.id} plan={p} lang={lang} L={L}
                  onChange={(revision,patch)=>changeSchedule(p.id,revision,patch)}
                  onMessage={locateMessage} onFile={openFile}/>)}
              </div>
            ) : (
              <p>
                {snapshot && !snapshot.schedulingAvailable
                  ? L('Scheduling is unavailable on this deployment', '当前部署未启用定时任务')
                  : L('No scheduled tasks', '暂无定时任务')}
              </p>
            )}
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
