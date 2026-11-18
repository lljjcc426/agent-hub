import { configureLanguage } from '../src/terminal/language.ts'
import { SessionDisplay } from '../src/terminal/session-display.ts'
import { describe, expect, it } from 'vitest'
import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'
import type { Snapshot } from '../src/terminal/client.ts'
import { draftLines, fit, TerminalLayout } from '../src/terminal/presentation.ts'

describe('interactive terminal layout', () => {
  it('positions the cursor in cells across CJK, joined emoji and combining marks', () => {
    const text = 'AB你👩‍💻e\u0301'
    expect(draftLines(text, 3, 5)).toEqual({
      lines: ['AB你', '👩‍💻e\u0301'],
      caret: { row: 1, col: 0 }
    })
    expect(draftLines(text, text.length, 5).caret).toEqual({ row: 1, col: 3 })
    expect(fit('你👩‍💻好', 5)).toBe('你👩‍💻…')
  })

  it('keeps pending drafts visible on narrow terminals and preserves the cursor in the middle', () => {
    const layout = new TerminalLayout(32, false),
      text = '长草稿'.repeat(15)
    const frame = layout.composer(undefined, text, 17, false, 12)
    expect(frame.lines.every((line) => stringWidth(line) < 32)).toBe(true)
    expect(frame.lines[frame.row]).toContain('草')
    expect(frame.col).toBeLessThan(32)
    expect(frame.lines.join('\n')).not.toContain('Message Roppo')
    expect(frame.lines.join('\n')).toContain('/help')
    expect(frame.lines.join('\n')).not.toContain('\x1b')
  })

  it('wraps Markdown and code safely in the terminal width', () => {
    const layout = new TerminalLayout(32, true),
      bad = '\x1b[2J'
    const result = layout.message(
      'Roppo',
      bad + '**结论**：可以恢复。\n\n```sh\n' + '超长'.repeat(22) + '\n```',
      false
    )
    expect(result.every((line) => stringWidth(line) < 32)).toBe(true)
    expect(result.join('\n')).not.toContain(bad)
    expect(stripVTControlCharacters(result.join('\n'))).toContain('结论')
    expect(result.join('\n')).not.toContain('**')
  })
  it('anchors the prompt to the same bottom row with suggestions above it', () => {
    const view = {
      conversation: { project: '/tmp/示例' },
      readiness: { workers: [], routerLabel: 'Router' },
      tasks: [],
      calls: [],
      messages: [],
      approvals: []
    } as unknown as Snapshot
    const menu = {
      title: 'Commands',
      start: 0,
      end: 1,
      selected: 0,
      items: [{ label: '/tasks', detail: 'Inspect Worker tasks', value: '/tasks' }]
    }
    for (const [columns, rows] of [
      [24, 14],
      [43, 21],
      [80, 24],
      [132, 30],
      [246, 72]
    ] as const) {
      const layout = new TerminalLayout(columns, true)
      const empty = layout.composer(view, '', 0, false, rows, {})
      const open = layout.composer(view, '/', 1, false, rows, { menu })
      expect(open.lines.length - open.row).toBe(empty.lines.length - empty.row)
      expect(open.col).toBe(empty.col + 1)
      expect(open.lines.length).toBeLessThanOrEqual(rows)
      expect(open.lines.findIndex((line) => line.includes('Commands'))).toBeLessThan(open.row)
      for (const line of [...open.lines, ...layout.header(view)])
        expect(stringWidth(line)).toBeLessThan(columns)
      const borders = open.lines.filter(
        (line) => line.includes('╭') || line.includes('╰') || line.includes('│')
      )
      expect(borders).toHaveLength(3)
      expect(new Set(borders.map((line) => stringWidth(line))).size).toBe(1)
    }
  })
})

it('positions the first message near the left edge and keeps the input at the bottom editing row', () => {
  let output = ''
  const out = {
    columns: 246,
    rows: 72,
    write: (value: string) => {
      output += value
    }
  } as NodeJS.WriteStream
  const display = new SessionDisplay(out, { line: '', cursor: 0 }, false)
  const snapshot = {
    conversation: {},
    readiness: { workers: [] },
    workers: [],
    calls: [],
    approvals: [],
    tasks: [],
    messages: [{ id: 'm', createdAt: 1, role: 'user', text: '你好' }],
    run: { id: 'r', state: 'queued', createdAt: 1 }
  } as unknown as Snapshot
  display.update(snapshot)
  const plain = stripVTControlCharacters(output)
  expect(plain).toContain('   ❯ 你好')
  expect(plain).toContain('Waiting for Router')
  expect(output).toContain('\x1b[70;1H')
  expect(output.endsWith('\x1b[70;8H')).toBe(true)
})

it('uses the active actor, public status and tool trace, ignoring finished and unrelated calls', () => {
  configureLanguage('zh')
  try {
    const layout = new TerminalLayout(246, false)
    const view = {
      run: { id: 'r', state: 'running' },
      workers: [{ id: 'w', label: '审阅员' }],
      tasks: [],
      calls: [
        {
          id: 'router',
          kind: 'router',
          runId: 'r',
          state: 'running',
          name: 'router',
          status: { label: '正在核对需求', updatedAt: 10 }
        },
        { id: 'other', kind: 'tool', runId: 'unrelated', state: 'running', name: 'stale' },
        { id: 'finished', kind: 'tool', runId: 'r', state: 'completed', name: 'done' }
      ]
    } as unknown as Snapshot
    expect(layout.workStatus(view)).toBe('Router · 正在核对需求')
    view.calls.push({
      id: 't',
      state: 'running',
      kind: 'tool',
      name: 'superagent_read',
      workerId: 'w',
      runId: 'r',
      trace: { kind: 'read', label: 'notes.md' },
      startedAt: 1,
      conversationId: 'chat'
    })
    expect(layout.workStatus(view)).toBe('Worker 审阅员 · 正在读文件 · notes.md')
  } finally {
    configureLanguage('en')
  }
})
