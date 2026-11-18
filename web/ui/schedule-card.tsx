import { useRef, useState } from 'react'
import { CalendarClock, ChevronRight, FileText, MessageSquare, Pause, Play } from 'lucide-react'
import type { ChatSchedule } from '../../src/chat-schedules.ts'
import type { Localize } from '../chat/composer-commands.tsx'
import { Dialog } from './overlays.tsx'
import { IconButton } from './controls.tsx'
import { ScheduleEditor, scheduleCadence, scheduleDate } from './schedule-editor.tsx'
import './schedule.css'

type CardEdit = { active: boolean } | { timing: ChatSchedule['timing'] }

export function ScheduleCard<File extends { id: string; name: string }>({ plan, lang, L, onChange, onMessage, onFile }: {
  plan: ChatSchedule<File>; lang: string; L: Localize
  onChange: (revision: number, change: CardEdit) => Promise<void>
  onMessage: (id: string) => void; onFile: (file: File) => void
}) {
  const [editing, setEditing] = useState<Pick<typeof plan,'revision'|'timing'> | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const afterClose = useRef<(() => void) | null>(null)
  const { timing, active, lastRun, lastResult } = plan
  const date = (at: number) => scheduleDate(at, timing.timezone, lang)
  const ended = active ? plan.nextAt == null : (timing.endAt && Date.parse(timing.endAt) <= Date.now()) ||
    (timing.kind === 'once' && Date.parse(timing.startAt) <= Date.now())
  const next = ended ? L('Ended', '已结束') : !active ? L('Paused', '已暂停') : date(plan.nextAt!)
  const verbs = { queued: L('Queued','排队中'), running: L('Running','运行中'), waiting: L('Waiting','等待中'),
    completed: L('Completed','已完成'), failed: L('Failed','失败'), cancelled: L('Cancelled','已取消'), skipped: L('Skipped','已跳过') }
  const edit = () => { setError(''); setEditing({revision:plan.revision,timing:plan.timing}) }
  const close = () => { setEditing(null); setError('') }
  function follow(action: () => void) {
    if (!editing) return action()
    afterClose.current = action
    close()
  }
  function finishClose() {
    const action = afterClose.current
    afterClose.current = null
    action?.()
  }
  async function change(revision: number, patch: CardEdit) {
    setBusy(true); setError('')
    try {
      await onChange(revision, patch)
      if ('timing' in patch) close()
    } catch (e) {
      setError(e instanceof Error && e.message === 'schedule_conflict' ? L('This schedule was changed elsewhere.', '排期已在其他窗口更改。')
        : L('Could not save the schedule. Please try again.', '排期未保存，请重试。'))
    } finally { setBusy(false) }
  }
  const links = (compact: boolean) => lastResult && <div className="rp-schedule-links">
    <button type="button" onClick={()=>follow(()=>onMessage(lastResult.messageId))} title={lastResult.text || L('Go to message','查看消息')}>
      <MessageSquare size={14}/><span>{lastResult.text || L('Go to message','查看消息')}</span>
    </button>
    {(compact ? lastResult.files.slice(0,1) : lastResult.files).map(file=><button type="button" key={file.id}
      onClick={()=>follow(()=>onFile(file))} title={file.name}><FileText size={14}/><span>{file.name}</span></button>)}
  </div>
  const toggle = (active ? L('Pause', '暂停') : L('Resume', '恢复')) + ' ' + plan.name
  return <article className="rp-schedule-card" data-schedule-id={plan.id}>
    <header><button type="button" className="rp-schedule-open" onClick={edit} aria-haspopup="dialog">
      <CalendarClock size={18}/><strong>{plan.name}</strong><ChevronRight size={14}/>
    </button>
    {!ended && <IconButton label={toggle} disabled={busy} onClick={()=>void change(plan.revision,{active:!active})}>
      {active ? <Pause size={14}/> : <Play size={14}/>}</IconButton>}</header>
    <div className="rp-schedule-meta"><span>{scheduleCadence(timing,lang,L)}</span><span>{timing.timezone}</span></div>
    <div className="rp-schedule-next"><span>{L('Next run','下次执行')}</span><strong>{next}</strong></div>
    <div className="rp-schedule-receipt"><small>{L('Last delivery','上次交付')}</small>
      {lastResult ? links(true) : <span>{L('No delivery yet','暂无交付')}</span>}</div>
    {error && !editing && <p role="alert">{error}</p>}
    <Dialog open={!!editing} onClose={close} onAfterClose={finishClose} title={plan.name} closeLabel={L('Close details', '关闭详情')}>
      {editing && <div className="rp-schedule-detail">
        <p className="rp-schedule-prompt">{plan.prompt}</p>
        <dl><dt>{L('Next run','下次执行')}</dt><dd>{next}</dd>
          <dt>{L('Last run','上次执行')}</dt><dd>{lastRun ? verbs[lastRun.state]+' · '+date(lastRun.at) : L('Has not run yet','尚未执行')}</dd>
          <dt>{L('Last delivery','上次交付')}</dt><dd>{lastResult ? <><time dateTime={new Date(lastResult.at).toISOString()}>{date(lastResult.at)}</time>{links(false)}</> : L('No delivery yet','暂无交付')}</dd></dl>
        <ScheduleEditor key={editing.revision} timing={editing.timing} active={active} L={L} lang={lang} busy={busy}
          stale={editing.revision!==plan.revision} reload={edit} save={t=>change(editing.revision,{timing:t})}/>
        {error && editing.revision === plan.revision && <p role="alert">{error}</p>}
      </div>}
    </Dialog>
  </article>
}
