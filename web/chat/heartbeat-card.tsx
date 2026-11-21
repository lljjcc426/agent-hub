import {useEffect, useState} from 'react'
import {ChevronRight, HeartPulse, Pause, Play} from 'lucide-react'
import type {HeartbeatChange, HeartbeatIssue, HeartbeatStatus} from '../../src/heartbeat.ts'
import type {Localize} from './composer-commands.tsx'
import {IconButton} from '../ui/controls.tsx'
import {Dialog} from '../ui/overlays.tsx'

function issueText(issue: HeartbeatIssue, L: Localize) {
  if (issue.check === 'chat') {
    const reasons: Record<string, string> = {
      model_credentials_missing: L('Model credentials are unavailable', '模型凭据不可用'),
      model_unavailable: L('The configured model is unavailable', '配置的模型不可用'),
      host_router_required: L('The host Router is unavailable', '宿主 Router 未启用'),
      local_source_required: L('The local Chat source is unavailable', '本地 Chat 入口不可用'),
    }
    return reasons[issue.code] ?? L('Chat is not ready', 'Chat 未就绪')
  }
  if (issue.check === 'watchdog') {
    return issue.code === 'missing'
      ? L('Waiting for the watchdog heartbeat', '尚未收到 watchdog 心跳')
      : L('The watchdog heartbeat has expired', 'watchdog 心跳已过期')
  }
  if (issue.check === 'feishu') {
    const reasons = {
      missing: L('Waiting for the first poll', '尚无轮询结果'),
      stale: L('The last poll is stale', '最近一次轮询已过期'),
      retrying: L('Polling is retrying', '轮询正在重试'),
      error: L('Polling failed', '轮询失败'),
    }
    return issue.source + ' · ' + reasons[issue.code]
  }
  return L('The check did not finish', '检查未能完成')
}

function newest(previous: HeartbeatStatus | undefined, next: HeartbeatStatus) {
  if (!previous || next.revision > previous.revision) return next
  if (next.revision < previous.revision) return previous
  return (next.runs[0]?.ranAt ?? 0) >= (previous.runs[0]?.ranAt ?? 0) ? next : previous
}

export function HeartbeatCard({L, lang, read, change}: {
  L: Localize
  lang: string
  read: (signal: AbortSignal) => Promise<HeartbeatStatus>
  change: (input: HeartbeatChange) => Promise<HeartbeatStatus>
}) {
  const [status, setStatus] = useState<HeartbeatStatus>()
  const [opened, setOpened] = useState(false)
  const [pending, setPending] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [changeError, setChangeError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const next = await read(AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]))
        if (!controller.signal.aborted) {
          setStatus(previous => newest(previous, next))
          setLoadFailed(false)
        }
      } catch {
        if (!controller.signal.aborted) setLoadFailed(true)
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 10_000)
      }
    }
    void refresh()
    return () => {controller.abort(); clearTimeout(timer)}
  }, [read])

  if (!status) return <p role="status">{loadFailed
    ? L('Could not load Heartbeat. Retrying…', '读取 Heartbeat 失败，正在重试…')
    : L('Loading Heartbeat…', '正在读取 Heartbeat…')}</p>

  const date = new Intl.DateTimeFormat(lang, {dateStyle: 'short', timeStyle: 'short'})
  const cadence = L('Every ' + status.intervalMinutes + ' minutes', '每 ' + status.intervalMinutes + ' 分钟')
  const healthy = (state: 'success' | 'failed') => state === 'success' ? L('Success', '成功') : L('Failed', '异常')
  const nextAt = status.nextAt === null ? L('Paused', '已暂停')
    : status.hostPaused ? L('Host paused', '服务维护暂停') : date.format(status.nextAt)
  const toggleLabel = status.active ? L('Pause Heartbeat', '暂停 Heartbeat') : L('Enable Heartbeat', '启用 Heartbeat')
  const latest = status.runs[0]

  async function toggle(plan: HeartbeatStatus) {
    setPending(true)
    setChangeError('')
    try {
      const saved = await change({active: !plan.active, expectedRevision: plan.revision})
      setStatus(previous => newest(previous, saved))
    } catch (error) {
      setChangeError(error instanceof Error && error.message === 'schedule_conflict'
        ? L('Heartbeat changed in another window.', 'Heartbeat 已在其他窗口更改。')
        : L('Could not confirm the schedule change.', '暂时无法确认排期变更。'))
    } finally {
      setPending(false)
    }
  }

  return <article className="rp-schedule-card" data-schedule-id="internal-heartbeat">
    <header>
      <button type="button" className="rp-schedule-open" aria-haspopup="dialog" onClick={() => setOpened(true)}>
        <HeartPulse size={18} aria-hidden="true" /><strong>Heartbeat</strong><ChevronRight size={14} aria-hidden="true" />
      </button>
      <IconButton label={toggleLabel} disabled={pending} onClick={() => void toggle(status)}>
        {status.active ? <Pause size={14} /> : <Play size={14} />}
      </IconButton>
    </header>
    <div className="rp-schedule-meta">{cadence}</div>
    <div className="rp-schedule-next"><span>{L('Next run', '下次执行')}</span><strong>{nextAt}</strong></div>
    <div className="rp-schedule-receipt">
      <small>{L('Last run', '最近运行')}</small>
      <span>{latest ? healthy(latest.state) + ' · ' + date.format(latest.ranAt) : L('Has not run yet', '尚未执行')}</span>
    </div>
    {changeError && <p role="alert">{changeError}</p>}
    {loadFailed && <p role="status">{L('Could not refresh. Showing the last record.', '暂时无法刷新，正在显示上次记录。')}</p>}
    <Dialog open={opened} onClose={() => setOpened(false)} title="Heartbeat" closeLabel={L('Close details', '关闭详情')}>
      {opened && <div className="rp-schedule-detail">
        <dl>
          <dt>{L('Frequency', '频率')}</dt><dd>{cadence}</dd>
          <dt>{L('Next run', '下次执行')}</dt><dd>{nextAt}</dd>
        </dl>
        <section aria-label={L('Run history', '运行记录')}>
          <h3 className="rp-heartbeat-title">{L('Run history', '运行记录')}</h3>
          {status.runs.length ? <ol className="rp-heartbeat-history">
            {status.runs.map(run => <li key={run.id} data-run-state={run.state}>
              <div className="rp-heartbeat-run">
                <span><strong>{healthy(run.state)}</strong> · {L('Scheduled', '定时触发')}</span>
                <time dateTime={new Date(run.ranAt).toISOString()}>{date.format(run.ranAt)}</time>
              </div>
              {run.issues.length > 0 && <ul>{run.issues.map((issue, index) =>
                <li key={issue.check + ':' + index}>{issueText(issue, L)}</li>)}</ul>}
            </li>)}
          </ol> : <p>{L('Has not run yet', '尚未执行')}</p>}
        </section>
        <details className="rp-heartbeat-permissions">
          <summary>{L('View permissions', '查看权限')}</summary>
          <p>{L('Reads Chat readiness, the watchdog heartbeat and enabled Feishu sources’ polling status. Saves Heartbeat run records.', '读取 Chat 就绪状态、watchdog 心跳和已启用飞书入口的轮询状态，写入 Heartbeat 运行记录。')}</p>
        </details>
      </div>}
    </Dialog>
  </article>
}
