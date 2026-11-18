import { useState } from 'react'
import {
  BookOpen,
  ChevronDown,
  CircleAlert,
  Globe,
  ListChecks,
  LoaderCircle,
  MessagesSquare,
  Search,
  SquareTerminal,
  UsersRound,
  Wrench,
} from 'lucide-react'
import type { ExecutionCall } from '../../src/execution-activity.ts'

type Localize = (en: string, zh: string) => string
type Group = 'read' | 'resource' | 'search' | 'command' | 'team' | 'browser' | 'tool'
const icons = {
  read: BookOpen,
  resource: BookOpen,
  search: Search,
  command: SquareTerminal,
  team: UsersRound,
  browser: Globe,
  tool: Wrench,
}
function group(call: ExecutionCall): Group {
  if (call.trace) return call.trace.kind
  if (call.name === 'router_read' || call.name === 'superagent_read') return 'resource'
  if (call.name === 'superagent_shell') return 'command'
  if (call.name === 'worker_manage' || call.name === 'superagent_spawn') return 'team'
  if (call.name.endsWith('_browser')) return 'browser'
  return 'tool'
}
function summary(group: Group, L: Localize, done: boolean) {
  switch (group) {
    case 'read':
      return done ? L('Read files', '读取了文件') : L('Reading files', '读取文件')
    case 'resource':
      return done ? L('Read resources', '读取了资料') : L('Reading resources', '读取资料')
    case 'search':
      return done ? L('Searched', '进行了搜索') : L('Searching', '搜索')
    case 'command':
      return done ? L('Ran commands', '运行了命令') : L('Running commands', '运行命令')
    case 'team':
      return done ? L('Worked with the team', '处理了团队事务') : L('Working with the team', '处理团队事务')
    case 'browser':
      return done ? L('Used the browser', '使用了浏览器') : L('Using the browser', '使用浏览器')
    case 'tool':
      return done ? L('Used tools', '调用了工具') : L('Using tools', '调用工具')
  }
}
function rowLabel(c: ExecutionCall, L: Localize) {
  const item = c.trace
  if (item?.kind === 'read')
    return item.label ? L('Read ' + item.label, '读取 ' + item.label) : L('Read resource', '读取资源')
  if (item?.kind === 'search')
    return item.label ? L('Search in ' + item.label, '在 ' + item.label + ' 中搜索') : L('Search workspace', '搜索工作区')
  if (item?.kind === 'command') return item.label ?? L('Run command', '运行命令')
  const enZh: Record<string, [string, string]> = {
    list: ['Inspect team', '查看团队'],
    inspect: ['Inspect task', '查看任务'],
    result: ['Read result', '读取结果'],
    assign: ['Delegate task', '分派任务'],
    send: ['Continue task', '继续任务'],
    create: ['Create Worker', '创建 Worker'],
    configure: ['Configure Worker', '配置 Worker'],
    set_prompt: ['Update instructions', '修改提示词'],
    clone: ['Clone Worker', '复制 Worker'],
    retire: ['Retire Worker', '停用 Worker'],
    destroy: ['Remove Worker', '移除 Worker'],
    migrate: ['Migrate Worker', '迁移 Worker'],
    cancel: ['Cancel task', '取消任务'],
    pause: ['Pause Worker', '暂停 Worker'],
    resume: ['Resume Worker', '恢复 Worker'],
    superagent_progress: ['Update progress', '更新进度'],
    superagent_tools: ['Inspect tools', '查看工具'],
    superagent_job: ['Check job', '查看任务状态'],
    superagent_read: ['Read resource', '读取资源'],
    router_read: ['Read resource', '读取资源'],
    superagent_tool: ['Call connected tool', '调用连接工具'],
    superagent_spawn: ['Delegate subtask', '分派子任务'],
    router_manage: ['Manage task', '管理任务'],
    chat_deliver_file: ['Prepare file', '准备交付文件'],
    open: ['Open browser', '打开浏览器'],
    navigate: ['Open website', '打开网页'],
    snapshot: ['Read page', '读取页面'],
    click: ['Click element', '点击页面元素'],
    fill: ['Fill field', '填写字段'],
    press: ['Press key', '按键'],
    scroll: ['Scroll page', '滚动页面'],
    login: ['Fill saved account', '填入已保存的账号'],
    close: ['Close browser', '关闭浏览器'],
    profiles: ['Read browser profiles', '查看浏览器配置'],
    request_takeover: ['Request takeover', '请求接管'],
    back: ['Go back', '后退'],
    forward: ['Go forward', '前进'],
    reload: ['Reload', '重新加载'],
    new_tab: ['Open tab', '打开标签页'],
    select_tab: ['Select tab', '切换标签页'],
    close_tab: ['Close tab', '关闭标签页'],
  }
  const key = c.action?.replace(/^browser:/, '') ?? c.name
  return enZh[key] ? L(...enZh[key]) : key
}
export function ToolTrace({
  calls,
  L,
  locale,
  actor,
  arrival,
}: {
  calls: ExecutionCall[]
  L: Localize
  locale: string
  actor: (id?: string) => string
  arrival?: boolean
}) {
  const [open, setOpen] = useState(false)
  const current = calls.find((c) => c.state === 'running'),
    problem = calls.some((c) => c.state === 'failed' || c.state === 'interrupted')
  const categories = [...new Set(calls.map(group))]
  const Icon = current ? LoaderCircle : problem ? CircleAlert : icons[categories[0]!]
  const labels = categories.map((g) => summary(g, L, !current && !problem))
  const joined = new Intl.ListFormat(locale, { style: 'short', type: 'conjunction' }).format(labels)
  const only = calls.every((c) => c.action === calls[0]?.action) ? calls[0]?.action : undefined
  const finished =
    categories.length === 1 && categories[0] === 'team' && only === 'list'
      ? L('Checked the team', '查看了团队')
      : categories.length === 1 && categories[0] === 'team' && only === 'assign'
        ? L('Delegated work', '分派了任务')
        : joined
  const label = calls.every((c) => c.permission === 'pending')
    ? L('Requested approval', '已请求批准')
    : current
      ? summary(group(current), L, false)
      : problem
        ? L('Tool activity · needs attention', '工具调用有异常')
        : finished
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  function state(c: ExecutionCall) {
    if (c.permission === 'pending') return L('Requested approval', '已请求批准')
    if (c.permission === 'denied') return L('Declined', '已拒绝')
    if (c.permission === 'uncertain') return L('Outcome unconfirmed', '结果待核对')
    if (c.permission === 'cancelled') return L('Cancelled', '已取消')
    return {
      running: L('Running', '进行中'),
      completed: L('Complete', '已完成'),
      failed: L('Failed', '失败'),
      interrupted: L('Interrupted', '已中断'),
    }[c.state]
  }
  return (
    <details
      className="trace-inline"
      data-arrival={arrival}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary title={L('Tool activity', '工具调用')}>
        <Icon aria-hidden size={16} className={current ? 'spin' : undefined} />
        <span>{label}</span>
        <ChevronDown className="trace-chevron" size={13} aria-hidden />
      </summary>
      <div className="trace-steps">
        {calls.map((c) => {
          const Icon =
            c.state === 'running'
              ? LoaderCircle
              : c.state === 'failed' || c.state === 'interrupted'
                ? CircleAlert
                : c.action === 'assign'
                  ? MessagesSquare
                  : c.action === 'list'
                    ? ListChecks
                    : icons[group(c)]
          const text = rowLabel(c, L),
            target = c.target ? actor(c.target) : undefined
          return (
            <details key={c.id} className="trace-step" data-state={c.state}>
              <summary>
                <Icon aria-hidden size={15} className={c.state === 'running' ? 'spin' : undefined} />
                <span>
                  {text}
                  {target ? ' · ' + target : ''}
                </span>
                <small>
                  {c.permission || c.state === 'failed' || c.state === 'interrupted' ? state(c) : null}
                </small>
                <time dateTime={new Date(c.startedAt).toISOString()}>{clock.format(c.startedAt)}</time>
              </summary>
              <div className="trace-meta">
                <code>{c.name}</code>
                <span>{actor(c.workerId)}</span>
                <span>{state(c)}</span>
                {c.endedAt != null && (
                  <span>
                    {new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
                      Math.max(0, c.endedAt - c.startedAt) / 1000
                    )}{' '}
                    s
                  </span>
                )}
              </div>
            </details>
          )
        })}
      </div>
    </details>
  )
}
