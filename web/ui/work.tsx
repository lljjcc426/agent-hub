import type { ReactNode } from 'react'
import { CalendarClock, Check, ChevronRight, Clock3, Download, FileText, LoaderCircle } from 'lucide-react'
import { AgentAvatar } from '../chat/agent-avatar.tsx'
import { CheckField } from './controls.tsx'

export type WorkState = 'working' | 'waiting' | 'done'

export function StatusMark({ state, children }: { state: WorkState; children: ReactNode }) {
  const Icon = { working: LoaderCircle, waiting: Clock3, done: Check }[state]
  return (
    <span className="rp-status" data-state={state}>
      <Icon size={15} aria-hidden="true" />
      {children}
    </span>
  )
}

export function AgentIdentity({
  name,
  kind = 'router',
  id,
  detail,
  size = 30,
}: {
  name: string
  kind?: 'router' | 'worker'
  id?: string
  detail?: ReactNode
  size?: number
}) {
  return (
    <span className="rp-identity">
      <AgentAvatar kind={kind} id={id} size={size} />
      <span>
        <strong>{name}</strong>
        {detail && <small>{detail}</small>}
      </span>
    </span>
  )
}

export function TaskRow({
  title,
  source,
  status,
  time,
  selected,
  onSelect,
}: {
  title: string
  source: string
  status: ReactNode
  time: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className="rp-task-row"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <strong>{title}</strong>
      <span className="rp-task-source">{source}</span>
      {status}
      <span className="rp-time">{time}</span>
      <ChevronRight size={15} aria-hidden="true" />
    </button>
  )
}

export function FileCard({
  name,
  detail,
  preview,
  onOpen,
  download,
}: {
  name: string
  detail: string
  preview?: ReactNode
  onOpen: () => void
  download?: { href: string; label: string }
}) {
  return (
    <div className="rp-file">
      <button type="button" className="rp-file-open" onClick={onOpen}>
        <span className="rp-file-thumb" aria-hidden="true">
          {preview ?? <FileText size={25} />}
        </span>
        <span className="rp-file-name">
          <strong>{name}</strong>
          <small>{detail}</small>
        </span>
      </button>
      {download && (
        <a
          className="rp-icon-button rp-download"
          href={download.href}
          download={name}
          aria-label={download.label}
          title={download.label}
        >
          <Download size={17} />
        </a>
      )}
    </div>
  )
}

export function Timeline({
  items,
  label,
}: {
  items: readonly { id: string; title: string; time: string }[]
  label: string
}) {
  return (
    <ol className="rp-timeline" aria-label={label}>
      {items.map((item) => (
        <li key={item.id}>
          <span>{item.title}</span>
          <span className="rp-time">{item.time}</span>
        </li>
      ))}
    </ol>
  )
}

export function EmptyState({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="rp-empty">
      {icon && <span aria-hidden="true">{icon}</span>}
      <span>{children}</span>
    </div>
  )
}

export function ScheduleRow({
  title,
  cadence,
  next,
  enabled,
  onChange,
  switchLabel,
}: {
  title: string
  cadence: string
  next: string
  enabled: boolean
  onChange: (enabled: boolean) => void
  switchLabel: string
}) {
  return (
    <div className="rp-schedule">
      <span className="rp-schedule-icon" aria-hidden="true">
        <CalendarClock size={20} />
      </span>
      <span className="rp-schedule-text">
        <strong>{title}</strong>
        <small>{cadence}</small>
      </span>
      <span className="rp-schedule-next">{next}</span>
      <CheckField
        label={switchLabel}
        appearance="switch"
        hideLabel
        checked={enabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  )
}
