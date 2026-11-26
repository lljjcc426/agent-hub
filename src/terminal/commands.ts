import { ui } from './language.ts'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { openLocalBrowser } from '../personal-launch.ts'
import { publicMessage } from './conversation.ts'
import type { CapabilitySnapshot } from '../capability-types.ts'
import { TerminalClient, CliError, type Snapshot } from './client.ts'

export const commands = (advanced = false) =>
  [
    { name: '/config', usage: '', description: ui('Terminal settings', '终端设置') },
    { name: '/model', usage: '', description: ui('Choose a Router or Worker model', '选择 Router 或 Worker 模型') },
    { name: '/effort', usage: '', description: ui('Choose reasoning effort', '选择思考强度') },
    { name: '/permissions', usage: '', description: ui('Shared account permissions', '账号共享权限') },
    { name: '/theme', usage: '', description: ui('Choose a terminal theme', '选择终端主题') },
    { name: '/status', usage: '', description: ui('Connection, session and settings', '连接、会话和设置状态') },
    { name: '/context', usage: '', description: ui('Measured context usage', '实测上下文用量') },
    { name: '/compact', usage: '[now | auto on/off | threshold PERCENT]', description: ui('Compact context or configure automatic compaction', '压缩上下文或配置自动压缩') },
    { name: '/clear', usage: '', description: ui('Confirm clearing conversation and working context', '确认后清理对话和工作上下文') },
    { name: '/rename', usage: '', description: ui('Choose and rename a Worker', '选择并重命名 Worker') },
    { name: '/files', usage: '', description: ui('Files shared in this conversation', '查看对话中的文件') },
    { name: '/tasks', usage: '', description: ui('Inspect internal tasks', '查看内部任务') },
    {
      name: '/diff',
      usage: '',
      description: ui('Choose a Worker and review changes', '选择 Worker 查看文件改动')
    },
    {
      name: '/approvals',
      usage: '',
      description: ui('Review actions awaiting your permission', '查看需要你授权的操作')
    },
    {
      name: '/plan',
      usage: '',
      description: ui('Clarify requirements and prepare a plan', '澄清需求并制定计划')
    },
    {
      name: '/choose',
      usage: 'OPTION',
      description: ui('Answer an open Router question', '回答 Router 的提问')
    },
    {
      name: '/tools',
      usage: '[filter]',
      description: ui('Find tools, skills and MCP servers', '查找工具、技能和 MCP 服务')
    },
    {
      name: '/open',
      usage: '',
      description: ui('Open this conversation in the web workspace', '在网页中打开这段对话')
    },
    {
      name: '/stop',
      usage: '',
      description: ui('Stop the current request', '停止当前请求')
    },
    {
      name: '/approve',
      usage: 'TICKET ID',
      description: ui('Approve a pending request', '批准待处理请求')
    },
    {
      name: '/decline',
      usage: 'TICKET ID',
      description: ui('Decline a pending request', '拒绝待处理请求')
    },
    {
      name: '/answer',
      usage: 'TICKET ID JSON',
      description: ui('Answer a structured request', '回答结构化请求')
    },
    {
      name: '/help',
      usage: '',
      description: ui('Show commands and keyboard shortcuts', '查看命令和快捷键')
    },
    {
      name: '/exit',
      usage: '',
      description: ui('Leave the session running', '退出终端，后台继续运行')
    }
  ].filter(c => advanced || !['/tasks', '/diff', '/approve', '/decline', '/answer'].includes(c.name))

const commandHelp = () =>
  commands()
    .map(
      ({ name, usage, description }) => (name + (usage ? ' ' + usage : '')).padEnd(27) + description
    )
    .join('\n') +
  ui(
    '\n\nType / for commands or @ for project files. Alt+Enter inserts a newline. Ctrl+D exits an empty prompt. Ctrl+C/Esc interrupts work. Ctrl+R searches history; Ctrl+S stashes a draft; Ctrl+L redraws. Alt+P opens models; Shift+Tab opens permissions.',
    '\n\n/ 查看命令，@ 选择文件。Alt+Enter 换行，PgUp/PgDn 翻阅历史。输入框为空时按 Ctrl+D 退出。Ctrl+C/Esc 中断，Ctrl+R 搜索历史，Ctrl+S 暂存草稿，Ctrl+L 重绘。Alt+P 选模型，Shift+Tab 打开权限菜单。'
  )

export function mentionedFiles(text: string, cwd: string) {
  const files = new Set<string>()
  for (const match of text.matchAll(/(?:^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s"]+))/gu)) {
    let name = match[2]
    if (name === undefined) {
      try {
        name = JSON.parse('"' + match[1] + '"') as string
      } catch {
        name = match[1]
      }
    }
    if (!name) continue
    const path = resolve(cwd, name)
    if (existsSync(path)) files.add(path)
  }
  return [...files]
}
export function pendingDecisions(view: Snapshot) {
  return view.messages.filter(
    (m) => !m.recipient && m.decision && !m.decision.closed && !m.decision.replyRunId
  )
}
export async function command(client: TerminalClient, id: string, input: string): Promise<string> {
  const [name, ...args] = input.trim().split(/\s+/),
    ticket = args[0],
    approval = args[1]
  if (name === '/help') return args[0] === 'advanced'
    ? commands(true).map(c => (c.name + ' ' + c.usage).padEnd(27) + c.description).join('\n')
    : commandHelp()
  if (name === '/files') {
    const view = await client.view(id)
    const files = view.deliveries.map(d => d.name + '\n  ' + client.base + '/api/chat/conversations/' + id + '/deliveries/' + d.id)
    const attachments = view.messages.filter(publicMessage).flatMap(m => (m.attachments ?? []).map(f => f.name))
    return [...files, ...new Set(attachments)].join('\n\n') || ui('No files shared yet. Attach one with @ or --file.', '还没有文件，可用 @ 或 --file 添加。')
  }
  if (name === '/plan') {
    const { publicPlans, run } = await client.view(id)
    const plans = publicPlans.filter((p) => p.runId === run?.id)
    const marks = { pending: '○', running: '›', completed: '✓', blocked: '!' }
    return (
      plans
        .map(
          (p) =>
            p.title +
            '\n' +
            p.steps.map((step) => '  ' + marks[step.state] + ' ' + step.title).join('\n')
        )
        .join('\n\n') || ui('No plan published for this turn.', '本轮还没有执行计划。')
    )
  }
  if (name === '/choose') {
    const open = pendingDecisions(await client.view(id))
    if (!ticket)
      return (
        open
          .map(
            (m) =>
              m.decision!.question +
              '\n' +
              m
                .decision!.options.map(
                  (option, i) => '  /choose ' + m.id + ' ' + (i + 1) + '  ' + option.label
                )
                .join('\n')
          )
          .join('\n\n') || ui('No open questions.', '没有待回答的问题。')
      )
    const question = open.find((m) => m.id === ticket)
    const choice = question?.decision?.options[Number(approval) - 1]
    if (!question || !choice)
      throw new CliError(
        ui(
          'This choice is no longer available. Open /choose again.',
          '该选项已失效，请重新打开 /choose。'
        )
      )
    await client.request('/api/chat/conversations/' + id + '/decisions', {
      messageId: question.id,
      answer: choice.label,
      locale: Intl.DateTimeFormat().resolvedOptions().locale
    })
    return ''
  }
  if (name === '/open') {
    const url = client.link(id)
    await openLocalBrowser(url)
    return url
  }
  if (name === '/tools') {
    const library = await client.request<CapabilitySnapshot>('/api/capability-library')
    if (ticket === '--inspect' && approval) {
      const item = library.items.find((item) => encodeURIComponent(item.id) === approval)
      if (!item) return ui('Capability no longer available.', '该能力已不可用。')
      const source = item.sourceGroup ?? item.source
      return [
        item.name,
        [source, item.kind, item.status, item.version].filter(Boolean).join(' · '),
        item.description,
        ...(item.facts ?? []),
        ...(item.tools ?? []).map(
          (t) => '  ' + t.name + (t.description ? ' — ' + t.description : '')
        ),
        ...(item.steps ?? []),
        ...(item.inputs ?? []),
        ...(item.criteria ?? []),
        ...library.warnings
      ]
        .filter(Boolean)
        .join('\n')
    }
    const query = args.join(' ').toLowerCase()
    const groups = new Map<string, string[]>()
    for (const item of library.items) {
      const source = item.sourceGroup ?? item.source
      const line = item.kind + '  ' + item.name + '  [' + item.status + ']'
      if (!(source + ' ' + line).toLowerCase().includes(query)) continue
      const entries = groups.get(source) ?? []
      entries.push(line)
      groups.set(source, entries)
    }
    const names = [...groups.keys()].sort(
      (a, b) => Number(b === 'Roppo') - Number(a === 'Roppo') || a.localeCompare(b)
    )
    return (
      [
        ...names.map((n) => n + '\n  ' + groups.get(n)!.join('\n  ')),
        ...library.warnings,
        ...(library.refreshing
          ? [
              ui(
                'Sources are refreshing. Run /tools again for the updated list.',
                '来源正在刷新，稍后可用 /tools 查看最新列表。'
              )
            ]
          : [])
      ].join('\n') || ui('No matching capabilities.', '没有匹配的能力。')
    )
  }
  if (name === '/tasks') {
    const view = await client.view(id)
    return (
      view.tasks
        .map((t) => [t.id, t.workerId, t.state, t.title, t.question].filter(Boolean).join('  '))
        .join('\n') || ui('No Worker tasks.', '目前没有 Worker 任务。')
    )
  }
  if (name === '/stop' && !ticket) {
    const { run } = await client.view(id)
    if (!run || !['running', 'queued', 'waiting', 'cancel_requested'].includes(run.state))
      return ui('No active run.', '当前没有运行中的任务。')
    await client.request('/api/chat/conversations/' + id + '/cancel', { runId: run.id })
    return ui('Stop requested.', '已请求停止。')
  }
  if (!['/stop', '/approvals', '/approve', '/decline', '/answer', '/diff'].includes(name!))
    throw new CliError(ui('Unknown command. Type /help.', '未知命令，输入 /help 查看帮助。'))
  if (!ticket) throw new CliError(ui('Select a ticket from /tasks.', '请从 /tasks 选择任务。'))
  const action =
    name === '/stop'
      ? 'stop'
      : name === '/diff'
        ? 'diff'
        : name === '/approvals'
          ? 'approvals'
          : 'answer'
  if (action === 'answer' && !approval)
    throw new CliError(
      ui('Choose a request ID from /approvals TICKET.', '请从 /approvals TICKET 中选择请求 ID。')
    )
  const answer =
    name === '/answer'
      ? JSON.parse(args.slice(2).join(' '))
      : name === '/approve'
        ? 'accept'
        : name === '/decline'
          ? 'decline'
          : undefined
  const result = await client.request<{
    diff?: string
    untracked?: string[]
    truncated?: boolean
    pending?: unknown[]
  }>('/api/terminal/tasks', { conversation: id, ticket, action, approval, answer })
  if (action === 'diff')
    return (
      [
        result.diff,
        ...(result.untracked ?? []).map((f) => '? ' + f),
        result.truncated ? ui('[truncated]', '[已截断]') : ''
      ]
        .filter(Boolean)
        .join('\n') || ui('No changes.', '没有文件改动。')
    )
  if (action === 'approvals')
    return result.pending?.length
      ? JSON.stringify(result.pending, null, 2)
      : ui('No pending requests.', '没有待处理请求。')
  return action === 'stop'
    ? ui('Stopped ', '已停止 ') + ticket
    : ui('Response submitted.', '已提交答复。')
}

export function runResult(view: Snapshot, runId: string, status: string) {
  const messages = view.messages.filter(
    (m) => m.runId === runId && m.role === 'assistant' && publicMessage(m) && m.status !== 'streaming'
  )
  const router = messages.filter((m) => m.speaker?.kind !== 'worker').at(-1)
  const deliveries = view.deliveries
    .filter((d) => d.runId === runId || view.tasks.some((t) => t.id === d.ticketId))
    .map((d) => ({
      id: d.id,
      name: d.name,
      path: '/api/chat/conversations/' + view.conversation.id + '/deliveries/' + d.id
    }))
  return {
    conversationId: view.conversation.id,
    runId,
    status,
    text:
      (status === 'waiting'
        ? view.tasks
            .map((t) => t.question)
            .filter(Boolean)
            .join('\n')
        : '') ||
      router?.text || '',
    tasks: view.tasks,
    deliveries
  }
}
