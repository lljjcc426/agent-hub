// Run with the bundled Bun: npm run test:tui. The host suite remains on Node 22+.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { ScrollBoxRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { TuiScreen, type TuiItem } from '../src/terminal/tui-screen.ts'
import type { Snapshot } from '../src/terminal/client.ts'
import { configureLanguage } from '../src/terminal/language.ts'

configureLanguage('en')
const test = await createTestRenderer({ width: 120, height: 34, kittyKeyboard: true, useMouse: true })
const sent: string[] = [], commands: string[] = []
let chosen = '', interrupted = 0
let completions: TuiItem[] = []
const screen = new TuiScreen(test.renderer, { theme: 'dark', motion: 'reduced' }, {
  send: async text => { sent.push(text) }, command: async text => { commands.push(text) },
  complete: async text => text.startsWith('/') ? completions : [], interrupt: async () => { interrupted++ }, older: async () => {}, review: async () => {}, quit: () => {}
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

  const namedItems = ['zulu', ...Array.from({length: 30}, (_, i) => 'item' + (30 - i)), 'Beta', 'Alpha10', 'alpha2']
    .map(label => ({label, detail: 'Details for ' + label, run: () => {chosen = label}}))
  const pointAt = (text: string) => {
    const lines = test.captureCharFrame().split('\n'), y = lines.findIndex(line => line.includes(text))
    assert.ok(y >= 0, 'visible row: ' + text)
    return {x: lines[y]!.indexOf(text), y}
  }
  screen.menu({title: 'Sorted resources', items: namedItems})
  const sorted = await capture('sorted-menu')
  assert.ok(sorted.indexOf('alpha2') < sorted.indexOf('Alpha10') && sorted.indexOf('Alpha10') < sorted.indexOf('Beta'))
  assert.doesNotMatch(sorted, /zulu/)
  const point = pointAt('alpha2')
  for (let i = 0; i < 80; i++) await test.mockMouse.scroll(point.x, point.y, 'down')
  const scrolled = await capture('mouse-scrolled-menu')
  assert.match(scrolled, /zulu/)
  assert.doesNotMatch(scrolled, /alpha2/)
  screen.update(view); await test.renderOnce()
  assert.match(test.captureCharFrame(), /zulu/, 'host refresh preserves mouse scroll position')
  for (let i = 0; i < 80; i++) await test.mockMouse.scroll(point.x, point.y, 'up')
  await test.renderOnce()
  assert.match(test.captureCharFrame(), /alpha2/, 'wheel scrolls back to the start')
  const list = test.renderer.root.findDescendantById('menu-items') as ScrollBoxRenderable
  const bar = list.verticalScrollBar
  await test.mockMouse.drag(bar.x, bar.y, bar.x, bar.y + bar.height - 1)
  await test.renderOnce()
  assert.match(test.captureCharFrame(), /zulu/, 'scrollbar supports dragging to the bottom')
  const bottom = pointAt('zulu')
  await test.mockMouse.click(bottom.x, bottom.y); await test.renderOnce()
  assert.equal(chosen, 'zulu', 'click selects the scrolled row, not the keyboard selection')
  assert.equal(screen.draft.plainText, draft)

  screen.menu({title: 'Sorted resources', items: namedItems})
  await test.renderOnce()
  for (let i = 0; i < 80; i++) await test.mockMouse.scroll(point.x, point.y, 'down')
  const searchList = test.renderer.root.findDescendantById('menu-items') as ScrollBoxRenderable
  await test.mockMouse.click(searchList.verticalScrollBar.x, searchList.verticalScrollBar.y + searchList.verticalScrollBar.height - 1)
  await test.mockInput.typeText('alpha')
  await test.renderOnce()
  assert.match(test.captureCharFrame(), /alpha2[\s\S]*Alpha10/)
  assert.doesNotMatch(test.captureCharFrame(), /zulu/)
  test.mockInput.pressKey('ARROW_DOWN'); test.mockInput.pressEnter(); await test.renderOnce()
  assert.equal(chosen, 'Alpha10', 'keyboard search still selects the correct sorted item after scrolling')

  completions = namedItems.map(item => ({...item, label: '/' + item.label}))
  screen.setDraft('/')
  await new Promise(resolve => setTimeout(resolve, 100)); await test.renderOnce()
  const slash = pointAt('/alpha2')
  for (let i = 0; i < 80; i++) await test.mockMouse.scroll(slash.x, slash.y, 'down')
  await capture('mouse-scrolled-completions')
  const last = pointAt('/zulu')
  await test.mockMouse.click(last.x, last.y); await test.renderOnce()
  assert.equal(chosen, 'zulu', 'slash suggestions support wheel scrolling and clicking')
  completions = []; screen.setDraft(draft)
  screen.menu({title: 'Small terminal', items: namedItems})
  test.resize(60, 16); await test.renderOnce()
  const small = test.renderer.root.findDescendantById('menu-items') as ScrollBoxRenderable
  assert.ok(small.height > 0 && small.y + small.height < 16)
  await test.mockMouse.drag(small.verticalScrollBar.x, small.verticalScrollBar.y,
    small.verticalScrollBar.x, small.verticalScrollBar.y + small.verticalScrollBar.height)
  await test.renderOnce()
  assert.match(test.captureCharFrame(), /zulu/, 'small terminal can reach the last item')
  screen.closeModal(); test.resize(120, 34); await test.renderOnce()


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
  console.log('TUI checks passed: empty viewport, Unicode paste, newline, menu draft, sorted menus, mouse scrolling/clicks, scroll follow, approval keys, resize and interrupt')
} finally {
  screen.close(); await test.dispose()
}
