import { basename } from 'node:path'
import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
import { clean, type Snapshot } from './client.ts'

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const oneLine = (value: string) => clean(value).replace(/\s+/g, ' ').trim()
export function fit(text: string, cells: number) {
  if (cells < 1) return ''
  if (stringWidth(text) <= cells) return text
  let out = '',
    used = 0
  for (const { segment } of segments.segment(text)) {
    const width = stringWidth(segment)
    if (used + width >= cells) break
    out += segment
    used += width
  }
  return out + '…'
}

function latestText(text: string, cells: number) {
  if (stringWidth(text) <= cells) return text
  const graphemes = segments.segment(text)
  let index = text.length,
    used = 1
  while (index > 0) {
    const part = graphemes.containing(index - 1)!
    used += stringWidth(part.segment)
    if (used > cells) break
    index = part.index
  }
  return '…' + text.slice(index)
}

// Keep draft layout and cursor positioning in terminal cells, including wide CJK and emoji.
export function draftLines(text: string, cursor: number, cells: number) {
  const lines = ['']
  let row = 0,
    col = 0,
    caret = { row: 0, col: 0 }
  for (const { segment, index } of segments.segment(text)) {
    const part = clean(segment).replace(/\t/g, '  ')
    const width = stringWidth(part)
    if (col && col + width > cells) {
      lines.push('')
      row++
      col = 0
    }
    if (index === cursor) caret = { row, col }
    lines[row] += part
    col += width
    if (index < cursor) caret = { row, col }
  }
  return { lines, caret }
}

// The same Roppo silhouette as the workspace logo, sampled on a terminal braille grid.
const mark = ['⢰⣿⣿⣿⣿⣆', '⢀⣤⡤⢀⣹⡿', '⢸⣿⡇⢿⣿⡅', '⠈⠛⠁ ⠛⠛']
type Tone = 'title' | 'quiet' | 'accent' | 'success' | 'attention' | 'error' | 'rule'
const codes: Record<Tone, string> = {
  title: '1',
  quiet: '90',
  accent: '36',
  success: '32',
  attention: '33',
  error: '31',
  rule: '2'
}
const runLabels: Record<string, string> = {
  queued: 'Queued',
  running: 'Working',
  completed: 'Completed',
  waiting: 'Needs input',
  failed: 'Failed',
  cancel_requested: 'Stopping',
  cancelled: 'Stopped'
}
export class TerminalLayout {
  readonly margin: string
  readonly width: number
  constructor(
    columns: number,
    readonly colors: boolean
  ) {
    const pad = columns < 50 ? 1 : 3
    this.margin = ' '.repeat(pad)
    this.width = Math.max(8, Math.min(96, columns - pad * 2 - 1))
  }
  ink(text: string, tone: Tone) {
    return this.colors ? '\x1b[' + codes[tone] + 'm' + text + '\x1b[0m' : text
  }
  private inline(text: string) {
    return text.replace(/\*\*([^*\n]+)\*\*|`([^`\n]+)`/g, (_m, strong?: string, code?: string) =>
      strong ? this.ink(strong, 'title') : this.ink(code!, 'accent')
    )
  }
  header(view: Snapshot) {
    const { conversation: c, readiness } = view
    const project = oneLine(basename(c.project ?? '') || 'Workspace')
    const workers = readiness.workers.filter(
      (w) => w.state !== 'paused' && w.state !== 'retiring'
    ).length
    const model = oneLine(c.model ?? c.backend ?? '')
    const info = [model, workers + ' ' + (workers === 1 ? 'worker' : 'workers')]
      .filter(Boolean)
      .join('  ·  ')
    if (this.width < 31)
      return [
        '',
        this.margin + this.ink('Roppo', 'title') + '  ' + this.ink('CLI', 'quiet'),
        this.margin + fit(project, this.width),
        ''
      ]
    const available = this.width - 10
    const title = this.ink('Roppo', 'title') + ' ' + this.ink('CLI', 'quiet')
    const team = fit(info, Math.floor(available / 2))
    const labels = [
      title + ' '.repeat(Math.max(2, available - 9 - stringWidth(team))) + this.ink(team, 'quiet'),
      '',
      this.ink('Project', 'quiet') + '  ' + this.ink(fit(project, available - 9), 'title'),
      c.title ? this.ink(fit(oneLine(c.title), available), 'quiet') : ''
    ]
    return [
      '',
      ...mark.map((row, i) => this.margin + this.ink(row, 'accent') + '   ' + labels[i]),
      '',
      this.margin + this.ink('─'.repeat(this.width), 'rule')
    ]
  }
  message(who: string, text: string, user: boolean) {
    const tone = user ? 'quiet' : 'accent'
    const lines = [
      '',
      this.margin +
        this.ink(user ? '❯ ' : '● ', tone) +
        this.ink(oneLine(who), user ? 'title' : 'accent')
    ]
    let code = false
    for (let line of clean(text).replace(/\t/g, '    ').split('\n')) {
      if (/^\s*```/.test(line)) {
        code = !code
        continue
      }
      if (!code) {
        line = line
          .replace(/^[-*] /, '• ')
          .replace(/^#{1,6} (.+)$/, (_m, h: string) => this.ink(h, 'title'))
        line = this.inline(line)
      }
      for (const part of wrapAnsi(line, Math.max(4, this.width - (code ? 4 : 2)), {
        hard: true,
        trim: false
      }).split('\n'))
        lines.push(this.margin + '  ' + (code ? this.ink('│', 'quiet') + ' ' : '') + part)
    }
    return lines
  }
  result(text: string, error = false) {
    const lines = wrapAnsi(clean(text), this.width - 2, { hard: true, trim: false }).split('\n')
    return ['', ...lines.map((line) => this.margin + '  ' + (error ? this.ink(line, 'error') : line))]
  }
  task(t: Snapshot['tasks'][number], view: Snapshot) {
    const label = oneLine(view.workers.find((w) => w.id === t.workerId)?.label ?? t.workerId)
    const state = runLabels[t.state] ?? oneLine(t.state)
    const tone =
      t.state === 'failed'
        ? 'error'
        : t.state === 'waiting'
          ? 'attention'
          : t.state === 'completed'
            ? 'success'
            : 'accent'
    const glyph =
      t.state === 'completed' ? '✓' : t.state === 'failed' ? '×' : t.state === 'waiting' ? '?' : '↳'
    const name = fit(label, Math.max(5, Math.floor(this.width / 3)))
    const showState = !['running', 'completed'].includes(t.state)
    const title = fit(
      oneLine(t.question || t.title),
      this.width - stringWidth(name) - (showState ? stringWidth(state) + 2 : 0) - 9
    )
    return (
      this.margin +
      '  ' +
      this.ink(glyph, tone) +
      ' ' +
      this.ink(name, 'title') +
      (showState ? '  ' + this.ink(state, tone) : '') +
      (title ? this.ink('  ·  ', 'quiet') + title : '')
    )
  }
  activity(call: Snapshot['calls'][number]) {
    const desc = oneLine([call.name, call.action, call.target].filter(Boolean).join(' · '))
    return (
      this.margin +
      '  ' +
      this.ink(
        '↳ ' + fit(desc + '  ' + call.state, this.width - 4),
        call.state === 'failed' ? 'error' : 'quiet'
      )
    )
  }
  composer(
    view: Snapshot | undefined,
    text: string,
    cursor: number,
    continuation: boolean,
    maxRows: number
  ) {
    const lines: string[] = ['']
    const tasks = view?.tasks.filter((t) => ['queued', 'running', 'waiting'].includes(t.state)) ?? []
    const maxTasks = maxRows >= 15 ? 3 : 1
    for (const t of tasks.slice(0, maxTasks)) lines.push(this.task(t, view!))
    if (tasks.length > maxTasks)
      lines.push(this.margin + this.ink('  +' + (tasks.length - maxTasks) + ' more · /tasks', 'quiet'))
    const activeTool = view?.calls.findLast((c) => c.kind === 'tool' && c.state === 'running')
    if (activeTool && !tasks.length) lines.push(this.activity(activeTool))
    const stream = view?.messages.findLast(
      (m) => !m.recipient && m.status === 'streaming' && m.text
    )?.text
    if (stream)
      lines.push(this.margin + this.ink('  ' + latestText(oneLine(stream), this.width - 2), 'quiet'))
    if (tasks.length || activeTool || stream) lines.push('')
    const state = view?.run?.state
    const publicStatus =
      state === 'running'
        ? view?.calls.findLast((c) => c.state === 'running' && c.status?.label)?.status?.label
        : undefined
    const label = fit(
      oneLine(publicStatus ?? (state ? (runLabels[state] ?? state) : 'Ready')),
      Math.max(5, this.width - 12)
    )
    const tone =
      state === 'failed'
        ? 'error'
        : state === 'waiting'
          ? 'attention'
          : !state || state === 'completed'
            ? 'success'
            : 'accent'
    const rule = this.ink('─'.repeat(Math.max(1, this.width - stringWidth(label) - 4)), 'rule')
    lines.push(this.margin + rule + '  ' + this.ink('● ' + label, tone))
    const prompt = continuation ? '… ' : '❯ '
    const { lines: draft, caret } = draftLines(text, cursor, Math.max(4, this.width - 3))
    const limit = Math.max(1, Math.min(5, Math.floor(maxRows / 4))),
      start = Math.max(0, caret.row - limit + 1)
    const row = lines.length + caret.row - start
    for (const [i, line] of draft.slice(start, start + limit).entries())
      lines.push(
        this.margin +
          (i + start === 0 ? this.ink(prompt, 'accent') : '  ') +
          (line ||
            (!text && !continuation ? this.ink(fit('Message Roppo…', this.width - 2), 'quiet') : ''))
      )
    lines.push(this.margin + this.ink('─'.repeat(this.width), 'rule'))
    const shortcuts =
      this.width >= 56
        ? [
            ['/tasks', 'workers'],
            ['/open', 'web chat'],
            ['/help', 'commands']
          ]
        : this.width >= 33
          ? [
              ['/tasks', 'workers'],
              ['/help', 'commands']
            ]
          : [['/help', 'commands']]
    const hints = shortcuts
      .map(([key, label]) => this.ink(key!, 'title') + ' ' + this.ink(label!, 'quiet'))
      .join('    ')
    lines.push(this.margin + (stringWidth(hints) <= this.width ? hints : this.ink('/help', 'quiet')))
    return { lines, row, col: this.margin.length + 2 + caret.col }
  }
}
