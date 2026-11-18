import { basename } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Menu } from './editor.ts'
import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  .version as string
import { clean, type Snapshot } from './client.ts'
import { isApprovalPending } from '../chat-workflow.ts'

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

// Keep draft layout and cursor positioning in terminal cells, including wide CJK and emoji.
export function draftLines(text: string, cursor: number, cells: number) {
  const lines = ['']
  let row = 0,
    col = 0,
    caret = { row: 0, col: 0 }
  for (const { segment, index } of segments.segment(text)) {
    const part = clean(segment).replace(/\t/g, '  ')
    if (segment === '\n') {
      if (index === cursor) caret = { row, col }
      lines.push('')
      row++
      col = 0
      if (index < cursor) caret = { row, col }
      continue
    }
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

// Paired half-block rows keep the workspace R mark and wordmark aligned in terminal cells.
const wordmark = [
  ['▄██████▄ ', '        ', '        '],
  ['▀▀▀▀▀▀███', '  ▄▄▄▄  ', '▄▄▄▄▄▄  '],
  ['    ▄▄███', '▄██▀▀██▄', '██▀▀▀██▄'],
  ['███▀▀█▀▀ ', '██    ██', '██    ██'],
  ['███  ▀██▄', '▀██▄▄██▀', '██▄▄▄██▀'],
  ['▀▀▀   ▀▀▀', '  ▀▀▀▀  ', '██▀▀▀▀  '],
  ['         ', '        ', '██      ']
] as const
type Tone = 'title' | 'quiet' | 'accent' | 'success' | 'attention' | 'error' | 'rule' | 'selected'
const codes: Record<Tone, string> = {
  title: '1',
  quiet: '90',
  accent: '36',
  success: '32',
  attention: '33',
  error: '31',
  rule: '90',
  selected: '1;36'
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
  private draft?: { text: string; cursor: number; value: ReturnType<typeof draftLines> }
  constructor(
    columns: number,
    readonly colors: boolean
  ) {
    const pad = columns >= 74 ? 5 : columns >= 44 ? 2 : 1
    this.width = Math.max(8, Math.min(94, columns - 2 * pad - 1))
    this.margin = ' '.repeat(Math.max(0, Math.floor((columns - this.width) / 2)))
  }
  ink(text: string, tone: Tone) {
    return this.colors ? '\x1b[' + codes[tone] + 'm' + text + '\x1b[0m' : text
  }
  private inline(text: string) {
    return text.replace(/\*\*([^*\n]+)\*\*|`([^`\n]+)`/g, (_m, strong?: string, code?: string) =>
      strong ? this.ink(strong, 'title') : this.ink(code!, 'accent')
    )
  }
  private context(view: Snapshot) {
    const { conversation, readiness } = view
    const path = oneLine(conversation.project || 'Workspace')
    const project = basename(path) || path
    const model = oneLine(
      conversation.model ||
        conversation.backend ||
        readiness.model ||
        readiness.backend ||
        readiness.routerLabel ||
        'Router'
    )
    const workers = readiness.workers.filter(
      (w) => !['paused', 'retiring'].includes(w.state)
    ).length
    const router = oneLine(readiness.routerLabel || '')
    const team = [
      ...new Set([router, model].filter(Boolean)),
      workers + (workers === 1 ? ' worker' : ' workers')
    ].join('  ·  ')
    return { project, team }
  }
  private across(left: string, right: string, cells = this.width) {
    const gap = cells - stringWidth(left) - stringWidth(right)
    return gap >= 2 ? left + ' '.repeat(gap) + right : left
  }
  header(view: Snapshot) {
    const { project, team } = this.context(view)
    const brand = this.ink('Roppo', 'accent')
    const name = fit(project, Math.max(1, this.width - 10))
    const left = brand + this.ink('  /  ', 'rule') + name
    return [
      '',
      this.margin + this.across(left, this.ink('v' + version, 'quiet')),
      this.margin + this.ink(fit(team, this.width), 'quiet')
    ]
  }
  private welcome(view: Snapshot, rows: number) {
    const { project, team } = this.context(view)
    const centered = (value: string) =>
      this.margin +
      ' '.repeat(Math.max(0, Math.floor((this.width - stringWidth(value)) / 2))) +
      value
    const wide = this.width >= 54 && rows >= 22
    const lines: string[] = Array.from(
      { length: Math.max(0, Math.min(7, Math.floor((rows - (wide ? 15 : 9)) / 3))) },
      () => ''
    )
    if (wide) {
      for (const [r, o, p] of wordmark)
        lines.push(
          centered(this.ink(r, 'accent') + ' ' + this.ink([o, p, p, o].join(' '), 'title'))
        )
    } else lines.push(centered(this.ink('Roppo CLI', 'title')))
    lines.push(
      '',
      centered(this.ink(fit(project, this.width), 'title')),
      centered(this.ink(fit(team, this.width), 'quiet'))
    )
    return lines
  }
  menuLines(menu: Menu, limit: number) {
    const count = menu.items.length
    const height = Math.max(1, Math.min(6, limit))
    const start = Math.max(0, Math.min(menu.selected - Math.floor(height / 2), count - height))
    const position = count ? menu.selected + 1 + ' / ' + count : ''
    const title =
      this.margin +
      '  ' +
      this.across(
        this.ink(fit(oneLine(menu.title), this.width - 4), 'title'),
        this.ink(position, 'quiet'),
        this.width - 4
      )
    if (!count)
      return [
        title,
        this.margin + '  ' + this.ink(fit(menu.empty ?? 'No matches', this.width - 2), 'quiet')
      ]
    const items = menu.items.slice(start, start + height)
    const hasDetail = this.width > 36 && items.some((item) => item.detail)
    const labelWidth = hasDetail
      ? Math.min(
          Math.floor(this.width * 0.46),
          Math.max(10, ...items.map((item) => stringWidth(oneLine(item.label))))
        )
      : this.width - 3
    return [
      title,
      ...items.map((item, i) => {
        const selected = start + i === menu.selected,
          label = fit(oneLine(item.label), labelWidth)
        const detail = hasDetail
          ? ' '.repeat(labelWidth - stringWidth(label) + 2) +
            fit(oneLine(item.detail), this.width - labelWidth - 5)
          : ''
        const marker = selected ? '▸ ' : '  '
        if (selected)
          return this.margin + this.ink(marker, 'accent') + this.ink(label, 'selected') + detail
        return this.margin + marker + label + this.ink(detail, 'quiet')
      })
    ]
  }
  message(who: string, text: string, user: boolean) {
    if (user) {
      const parts = wrapAnsi(clean(text).replace(/\t/g, '    '), this.width - 3, {
        hard: true,
        trim: false
      }).split('\n')
      return [
        '',
        ...parts.map((p, i) => this.margin + (i === 0 ? this.ink('❯ ', 'accent') : '  ') + p)
      ]
    }
    const lines = [
      '',
      this.margin + this.ink('● ', 'accent') + this.ink(fit(oneLine(who), this.width - 3), 'title')
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
    return [
      '',
      ...lines.map((line) => this.margin + '  ' + (error ? this.ink(line, 'error') : line))
    ]
  }
  diff(text: string) {
    const lines = ['']
    for (const line of clean(text).split('\n')) {
      const tone =
        line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')
          ? 'title'
          : line.startsWith('+')
            ? 'success'
            : line.startsWith('-')
              ? 'error'
              : line.startsWith('@@')
                ? 'accent'
                : undefined
      for (const part of wrapAnsi(line, this.width - 2, { hard: true, trim: false }).split('\n'))
        lines.push(this.margin + '  ' + (tone ? this.ink(part, tone) : part))
    }
    return lines
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
    const assignment = call.name === 'worker_manage' && call.action === 'assign'
    const desc = assignment
      ? 'Assign Worker' + (call.target ? '  →  ' + oneLine(call.target) : '')
      : oneLine([call.name, call.action, call.target].filter(Boolean).join(' · '))
    return (
      this.margin +
      '  ' +
      this.ink(
        (call.state === 'completed' ? '✓ ' : call.state === 'failed' ? '× ' : '↳ ') +
          fit(desc, this.width - 4),
        call.state === 'failed' ? 'error' : 'quiet'
      )
    )
  }
  composer(
    view: Snapshot | undefined,
    text: string,
    cursor: number,
    continuation: boolean,
    maxRows: number,
    options: {
      menu?: Menu
      expanded?: boolean
      now?: number
      picker?: boolean
      home?: boolean
    } = {}
  ) {
    const lines: string[] = []
    const { menu, expanded, now = Date.now() } = options
    const state = view?.run?.state
    const tasks =
      view?.tasks.filter((t) => ['queued', 'running', 'waiting'].includes(t.state)) ?? []
    const calls = view?.calls ?? []
    const activeCalls = calls.filter((c) => c.state === 'running')
    const live = state === 'running' || state === 'queued' || state === 'cancel_requested'
    const busy = live || tasks.some((t) => t.state === 'running' || t.state === 'queued')
    const showWork = maxRows >= 10 && !options.picker
    if (showWork && view && (state || tasks.length)) {
      const label = activeCalls.findLast((c) => c.status?.label)?.status?.label
      const elapsed = Math.max(0, Math.floor((now - (view.run?.createdAt ?? now)) / 1000))
      const time =
        elapsed >= 60 ? Math.floor(elapsed / 60) + 'm ' + (elapsed % 60) + 's' : elapsed + 's'
      const glyph = busy
        ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][Math.floor(now / 150) % 10]
        : state === 'failed'
          ? '×'
          : state === 'waiting'
            ? '?'
            : '✓'
      const status = oneLine(
        (busy && label) ||
          (busy && !live ? 'Workers running' : state ? (runLabels[state] ?? state) : 'Working')
      )
      const tone = busy
        ? 'accent'
        : state === 'failed'
          ? 'error'
          : state === 'waiting'
            ? 'attention'
            : 'quiet'
      lines.push(
        '',
        this.margin +
          this.ink(
            glyph + ' ' + fit(status + (busy && view.run ? '  ·  ' + time : ''), this.width - 3),
            tone
          )
      )
      if (!menu || maxRows >= 22) {
        for (const t of tasks.slice(0, maxRows >= 18 ? 3 : 1)) lines.push(this.task(t, view))
        const visibleCalls = expanded
          ? calls.filter((c) => c.kind === 'tool').slice(-4)
          : activeCalls.filter((c) => c.kind === 'tool').slice(-1)
        for (const call of visibleCalls) lines.push(this.activity(call))
        const stream = view.messages.findLast(
          (m) => !m.recipient && m.status === 'streaming' && m.text
        )
        if (stream) {
          const wrapped = wrapAnsi(clean(stream.text), this.width - 3, {
            hard: true,
            trim: false
          }).split('\n')
          for (const line of wrapped.slice(-Math.min(4, Math.max(1, Math.floor(maxRows / 7)))))
            lines.push(this.margin + '  ' + line)
        }
      }
    }
    if (options.home && view && maxRows >= 12) lines.push(...this.welcome(view, maxRows))
    if (expanded && view && !busy && !menu && maxRows >= 15) {
      const team = view.readiness.workers
        .filter((w) => !['paused', 'retiring'].includes(w.state))
        .map((w) => oneLine(w.label || w.id))
      lines.push(
        '',
        this.margin +
          this.ink('Project  ', 'quiet') +
          fit(oneLine(view.conversation.project || 'Workspace'), this.width - 9),
        this.margin + this.ink('Workers  ', 'quiet') + fit(team.join(' · ') || '0', this.width - 9)
      )
    }
    if (maxRows >= 10 || !menu) lines.push('')
    const fieldWidth = Math.max(1, this.width - 7)
    const rim = this.ink('─'.repeat(Math.max(0, this.width - 2)), 'rule')
    lines.push(this.margin + this.ink('╭', 'rule') + rim + this.ink('╮', 'rule'))
    if (this.draft?.text !== text || this.draft.cursor !== cursor) {
      this.draft = { text, cursor, value: draftLines(text, cursor, fieldWidth) }
    }
    const { lines: draft, caret } = this.draft.value
    const limit = Math.max(
      1,
      Math.min(7, Math.floor(maxRows / 3), maxRows - lines.length - (menu ? 7 : 3))
    )
    const start = Math.max(0, caret.row - limit + 1)
    const row = lines.length + caret.row - start
    for (const [i, line] of draft.slice(start, start + limit).entries()) {
      const marker = i + start === 0 ? (options.picker ? '⌕ ' : continuation ? '… ' : '› ') : '  '
      const hint = options.picker ? 'Search conversations…' : 'Message Roppo…'
      const content =
        line || (!text && !continuation ? ' ' + this.ink(fit(hint, fieldWidth - 1), 'quiet') : '')
      const pad = Math.max(0, this.width - 6 - stringWidth(content))
      lines.push(
        this.margin +
          this.ink('│', 'rule') +
          ' ' +
          this.ink(marker, 'accent') +
          content +
          ' '.repeat(pad) +
          ' ' +
          this.ink('│', 'rule')
      )
    }
    lines.push(this.margin + this.ink('╰', 'rule') + rim + this.ink('╯', 'rule'))
    if (menu) lines.push(...this.menuLines(menu, maxRows - lines.length - 2))
    const pending = view?.messages.some(
      (m) => m.decision && !m.recipient && !m.decision.closed && !m.decision.replyRunId && !m.decision.defaultOption
    )
    const needsApproval = view?.approvals.some((a) => isApprovalPending(a, now))
    const actions = menu
      ? options.picker
        ? '↑↓ select    Enter resume'
        : '↑↓ select    Enter choose'
      : pending
        ? '/choose answer question'
        : needsApproval
          ? '/approvals review request'
          : busy
            ? (live ? 'Esc interrupt' : '/stop task') + '    Ctrl+O activity'
            : this.width < 40
              ? '/help   @ files'
              : '/ commands    @ files'
    const secondary = menu
      ? options.picker
        ? 'Esc back'
        : 'Tab complete    Esc close'
      : busy
        ? ''
        : this.width >= 72
          ? 'Ctrl+O details    Alt+Enter newline'
          : 'Alt+Enter newline'
    lines.push(
      this.margin +
        '  ' +
        this.ink(this.across(fit(actions, this.width - 4), secondary, this.width - 4), 'quiet')
    )
    return { lines, row, col: this.margin.length + 4 + caret.col }
  }
}
