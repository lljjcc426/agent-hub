import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect, it, vi} from 'vitest'
import {configSchema} from '../src/config.ts'
import {Heartbeat} from '../src/heartbeat.ts'
import {Runtime} from '../src/runtime.ts'
import {serve} from '../src/server.ts'
import {Store} from '../src/store.ts'

const period = 30 * 60_000

it('runs Heartbeat through the actual host scheduler and retains one receipt per due occurrence across restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'roppo-internal-heartbeat-'))
  const config = configSchema.parse({
    port: 0, stateDir: join(root, 'state'), work: {sandboxDriver: 'disabled'},
    execution: {router: {mode: 'host'}}, watchdog: {enabled: false},
    sources: [{id: 'local', kind: 'local', cwd: root, allowedActors: ['operator']}],
  })
  let now = Date.now()
  const start = now
  const model = {run: vi.fn(async () => {throw Error('Unexpected model invocation')})}
  const runtime = () => new Runtime(config, {model, clock: () => now})
  let host: Runtime | undefined
  let app: Awaited<ReturnType<typeof serve>> | undefined
  try {
    host = runtime()
    vi.spyOn(host, 'start').mockImplementation(() => {})
    app = await serve(host)
    const url = app.url + '/api/chat/heartbeat'
    const headers = {authorization: 'Bearer ' + readFileSync(app.tokenPath, 'utf8').trim(), 'content-type': 'application/json'}
    const patch = (active: boolean, expectedRevision: number, requestHeaders: Record<string, string> = headers) =>
      fetch(url, {method: 'PATCH', headers: requestHeaders, body: JSON.stringify({active, expectedRevision})})
    expect((await fetch(url)).status).toBe(401)
    expect((await patch(true, 0, {...headers, origin: 'http://example.test'})).status).toBe(403)
    expect(await (await fetch(url, {headers})).json()).toMatchObject({active: false, runs: []})
    expect(await (await patch(true, 0)).json()).toMatchObject({active: true, revision: 1})
    expect((await patch(false, 0)).status).toBe(409)
    await host.tick()
    const first = host.heartbeat.snapshot()
    expect(first).toMatchObject({nextAt: start + period, intervalMinutes: 30,
      runs: [{state: 'success', scheduledAt: start, ranAt: start, issues: []}]})
    now = start + period - 1
    await host.tick()
    expect(host.heartbeat.snapshot()).toEqual(first)

    app.server.closeAllConnections()
    await new Promise<void>(resolve => app!.server.close(() => resolve()))
    app = undefined
    await host.close()
    host = undefined
    now = start + 3 * period + 2000
    host = runtime()
    expect(host.heartbeat.snapshot()).toEqual(first)
    host.pause(true)
    await host.tick()
    expect(host.heartbeat.snapshot()).toMatchObject({hostPaused: true, runs: first.runs})
    host.pause(false)
    await host.tick()
    await host.tick()
    const resumed = host.heartbeat.snapshot()
    expect(resumed.runs).toHaveLength(2)
    expect(resumed.runs[0]).toMatchObject({scheduledAt: start + 3 * period, ranAt: now, state: 'success'})
    expect(resumed.nextAt).toBe(start + 4 * period)
    host.heartbeat.change({active: false, expectedRevision: 1})
    now += period
    await host.tick()
    expect(host.heartbeat.snapshot()).toMatchObject({active: false, nextAt: null, runs: resumed.runs})
    expect(model.run).not.toHaveBeenCalled()
    expect(host.store.list('trigger')).toEqual([])
  } finally {
    if (app) {
      app.server.closeAllConnections()
      await new Promise<void>(resolve => app!.server.close(() => resolve()))
    }
    await host?.close()
    rmSync(root, {recursive: true, force: true})
  }
})

it('records the failing component and ignores disabled sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'roppo-heartbeat-check-'))
  const store = new Store(join(root, 'state.sqlite'))
  const now = Date.now()
  const source = {kind: 'feishu', cwd: root, allowedActors: [], pollSeconds: 120, feishu: {cli: 'fixture', chats: ['test']}}
  const config = configSchema.parse({stateDir: root, watchdog: {enabled: true}, sources: [
    {...source, id: 'mailbox', label: 'Fixture channel'},
    {...source, id: 'disabled', enabled: false},
  ]})
  const chat = {readiness: () => ({ready: false, code: 'model_credentials_missing'})} as Pick<Runtime['chat'], 'readiness'>
  try {
    store.put('source-health', 'mailbox', {at: now - period, status: 'ok', error: 'private detail'})
    const heartbeat = new Heartbeat({store, config, chat, isPaused: false}, () => now)
    heartbeat.change({active: true, expectedRevision: 0})
    heartbeat.tick()
    expect(heartbeat.snapshot().runs).toEqual([{
      id: '1:' + now, ranAt: now, scheduledAt: now, state: 'failed',
      issues: [{check: 'chat', code: 'model_credentials_missing'}, {check: 'watchdog', code: 'missing'},
        {check: 'feishu', source: 'Fixture channel', code: 'stale'}],
    }])
  } finally {
    store.close()
    rmSync(root, {recursive: true, force: true})
  }
})
