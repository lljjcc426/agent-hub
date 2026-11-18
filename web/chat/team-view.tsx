import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronRight,
  FileText,
  Folder,
  Globe,
  Image,
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
import { downloadUrl } from './delivery-links.ts'
import { AgentAvatar } from './agent-avatar.tsx'

const DeliveryMarkdown = lazy(() => import('./markdown.tsx').then((m) => ({ default: m.FileMarkdown })))

type View = ReturnType<ChatSessions['view']>
type Localize = (en: string, zh: string) => string
export type TeamTab = 'activity' | 'agents' | 'schedules'
type Schedule = View['schedules'][number]
const tabs = [
  { id: 'activity', Icon: List },
  { id: 'agents', Icon: Users },
  { id: 'schedules', Icon: CalendarClock },
] as const
export const teamName = (label: string) => (label === 'Router' ? 'Roppo' : label)

function fileSize(bytes: number) {
  return bytes < 1024
    ? bytes + ' B'
    : bytes < 1024 ** 2
      ? Number((bytes / 1024).toFixed(1)) + ' KB'
      : Number((bytes / 1024 ** 2).toFixed(1)) + ' MB'
}
export function DeliveryCard({
  file,
  open,
  L,
}: {
  file: ChatDelivery
  open: (file: ChatDelivery) => void
  L: Localize
}) {
  const Icon = file.preview === 'image' ? Image : FileText
  return (
    <button
      type="button"
      className="team-file"
      onClick={() => open(file)}
      aria-label={L('Open file ', '打开文件 ') + file.name}
    >
      <span className="file-stamp" aria-hidden="true">
        {file.preview === 'image' ? (
          <img
            loading="lazy"
            alt=""
            src={downloadUrl(file) + '?preview=1'}
          />
        ) : file.excerpt ? (
          <span className="file-page">
            <b>{file.name.split('.').at(-1)?.toUpperCase()}</b>
            {file.excerpt}
          </span>
        ) : (
          <Icon size={25} strokeWidth={1.4} />
        )}
      </span>
      <span className="team-file-label">
        <strong>{file.name}</strong>
        <small>
          {fileSize(file.size)} · {L('Delivered file', '交付文件')}
        </small>
      </span>
      <ArrowUpRight size={16} />
    </button>
  )
}

export function FileViewer({ file, close, L }: { file: ChatDelivery; close: () => void; L: Localize }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [content, setContent] = useState<string>(),
    [error, setError] = useState(false)
  const url = downloadUrl(file)
  const previewText = file.preview === 'text' && file.size <= 512 * 1024
  useEffect(() => {
    const el = dialog.current!
    el.showModal()
    return () => el.close()
  }, [])
  useEffect(() => {
    if (!previewText) return
    const controller = new AbortController()
    fetch(url + '?preview=1', { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw Error()
        return r.text()
      })
      .then(setContent)
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => controller.abort()
  }, [url, previewText])
  return (
    <dialog
      ref={dialog}
      className="team-file-dialog"
      onCancel={close}
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.stopPropagation()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
      aria-labelledby="delivery-title"
    >
      <section>
        <header>
          <h2 id="delivery-title">{file.name}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={L('Close file', '关闭文件')}
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <div className="team-file-preview">
          {error ? (
            <p role="alert">{L('Could not load preview', '预览加载失败')}</p>
          ) : file.preview === 'image' ? (
            <img alt={file.name} src={url + '?preview=1'} onError={() => setError(true)} />
          ) : previewText ? (
            content === undefined ? (
              <p role="status">{L('Loading…', '正在加载…')}</p>
            ) : file.name.toLowerCase().endsWith('.md') ? (
              <Suspense fallback={<pre>{content}</pre>}>
                <DeliveryMarkdown text={content} />
              </Suspense>
            ) : (
              <pre>{content}</pre>
            )
          ) : (
            <FileText size={52} strokeWidth={1} />
          )}
        </div>
        <footer>
          <span>{fileSize(file.size)}</span>
          <a className="delivery-download" href={url} download={file.name}>
            <ArrowDownToLine size={16} />
            {L('Download', '下载')}
          </a>
        </footer>
      </section>
    </dialog>
  )
}
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

interface TeamDrawerProps {
  hidden?: boolean
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
export function TeamDrawer({
  hidden,
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
}: TeamDrawerProps) {
  const [busy, setBusy] = useState<string[]>([]),
    [error, setError] = useState(''),
    closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true })
  }, [])
  const titles = { activity: L('Activity', '动态'), agents: 'Agents', schedules: L('Schedules', '定时') }
  const tasks = [...(snapshot?.tasks ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  const files = snapshot?.deliveries ?? [],
    plans = snapshot?.schedules ?? []
  const taskStatus = (state: string) =>
    ({
      queued: L('Queued', '排队中'),
      running: L('Working', '进行中'),
      completed: L('Complete', '已完成'),
      waiting: L('Waiting', '待处理'),
      cancelled: L('Cancelled', '已取消'),
    })[state] ?? state
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
    <aside id={hidden ? undefined : 'session-panel'} hidden={hidden} className="session-panel chat-inspector team-drawer" aria-label={L('Team panel', '团队面板')}>
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
                aria-label={L('Edit Router profile', '编辑 Router 资料')}
                title={L('Edit Router profile', '编辑 Router 资料')}
              >
                <Pencil size={13} />
              </a>
            </div>
            <small>Router</small>
          </div>
        </div>
        <button
          className="icon-button"
          ref={closeButton}
          aria-label={L('Close team panel', '关闭团队面板')}
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
            <h3>{L('Tasks', '任务动态')}</h3>
            {tasks.length ? (
              tasks.map((t) => (
                <button key={t.id} className="team-row" onClick={() => select(t.workerId)}>
                  <AgentAvatar id={t.workerId} kind="worker" size={31} />
                  <span>
                    <strong>{t.title}</strong>
                    <small>
                      {participants.find((a) => a.id === t.workerId)?.label ?? t.workerId} ·{' '}
                      {t.reviewing ? L('In review', '验收中') : taskStatus(t.state)}
                    </small>
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))
            ) : (
              <p>{L('No tasks yet', '暂无任务')}</p>
            )}
            <h3>{L('Delivered files', '交付文件')}</h3>
            {files.length ? (
              files.map((f) => <DeliveryCard file={f} key={f.id} open={openFile} L={L} />)
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
    </aside>
  )
}
