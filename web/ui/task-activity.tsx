import {ArrowUpRight, ChevronRight, CircleCheck, CircleMinus, List, LoaderCircle, Play} from 'lucide-react'
import type {TaskActivity} from '../../src/chat-task-activity.ts'
import type {Localize} from '../chat/composer-commands.tsx'
import './task-activity.css'

export function taskStatus(state: string, L: Localize) {
  return ({
      pending: L('Pending', '待开始'),
      planned: L('Planned', '已计划'),
      active: L('Working', '进行中'),
      reviewing: L('In review', '验收中'),
      needs_input: L('Needs input', '待补充'),
      paused: L('Paused', '已暂停'),
      blocked: L('Progress saved', '进度已保留'),
      held: L('Progress saved', '进度已保留'),
      queued: L('Queued', '排队中'),
      running: L('Working', '进行中'),
      completed: L('Complete', '已完成'),
      waiting: L('Waiting', '待处理'),
      cancelled: L('Cancelled', '已取消'),
      failed: L('Progress saved', '进度已保留'),
      interrupted: L('Progress saved', '进度已保留'),
      ready: L('Result submitted', '已提交结果'),
      progress: L('Progress reported', '已报告进度'),
      dropped: L('No further work', '无需继续'),
      merged: L('Merged', '已合并'),
      closed: L('Closed', '已关闭'),
      stopped: L('Stopped', '已停止'),
    })[state] ?? state
}

export function TaskActivityRow({activity, agentName, onAgent, onOpen, replayTicket, L}: {
  activity: TaskActivity; agentName: (id: string) => string; onAgent: (id: string) => void; L: Localize
  onOpen?: (source: HTMLButtonElement) => void
  replayTicket?: (ticketId: string) => (() => void) | undefined
}) {
  const state = activity.state
  const status = ['active', 'running', 'reviewing'].includes(state) ? 'working'
    : ['completed', 'merged'].includes(state) ? 'success'
    : state === 'cancelled' ? 'cancelled' : 'other'
  const Icon = {working: LoaderCircle, success: CircleCheck, cancelled: CircleMinus, other: List}[status]
  const heading = <>
    <Icon className="task-activity-icon" data-status={status} size={18} aria-hidden="true"/>
    <span><strong>{activity.title}</strong><small>{taskStatus(activity.state,L)}</small></span>
    <ChevronRight size={15} aria-hidden="true"/>
  </>
  if (onOpen) return <button type="button" className="team-row task-activity" data-activity-id={activity.id}
    onClick={event => onOpen(event.currentTarget)}>{heading}</button>
  return (
    <details className="task-activity" data-activity-id={activity.id}>
      <summary className="team-row">{heading}</summary>
      <div className="task-activity-detail">
        {activity.objective && activity.objective !== activity.title && <p>{activity.objective}</p>}
        {activity.nextAction && !activity.steps.length && <p>{activity.nextAction}</p>}
        {activity.steps.length > 0 && <ol>{activity.steps.map(step =>
          <li key={step.id}>{step.title}{step.state && <small>{taskStatus(step.state,L)}</small>}</li>
        )}</ol>}
        {activity.tickets.map(ticket => {const replay = replayTicket?.(ticket.id); return <div key={ticket.id}>
          {ticket.title !== activity.title && <strong>{ticket.title}</strong>}
          <button type="button" onClick={() => onAgent(ticket.workerId)}>
            {agentName(ticket.workerId)} · {taskStatus(ticket.reviewing ? 'reviewing' : ticket.state,L)}
            <ArrowUpRight size={13}/>
          </button>
          {replay && <button type="button" className="handoff-replay" onClick={replay}><Play size={12}/>{L('Replay handoffs','回放任务交接')}</button>}
          {(ticket.question || ticket.summary) && <p>{ticket.question || ticket.summary}</p>}
        </div>})}
      </div>
    </details>
  )
}
