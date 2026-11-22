import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { configSchema, type Config } from '../src/config.ts'
import { Runtime } from '../src/runtime.ts'
import { serve } from '../src/server.ts'
import { OfficeMcp } from '../src/office-mcp.ts'
import { managedSecrets } from '../src/managed-config.ts'
import type { Trigger } from '../src/vendor/dsh-core/index.ts'
import type { WorkOwner } from '../src/work.ts'

const wire = vi.hoisted(() => ({ ding: [] as any[], wecom: [] as any[], replies: [] as { chat: string; text: string }[] }))
vi.mock('ws', async importOriginal => {
  const ws = await importOriginal<typeof import('ws')>()
  const { EventEmitter } = await import('node:events')
  class Socket extends EventEmitter {
    closed = false
    acknowledgements: any[] = []
    constructor(url: URL) {
      super()
      expect(url.origin).toBe('wss://wss-open-connection.dingtalk.com')
      expect(url.searchParams.get('ticket')).toBe('fixture-ws-ticket')
      wire.ding.push(this)
      queueMicrotask(() => { if (!this.closed) this.emit('open') })
    }
    send(data: string) { this.acknowledgements.push(JSON.parse(data)) }
    ping() { this.emit('pong') }
    terminate() { if (!this.closed) { this.closed = true; this.emit('close') } }
  }
  return { ...ws, default: Socket }
})
vi.mock('@wecom/aibot-node-sdk', async () => {
  const { EventEmitter } = await import('node:events')
  class Bot extends EventEmitter {
    closed = false
    constructor(readonly options: { botId: string; secret: string }) { super(); wire.wecom.push(this) }
    connect() { queueMicrotask(() => { if (!this.closed) this.emit('authenticated') }) }
    disconnect() { this.closed = true; this.emit('disconnected') }
    async replyStream() {}
    async sendMessage(chat: string, body: { markdown: { content: string } }) { wire.replies.push({ chat, text: body.markdown.content }) }
  }
  return { WSClient: Bot, decryptFile: () => { throw Error('No media in this fixture') } }
})

const temporary: string[] = [], stops: (() => Promise<void>)[] = [], envNames: string[] = []
const model = { async run() { throw Error('This fixture observes ingress and tool transport without a model') } }
const nativeFetch = globalThis.fetch

afterEach(async () => {
  vi.restoreAllMocks()
  for (const stop of stops.splice(0).reverse()) await stop()
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
  for (const name of envNames.splice(0)) delete process.env[name]
  wire.ding.length = 0
  wire.wecom.length = 0
  wire.replies.length = 0
  vi.unstubAllGlobals()
})

async function fixture(options: { failRestart?: boolean; preview?: boolean; network?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'roppo-office-connectors-'))
  temporary.push(root)
  const config = configSchema.parse({
    stateDir: join(root, 'state'), port: 0, execution: { router: { mode: 'host' } },
    work: { sandboxDriver: 'disabled', network: options.network ?? false },
    sources: [{ id: 'local', kind: 'local', cwd: join(root, 'workspace'), allowedActors: ['operator'] }],
  })
  const makeRuntime = (next: Config, _activationId?: string, startupSourceIds?: readonly string[]) => new Runtime(next, { model, startupSourceIds })
  let rebuilds = 0
  const host = await serve(makeRuntime(config), { configurationPreview: options.preview,
    createRuntime(next, activationId, sourceIds) {
      if (options.failRestart && rebuilds++ === 0) throw Error('Fixture failed before the new runtime started')
      return makeRuntime(next, activationId, sourceIds)
    },
  })
  stops.push(async () => {
    envNames.push(...Object.keys(managedSecrets(config.stateDir)))
    host.server.closeAllConnections()
    await new Promise<void>(resolve => host.server.close(() => resolve()))
    await host.closeRuntime()
  })
  const headers = { authorization: 'Bearer ' + readFileSync(host.tokenPath, 'utf8').trim(), 'content-type': 'application/json' }
  const request = async (path: string, data?: object, signed: boolean | string = true) => {
    const response = await nativeFetch(host.url + path, { headers: signed === true ? headers : typeof signed === 'string'
      ? { authorization: 'Bearer ' + signed, 'content-type': 'application/json' } : {}, redirect: 'manual',
      ...(data && { method: 'POST', body: JSON.stringify(data) }) })
    return { status: response.status, body: response.status === 303 ? await response.text() : await response.json() }
  }
  return { host, config, request }
}

function stubBotService() {
  let scans = 0
  const json = (value: unknown) => Response.json(value)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    switch (url.pathname) {
      case '/app/registration/init':
        expect(body).toEqual({ source: 'DING_DSH' })
        return json({ errcode: 0, nonce: 'fixture-nonce' })
      case '/app/registration/begin':
        return json({ errcode: 0, device_code: 'fixture-device-code', verification_uri_complete: 'https://open-dev.dingtalk.com/fixture?user_code=123',
          expires_in: 90, interval: 1 })
      case '/app/registration/poll':
        return json({ errcode: 0, status: 'SUCCESS', client_id: 'ding-fixture', client_secret: 'fixture-ding-secret' })
      case '/ai/qc/generate':
        return json({ data: { scode: 'fixture-scan-' + ++scans, auth_url: 'https://work.weixin.qq.com/fixture/confirm' } })
      case '/ai/qc/query_result':
        return json({ data: { status: 'success', bot_info: { botid: 'wecom-fixture', secret: 'fixture-wecom-secret' } } })
      case '/v1.0/gateway/connections/open':
        expect(body.clientId).toBe('ding-fixture')
        expect(body.clientSecret).toBe('fixture-ding-secret')
        return json({ endpoint: 'wss://wss-open-connection.dingtalk.com', ticket: 'fixture-ws-ticket' })
      case '/v1.0/oauth2/accessToken':
        return json({ accessToken: 'fixture-ding-access', expireIn: 7200 })
      case '/v1.0/robot/groupMessages/send':
        expect(new Headers(init?.headers).get('x-acs-dingtalk-access-token')).toBe('fixture-ding-access')
        wire.replies.push({ chat: body.openConversationId, text: JSON.parse(body.msgParam).text })
        return json({ processQueryKey: 'receipt' })
      default:
        return nativeFetch(input, init)
    }
  }))
}

function ding(socket: any, id: string, chat: string, text: string, addressed: boolean, actor = 'staff-a') {
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'CALLBACK',
    headers: { topic: '/v1.0/im/bot/messages/get', messageId: id }, data: JSON.stringify({
      conversationId: chat, conversationTitle: chat === 'cid-a' ? '研发群' : '发布群', conversationType: '2',
      msgId: id, senderStaffId: actor, robotCode: 'ding-fixture', isInAtList: addressed, msgtype: 'text', text: { content: text },
    }),
  })))
}
function wecom(socket: any, id: string, chat: string, text: string) {
  socket.emit('message', { headers: { req_id: 'request-' + id }, body: {
    aibotid: 'wecom-fixture', msgid: id, chatid: chat, chattype: 'group', msgtype: 'text', from: { userid: 'user-a' }, text: { content: text },
  } })
}

it('pairs DingTalk via native QR, proves and selects scopes, and preserves addressed and ambient events for the Router', async () => {
  stubBotService()
  const { host, config, request } = await fixture()
  const path = '/api/connectors/dingtalk/setup'
  expect((await request(path + '/start', {}, false)).status).toBe(401)
  const start = (await request(path + '/start', {})).body
  await vi.waitFor(async () => expect((await request(path)).body.stage).toBe('scan'))
  expect(JSON.stringify((await request(path)).body)).not.toContain('fixture-device')
  let group: any
  await vi.waitFor(async () => { group = (await request(path)).body; expect(group.stage).toBe('groups') }, { timeout: 4000 })
  const probe = wire.ding[0]
  ding(probe, 'unverified', 'cid-hidden', group.code, false)
  ding(probe, 'pair-a', 'cid-a', group.code, true)
  ding(probe, 'pair-b', 'cid-b', group.code, true)
  expect((await request(path)).body.groups).toEqual([{ id: 'cid-a', label: '研发群' }, { id: 'cid-b', label: '发布群' }])
  expect((await request(path + '/apply', { id: start.id, groups: ['cid-hidden'] })).status).toBe(409)
  const applied = (await request(path + '/apply', { id: start.id, groups: ['cid-a'] })).body
  expect(applied.stage).toBe('connected')
  expect(probe.closed).toBe(true)
  expect(statSync(join(config.stateDir, 'setup', 'credentials.json')).mode & 0o777).toBe(0o600)
  expect(JSON.stringify((await request('/api/connectors')).body)).not.toContain('fixture-ding-secret')
  await host.runtime.pollSources()
  await vi.waitFor(() => expect(wire.ding.length).toBeGreaterThan(1))
  const socket = wire.ding.at(-1)
  const runtime = host.runtime
  runtime.updateSettings(runtime.settings.current().revision, { acceptMode: 'auto', rules: [{ id: 'office', instruction: 'Handle release requests' }] })
  ding(socket, 'mention', 'cid-a', 'Direct request', true)
  ding(socket, 'ambient', 'cid-a', 'Ordinary work message', false)
  ding(socket, 'ambient', 'cid-a', 'Ordinary work message', false)
  ding(socket, 'out-of-scope', 'cid-b', 'Ignore this', true)
  const triggers = runtime.store.list<Trigger>('trigger').filter(t => t.source === applied.sourceId)
  expect(triggers.map(t => [t.meta.messageId, t.addressed])).toEqual([['mention', 'direct'], ['ambient', undefined]])
  const direct = runtime.routerIngress.get(triggers[0]!.id)
  expect(direct?.mandate?.strength).toBe('explicit')
  expect(runtime.routerIngress.get(triggers[1]!.id)?.state).toBe('pending')
  expect(socket.acknowledgements.map((x: any) => x.headers.messageId)).toEqual(['mention', 'ambient', 'ambient', 'out-of-scope'])
  const view = (await request('/api/connectors')).body.instances.find((s: any) => s.id === applied.sourceId)
  expect(view).toMatchObject({ scopeCount: 1, liveStatus: 'ready', observedGroups: 1 })
  const source = runtime.sources.get(applied.sourceId)!
  await source.deliver({ id: 'reply', channel: triggers[0]!.channel!, text: 'DingTalk result' } as any)
  expect(wire.replies).toEqual([{ chat: 'cid-a', text: 'DingTalk result' }])
  socket.terminate()
  await vi.waitFor(() => expect(wire.ding.at(-1)).not.toBe(socket), { timeout: 3000 })
  ding(wire.ding.at(-1), 'after-reconnect', 'cid-a', 'After reconnect', true)
  expect(runtime.store.list<Trigger>('trigger').some(t => t.meta.messageId === 'after-reconnect')).toBe(true)
}, 15_000)

it('resumes a scanned WeCom setup after a failed rebuild and manages groups without restarting again', async () => {
  stubBotService()
  const { host, config, request } = await fixture({ failRestart: true })
  const path = '/api/connectors/wecom/setup'
  await request(path + '/start', {})
  let groups: any
  await vi.waitFor(async () => { groups = (await request(path)).body; expect(groups.stage).toBe('groups') }, { timeout: 5300 })
  wecom(wire.wecom.at(-1), 'pair-a', 'group-a', groups.code)
  const result = await request(path + '/apply', { id: groups.id, groups: ['group-a'] })
  expect(result.body.code).toBe('setup_apply_failed')
  expect(host.runtime.config.sources.some(s => s.kind === 'wecom')).toBe(false)
  expect(managedSecrets(config.stateDir)).toEqual({})
  expect(statSync(join(config.stateDir, 'setup', 'wecom-pairing.json')).mode & 0o777).toBe(0o600)
  await request(path + '/start', {})
  await vi.waitFor(async () => { groups = (await request(path)).body; expect(groups.stage).toBe('groups') })
  wecom(wire.wecom.at(-1), 'pair-a', 'group-a', groups.code)
  const applied = (await request(path + '/apply', { id: groups.id, groups: ['group-a'] })).body
  const runtime = host.runtime
  await runtime.pollSources()
  await vi.waitFor(async () => expect((await runtime.sources.get(applied.sourceId)?.identity?.())?.verified).toBe(true))
  const managing = (await request(path + '/start', { sourceId: applied.sourceId })).body
  expect(managing.selected).toEqual(['group-a'])
  wecom(wire.wecom.at(-1), 'pair-b', 'group-b', managing.code)
  const updated = (await request(path + '/apply', { id: managing.id, groups: ['group-b'] })).body
  expect(updated.groupCount).toBe(1)
  expect(host.runtime).toBe(runtime)
  wecom(wire.wecom.at(-1), 'unlisted-group', 'group-a', 'No longer selected')
  wecom(wire.wecom.at(-1), 'selected-group', 'group-b', 'Request to the bot')
  await vi.waitFor(() => {
    const events = runtime.store.list<Trigger>('trigger').filter(t => t.source === applied.sourceId)
    expect(events.map(t => t.meta.messageId)).toEqual(['selected-group'])
    expect(events[0]?.addressed).toBe('direct')
  })
  const configSource = runtime.config.sources.find(s => s.id === applied.sourceId)!
  const feed = managedSecrets(config.stateDir)[configSource.tokenEnv!]!
  const event = { id: 'ordinary', scope: 'group-b', thread: 'group:group-b', text: 'Prepare the release materials', addressed: false, at: new Date().toISOString() }
  runtime.updateSettings(runtime.settings.current().revision, { acceptMode: 'auto', rules: [{ id: 'release', instruction: 'Prepare release materials' }] })
  const ingress = '/events/' + applied.sourceId
  expect((await request(ingress, { actor: 'user-a', human: true, event }, 'incorrect')).status).toBe(401)
  expect((await request(ingress, { actor: 'user-a', human: true, event: { ...event, addressed: true } }, feed)).status).toBe(400)
  expect((await request(ingress, { actor: 'user-a', human: true, event: { ...event, scope: 'group-a', thread: 'group:group-a' } }, feed)).status).toBe(400)
  const received = await request(ingress, { actor: 'user-a', human: true, event }, feed)
  expect(received.status).toBe(202)
  const trigger = runtime.store.triggers.get(received.body.triggerId)
  expect(trigger?.addressed).toBeUndefined()
  const admission = runtime.routerIngress.get(received.body.triggerId)
  expect(admission).toMatchObject({ state: 'pending', mandate: { strength: 'inferred' } })
  const accepted = runtime.routerIngress.decide(received.body.triggerId, admission!.policyVersion, {
    action: 'accept', title: 'Release materials', scope: 'Prepare the requested release materials', reason: 'Matches the release rule',
    rules: ['release'], ruleAssessments: [{ id: 'release', matched: true, reason: 'Explicit request to prepare release materials' }],
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: event.text },
    intent_evidence: event.text,
  })
  expect(accepted).toMatchObject({ state: 'accepted', mandate: { strength: 'inferred', basis: { rules: ['release'] } } })
  expect((await request(ingress, { actor: 'user-a', human: true, event }, feed)).body.disposition).toBe('duplicate')
  expect(wire.replies).toEqual([])
}, 15_000)

const schemas = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
function stubAppService() {
  const codes = new Map<string, string>(), refresh = vi.fn(), invoke = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)), domain = url.origin
    if (!['https://mcp.linear.app', 'https://mcp.notion.com'].includes(domain)) return nativeFetch(input, init)
    const json = (value: unknown, status = 200) => Response.json(value, { status })
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: domain + '/mcp', authorization_servers: [domain] })
    if (url.pathname === '/.well-known/oauth-authorization-server') return json({
      issuer: domain, authorization_endpoint: domain + '/authorize', registration_endpoint: domain + '/register', token_endpoint: domain + '/token',
      response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    })
    if (url.pathname === '/register') {
      const body = JSON.parse(String(init?.body))
      expect(body.client_name).toBe('Roppo')
      return json({ client_id: 'fixture-id', redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' })
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(String(init?.body))
      if (form.get('grant_type') === 'refresh_token') {
        refresh(domain)
        expect(form.get('refresh_token')).toBe('fixture-refresh-token')
        return json({ token_type: 'Bearer', access_token: 'fixture-refresh-complete', expires_in: 3600, refresh_token: 'fixture-new-refresh' })
      }
      const verifier = form.get('code_verifier')!
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(codes.get(domain))
      expect(form.get('code')).toBe('fixture-code')
      return json({ token_type: 'Bearer', access_token: 'fixture-access-token', expires_in: 3600, refresh_token: 'fixture-refresh-token' })
    }
    expect(url.pathname).toBe('/mcp')
    if (init?.method === 'GET') return new Response(null, { status: 405 })
    const raw = JSON.parse(String(init?.body)), header = new Headers(init?.headers)
    expect(header.get('authorization')).toMatch(/^Bearer fixture-(?:access-token|refresh-complete)$/)
    if (raw.id === undefined) return new Response(null, { status: 202 })
    let result
    if (raw.method === 'initialize') result = { protocolVersion: raw.params.protocolVersion, serverInfo: { name: 'office-fixture', version: '1' }, capabilities: { tools: {} } }
    else if (raw.method === 'tools/list') result = { tools: [
      { name: 'find', description: 'Find an item', inputSchema: schemas, annotations: { readOnlyHint: true } },
      { name: 'update', description: 'Update an item', inputSchema: schemas },
    ] }
    else if (raw.method === 'tools/call') {
      invoke(raw.params.name)
      result = { content: [{ type: 'text', text: 'Office tool result' }] }
    } else throw Error('Unexpected MCP fixture method')
    return json({ jsonrpc: '2.0', id: raw.id, result })
  }))
  return { codes, refresh, invoke }
}

it('completes both native OAuth flows, refreshes once and grants tools only to authorized personal work', async () => {
  const provider = stubAppService()
  const { host, config, request } = await fixture({ network: true })
  for (const kind of ['linear', 'notion']) {
    const path = '/api/connectors/' + kind
    expect((await request(path + '/setup/start', {}, false)).status).toBe(401)
    await request(path + '/setup/start', {})
    let consent!: URL
    await vi.waitFor(async () => {
      const result = (await request(path + '/setup')).body
      expect(result.status).toBe('authorize')
      consent = new URL(result.url)
    })
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256')
    provider.codes.set(consent.origin, consent.searchParams.get('code_challenge')!)
    const state = consent.searchParams.get('state')!
    await request(path + '/callback?code=wrong&state=wrong', undefined, false)
    expect((await request(path + '/setup')).body.status).toBe('authorize')
    const callback = path + '/callback?' + new URLSearchParams({ code: 'fixture-code', state, iss: consent.origin })
    expect((await request(callback, undefined, false)).status).toBe(303)
    await vi.waitFor(async () => expect((await request(path + '/setup')).body).toMatchObject({ status: 'connected', toolCount: 2 }))
    const grant = host.runtime.store.get<{ id: string }>('office-app-connection', kind)!
    const stored = join(config.stateDir, 'setup', kind + '-oauth-' + grant.id + '.json')
    expect(statSync(stored).mode & 0o777).toBe(0o600)
    expect(JSON.stringify((await request('/api/connectors')).body)).not.toContain('fixture-access-token')
    await request(callback, undefined, false)
    expect((await request(path + '/setup')).body.status).toBe('connected')
  }
  const runtime = host.runtime
  vi.spyOn(runtime, 'validWork').mockReturnValue(true)
  vi.spyOn(runtime, 'taskAuthority').mockReturnValue({ parentTrigger: 'chat:trigger' } as any)
  const permission = vi.spyOn(runtime.chat, 'permissionActor')
  const owner: WorkOwner = { ticketId: 'fixture', assignmentId: 'assignment', cwd: config.stateDir, sandbox: 'read-only', depth: 0 }
  permission.mockReturnValue(undefined)
  expect(await runtime.toolConnections.catalog(owner)).toEqual([])
  expect(() => runtime.toolConnections.call(owner, { connection: '@linear', tool: 'find', arguments: { query: 'test' }, requestId: 'unscoped' })).toThrow('unavailable')
  permission.mockReturnValue({ mode: 'ask', conversationId: 'conversation', triggerId: 'chat:trigger', runId: 'run', workerId: 'worker' })
  expect((await runtime.toolConnections.catalog(owner)).map(c => c.connection)).toEqual(['@linear', '@notion'])
  expect(await runtime.toolConnections.catalog({ ...owner, agentId: 'subagent' })).toEqual([])
  expect((await runtime.toolConnections.permission(owner, '@notion', 'update')).readOnly).toBe(false)
  const call = { connection: '@linear', tool: 'find', arguments: { query: 'test' }, requestId: 'read-1' }
  expect((await runtime.toolConnections.call(owner, call)).success).toBe(true)
  expect((await runtime.toolConnections.call(owner, call)).success).toBe(true)
  expect(provider.invoke).toHaveBeenCalledTimes(1)
  const reload = new OfficeMcp(config.stateDir, runtime.store)
  expect(reload.inventory().filter(app => app.status === 'connected')).toHaveLength(2)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000)
  expect((await runtime.toolConnections.call(owner, { ...call, requestId: 'read-2' })).success).toBe(true)
  expect(provider.refresh).toHaveBeenCalledTimes(1)
  expect(readFileSync(join(config.stateDir, 'setup', 'linear-oauth-' + runtime.store.get<{ id: string }>('office-app-connection', 'linear')!.id + '.json'), 'utf8')).toContain('fixture-new-refresh')
  await request('/api/connectors/linear/disconnect', {})
  expect(() => runtime.toolConnections.call(owner, { ...call, requestId: 'disconnected' })).toThrow('unavailable')
  expect(new OfficeMcp(config.stateDir, runtime.store).status('linear')).toEqual({ status: 'disconnected' })
  reload.close()
}, 15_000)

it('keeps vendor setup and callback exchange out of configuration previews', async () => {
  const { request } = await fixture({ preview: true })
  for (const kind of ['dingtalk', 'wecom', 'linear', 'notion']) {
    expect((await request('/api/connectors/' + kind + '/setup/start', {})).body.code).toBe('preview_restricted')
  }
})
