import { useState } from 'react'
import { Bell, CalendarDays, Check, Copy, Flag } from 'lucide-react'
import { Button, Dialog, EmptyState } from '../ui'
import { scheduleCadence } from '../ui/schedule-editor.tsx'
import type { ChatSchedule } from '../../src/chat-schedules.ts'
import { ReminderEditor } from './reminder-editor.tsx'
import type { WorkPageProps } from './work-items.ts'

export type Plan = { id: string; title: string; kind: string; nextAt?: number; state: string; promoteText?: string }
export type PlanSchedule = Pick<ChatSchedule,'id'|'timing'>

export function PlanList({ plans, schedules, goals, scope, saved, L, language }: WorkPageProps & { plans: Plan[]; schedules: PlanSchedule[]; goals: boolean; scope: string; saved: () => void }) {
  const [promote, setPromote] = useState<Plan | null>(null)
  const [copyResult, setCopyResult] = useState('')
  const status: Record<string,string> = {
    active:L('In progress','进行中'), completed:L('Completed','已完成'), cancelled:L('Cancelled','已取消'), scheduled:L('Scheduled','已安排'),
    paused:L('Paused','已暂停'), held:L('On hold','已暂停'), promoted:L('Converted to a goal','已转为目标'),
    blocked:L('Waiting','等待处理'), failed:L('Failed','未完成'), delivered:L('Delivered','已送达'), ready:L('Ready','已就绪'),
    fired:L('Sent','已提醒'), due:L('Due','待提醒'), running:L('Running','执行中'), expired:L('Expired','已过期'),
    needs_input:L('Waiting for input','等待回复'), waiting:L('Waiting','等待中'), pending:L('Pending','等待处理'), stopped:L('Stopped','已停止'),
  }
  const reminders = plans.filter(plan => plan.kind !== 'goal')
  const timings = new Map(schedules.map(s => [s.id,s.timing]))
  const groups = goals
    ? [{ title:L('Active goals','正在跟进'), rows:plans.filter(p=>p.kind==='goal' && !['completed','cancelled'].includes(p.state)) },
       { title:L('Past goals','已结束'), rows:plans.filter(p=>p.kind==='goal' && ['completed','cancelled'].includes(p.state)) }]
    : [{ title:L('Upcoming reminders','接下来的提醒'), rows:reminders.filter(p=>p.nextAt!==undefined).sort((a,b)=>a.nextAt!-b.nextAt!) },
       { title:L('Other reminders','其他提醒'), rows:reminders.filter(p=>p.nextAt===undefined) }]
  const hasPlans = groups.some(group => group.rows.length)
  return <>
    {goals && !hasPlans && <EmptyState icon={<Flag size={24}/>}>{L('No goals here yet','这里还没有目标')}</EmptyState>}
    {groups.filter((group,index)=>group.rows.length || (!goals && index===0)).map((group,index)=><section className="work-block" key={group.title}>
      <div className="work-list-heading"><h2>{group.title}</h2>{!goals && index===0 && <ReminderEditor scope={scope} L={L} saved={saved}/>}</div>
      {!group.rows.length && <EmptyState icon={<Bell size={24}/>}>{L('No upcoming reminders','还没有安排提醒')}</EmptyState>}
      <ul className="work-rows">{group.rows.map(plan=>{
        const date=plan.nextAt===undefined?null:new Date(plan.nextAt)
        const timing=timings.get(plan.id), timeZone=timing?.timezone
        const year=date?.toLocaleDateString(language,{year:'numeric',timeZone})
        const detail=[
          year && year!==new Date().toLocaleDateString(language,{year:'numeric',timeZone}) && year,
          date && (!timing || timing.kind==='once' || timing.kind==='interval') && date.toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit',timeZone}),
          timing && scheduleCadence(timing,language,L),
          timeZone,
          !date && (status[plan.state]??plan.state),
        ].filter(Boolean).join(' · ')
        return <li className="plan-row" key={plan.id}>
          {date?<time className="plan-date" dateTime={date.toISOString()} aria-label={date.toLocaleDateString(language,{dateStyle:'long',timeZone})}><span>{date.toLocaleDateString(language,{month:'short',timeZone})}</span><strong>{date.toLocaleDateString(language,{day:'numeric',timeZone}).replace(/日$/,'')}</strong></time>
            :<span className="work-item-icon">{goals?(plan.state==='completed'?<Check size={21}/>:<Flag size={20}/>):<CalendarDays size={20}/>}</span>}
          <div className="work-item-copy"><strong>{plan.title}</strong><span>{goals ? status[plan.state]??plan.state : detail}</span></div>
          {plan.promoteText && <Button onClick={()=>{setCopyResult('');setPromote(plan)}}>{L('Turn into a goal','转为目标')}</Button>}
        </li>
      })}</ul></section>)}
    <Dialog open={!!promote} title={L('Turn reminder into a goal','将提醒转为目标')} closeLabel={L('Close','关闭')} onClose={()=>setPromote(null)}>
      {promote?.promoteText && <div className="work-sheet"><h3>{promote.title}</h3>
        <p>{L('In the original conversation, send this command followed by your goal and what counts as done.','在原会话发送这条指令，下一行写下目标和完成条件。')}</p>
        <code className="work-command">{promote.promoteText}</code><div className="work-buttons">
          <Button tone="primary" onClick={async()=>{try{await navigator.clipboard.writeText(promote.promoteText!);setCopyResult(L('Copied','已复制'))}catch{setCopyResult(L('Select the command to copy it.','可选中指令复制。'))}}}><Copy size={16}/>{L('Copy command','复制指令')}</Button>
          {copyResult&&<span role="status">{copyResult}</span>}</div></div>}
    </Dialog>
  </>
}
