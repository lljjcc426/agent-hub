import { useState } from 'react'
import { ChevronRight, ListChecks, MessageCircle } from 'lucide-react'
import { Button, EmptyState, SelectField } from '../ui'
import { TaskProgressSnapshot } from './progress-snapshot.tsx'
import { useWorkspaceRead } from './workspace-read.ts'
import { workDate, workspaceTasks, type WorkItems, type WorkPageProps, type WorkTask } from './work-items.ts'
import './work-pages.css'

type ListedTask = { id: string; label: string; state: string; updatedAt: string }
type TaskPage = { tasks: ListedTask[]; total: number; more: boolean }

export function TaskProgress({ L, language, requested }: WorkPageProps & { requested: string }) {
  const [offset, setOffset] = useState(0)
  const [chosen, choose] = useState(requested)
  const catalog = useWorkspaceRead<TaskPage>('/api/execution-trace?limit=100&offset=' + offset)
  const work = useWorkspaceRead<WorkItems>('/entry-workspace')
  const tasks = workspaceTasks(work.data)
  const records = catalog.data?.tasks ?? []
  const defaultTask = records.find(row => tasks.get(row.id)?.state === 'attention') ?? records[0]
  const taskId = chosen || defaultTask?.id
  const listed = records.find(row => row.id === taskId)
  const linked = useWorkspaceRead<TaskPage>(requested && requested === taskId && catalog.data && !listed ? '/api/execution-trace?ticketId=' + encodeURIComponent(requested) : null)
  const current = listed ?? linked.data?.tasks.find(row => row.id === taskId)
  const extra = useWorkspaceRead<WorkTask>(current && !tasks.has(current.id) ? '/entry-workspace/task/' + encodeURIComponent(current.id) : null)
  const selected = current ? tasks.get(current.id) ?? extra.data : undefined
  const name = (task?: WorkTask, row?: ListedTask) => task?.displayTitle && task.displayTitle !== 'Task' ? task.displayTitle : row?.label || L('Task','任务')
  const busy = !catalog.data || (!work.data && !work.error)
  return <article className="settings-directory work-page"><header className="work-heading"><h1>{L('Task progress','任务进度')}</h1></header>
    {catalog.error ? <Button onClick={catalog.refresh}>{L('Reload tasks','重新读取任务')}</Button>
    : busy ? <p role="status">{L('Loading tasks…','正在读取任务…')}</p>
    : !taskId ? <EmptyState icon={<ListChecks size={24}/>}>{L('No tasks to track yet','还没有可跟进的任务')}</EmptyState>
    : <div className="progress-layout">
      <section className="progress-index" aria-label={L('Task list','任务列表')}>
        <h2>{L('Select a task','选择任务')}</h2>
        <label className="progress-select"><span className="rp-sr-only">{L('Select a task','选择任务')}</span>
          <SelectField id="trace-task" value={taskId} onChange={event => choose(event.target.value)}>
            {!records.some(row => row.id === taskId) && <option value={taskId}>{name(selected, current)}</option>}
            {records.map(row => <option key={row.id} value={row.id}>{name(tasks.get(row.id), row)} · {workDate(row.updatedAt, language)}</option>)}
          </SelectField>
        </label>
        <ul className="progress-task-list">{records.map(row => {
          const task = tasks.get(row.id)
          return <li key={row.id}><Button tone="quiet" aria-current={row.id === taskId ? 'true' : undefined} onClick={() => choose(row.id)}>
            {task?.question ? <MessageCircle size={18} aria-hidden="true"/> : <ListChecks size={18} aria-hidden="true"/>}
            <span><strong>{name(task, row)}</strong><time dateTime={row.updatedAt}>{workDate(row.updatedAt, language)}</time></span><ChevronRight size={15} aria-hidden="true"/>
          </Button></li>
        })}</ul>
        {(offset > 0 || catalog.data?.more) && <div className="work-buttons">
          <Button disabled={!offset} onClick={() => { choose(''); setOffset(offset - 100) }}>{L('Previous','上一页')}</Button>
          <Button disabled={!catalog.data?.more} onClick={() => { choose(''); setOffset(offset + 100) }}>{L('Next','下一页')}</Button></div>}
      </section>
      <div className="progress-view"><h2>{name(selected, current)}</h2><TaskProgressSnapshot key={taskId} ticketId={taskId} language={language} createdAt={selected?.createdAt} question={selected?.state === 'attention' ? selected.question : undefined}/></div>
    </div>}
  </article>
}
