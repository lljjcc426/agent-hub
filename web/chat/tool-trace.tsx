import { ChevronRight } from 'lucide-react'
import { DisclosureRoot, DisclosureSummary } from '../ui/overlays.tsx'
import type { ExecutionCall } from '../../src/execution-activity.ts'

type Localize = (en: string, zh: string) => string
export function toolLabel(c: ExecutionCall, L: Localize) {
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
    superagent_status: ['Update status', '更新状态'],
    superagent_plan: ['Update plan', '更新计划'],
    superagent_tools: ['Inspect tools', '查看工具'],
    superagent_job: ['Check job', '查看任务状态'],
    superagent_read: ['Read resource', '读取资源'],
    router_read: ['Read resource', '读取资源'],
    superagent_tool: ['Call connected tool', '调用连接工具'],
    code_mode: ['Compose tools in Code Mode', '用 Code Mode 编排工具'],
    'opencode/websearch': ['Search the web', '搜索网页'],
    'opencode/webfetch': ['Read a web page', '读取网页'],
    'opencode/webfetch_batch': ['Fetch pages in parallel', '并行抓取网页'],
    superagent_browser: ['Use browser', '使用浏览器'],
    workspace_browser: ['Use browser', '使用浏览器'],
    superagent_spawn: ['Delegate subtask', '分派子任务'],
    router_manage: ['Manage task', '管理任务'],
    chat_deliver_file: ['Prepare file', '准备交付文件'],
    chat_request_decision: ['Ask for a decision', '请求确认'],
    router_goal: ['Manage goal', '管理任务目标'],
    router_journal: ['Update work notes', '更新工作记录'],
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
  const label = Object.hasOwn(enZh,key) ? enZh[key] : undefined
  return label ? L(...label) : key || L('Tool call', '调用工具')
}
export function toolStatus(c: ExecutionCall, L: Localize) {
  if (c.permission === 'pending') return L('Requested approval', '已请求批准')
  if (c.permission === 'denied') return L('Declined', '已拒绝')
  if (c.permission === 'uncertain') return L('Outcome unconfirmed', '结果待核对')
  if (c.permission === 'cancelled') return L('Cancelled', '已取消')
  return {
    running: L('Running', '进行中'),
    completed: L('Complete', '已完成'),
    failed: L('Recorded', '已记录'),
    interrupted: L('Recorded', '已记录'),
  }[c.state]
}
export function ToolCallDetail({call,label,active,locale,L,actor}: {
  call: ExecutionCall; label:string; active:boolean; locale:string; L:Localize; actor:(id?:string)=>string
}) {
  const clock=new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
  const flagged=call.permission==='pending'||call.permission==='denied'||call.permission==='cancelled'
  const start=new Date(call.startedAt)
  return <DisclosureRoot className="trace-step" data-state={call.state==='failed'||call.state==='interrupted'?'recorded':call.state}>
    <DisclosureSummary>
      <span className={active?'rv-thinking-sheen':undefined}>{label}{call.target?' · '+actor(call.target):''}</span>
      {flagged && <small>{toolStatus(call,L)}</small>}
      <time dateTime={start.toISOString()}>{clock.format(start)}</time>
      <ChevronRight size={12} aria-hidden="true"/>
    </DisclosureSummary>
    <div className="trace-meta">
      <code>{call.name}</code>
      <span>{actor(call.workerId)}</span>
      <span>{toolStatus(call,L)}</span>
      {call.endedAt != null && <span>{new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(
        Math.max(0,call.endedAt-call.startedAt)/1000)} {L('s','秒')}</span>}
    </div>
  </DisclosureRoot>
}
