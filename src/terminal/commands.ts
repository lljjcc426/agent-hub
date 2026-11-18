import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { openLocalBrowser } from '../personal-launch.ts'
import type { CapabilitySnapshot } from '../capability-types.ts'
import { TerminalClient, CliError, type Snapshot } from './client.ts'

export const commandHelp = [
  '/tasks                    Show Worker tasks',
  '/diff TICKET              Show changes recorded for a task',
  '/approvals TICKET         Inspect pending requests and their scope',
  '/approve TICKET ID        Approve the displayed request for this turn',
  '/decline TICKET ID        Decline a request',
  '/answer TICKET ID JSON    Answer a structured input request',
  '/tools [filter]           Browse the workspace capability library',
  '/stop [TICKET]            Stop a task, or the current run',
  '/open                     Open this conversation in the web workspace',
  '/exit                     Leave this session running'
].join('\n')
export function mentionedFiles(text: string, cwd: string) {
  const files: string[] = []
  for (const match of text.matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s]+))/g)) {
    const path = resolve(cwd, match[1] ?? match[2]!)
    if (existsSync(path)) files.push(path)
  }
  return files
}
export async function command(client: TerminalClient, id: string, input: string): Promise<string> {
  const [name, ...args] = input.trim().split(/\s+/),
    ticket = args[0],
    approval = args[1]
  if (name === '/help') return commandHelp
  if (name === '/open') {
    const url = client.link(id)
    await openLocalBrowser(url)
    return url
  }
  if (name === '/tools') {
    const library = await client.request<CapabilitySnapshot>('/api/capability-library')
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
        ...(library.refreshing ? ['Sources are refreshing. Run /tools again for the updated list.'] : [])
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
  if (action === 'answer' && !approval) throw new CliError('Choose a request ID from /approvals TICKET.')
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
