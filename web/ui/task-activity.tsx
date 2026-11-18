import {ArrowUpRight, ChevronRight, List} from 'lucide-react'
import type {TaskActivity} from '../chat/task-activity.ts'
import type {Localize} from '../chat/composer-commands.tsx'
import './task-activity.css'

export function TaskActivityRow({activity, agentName, onAgent, L}: {
  activity: TaskActivity; agentName: (id: string) => string; onAgent: (id: string) => void; L: Localize
}) {
  const taskStatus = (state: string) =>
    ({
      pending: L('Pending', '待开始'),
      planned: L('Planned', '已计划'),
      active: L('Working', '进行中'),
      reviewing: L('In review', '验收中'),
      needs_input: L('Needs input', '待补充'),
      paused: L('Paused', '已暂停'),
      blocked: L('Blocked', '受阻'),
      held: L('On hold', '已搁置'),
      queued: L('Queued', '排队中'),
      running: L('Working', '进行中'),
      completed: L('Complete', '已完成'),
      waiting: L('Waiting', '待处理'),
      cancelled: L('Cancelled', '已取消'),
    })[state] ?? state
  return (
    <details className="task-activity" data-activity-id={activity.id}>
      <summary className="team-row">
        <List size={19} aria-hidden="true"/>
        <span><strong>{activity.title}</strong><small>{taskStatus(activity.state)}</small></span>
        <ChevronRight size={15} aria-hidden="true"/>
      </summary>
      <div className="task-activity-detail">
        {activity.objective && activity.objective !== activity.title && <p>{activity.objective}</p>}
        {activity.nextAction && !activity.steps.length && <p>{activity.nextAction}</p>}
        {activity.steps.length > 0 && <ol>{activity.steps.map(step =>
          <li key={step.id}>{step.title}{step.state && <small>{taskStatus(step.state)}</small>}</li>
        )}</ol>}
        {activity.tickets.map(ticket => <div key={ticket.id}>
          {ticket.title !== activity.title && <strong>{ticket.title}</strong>}
          <button type="button" onClick={() => onAgent(ticket.workerId)}>
            {agentName(ticket.workerId)} · {taskStatus(ticket.reviewing ? 'reviewing' : ticket.state)}
            <ArrowUpRight size={13}/>
          </button>
          {(ticket.question || ticket.summary) && <p>{ticket.question || ticket.summary}</p>}
        </div>)}
      </div>
    </details>
  )
}
