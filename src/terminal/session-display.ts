import type { Interface } from 'node:readline'
import stringWidth from 'string-width'
import { TerminalLayout } from './presentation.ts'
import type { Snapshot } from './client.ts'

type Frame = ReturnType<TerminalLayout['composer']>
const up = (count: number) => (count > 0 ? '\x1b[' + count + 'A' : '')
const right = (count: number) => (count > 0 ? '\x1b[' + count + 'C' : '')

// A small live area below ordinary terminal scrollback. Readline owns editing and history.
export class SessionDisplay {
  private frame?: Frame
  private columns = 0
  private view?: Snapshot
  private seen = new Map<string, string>()
  continuation = false
  get layout() {
    return new TerminalLayout(this.out.columns || 80, !this.plain && !process.env.NO_COLOR)
  }
  constructor(
    private out: NodeJS.WriteStream,
    private editor: Interface,
    readonly plain: boolean
  ) {}
  private erase() {
    if (!this.frame) return ''
    let row = this.frame.row
    const width = Math.max(1, this.out.columns || 80)
    if (width < this.columns) {
      for (const line of this.frame.lines.slice(0, row))
        row += Math.max(0, Math.ceil(stringWidth(line) / width) - 1)
      row += Math.floor(this.frame.col / width)
    }
    return '\r' + up(row) + '\x1b[J'
  }
  paint(history: string[] = []) {
    if (this.plain) {
      if (history.length) this.out.write(history.join('\n') + '\n')
      return
    }
    const next = this.layout.composer(
      this.view,
      this.editor.line || '',
      this.editor.cursor || 0,
      this.continuation,
      this.out.rows || 24
    )
    if (
      !history.length &&
      this.columns === this.out.columns &&
      this.frame?.row === next.row &&
      this.frame.col === next.col &&
      this.frame.lines.length === next.lines.length &&
      next.lines.every((line, i) => line === this.frame!.lines[i])
    )
      return
    const text =
      this.erase() + (history.length ? history.join('\r\n') + '\r\n' : '') + next.lines.join('\r\n')
    this.out.write(text + '\r' + up(next.lines.length - 1 - next.row) + right(next.col))
    this.columns = this.out.columns
    this.frame = next
  }
  update(view: Snapshot) {
    const layout = this.layout,
      first = !this.view,
      history = first ? layout.header(view) : []
    const entries: { at: number; lines: string[] }[] = []
    // Record each finished activity once. Active tasks keep their place above the draft.
    for (const task of view.tasks) {
      const key = 'task/' + task.id,
        previous = this.seen.get(key)
      this.seen.set(key, task.state)
      if ((previous !== task.state || first) && !['queued', 'running', 'waiting'].includes(task.state)) {
        entries.push({ at: task.updatedAt, lines: ['', layout.task(task, view)] })
      }
    }
    for (const call of view.calls) {
      if (call.kind !== 'tool') continue
      const key = 'call/' + call.id,
        previous = this.seen.get(key)
      this.seen.set(key, call.state)
      // Successful Worker assignments are already represented by the task they created.
      const represented =
        call.name === 'worker_manage' &&
        call.action === 'assign' &&
        call.state === 'completed' &&
        view.tasks.some((t) => t.workerId === call.target)
      if (!first && !represented && call.state !== 'running' && call.state !== previous)
        entries.push({ at: call.endedAt ?? call.startedAt, lines: [layout.activity(call)] })
    }
    for (const message of view.messages) {
      if (message.recipient || message.status === 'streaming' || this.seen.has(message.id)) continue
      const body = [message.text, ...(message.attachments ?? []).map((file) => '@' + file.name)]
        .filter(Boolean)
        .join('\n')
      if (!body) continue
      this.seen.set(message.id, 'shown')
      const user = message.role === 'user'
      entries.push({
        at: message.createdAt,
        lines: layout.message(user ? 'You' : (message.speaker?.label ?? 'Roppo'), body, user)
      })
    }
    for (const entry of entries.sort((a, b) => a.at - b.at)) history.push(...entry.lines)
    if (this.plain && first) history.push('/help for commands')
    if (this.plain && view.run?.state !== this.view?.run?.state && view.run)
      history.push('Roppo · ' + view.run.state)
    this.view = view
    this.paint(history)
  }
  close() {
    if (this.frame) this.out.write(this.erase())
    this.frame = undefined
  }
}
