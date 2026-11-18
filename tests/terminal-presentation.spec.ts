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
  it('keeps the home prompt in place when suggestions open and fits its cursor and borders', () => {
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
      [132, 30]
    ] as const) {
      const layout = new TerminalLayout(columns, true)
      const empty = layout.composer(view, '', 0, false, rows, { home: true })
      const open = layout.composer(view, '/', 1, false, rows, { home: true, menu })
      expect(open.row).toBe(empty.row)
      expect(open.col).toBe(empty.col + 1)
      expect(open.lines.length).toBeLessThanOrEqual(rows)
      expect(open.lines.findIndex((line) => line.includes('Commands'))).toBeGreaterThan(open.row)
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
