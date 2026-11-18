import { FileSearch, Search } from 'lucide-react'
import { useState } from 'react'
import {
  AgentIdentity,
  ChoiceGroup,
  EmptyState,
  FileCard,
  SelectField,
  StatusMark,
  TaskRow,
  TextField,
  Timeline,
  SwitchView,
  switchView,
  type WorkState,
} from '../ui'
import sheetUrl from './release-checklist.xlsx?url'

export const fileName = '发布清单.xlsx'
export const download = { label: '下载发布清单', href: sheetUrl }
const cells = [
  ['负责人', '检查项', '状态'],
  ['林乔', '校对标题', '待办'],
  ['林乔', '确认文件能下载', '待办'],
  ['陈舟', '检查链接', '待办'],
]

export function Sheet({ small = false }: { small?: boolean }) {
  if (small)
    return (
      <span className="sheet-paper" aria-hidden="true">
        <b>XLSX</b>
        <span className="sheet-grid">
          {cells.map((row) => (
            <i key={row[1]} />
          ))}
        </span>
      </span>
    )
  return (
    <div className="sheet-full">
      <table aria-label="发布清单内容">
        <thead>
          <tr>
            {cells[0]!.map((cell) => (
              <th key={cell} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cells.slice(1).map((row) => (
            <tr key={row[1]}>
              {row.map((cell, i) => (
                <td key={i}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function SampleFile({ open }: { open: () => void }) {
  return (
    <FileCard
      name={fileName}
      detail="Excel · 3 项检查"
      preview={<Sheet small />}
      onOpen={open}
      download={download}
    />
  )
}

export interface Task {
  id: string
  title: string
  source: string
  state: WorkState
  time: string
  agent: string
  day: '今天' | '昨天'
}
export const tasks: Task[] = [
  {
    id: 'release',
    title: '整理发布清单',
    source: 'Chat',
    state: 'done',
    time: '09:42',
    agent: '文档助手',
    day: '今天',
  },
  {
    id: 'links',
    title: '核对文档链接',
    source: '飞书',
    state: 'working',
    time: '09:15',
    agent: '文档助手',
    day: '今天',
  },
  {
    id: 'review',
    title: '等待确认周报草稿',
    source: 'Chat',
    state: 'waiting',
    time: '08:40',
    agent: '研究助手',
    day: '今天',
  },
  {
    id: 'notes',
    title: '汇总周会待办',
    source: 'Slack',
    state: 'done',
    time: '16:28',
    agent: '研究助手',
    day: '昨天',
  },
]
export const states: Record<WorkState, string> = { done: '已完成', working: '进行中', waiting: '待处理' }

export function TaskList({
  compact,
  selected,
  onSelect,
}: {
  compact?: boolean
  selected: string
  onSelect: (task: Task) => void
}) {
  const [tab, setTab] = useState<'active' | 'history'>('history')
  const [query, setQuery] = useState('')
  const [order, setOrder] = useState('time')
  const available = compact
    ? tasks.slice(0, 3)
    : tasks.filter((t) => (tab === 'history') === (t.state === 'done'))
  const filtered = available.filter((t) =>
    (t.title + t.source + t.agent).toLowerCase().includes(query.trim().toLowerCase()),
  )
  if (order === 'title') filtered.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
  const row = (task: Task) => (
    <TaskRow
      key={task.id}
      title={task.title}
      source={task.source}
      time={task.time}
      selected={selected === task.id}
      onSelect={() => onSelect(task)}
      status={<StatusMark state={task.state}>{states[task.state]}</StatusMark>}
    />
  )
  return (
    <div className="sample-tasks">
      {!compact && (
        <div className="task-tools">
          <ChoiceGroup
            label="任务视图"
            value={tab}
            onChange={(v) => switchView('panel', () => setTab(v))}
            choices={[
              { value: 'active', label: '进行中' },
              { value: 'history', label: '任务记录' },
            ]}
          />
          <div className="filter-line">
            <TextField
              type="search"
              icon={<Search size={16} />}
              label="搜索任务"
              placeholder="搜索任务"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <SelectField label="排序方式" value={order} onChange={(e) => setOrder(e.target.value)}>
              <option value="time">更新时间</option>
              <option value="title">任务名称</option>
            </SelectField>
          </div>
        </div>
      )}
      <SwitchView>
        <div>
          {compact ? (
            filtered.map(row)
          ) : (
            <>
              {(['今天', '昨天'] as const).map((day) => {
                const group = filtered.filter((t) => t.day === day)
                return (
                  group.length > 0 && (
                    <section className="task-day" key={day}>
                      <h3>{day}</h3>
                      {group.map(row)}
                    </section>
                  )
                )
              })}
              {filtered.length === 0 && (
                <EmptyState icon={<FileSearch size={23} />}>没有匹配的任务</EmptyState>
              )}
            </>
          )}
        </div>
      </SwitchView>
    </div>
  )
}

export function TaskDetails({ task, openFile }: { task: Task; openFile: () => void }) {
  const events = [
    { id: 'start', title: '收到任务', time: task.id === 'release' ? '09:41' : task.time },
    {
      id: 'current',
      title: { done: '已完成核对', working: '正在核对链接', waiting: '等待确认' }[task.state],
      time: task.time,
    },
  ]
  if (task.id === 'release') events.push({ id: 'file', title: '文件已交付', time: task.time })
  return (
    <div className="sample-task-detail">
      <h3>{task.title}</h3>
      <StatusMark state={task.state}>{states[task.state]}</StatusMark>
      <dl>
        <div>
          <dt>来源</dt>
          <dd>{task.source}</dd>
        </div>
        <div>
          <dt>执行人</dt>
          <dd>
            <AgentIdentity name={task.agent} kind="worker" id={task.agent} size={23} />
          </dd>
        </div>
      </dl>
      <Timeline label="任务进展" items={events} />
      {task.id === 'release' && <SampleFile open={openFile} />}
    </div>
  )
}
