import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { openLocalBrowser } from '../personal-launch.ts'
import type { CapabilitySnapshot } from '../capability-types.ts'
import { TerminalClient, CliError, type Snapshot } from './client.ts'

export const commands = [
  { name: '/tasks', usage: '', description: 'Inspect Worker tasks' },
  { name: '/diff', usage: 'TICKET', description: 'Review changes for a task' },
  { name: '/approvals', usage: 'TICKET', description: 'Inspect pending requests and their scope' },
  { name: '/plan', usage: '', description: 'Read the current execution plan' },
  { name: '/choose', usage: 'OPTION', description: 'Answer an open Router question' },
  { name: '/tools', usage: '[filter]', description: 'Find tools, skills and MCP servers' },
  { name: '/open', usage: '', description: 'Open this conversation in the web workspace' },
  { name: '/stop', usage: '[TICKET]', description: 'Stop the current run or a Worker task' },
  { name: '/approve', usage: 'TICKET ID', description: 'Approve a pending request' },
  { name: '/decline', usage: 'TICKET ID', description: 'Decline a pending request' },
  { name: '/answer', usage: 'TICKET ID JSON', description: 'Answer a structured request' },
  { name: '/help', usage: '', description: 'Show commands and keyboard shortcuts' },
  { name: '/exit', usage: '', description: 'Leave the session running' }
] as const

export const commandHelp =
  commands
    .map(
      ({ name, usage, description }) => (name + (usage ? ' ' + usage : '')).padEnd(27) + description
    )
    .join('\n') +
  '\n\nType / for commands or @ for project files. Alt+Enter inserts a newline. Ctrl+D exits an empty prompt.'

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
  if (name === '/help') return commandHelp
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
        .join('\n\n') || 'No plan published for this turn.'
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
          .join('\n\n') || 'No open questions.'
      )
    const question = open.find((m) => m.id === ticket)
    const choice = question?.decision?.options[Number(approval) - 1]
    if (!question || !choice)
      throw new CliError('This choice is no longer available. Open /choose again.')
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
      if (!item) return 'Capability no longer available.'
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
          ? ['Sources are refreshing. Run /tools again for the updated list.']
          : [])
      ].join('\n') || 'No matching capabilities.'
    )
  }
  if (name === '/tasks') {
    const view = await client.view(id)
    return (
      view.tasks
        .map((t) => [t.id, t.workerId, t.state, t.title, t.question].filter(Boolean).join('  '))
        .join('\n') || 'No Worker tasks.'
    )
  }
  if (name === '/stop' && !ticket) {
    const { run } = await client.view(id)
    if (!run || !['running', 'queued', 'waiting', 'cancel_requested'].includes(run.state))
      return 'No active run.'
    await client.request('/api/chat/conversations/' + id + '/cancel', { runId: run.id })
    return 'Stopped ' + run.id
  }
  if (!['/stop', '/approvals', '/approve', '/decline', '/answer', '/diff'].includes(name!))
    throw new CliError('Unknown command. Type /help.')
  if (!ticket) throw new CliError('Select a ticket from /tasks.')
  const action =
    name === '/stop'
      ? 'stop'
      : name === '/diff'
        ? 'diff'
        : name === '/approvals'
          ? 'approvals'
          : 'answer'
  if (action === 'answer' && !approval)
    throw new CliError('Choose a request ID from /approvals TICKET.')
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
        result.truncated ? '[truncated]' : ''
      ]
        .filter(Boolean)
        .join('\n') || 'No changes.'
    )
  if (action === 'approvals')
    return result.pending?.length ? JSON.stringify(result.pending, null, 2) : 'No pending requests.'
  return action === 'stop' ? 'Stopped ' + ticket : 'Answered ' + approval
}

export function runResult(view: Snapshot, runId: string, status: string) {
  const messages = view.messages.filter(
    (m) => m.runId === runId && m.role === 'assistant' && !m.recipient && m.status !== 'streaming'
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
      router?.text ||
      messages.at(-1)?.text ||
      view.tasks
        .map((t) => t.summary)
        .filter(Boolean)
        .join('\n'),
    tasks: view.tasks,
    deliveries
  }
}
