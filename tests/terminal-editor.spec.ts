import { afterEach, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { TerminalEditor } from '../src/terminal/editor.ts'
import { projectFiles, suggestions } from '../src/terminal/suggestions.ts'
import { command, mentionedFiles } from '../src/terminal/commands.ts'
import type { Snapshot, TerminalClient } from '../src/terminal/client.ts'
import { draftLines, TerminalLayout } from '../src/terminal/presentation.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
})
function fixture() {
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    setRawMode(on: boolean) {
      this.isRaw = on
      return this
    }
  })
  const out = new PassThrough()
  const editor = new TerminalEditor(
    input as unknown as NodeJS.ReadStream,
    out as unknown as NodeJS.WriteStream,
    process.cwd()
  )
  cleanups.push(() => {
    editor.close()
    input.destroy()
    out.destroy()
  })
  return { editor, input, lines: editor[Symbol.asyncIterator]() }
}
it('keeps split bracketed paste, Unicode edits and multiline history as one submission', async () => {
  const { input, editor, lines } = fixture()
  input.write('\x1b[20')
  input.write('0~一\r\n👩‍💻')
  input.write('\x1b[201~')
  expect(editor.line).toBe('一\n👩‍💻')
  input.write('\x1b[D')
  input.write('好')
  input.write('\r')
  expect((await lines.next()).value).toBe('一\n好👩‍💻')
  input.write('\x1b[A')
  input.write('\x1b\r')
  input.write('末尾')
  expect(editor.line).toBe('一\n好👩‍💻\n末尾')
  expect(draftLines('一\n二', 2, 10)).toEqual({ lines: ['一', '二'], caret: { row: 1, col: 0 } })
  editor.close()
  expect(input.isRaw).toBe(false)
})
it('selects commands, preserves the draft on failure and restores failed submissions', async () => {
  const { editor, input, lines } = fixture()
  input.write('/di')
  expect(editor.menu!.items[0]!.label).toBe('/diff')
  input.write('\t')
  expect(editor.line).toBe('/diff ')
  expect(editor.menu?.title).toBe('Worker tasks')
  input.write('\x15/help\r')
  expect((await lines.next()).value).toBe('/help')
  input.write('/open\r')
  expect((await lines.next()).value).toBe('/open')
  editor.restoreDraft('我的问题')
  expect(editor.line).toBe('我的问题')
  editor.restoreDraft('older')
  expect(editor.line).toBe('我的问题')
})
it('completes quoted filenames and uses repository ignore rules', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roppo-files-'))
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
  execFileSync('git', ['-C', cwd, 'init', '-q'])
  const filename = 'one "quoted" file.md'
  writeFileSync(join(cwd, filename), 'ok')
  writeFileSync(join(cwd, '.gitignore'), 'ignored\n')
  writeFileSync(join(cwd, 'ignored'), 'ignore')
  const files = await projectFiles(cwd)
  expect(files).toContain(filename)
  expect(files).not.toContain('ignored')
  const menu = suggestions('Use @one', 8, [], files)!
  expect(mentionedFiles('Use ' + menu.items[0]!.value, cwd)).toEqual([join(cwd, filename)])
})
it('binds a selected Router answer to the original question and ignores closed questions', async () => {
  const m = {
    id: 'decision:original',
    decision: { question: 'Choose a format', options: [{ label: 'PDF' }, { label: 'Markdown' }] }
  }
  const view = {
    messages: [m, { ...m, id: 'old', decision: { ...m.decision, closed: true } }],
    approvals: []
  } as unknown as Snapshot
  const choice = suggestions('/choose ', 8, [], [], view)!
  expect(choice.items).toHaveLength(2)
  const sent: unknown[] = []
  const client = {
    view: async () => view,
    request: async (...args: unknown[]) => sent.push(args)
  } as unknown as TerminalClient
  await command(client, 'chat', choice.items[1]!.value)
  expect(sent).toEqual([
    [
      '/api/chat/conversations/chat/decisions',
      expect.objectContaining({ messageId: m.id, answer: 'Markdown' })
    ]
  ])
  await expect(command(client, 'chat', '/choose old 1')).rejects.toThrow('no longer available')
})
it('keeps the responsive identity panel and picker within the terminal width', async () => {
  const { default: width } = await import('string-width')
  const view = {
    conversation: { project: '/tmp/示例' },
    readiness: { workers: [] }
  } as unknown as Snapshot
  for (const columns of [24, 38, 42, 80, 132]) {
    const layout = new TerminalLayout(columns, true)
    const header = layout.header(view)
    expect(header.every((line) => width(line) < columns)).toBe(true)
    const borders = header.filter(
      (line) => line.includes('╭') || line.includes('│') || line.includes('╰')
    )
    expect(new Set(borders.map((line) => width(line))).size).toBeLessThanOrEqual(1)
  }
})

it('orders capabilities by source and inspects the selected item by stable ID', async () => {
  const library = {
    items: [
      { id: 'codex/toolkit', name: 'Toolkit', kind: 'mcp', source: 'Codex', status: 'cli' },
      {
        id: 'host/toolkit',
        name: 'Toolkit',
        kind: 'tool',
        source: 'Roppo',
        status: 'builtin',
        description: 'Workspace tools'
      }
    ],
    warnings: [],
    refreshing: false
  } as const
  const snapshot = { ...library, items: [...library.items], warnings: [] }
  const menu = suggestions('/tools toolkit', 14, [], undefined, undefined, snapshot)!
  expect(menu.items.map((c) => c.detail)).toEqual(['Roppo · tool', 'Codex · mcp'])
  const client = { request: async () => snapshot } as unknown as TerminalClient
  expect(await command(client, 'chat', menu.items[0]!.value)).toContain('Workspace tools')
})
