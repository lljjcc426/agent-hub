const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { collect } = require('./activity.cjs')
const { startMonitor } = require('./monitor.cjs')

const chatId = '983b91dc-2b90-4469-a384-b0bbd23c5a79'
const chatPath = '/chat#conversation/' + chatId
const missing = () => Object.assign(Error('unavailable'), {status: 404})

function fixture() {
  const f = {
    chat: {id: chatId, createdAt: 100, updatedAt: 100}, runs: {a: 'running'},
    view: {messages: [{sequence: 1, runId:'a'}], pendingCards: [], approvals: [], tasks: [], run: {id:'a', state:'running'}},
    tasks: [], attention: [], user: 'user-a', calls: []
  }
  f.get = async (route) => {
    f.calls.push(route)
    const url = new URL(route, 'http://localhost')
    if (url.pathname === '/session') return {operator: !!f.user, account: {user: {id: f.user}}}
    if (url.pathname === '/api/chat/conversations') return {conversations: f.chat ? [f.chat] : []}
    if (url.pathname === '/api/chat/conversations/' + chatId) {
      const id = url.searchParams.get('run')
      if (id && !f.runs[id]) throw missing()
      if (id) return {run: {id, state: f.runs[id]}}
      const before = Number(url.searchParams.get('before')) || Infinity
      const messages = f.view.messages.filter(m => m.sequence < before)
      return {...f.view, messages: messages.slice(-100), hasMore: messages.length > 100}
    }
    let key, rows
    if (url.pathname === '/entry-workspace') { key = 'tasks'; rows = f.tasks }
    if (url.pathname === '/entry-workspace/attention') { key = 'items'; rows = f.attention }
    if (!rows) throw missing()
    const offset = Number(url.searchParams.get('offset'))
    return { [key]: rows.slice(offset, offset + 100), offset, more: offset + 100 < rows.length }
  }
  return f
}

test('baseline, scoped completion, overlapping turns and restart deduplication', async () => {
  const f = fixture()
  const first = await collect(f.get, null, 101)
  assert.deepEqual(first.notices, [])
  f.runs = {a:'failed', b:'completed'}
  f.view.run = {id:'b', state:'running'}
  f.view.messages.push({sequence:2,runId:'b'})
  const second = await collect(f.get, first.snapshot, 102)
  assert.deepEqual(second.notices.map(n => n.kind).sort(), ['done','failed'])
  assert.ok(second.notices.every(n => n.path === chatPath))
  assert.deepEqual((await collect(f.get, JSON.parse(JSON.stringify(second.snapshot)), 100000)).notices, [])
})

test('required questions, decisions, permission, file review, Worker and uncertain execution', async () => {
  const f = fixture()
  const first = await collect(f.get, null, 101)
  f.runs.a = 'waiting'
  f.view.pendingCards = [
    {kind:'choice', id:'optional', decision:{defaultOption:'carry on'}},
    {kind:'choice', id:'choose', decision:{}},
    {kind:'approval', id:'nativeQuestion', request:{method:'item/tool/requestUserInput'}},
    {kind:'approval', id:'allow', request:{method:'roppo/tool'}},
    {kind:'file', id:'doc'}, {kind:'question', id:'renew', question:{version:2, status:'expired'}}
  ]
  f.view.tasks = [{id:'w',state:'waiting',question:'Question'}, {id:'other',state:'completed'}]
  f.view.approvals = [{id:'operation',executionState:'uncertain'}, {id:'broken',executionState:'failed'}]
  const second = await collect(f.get, first.snapshot, 102)
  assert.deepEqual(second.notices.map(n => n.kind).sort(), ['approval','choice','failed','file','question','revalidate','uncertain','workerDone'])
  f.view.pendingCards = []
  f.runs.a = 'cancelled'
  f.view.tasks = [{id:'w',state:'cancelled'}]
  assert.deepEqual((await collect(f.get, second.snapshot, 103)).notices, [{kind:'stopped',path:chatPath}])
})

test('optional choices stay quiet and resolving a prompt does not repeat the generic wait', async () => {
  const f = fixture()
  f.view.pendingCards = [{kind:'choice', id:'optional', decision:{defaultOption:'continue'}}]
  const first = await collect(f.get, null, 101)
  assert.equal(Object.values(first.snapshot.chats[chatId].states).length, 0)
  f.view.pendingCards = [{kind:'question', id:'q', question:{status:'pending',version:1}}]
  f.runs.a = 'waiting'
  const second = await collect(f.get, first.snapshot, 102)
  assert.deepEqual(second.notices, [{kind:'question',path:chatPath}])
  f.view.pendingCards = []
  assert.deepEqual((await collect(f.get, second.snapshot, 103)).notices, [])
})

test('unopened new conversations include fast runs on earlier transcript pages, ignoring removed runs', async () => {
  const f = fixture(), chat = f.chat
  f.chat = null
  const first = await collect(f.get, null, 90)
  f.chat = chat
  f.runs = {a:'completed',b:'failed'}
  f.view.messages = Array.from({length:109}, (_,i) => ({sequence:i+1,runId:i===0?'a':i===5?'removed':'b'}))
  f.view.run = {id:'b',state:'running'}
  const next = await collect(f.get, first.snapshot, 105)
  assert.deepEqual(next.notices.map(n=>n.kind).sort(), ['done','failed'])
  assert.ok(f.calls.some(c => c.includes('?before=')))
})

test('workspace pagination, reviews and deliveries; stale items and overlapping chat tickets stay quiet', async () => {
  const f = fixture()
  f.view.tasks = [{id:'inner',state:'running'}]
  const first = await collect(f.get, null, 101)
  f.tasks = Array.from({length:100}, (_,i) => ({id:'idle'+i,state:'queued'}))
  f.tasks.push({id:'ext',state:'replied'}, {id:'inner',state:'ready'}, {id:'prepared',state:'ready'}, {id:'finish',state:'closed'})
  f.attention = [
    {id:'1',kind:'project_review',state:'needs_review',taskRef:{id:'inner'}},
    {id:'2',kind:'workflow_review',state:'needs_review'},
    {id:'3',kind:'native_approval',state:'waiting_permission',taskRef:{id:'outside'}},
    {id:'4',kind:'native_question',state:'needs_reply',taskRef:{id:'inner'}},
    {id:'5',kind:'effect_unknown',state:'outcome_unknown'},
    {id:'6',kind:'task_question',state:'stale'},
  ]
  const next = await collect(f.get, first.snapshot, 102)
  const result = next.notices.map(n => n.kind + ' ' + n.path)
  assert.deepEqual(result.sort(), ['approval /configure#attention','done /configure#tasks/history','ended /configure#tasks/history',
    'ready /configure#tasks/history','review '+chatPath,'review /configure#attention','uncertain /configure#attention'].sort())
  assert.ok(f.calls.includes('/entry-workspace?limit=100&offset=100'))
})

test('chat notifications survive a workspace endpoint outage and recover without replay', async () => {
  const f = fixture()
  const first = await collect(f.get, null, 101)
  f.runs.a = 'completed'
  const outage = async route => {
    if (route.startsWith('/entry-workspace/attention')) throw Object.assign(Error('forbidden'),{status:403})
    return f.get(route)
  }
  const next = await collect(outage, first.snapshot, 102)
  assert.deepEqual(next.notices, [{kind:'done',path:chatPath}])
  assert.deepEqual((await collect(f.get, next.snapshot, 103)).notices, [])
})

test('background monitor persists notifications, respects opt-out and revalidates account on click and delivery', async t => {
  const f = fixture(), notices = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'roppo-notifications-'))
  let monitor
  t.after(() => { monitor?.stop(); fs.rmSync(dir,{recursive:true,force:true}) })
  const file = path.join(dir,'checkpoint.json')
  const start = (get = f.get) => startMonitor({file, get, notify:(notice, owner)=>notices.push({...notice,owner}), clear() {}})
  monitor = start()
  await monitor.poll()
  f.runs.a = 'completed'
  await monitor.poll()
  assert.deepEqual(notices, [{kind:'done',path:chatPath,owner:'user-a'}])
  assert.ok(await monitor.canOpen('user-a'))
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  monitor.stop()
  monitor = start()
  await monitor.poll()
  assert.equal(notices.length, 1)
  f.user = 'user-b'
  assert.equal(await monitor.canOpen('user-a'), false)
  await monitor.poll()
  monitor.setEnabled(false)
  monitor.stop()
  monitor = start()
  assert.equal(monitor.enabled, false)
  f.runs.a = 'failed'
  monitor.setEnabled(true)
  await monitor.poll()
  assert.equal(notices.length,1)
  monitor.stop()
  let checks = 0
  f.chat.updatedAt++
  f.runs.a = 'waiting'
  monitor = start(async route => {
    if (route === '/session' && ++checks === 2) f.user = null
    return f.get(route)
  })
  await monitor.poll()
  assert.equal(notices.length,1)
  assert.equal(JSON.parse(fs.readFileSync(file)).owner, null)
})
