// Run with the bundled Bun: npm run test:tui. The host suite remains on Node 22+.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createTestRenderer } from '@opentui/core/testing'
import { TuiScreen } from '../src/terminal/tui-screen.ts'
import type { Snapshot } from '../src/terminal/client.ts'
import { configureLanguage } from '../src/terminal/language.ts'

configureLanguage('en')
const test = await createTestRenderer({ width: 120, height: 34, kittyKeyboard: true })
const sent: string[] = [], commands: string[] = []
let chosen = '', interrupted = 0
const screen = new TuiScreen(test.renderer, { theme: 'dark', motion: 'reduced' }, {
  send: async text => { sent.push(text) }, command: async text => { commands.push(text) },
  complete: async () => [], interrupt: async () => { interrupted++ }, older: async () => {}, review: async () => {}, quit: () => {}
})
const view = { conversation: {id:'personal',sequence:0}, workers:[], calls:[], browsers:[], messages: [], approvals: [], tasks: [], schedules: [], deliveries: [], run: null } as unknown as Snapshot
const capture = async (name: string) => {
  await test.renderOnce()
  if (process.env.ROPPO_TUI_CAPTURES) {
    mkdirSync(process.env.ROPPO_TUI_CAPTURES, { recursive: true })
    writeFileSync(process.env.ROPPO_TUI_CAPTURES + '/' + name + '.txt', test.captureCharFrame())
    writeFileSync(process.env.ROPPO_TUI_CAPTURES + '/' + name + '.json', JSON.stringify(test.captureSpans()))
  }
  return test.captureCharFrame()
}
try {
  screen.update(view)
  const home = await capture('home')
  assert.match(home, /Ask Roppo anything/)
  assert.equal(screen.transcript.scrollHeight, 0)
  assert.match(home, /Ready when you are/)
  const composerY=screen.draft.y
  screen.preferences({theme:'dark',motion:'reduced',animation:false})
  const hidden=await capture('companion-off')
  assert.doesNotMatch(hidden,/Ready when you are/)
  assert.equal(screen.transcript.scrollHeight,0)
  screen.preferences({theme:'dark',motion:'reduced',animation:true})
  await test.renderOnce()
  assert.equal(screen.draft.y,composerY)

  test.mockInput.pressKey('\x1b[5~'); await test.renderOnce()
  assert.equal(test.captureCharFrame(), home, 'empty page must not scroll')

  await test.mockInput.pasteBracketedText('中文草稿 👩‍💻\n/permissions full')
  assert.equal(sent.length, 0, 'pasted commands are draft text')
  const draft = screen.draft.plainText
  test.mockInput.pressKey('ARROW_LEFT')
  const cursor = screen.draft.cursorOffset
  screen.update(view)
  assert.equal(screen.draft.cursorOffset, cursor, 'host events preserve the editing cursor')
  screen.menu({ title: 'Models', items: [{ label: 'First', run: () => { chosen = 'first' } }, { label: 'Second', run: () => { chosen = 'second' } }] })
  await capture('menu')
  test.mockInput.pressKey('ARROW_DOWN'); test.mockInput.pressEnter(); await test.renderOnce()
  assert.equal(chosen, 'second')
  assert.equal(screen.draft.plainText, draft, 'closing a picker preserves draft')
  screen.menu({ title: 'Commands', items: [{ label: 'Models', run: () => { chosen = 'models' } }, { label: 'Memory', run: () => { chosen = 'memory' } }] })
  test.mockInput.pressKey('memory\r'); await test.renderOnce()
  assert.equal(chosen, 'memory', 'fast search and Enter select the filtered command')
  test.mockInput.pressEnter(); await test.renderOnce()
  assert.equal(sent[0], draft)

  let secretValue = '', canceled = 0
  screen.prompt('API key', '', async value => { secretValue = value }, false, true, { allowEmpty: true, cancel: () => { canceled++ } })
  await test.mockInput.pasteBracketedText('sk-private-test')
  await test.mockInput.typeText('x')
  test.mockInput.pressKey('BACKSPACE')
  const secretFrame = await capture('secret-input')
  assert.doesNotMatch(secretFrame, /sk-private-test/)
  assert.ok(secretFrame.includes('•'))
  test.mockInput.pressEnter(); await test.renderOnce()
  assert.equal(secretValue, 'sk-private-test')
  assert.equal(canceled, 0)
  screen.prompt('Cancel setup', '', async () => {}, false, false, { cancel: () => { canceled++ } })
  test.mockInput.pressKey('ESCAPE'); await test.renderOnce()
  assert.equal(canceled, 1)

  screen.setDraft('中文')
  test.mockInput.pressEnter({ shift: true }); await test.mockInput.typeText('第二行')
  assert.equal(screen.draft.plainText, '中文\n第二行')
  screen.setDraft('')
  test.mockInput.pressKey('p', { ctrl: true }); assert.equal(commands.at(-1), '/commands')

  const messages = Array.from({ length: 30 }, (_, i) => ({ id: 'm' + i, sequence: i + 1, role: i % 2 ? 'assistant' : 'user', text: 'Message ' + i + '\n中文内容，保持连续对话。', status: 'complete', createdAt: i }))
  const chat = { ...view, messages, hasMore: false } as unknown as Snapshot
  screen.update(chat); const conversation = await capture('conversation')
  assert.doesNotMatch(conversation, /[┌┐└┘]/, 'replies have no enclosing border')
  assert.ok(screen.transcript.scrollTop > 0)
  screen.transcript.scrollBy(-8); await test.renderOnce()
  const position = screen.transcript.scrollTop
  screen.update({ ...chat, messages: [...chat.messages, { ...chat.messages[1]!, id: 'new', sequence: 31, text: 'New reply' }] })
  await test.renderOnce()
  assert.equal(screen.transcript.scrollTop, position, 'new reply must not steal reading position')
  screen.latest(); await test.renderOnce(); assert.match(test.captureCharFrame(), /New reply/)

  screen.document('Permission needed', 'Read a file in Downloads', [
    { label: 'Allow once', run: () => { chosen = 'allow' } }, { label: 'Decline', run: () => { chosen = 'decline' } }
  ])
  await capture('approval'); test.mockInput.pressTab(); test.mockInput.pressEnter(); assert.equal(chosen, 'decline')
  test.resize(60, 20); await capture('narrow')
  assert.ok(screen.draft.y + screen.draft.height < 20, 'composer must stay in viewport')
  test.resize(60, 16); const short=await capture('short')
  assert.doesNotMatch(short,/Ready when you are/)
  assert.ok(screen.draft.y + screen.draft.height < 16, 'short terminals keep the composer visible')
  test.resize(120, 34); await test.renderOnce()
  test.mockInput.pressEscape(); assert.equal(interrupted, 1)
  console.log('TUI checks passed: empty viewport, Unicode paste, newline, menu draft, scroll follow, approval keys, resize and interrupt')
} finally {
  screen.close(); await test.dispose()
}
