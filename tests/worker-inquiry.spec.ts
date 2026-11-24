import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { configSchema } from '../src/config.ts'
import type { Model, ModelRequest } from '../src/model.ts'
import { Runtime } from '../src/runtime.ts'
import { serve } from '../src/server.ts'
import { observe, type WorkerAttempt, type WorkerEventReceipt } from '../src/async-worker-inbox.ts'

const roots: string[] = []
const hosts = new Set<Runtime>()
const releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const host of hosts) await host.close()
  hosts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  return { release, promise }
}

const waiting = { state: 'waiting', summary: 'Independent verification is pending.', reply: '', question: null, askedBy: null, handbacks: [] }
const replay = process.env.ROPPO_POC_REPORT
  ? JSON.parse(readFileSync(process.env.ROPPO_POC_REPORT, 'utf8')) as typeof waiting
  : { ...waiting, reply: 'The Mac check is complete. The independent review is still pending.' }
const firstQuestion = 'Ask the original worker which platform checks are complete.'
const secondQuestion = 'Ask the same worker which artifact is available.'
const initial = 'Assign the platform checks to the release worker.'
const secondAnswer = 'The offline bundle is available in the release directory.'

interface Scenario {
  expectReply: boolean
  observeInput?: (request: ModelRequest, data: any) => void | Promise<void>
  recover?: (request: ModelRequest, data: {question: string; report: {summary: string}}) => string | Promise<string>
  owner?: string
  managed?: boolean
  retrySend?: boolean
  beforeSend?: (text: string) => Promise<void>
  worker?: (request: ModelRequest, input: WorkerInput[], call: number) => Promise<object>
  routerAnswer?: (messages: { id: string; text: string }[]) => Promise<string>
}
interface WorkerInput { text?: string; inquiryId?: string; event?: { text: string } }

async function until(host: Runtime, done: () => boolean) {
  for (let n = 0; n < 400; n++) {
    if (done()) return
    await host.tick()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  const errors = host.store.list<{error?: string}>('router-error').map(x => x.error)
  throw Error('Host did not reach the expected state. Router errors: ' + JSON.stringify(errors))
}

async function fixture(scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), 'roppo-inquiry-'))
  roots.push(root)
  const config = configSchema.parse({
    stateDir: join(root, 'state'), port: 0, work: { sandboxDriver: 'disabled', autoRecover: false },
    execution: { router: { mode: 'host' }, management: { enabled: true }, workers: [{ id: 'release', backend: 'codex' }] },
    sources: [{ id: 'local', kind: 'local', cwd: root, allowedActors: ['operator'] }],
  })
  let host: Runtime
  let ticketId = ''
  const workerTurns: { id: string; text: string; inputs: WorkerInput[]; threadId: string }[] = []
  const readyForAnswer: string[][] = []
  const errors: string[] = []
  const model: Model = { async run(r) {
    const threadId = r.threadId ?? randomUUID(), turnId = randomUUID()
    r.onThread?.(threadId)
    r.onTurn?.(turnId)
    const data = JSON.parse(r.input)
    let response: object
    if (data.kind === 'inquiry_readback') {
      expect(r.role).toBe('worker')
      expect(r.threadId).toBeUndefined()
      expect(r.allowNativeTools).toBe(false)
      expect(r.onTool).toBeUndefined()
      response = {reply: await scenario.recover?.(r, data) ?? ''}
    } else if (r.role === 'worker') {
      const inputs: WorkerInput[] = data.inputs
      const call = workerTurns.length
      const turn = { id: turnId, text: '', inputs, threadId }
      workerTurns.push(turn)
      response = call === 0 ? waiting : (scenario.worker ? await scenario.worker(r, inputs, call) : replay)
      turn.text = JSON.stringify(response)
    } else if (data.kind === 'worker_result') {
      const messages = data.messages as { id: string; text: string }[]
      readyForAnswer.push(messages.map(m => m.id))
      response = { reply: scenario.routerAnswer ? await scenario.routerAnswer(messages) : messages.map(m => m.text).join('\n') }
    } else if (data.kind === 'user_message') {
      const text = data.trigger.text
      await scenario.observeInput?.(r,data)
      if (text !== initial) await scenario.beforeSend?.(text)
      const createGoal = text === initial && scenario.managed
      const command = text === initial
        ? { action: 'assign', id: 'release', text: 'Check platform readiness' }
        : { action: 'send', ticketId, text, ...(scenario.expectReply ? { expectReply: true } : {}) }
      const tool = createGoal ? 'router_goal' : 'worker_manage'
      const args = createGoal ? {
        action:'start', operationId:'release-goal', expectedRevision:0, title:initial, objective:initial,
        authorizationQuote:initial, criteria:[{id:'review',description:'The independent review confirms the build.'}],
        nodes:[{id:'platforms',title:'Check platforms',instruction:initial,workerId:'release',criterionIds:['review']}],
      } : { ...command, revision: 0, requestId: data.trigger.id }
      const ack = await r.onTool!(tool, args, turnId)
      if (!ack.success) {
        errors.push(JSON.stringify(ack.contentItems))
        throw Error(errors.at(-1))
      }
      if (scenario.retrySend && text !== initial) {
        const retry = await r.onTool!(tool, args, turnId + '-retry')
        expect(retry).toEqual(ack)
      }
      ticketId = host.store.tickets.list()[0]?.id ?? ''
      response = { reply: 'Message transferred.' }
    } else throw Error('Unexpected model input ' + data.kind)
    return { threadId, turnId, text: JSON.stringify(response) }
  }}
  host = new Runtime(config, { model })
  hosts.add(host)
  host.scopes.command({ action: 'scope.put', operationId: 'scope', expectedRevision: 0, scope: {
    id: 'team', tenantId: 'private', name: 'Team', managers: [JSON.stringify(['local', 'operator'])],
    workerIds: ['release'], backendIds: ['codex'], sourceIds: ['local'],
  } })
  const owner = scenario.owner ?? 'owner'
  const chat = host.chat.create(owner)
  const send = (text: string, quote?:string) => host.chat.send(chat.id, owner, { text, clientMessageId: randomUUID(), locale: 'en', ...(quote?{quote:{messageId:quote}}:{}) })
  const view = () => host.chat.view(chat.id, owner).messages
  const results = () => host.store.list<WorkerEventReceipt>('async-worker-event').filter(event => event.kind === 'result')
  const start = send(initial)
  await until(host, () => !!host.store.get('router-result', 'router:' + start.runId) && results().length === 1)
  ticketId = host.store.tickets.list()[0]!.id
  expect(host.scopes.ownership(ticketId)).toBeDefined()
  async function close() {
    if (hosts.delete(host)) await host.close()
  }
  async function reopen() {
    await close()
    host = new Runtime(config, { model })
    hosts.add(host)
  }
  return { get h() { return host }, config, chatId:chat.id, ticketId, workerTurns, readyForAnswer, send, view, results, errors, reopen, close }
}

it('reproduces the unchanged baseline: a waiting worker answers after the Router ends and the original Chat has no answer', async () => {
  const pause = gate()
  const f = await fixture({ expectReply: false, worker: async () => { await pause.promise; return replay } })
  const ask = f.send(firstQuestion)
  await until(f.h, () => !!f.h.store.get('router-result', 'router:' + ask.runId) && f.workerTurns.length === 2)
  pause.release()
  await until(f.h, () => f.results().length === 2)
  for (let i = 0; i < 3; i++) await f.h.tick()
  expect(f.h.store.get('run', f.ticketId)).toMatchObject({ result: replay.reply })
  expect(f.h.store.tickets.get(f.ticketId)!.assignments.at(-1)!.report!.state).toBe('waiting')
  expect(f.h.store.list('async-worker-message')).toHaveLength(0)
  expect(f.readyForAnswer).toHaveLength(0)
  expect(f.view().filter(m => m.runId === ask.runId && m.text === replay.reply)).toHaveLength(0)
})

it('delivers the same waiting report to its own Chat run after the asking Router finishes', async () => {
  const pause = gate()
  const f = await fixture({ expectReply: true, worker: async () => { await pause.promise; return replay } })
  const ask = f.send(firstQuestion)
  await until(f.h, () => !!f.h.store.get('router-result', 'router:' + ask.runId) && f.workerTurns.length === 2)
  expect(f.readyForAnswer).toHaveLength(0)
  pause.release()
  await until(f.h, () => f.view().some(m => m.runId === ask.runId && m.text === replay.reply))
  expect(f.readyForAnswer).toHaveLength(1)
  expect(f.view().filter(m => m.text === replay.reply)).toHaveLength(1)
  expect(f.h.store.tickets.get(f.ticketId)!.assignments.at(-1)!.report!.state).toBe('waiting')
  expect(f.h.store.tickets.list()).toHaveLength(1)
})

async function waitForStoredReply(f: Awaited<ReturnType<typeof fixture>>, pause: ReturnType<typeof gate>) {
  const ask = f.send(firstQuestion)
  await until(f.h, () => !!f.h.store.get('router-result', 'router:' + ask.runId) && f.workerTurns.length === 2)
  pause.release()
  // The Worker completes asynchronously. The next scheduler tick would consume the pending Router job.
  await vi.waitFor(() => expect(f.results()).toHaveLength(2), { interval: 5, timeout: 2000 })
  const pending = f.h.store.db.prepare("SELECT id,state FROM jobs WHERE kind='router' AND json_extract(payload,'$.messageId') IS NOT NULL").all()
  expect(pending).toMatchObject([{ state: 'pending' }])
  expect(f.view().some(m => m.text === replay.reply)).toBe(false)
  return { ask, jobId: String(pending[0]!.id) }
}

it('reopens the database before delivery and folds duplicate native results and job retries into one reply', async () => {
  const pause = gate()
  const f = await fixture({ expectReply: true, worker: async () => { await pause.promise; return replay } })
  const { ask, jobId } = await waitForStoredReply(f, pause)
  const event = f.results().find(e => e.kind === 'result' && f.h.store.list<{eventId:string}>('async-worker-message').some(m => m.eventId === e.id))!
  const attempt = f.h.store.get<WorkerAttempt>('async-worker-attempt', event.attemptId)!
  const raw = f.workerTurns[1]!
  const calls = vi.fn()
  function replayEvent() {
    expect(observe(f.h, attempt, { kind: 'result', payload: raw.text, nativeTurnId: raw.id }, calls).replayed).toBe(true)
  }
  await f.reopen()
  for (let n = 0; n < 3; n++) replayEvent()
  await until(f.h, () => f.view().some(m => m.runId === ask.runId && m.text === replay.reply))
  await f.reopen()
  replayEvent()
  const job = f.h.store.db.prepare('SELECT payload FROM jobs WHERE id=?').get(jobId)!
  f.h.store.enqueue(jobId, 'router', JSON.parse(String(job.payload)))
  for (let n = 0; n < 4; n++) await f.h.tick()
  expect(calls).not.toHaveBeenCalled()
  expect(f.workerTurns).toHaveLength(2)
  expect(f.readyForAnswer).toHaveLength(1)
  expect(f.view().filter(m => m.text === replay.reply).map(m => m.runId)).toEqual([ask.runId])
  expect(f.h.store.list('async-worker-message')).toHaveLength(1)
})

it('correlates two overlapping questions on one ticket even when their replies arrive in reverse order', async () => {
  const pause = gate()
  const f = await fixture({ expectReply: true, worker: async (_r, inputs, call) => {
    if (call === 1) { await pause.promise; return { ...waiting, reply: 'Superseded private draft' } }
    const inquiryReplies = inputs.flatMap(input => input.inquiryId ? [{
      inquiryId: input.inquiryId, text: input.event?.text === firstQuestion ? replay.reply : secondAnswer,
    }] : []).reverse()
    expect(inquiryReplies).toHaveLength(2)
    return { ...waiting, reply: 'Ambiguous general status', inquiryReplies }
  } })
  const first = f.send(firstQuestion)
  await until(f.h, () => !!f.h.store.get('router-result', 'router:' + first.runId) && f.workerTurns.length === 2)
  const second = f.send(secondQuestion)
  await until(f.h, () => !!f.h.store.get('router-result', 'router:' + second.runId))
  pause.release()
  await until(f.h, () => f.view().some(m => m.text === secondAnswer) && f.view().some(m => m.text === replay.reply))
  expect(f.view().filter(m => m.text === replay.reply).map(m => m.runId)).toEqual([first.runId])
  expect(f.view().filter(m => m.text === secondAnswer).map(m => m.runId)).toEqual([second.runId])
  expect(f.view().some(m => ['Superseded private draft', 'Ambiguous general status'].includes(m.text))).toBe(false)
  expect(f.h.store.tickets.list()).toHaveLength(1)
  expect(f.h.store.tickets.get(f.ticketId)!.assignments).toHaveLength(1)
  expect(f.readyForAnswer.map(ids => ids.length)).toEqual([1, 1])
  expect(f.results().filter(e => e.disposition === 'archived')).toHaveLength(1)
})

it('withdraws a stored inquiry answer if the task is stopped before the composing Router can run', async () => {
  const pause = gate()
  const f = await fixture({ expectReply: true, worker: async () => { await pause.promise; return replay } })
  const { jobId } = await waitForStoredReply(f, pause)
  await f.h.stop(f.ticketId)
  await until(f.h, () => ['done', 'failed'].includes(String(f.h.store.db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId)?.state)))
  expect(f.readyForAnswer).toHaveLength(0)
  expect(f.view().some(m => m.text === replay.reply)).toBe(false)
})

it('uses the authorized answer when the composing Router returns empty text', async () => {
  const f = await fixture({ expectReply: true, routerAnswer: async () => '' })
  const ask = f.send(firstQuestion)
  await until(f.h, () => f.view().some(m => m.runId === ask.runId && m.text === replay.reply))
  expect(f.readyForAnswer).toHaveLength(1)
  expect(f.h.store.tickets.get(f.ticketId)!.assignments.at(-1)!.report!.state).toBe('waiting')
})

it('recovers an unanswered inquiry when a second question changes the task after the first Worker committed but before Router delivery', async () => {
  const firstWorker = gate(), secondRouterEntered = gate(), sendSecond = gate()
  const f = await fixture({
    expectReply: true,
    beforeSend: async text => {
      if (text === secondQuestion) { secondRouterEntered.release(); await sendSecond.promise }
    },
    worker: async (r, inputs, call) => {
      if (call === 1) { await firstWorker.promise; return replay }
      const prior = JSON.parse(r.input).unansweredInquiries ?? []
      const inquiryReplies = [
        ...inputs.flatMap(i => i.inquiryId ? [{ inquiryId: i.inquiryId, text: secondAnswer }] : []),
        ...prior.map((q: {inquiryId: string}) => ({ inquiryId: q.inquiryId, text: replay.reply })),
      ]
      return { ...waiting, inquiryReplies }
    },
  })
  const first = f.send(firstQuestion)
  await until(f.h, () => !!f.h.store.get('router-result', 'router:' + first.runId) && f.workerTurns.length === 2)
  const second = f.send(secondQuestion)
  await f.h.tick()
  await secondRouterEntered.promise
  firstWorker.release()
  await vi.waitFor(() => expect(f.results()).toHaveLength(2))
  expect(f.readyForAnswer).toHaveLength(0)
  sendSecond.release()
  await until(f.h, () => f.view().some(m => m.text === secondAnswer))
  await until(f.h, () => f.view().some(m => m.text === replay.reply))
  expect(f.view().filter(m => m.text === replay.reply).map(m => m.runId)).toEqual([first.runId])
  expect(f.view().filter(m => m.text === secondAnswer).map(m => m.runId)).toEqual([second.runId])
  expect(f.h.store.tickets.list()).toHaveLength(1)
})

it('resumes after SIGKILL while the reply Router owns the job, without executing the Worker again', async () => {
  const pause = gate()
  const f = await fixture({ expectReply: true, worker: async () => { await pause.promise; return replay } })
  const { ask, jobId } = await waitForStoredReply(f, pause)
  await f.close()
  const child = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', [
    "import { readFileSync, writeSync } from 'node:fs'",
    "import { Runtime } from './src/runtime.ts'",
    "const host = new Runtime(JSON.parse(readFileSync(0,'utf8')), {model:{async run(r){",
    " if (r.role !== 'router' || JSON.parse(r.input).kind !== 'worker_result') throw Error('Unexpected activation')",
    " writeSync(1, 'claimed reply job'); process.kill(process.pid, 'SIGKILL'); await new Promise(()=>{})",
    "}}})",
    "for(let n=0;n<200;n++){ await host.tick(); await new Promise(resolve=>setTimeout(resolve,5)) }",
    "await host.close(); process.exit(2)",
  ].join('\n')], { input: JSON.stringify(f.config), encoding: 'utf8', timeout: 12000 })
  expect(child.stdout).toBe('claimed reply job')
  expect(child.signal).toBe('SIGKILL')
  const crashed = new DatabaseSync(join(f.config.stateDir, 'state.sqlite'), { readOnly: true })
  try {
    expect(crashed.prepare('SELECT state FROM jobs WHERE id=?').get(jobId)?.state).toBe('running')
    expect(crashed.prepare("SELECT COUNT(*) n FROM records WHERE kind='chat-message' AND id=?").get('reply:'+jobId)?.n).toBe(0)
  } finally { crashed.close() }
  await f.reopen()
  await until(f.h, () => f.view().some(m => m.runId === ask.runId && m.text === replay.reply))
  expect(f.workerTurns).toHaveLength(2)
  expect(f.view().filter(m => m.text === replay.reply)).toHaveLength(1)
  expect(f.h.store.db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId)?.state).toBe('done')
}, 20000)

it('does not expose the pending answer after permission to return this task to the Chat entry is revoked', async () => {
  const pause = gate()
  const f = await fixture({ expectReply: true, worker: async () => { await pause.promise; return replay } })
  const { jobId } = await waitForStoredReply(f, pause)
  const entryId = f.h.scopes.ownership(f.ticketId)!.originEntry
  const grant = f.h.store.list<{ticketId:string;entryId:string;revision:number}>('task-channel').find(c => c.ticketId === f.ticketId && c.entryId === entryId)!
  f.h.scopes.command({ action:'task.channel', operationId:'revoke-result', expectedRevision:grant.revision,
    ticketId:f.ticketId, entryId, context:true, request:true, result:false })
  await until(f.h, () => f.h.store.db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId)?.state === 'done')
  expect(f.readyForAnswer).toHaveLength(0)
  expect(f.view().some(m => m.text === replay.reply)).toBe(false)
})

it.each(['empty','misaddressed'])('recovers a %s answer from the saved Worker report without another user event or work execution', async mode => {
  let recoveries = 0
  const summary = 'Mac offline check completed at 09:13.'
  const f = await fixture({ expectReply:true, worker:async () => ({ ...waiting, summary, reply:mode === 'empty' ? '' : 'General update',
    inquiryReplies:mode === 'empty' ? [] : [{inquiryId:'belongs-to-another-ask',text:'Unrelated answer'}] }),
    recover:(_request, data) => {
      recoveries++
      expect(data.question).toBe(firstQuestion)
      expect(data.report.summary).toBe(summary)
      expect(JSON.stringify(data)).not.toMatch(/General update|Unrelated answer/)
      return 'The Mac offline check completed at 09:13.'
    } })
  const ask = f.send(firstQuestion)
  await until(f.h, () => f.view().some(m => m.runId === ask.runId && m.text === 'The Mac offline check completed at 09:13.'))
  expect(f.view().some(m => ['General update','Unrelated answer'].includes(m.text))).toBe(false)
  expect(f.h.store.list<{delivered?:boolean}>('worker-inquiry').map(q => !!q.delivered)).toEqual([true])
  expect(recoveries).toBe(1)
  expect(f.workerTurns).toHaveLength(2)
  expect(f.h.store.tickets.get(f.ticketId)?.assignments.at(-1)?.report?.state).toBe('waiting')
})

it('answers a question about a running goal node without passing its independent acceptance or minting a delivery', async () => {
  const f = await fixture({ expectReply:true, managed:true })
  const goal = f.h.goals.forTask(f.ticketId)!
  expect(goal.managed).toBe(true)
  const ask = f.send(firstQuestion)
  await until(f.h, () => f.view().some(m => m.runId === ask.runId && m.text === replay.reply))
  const after = f.h.goals.forTask(f.ticketId)!
  expect(after.id).toBe(goal.id)
  const node = after.nodes?.find(n => n.ticketId === f.ticketId)
  expect(node).toBeDefined()
  expect(node!.state).not.toBe('passed')
  expect(after.state).not.toBe('completed')
  expect(f.h.store.list('goal-delivery')).toHaveLength(0)
  expect(f.h.store.tickets.get(f.ticketId)!.assignments.at(-1)!.report!.state).toBe('waiting')
})

it('returns an already accepted final answer through the original ready delivery once', async () => {
  const f = await fixture({expectReply:true, worker:async () => ({...waiting, state:'ready', reply:'Platform checks complete.'})})
  const ask = f.send(firstQuestion)
  await until(f.h, () => f.view().some(m => m.runId === ask.runId && !m.recipient && m.text === 'Platform checks complete.'))
  expect(f.view().filter(m => !m.recipient && m.text === 'Platform checks complete.')).toHaveLength(1)
  expect(f.readyForAnswer).toHaveLength(1)
  expect(f.h.store.list<{delivered?:boolean}>('worker-inquiry')[0]?.delivered).toBe(true)
})

it('delivers a progress answer and preserves it when the composing Router is unavailable', async () => {
  const f = await fixture({expectReply:true, worker:async () => ({...waiting, state:'waiting', reply:'Mac offline check completed.'}),
    routerAnswer: async () => {throw Error('temporary model error')} })
  vi.spyOn(f.h.work,'active').mockImplementation((ticketId,assignmentId) => ticketId===f.ticketId
    ? [{id:'original-job',ticketId,assignmentId,cwd:f.config.stateDir,sandbox:'read-only',depth:0,kind:'shell',state:'running',createdAt:1,notify:'auto'}] : [])
  const ask = f.send(firstQuestion)
  await until(f.h, () => f.view().some(m => m.runId === ask.runId && m.text === 'Mac offline check completed.'))
  expect(f.workerTurns).toHaveLength(2)
  expect(f.h.store.tickets.get(f.ticketId)?.ended).toBeUndefined()
})

it('keeps the saved report available after its single read-only recovery budget is spent', async () => {
  let reads=0
  const f = await fixture({expectReply:true, worker:async () => ({...waiting, reply:'', inquiryReplies:[]}),
    recover: () => { reads++;throw Error('temporary model error') }})
  const ask = f.send(firstQuestion)
  await until(f.h, () => f.view().some(m => m.runId === ask.runId && m.text === 'Latest task update: '+waiting.summary))
  const q = f.h.store.list<{delivered?:boolean;readbackStarted?:boolean}>('worker-inquiry')[0]
  expect(q).toMatchObject({readbackStarted:true,delivered:true})
  expect(reads).toBe(1)
  expect(Number(f.h.store.db.prepare('PRAGMA user_version').get()!.user_version)).toBe(19)
})

it('deduplicates a retried send from the same user message along with its Worker input and visible answer', async () => {
  const f = await fixture({ expectReply:true, retrySend:true })
  const ask = f.send(firstQuestion)
  await until(f.h, () => f.view().some(m => m.runId === ask.runId && m.text === replay.reply))
  expect(f.h.store.list('worker-inquiry')).toHaveLength(1)
  expect(f.h.store.get('worker-inquiry-open',f.ticketId)).toMatchObject({ids:[]})
  expect(f.workerTurns).toHaveLength(2)
  expect(f.workerTurns[1]?.inputs.filter(i => i.inquiryId)).toHaveLength(1)
  expect(f.view().filter(m => m.text === replay.reply)).toHaveLength(1)
})

it('notifies an already-open HTTP Chat client through its existing event stream and returns the late answer on its original message', async () => {
  const pause = gate(), owner = 'local-operator'
  const f = await fixture({owner, expectReply:true, worker:async () => { await pause.promise; return replay }})
  const server = await serve(f.h), controller = new AbortController()
  const path = server.url + '/api/chat/conversations/' + f.chatId
  const headers = {authorization:'Bearer ' + readFileSync(join(f.config.stateDir,'access-token'),'utf8').trim(), 'content-type':'application/json'}
  try {
    const sent = await fetch(path+'/messages',{method:'POST',headers,body:JSON.stringify({text:firstQuestion,clientMessageId:randomUUID()})})
    expect(sent.status).toBe(202)
    const {runId} = await sent.json() as {runId:string}
    await until(f.h, () => !!f.h.store.get('router-result','router:'+runId) && f.workerTurns.length===2)
    const revision = String(f.h.chat.revision(f.chatId,owner))
    const events = await fetch(path+'/events',{headers:{...headers,'last-event-id':revision},signal:controller.signal})
    expect(events.headers.get('content-type')).toBe('text/event-stream')
    const reader=events.body!.getReader(), decoder=new TextDecoder()
    let seen=false, changes=0
    const watch=async () => {
      let buffer=''
      while (!seen) {
        const {value,done}=await reader.read()
        if(done) return
        buffer+=decoder.decode(value,{stream:true})
        const packets=buffer.split('\n\n')
        buffer=packets.pop()!
        if(!packets.some(p=>p.includes('event: change'))) continue
        changes++
        const view=await (await fetch(path,{headers})).json() as {messages:{runId:string;text:string}[]}
        seen=view.messages.filter(m=>m.runId===runId&&m.text===replay.reply).length===1
      }
    }
    const received=watch()
    void received.catch(()=>{})
    pause.release()
    await until(f.h,()=>seen)
    await received
    expect(changes).toBeGreaterThan(0)
    await reader.cancel()
  } finally {
    controller.abort()
    server.server.closeAllConnections()
    await new Promise<void>(resolve=>server.server.close(()=>resolve()))
  }
})

it('accepts a partial answer that hands back only its own inquiry without admitting more work', async () => {
  const f=await fixture({expectReply:true,worker:async (_r,inputs) => {
    const inquiryId=inputs.find(i=>i.inquiryId)!.inquiryId!
    return {...waiting,reply:'Mac verified; Windows needs its owner.',inquiryReplies:[{inquiryId,text:'Mac verified.'}],
      handbacks:[{triggerId:inquiryId,reason:'Windows is outside my mandate.'}]}
  }})
  const q=f.send(firstQuestion)
  await until(f.h,()=>f.view().some(m=>m.runId===q.runId&&m.text==='Mac verified.'))
  expect(f.h.store.tickets.list()).toHaveLength(1)
  expect(f.workerTurns).toHaveLength(2)
  expect(f.h.store.tickets.get(f.ticketId)?.assignments.at(-1)?.report?.state).toBe('waiting')
})

it('uses a bounded task index for a long status inquiry and can read the original authorized goal', async () => {
  const seen: {kind:string; bytes:number; hasIndex:boolean; original:boolean}[]=[]
  const question='What is the status of release?'
  const f=await fixture({expectReply:true,managed:true,observeInput:async(r,data)=>{
    if(data.trigger.text!==question)return
    let original=false
    if(data.goals?.length){
      const stored=await r.onTool!('router_goal',{action:'inspect',id:data.goals[0].id},randomUUID())
      original=stored.success&&JSON.stringify(stored.contentItems).includes('Retained original plan')
    }
    seen.push({kind:data.kind,bytes:Buffer.byteLength(r.input),hasIndex:data.workerStatus?.revision===0,original})
  }})
  const g=f.h.goals.forTask(f.ticketId)!
  const longGoal={...g,plan:Array.from({length:35},(_,i)=>'Retained original plan '+i+' '+'x'.repeat(2400))}
  f.h.store.put('router-goal',g.id,longGoal)
  const q=f.send(question)
  await until(f.h,()=>f.view().some(m=>m.runId===q.runId&&m.text===replay.reply))
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({hasIndex:true,original:true,kind:'user_message'})
  expect(seen[0]!.bytes).toBeLessThan(24000)
  expect(f.h.goals.get(g.id)?.plan).toEqual(longGoal.plan)
})
