import { basename } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import type { Menu } from './editor.ts'
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  .version as string
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

// The same Roppo silhouette as the workspace logo, sampled on a terminal braille grid.
const mark = ['⢰⣿⣿⣿⣿⣆', '⢀⣤⡤⢀⣹⡿', '⢸⣿⡇⢿⣿⡅', '⠈⠛⠁ ⠛⠛']
type Tone = 'title' | 'quiet' | 'accent' | 'success' | 'attention' | 'error' | 'rule' | 'selected'
const codes: Record<Tone, string> = {
  title: '1',
  quiet: '90',
  accent: '36',
  success: '32',
  attention: '33',
  error: '31',
  rule: '2',
  selected: '7'
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
    const pad = columns < 50 ? 1 : 3
    this.margin = ' '.repeat(pad)
    this.width = Math.max(8, Math.min(120, columns - pad * 2 - 1))
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
    const path = oneLine(c.project ?? 'Workspace')
    const project = path.startsWith(homedir() + '/') ? '~' + path.slice(homedir().length) : path
    const roster = readiness.workers.filter((w) => !['paused', 'retiring'].includes(w.state))
    const workers = roster.length
    const model = oneLine(c.model || c.backend || readiness.model || readiness.backend || '')
    const team = [model, workers + (workers === 1 ? ' worker' : ' workers')]
      .filter(Boolean)
      .join('  ·  ')
    const title = this.ink('Roppo CLI', 'accent')
    if (this.width < 38)
      return [
        '',
        this.margin + title + this.ink('  v' + version, 'quiet'),
        this.margin + fit(basename(project), this.width),
        this.margin + this.ink(fit(team, this.width), 'quiet')
      ]
    const router = [oneLine(readiness.routerLabel || 'Router'), model].filter(Boolean).join(' · ')
    const people = roster.map((w) => oneLine(w.label || w.id)).join(', ') || '0'
    const pathHint = project.startsWith('~/') && project !== '~/' + basename(project) ? project : ''
    const box = Math.min(
        this.width,
        72,
        Math.max(
          44,
          13 +
            Math.max(
              stringWidth(basename(project)),
              stringWidth(router) + 9,
              stringWidth(people) + 9,
              stringWidth(pathHint)
            )
        )
      ),
      inside = box - 4,
      space = inside - 9
    const rule = (s: string) => this.ink(s, 'rule')
    const end = 'v' + version
    const top =
      rule('╭─ ') +
      title +
      rule(' ' + '─'.repeat(box - 17 - end.length) + ' ') +
      this.ink(end, 'quiet') +
      rule(' ─╮')
    const labels = [
      this.ink(fit(basename(project), space), 'title'),
      this.ink('Router   ', 'quiet') + fit(router, space - 9),
      this.ink('Workers  ', 'quiet') + fit(people, space - 9)
    ]
    if (pathHint) labels.push(this.ink(fit(pathHint, space), 'quiet'))
    return [
      '',
      this.margin + top,
      ...mark.map((row, i) => {
        const content = this.ink(row.padEnd(6), 'accent') + '   ' + (labels[i] ?? '')
        return (
          this.margin +
          rule('│ ') +
          content +
          ' '.repeat(Math.max(0, inside - stringWidth(content))) +
          rule(' │')
        )
      }),
      this.margin + rule('╰' + '─'.repeat(box - 2) + '╯')
    ]
  }
  menuLines(menu: Menu, limit: number) {
    const count = menu.items.length
    const height = Math.max(1, Math.min(6, limit))
    const start = Math.max(0, Math.min(menu.selected - Math.floor(height / 2), count - height))
    const position = count ? '  ' + (menu.selected + 1) + '/' + count : ''
    const title = this.margin + this.ink(fit(oneLine(menu.title) + position, this.width), 'quiet')
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
        const marker = selected ? '› ' : '  '
        const row = marker + label + detail
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
    options: { menu?: Menu; expanded?: boolean; now?: number; picker?: boolean } = {}
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
    if (menu) lines.push('', ...this.menuLines(menu, maxRows - lines.length - 7))
    if (maxRows >= 10 || !menu) lines.push('')
    const rule = this.margin + this.ink('─'.repeat(this.width), 'rule')
    lines.push(rule)
    if (this.draft?.text !== text || this.draft.cursor !== cursor) {
      this.draft = { text, cursor, value: draftLines(text, cursor, Math.max(4, this.width - 3)) }
    }
    const { lines: draft, caret } = this.draft.value
    const limit = Math.max(1, Math.min(7, Math.floor(maxRows / 3), maxRows - lines.length - 3))
    const start = Math.max(0, caret.row - limit + 1)
    const row = lines.length + caret.row - start
    for (const [i, line] of draft.slice(start, start + limit).entries()) {
      const marker = i + start === 0 ? (options.picker ? '⌕ ' : continuation ? '… ' : '❯ ') : '  '
      const hint = options.picker ? 'Search conversations…' : 'Message Roppo…'
      lines.push(
        this.margin +
          this.ink(marker, 'accent') +
          (line || (!text && !continuation ? this.ink(fit(hint, this.width - 3), 'quiet') : ''))
      )
    }
    lines.push(rule)
    const pending = view?.messages.some(
      (m) => m.decision && !m.recipient && !m.decision.closed && !m.decision.replyRunId
    )
    const needsApproval = view?.approvals.some((a) => a.state === 'pending' && a.expiresAt > now)
    const keys = menu
      ? options.picker
        ? '↑↓ select    Enter resume    Esc back'
        : '↑↓ select    Tab complete    Enter choose    Esc close'
      : pending
        ? '/choose answer question    / commands'
        : needsApproval
          ? '/approvals review request    / commands'
          : busy
            ? (live ? 'Esc interrupt' : '/stop task') + '    Ctrl+O activity    / commands'
            : this.width < 40
              ? '/help   @ files'
              : '/ commands    @ files    Alt+Enter newline'
    lines.push(this.margin + this.ink(fit(keys, this.width), 'quiet'))
    return { lines, row, col: this.margin.length + 2 + caret.col }
  }
}
