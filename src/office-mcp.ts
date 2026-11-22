import { randomBytes, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { OAuthClientInformationSchema, OAuthTokensSchema, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import { atomicPrivateFile } from './managed-config.ts'
import { OnboardingError } from './onboarding.ts'
import type { Store } from './store.ts'
import type { ToolConnection } from './connector-config.ts'

export const officeAppKinds = ['linear', 'notion'] as const
export type OfficeAppKind = typeof officeAppKinds[number]
const apps = {
  linear: { label: 'Linear', url: 'https://mcp.linear.app/mcp', scope: 'read write' },
  notion: { label: 'Notion', url: 'https://mcp.notion.com/mcp', scope: 'default' },
}
const application = (kind: OfficeAppKind) => ({ kind, label: apps[kind].label })
const metadata = (redirect: string) => ({
  client_name: 'Roppo', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'], token_endpoint_auth_method: 'none',
})

const grantSchema = z.object({
  id: z.string().uuid(), redirect: z.string().url(), client: OAuthClientInformationSchema,
  tokens: OAuthTokensSchema, expiresAt: z.number().optional(), checkedAt: z.number(),
  tools: z.array(z.string().min(1).max(200)).min(1).max(2000),
}).strict()
type Grant = z.infer<typeof grantSchema>
type SavedGrant = { id: string; toolCount: number; checkedAt: number }
const savedGrant = z.object({ id: z.string().uuid(), toolCount: z.number().int().positive(), checkedAt: z.number() })
type Attempt = {
  state: string; redirect: string; deadline: number; controller: AbortController; authorize: () => void
  stage: 'preparing' | 'authorize' | 'checking' | 'failed'
  url?: string; code?: string; verifier?: string; client?: Grant['client']; tokens?: OAuthTokens;
  discovery?: Awaited<ReturnType<NonNullable<OAuthClientProvider['discoveryState']>>>
}
export type OfficeAppView =
  | { status: 'disconnected' }
  | { status: 'preparing' | 'checking' }
  | { status: 'authorize'; url: string }
  | { status: 'failed'; code: string }
  | { status: 'connected' | 'auth_required'; toolCount: number; checkedAt: number }
export type AppToolGrant = { kind: OfficeAppKind; id: string; config: ToolConnection }

const unavailable = () => new OnboardingError('office_oauth_unavailable', 'office_oauth_unavailable', 409)
const reauthorize = () => new OnboardingError('office_oauth_required', 'office_oauth_required', 401)
const expiration = (tokens: OAuthTokens) => tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000
function isCallback(kind: OfficeAppKind, redirect: string) {
  const u = new URL(redirect)
  return u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) &&
    !u.search && !u.hash && !u.username && !u.password && u.pathname === '/api/connectors/' + kind + '/callback'
}
function providerUrl(kind: OfficeAppKind, input: string | URL) {
  const url = new URL(input)
  if (url.origin !== new URL(apps[kind].url).origin || url.username || url.password || url.hash) throw unavailable()
  return url
}
function providerFetch(kind: OfficeAppKind, signal: AbortSignal): FetchLike {
  return (input, init) => {
    providerUrl(kind, input instanceof Request ? input.url : input)
    return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]) })
  }
}
function oauthOptions(kind: OfficeAppKind, signal: AbortSignal) {
  return { serverUrl: apps[kind].url, scope: apps[kind].scope, fetchFn: providerFetch(kind, signal) }
}
function validateTokens(kind: OfficeAppKind, tokens: OAuthTokens) {
  if (tokens.issuer && providerUrl(kind, tokens.issuer).pathname !== '/' ||
    tokens.token_type.toLowerCase() !== 'bearer' || !/^[^\x00-\x20\x7f]{1,16000}$/.test(tokens.access_token)) throw unavailable()
  return tokens
}

/** Local OAuth grants for official hosted apps. Task tools use the same MCP
 * adapter and approval path as manually configured connections. */
export class OfficeMcp {
  private readonly grants = new Map<OfficeAppKind, Grant>()
  private readonly blocked = new Set<OfficeAppKind>()
  private readonly refreshing = new Map<OfficeAppKind, Promise<Grant>>()
  private readonly shutdown = new AbortController()
  constructor(private readonly stateDir: string, private readonly store: Store, private readonly dropConnection: (id: string) => void = () => {}) {
    for (const kind of officeAppKinds) {
      const saved = this.saved(kind)
      if (!saved) continue
      try {
        const path = this.file(kind, saved.id)
        if (!lstatSync(path).isFile()) continue
        const grant = grantSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
        validateTokens(kind, grant.tokens)
        if (grant.id === saved.id && isCallback(kind, grant.redirect)) this.grants.set(kind, grant)
      } catch { /* A fresh authorization repairs a missing or unreadable grant. */ }
    }
  }

  private saved(kind: OfficeAppKind) {
    return savedGrant.safeParse(this.store.get('office-app-connection', kind)).data
  }
  private file(kind: OfficeAppKind, id: string) { return join(this.stateDir, 'setup', kind + '-oauth-' + id + '.json') }
  private remove(kind: OfficeAppKind, id: string) {
    try { unlinkSync(this.file(kind, id)) } catch { /* A missing authorization record keeps this file inactive. */ }
  }
  private write(kind: OfficeAppKind, grant: Grant) {
    const previous = this.saved(kind)
    atomicPrivateFile(this.file(kind, grant.id), JSON.stringify(grantSchema.parse(grant)))
    if (previous?.id !== grant.id) {
      try {
        this.store.put('office-app-connection', kind, { id: grant.id, toolCount: grant.tools.length, checkedAt: grant.checkedAt } satisfies SavedGrant)
      } catch (error) { this.remove(kind, grant.id); throw error }
      if (previous) this.remove(kind, previous.id)
    }
    this.grants.set(kind, grant)
  }
  inventory() { return officeAppKinds.map(kind => ({ ...application(kind), ...this.status(kind) })) }
  status(kind: OfficeAppKind): OfficeAppView {
    const saved = this.saved(kind), grant = this.grants.get(kind)
    if (!saved) return { status: 'disconnected' }
    const reconnect = !grant || saved.id !== grant.id || this.blocked.has(kind) ||
      grant.expiresAt !== undefined && grant.expiresAt <= Date.now() && !grant.tokens.refresh_token
    return { status: reconnect ? 'auth_required' : 'connected', toolCount: saved.toolCount, checkedAt: saved.checkedAt }
  }
  clientRegistration(kind: OfficeAppKind, redirect: string) {
    const grant = this.grants.get(kind)
    return grant?.redirect === redirect ? grant.client : undefined
  }
  saveAuthorization(kind: OfficeAppKind, authorization: Omit<Grant, 'id'>) {
    this.shutdown.signal.throwIfAborted()
    const previous = this.grants.get(kind)
    this.write(kind, { ...authorization, id: randomUUID() })
    this.blocked.delete(kind)
    if (previous) this.dropConnection(previous.id)
  }
  disconnect(kind: OfficeAppKind) {
    const previous = this.saved(kind)
    this.store.put('office-app-connection', kind, null)
    this.grants.delete(kind)
    this.blocked.delete(kind)
    if (previous) { this.remove(kind, previous.id); this.dropConnection(previous.id) }
    return this.status(kind)
  }

  access(kind: OfficeAppKind): AppToolGrant | undefined {
    const grant = this.grants.get(kind)
    if (!grant || this.status(kind).status !== 'connected') return
    const app = apps[kind]
    return { kind, id: grant.id, config: { enabled: true, label: app.label, allowedTools: grant.tools, timeoutMs: 30_000,
      transport: { kind: 'http', url: app.url, headerEnv: {} } } }
  }
  private current(access: AppToolGrant) {
    const grant = this.grants.get(access.kind)
    if (!grant || grant.id !== access.id || this.saved(access.kind)?.id !== access.id || this.blocked.has(access.kind) || this.shutdown.signal.aborted) throw reauthorize()
    return grant
  }

  private refresh(access: AppToolGrant, previous: Grant) {
    const current = this.current(access)
    if (current !== previous) return Promise.resolve(current)
    const inflight = this.refreshing.get(access.kind)
    if (inflight) return inflight.then(() => this.current(access))
    const promise = this.exchange(access, previous).finally(() => this.refreshing.delete(access.kind))
    this.refreshing.set(access.kind, promise)
    return promise
  }

  private async exchange(access: AppToolGrant, previous: Grant) {
    const { kind } = access
    try {
      if (!previous.tokens.refresh_token) throw reauthorize()
      let next: OAuthTokens | undefined
      const provider: OAuthClientProvider = {
        redirectUrl: previous.redirect, clientMetadata: metadata(previous.redirect), clientInformation: () => previous.client,
        tokens: () => previous.tokens, saveTokens: value => { next = validateTokens(kind, value) },
        redirectToAuthorization: () => { throw reauthorize() }, saveCodeVerifier() {}, codeVerifier: () => '',
      }
      const result = await auth(provider, oauthOptions(kind, this.shutdown.signal))
      this.current(access)
      if (result !== 'AUTHORIZED' || !next) throw reauthorize()
      const grant = { ...previous, tokens: { ...next, refresh_token: next.refresh_token ?? previous.tokens.refresh_token }, expiresAt: expiration(next) }
      this.write(kind, grant)
      return grant
    } catch (error) {
      if ((error instanceof InvalidGrantError || error instanceof OnboardingError && error.code === 'office_oauth_required') &&
        this.grants.get(kind)?.id === access.id) this.blocked.add(kind)
      if (this.blocked.has(kind)) throw reauthorize()
      throw unavailable()
    }
  }

  transport(access: AppToolGrant) {
    const { kind } = access, url = new URL(apps[kind].url)
    const fetchMcp = providerFetch(kind, this.shutdown.signal)
    return new StreamableHTTPClientTransport(url, { fetch: async (input, init) => {
      if (providerUrl(kind, input instanceof Request ? input.url : input).href !== url.href) throw unavailable()
      const send = (value: Grant) => {
        this.current(access)
        const headers = new Headers(init?.headers)
        headers.set('authorization', 'Bearer ' + value.tokens.access_token)
        return fetchMcp(input, { ...init, headers })
      }
      let grant = this.current(access)
      if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now() + 15_000) grant = await this.refresh(access, grant)
      const response = await send(grant)
      if (response.status !== 401) return response
      await response.body?.cancel()
      return send(await this.refresh(access, grant))
    } })
  }

  close() {
    this.shutdown.abort()
  }
}

/** Authorization attempts belong to the HTTP server and survive a Runtime rebuild. */
export class OfficeAuthorization {
  private readonly attempts = new Map<OfficeAppKind, Attempt>()
  private readonly shutdown = new AbortController()
  constructor(private readonly host: () => OfficeMcp,
    private readonly commit: (signal: AbortSignal, save: (host: OfficeMcp) => void) => Promise<void>) {}

  status(kind: OfficeAppKind): OfficeAppView {
    const attempt = this.attempts.get(kind)
    if (!attempt) return this.host().status(kind)
    if (attempt.stage !== 'failed' && attempt.deadline <= Date.now()) {
      this.fail(kind, attempt, 'office_oauth_expired')
      return { status: 'failed', code: 'office_oauth_expired' }
    }
    if (attempt.stage === 'failed') return { status: 'failed', code: attempt.code! }
    if (attempt.stage === 'authorize') return { status: 'authorize', url: attempt.url! }
    return { status: attempt.stage }
  }

  start(kind: OfficeAppKind, origin: string, authorize: () => void) {
    authorize()
    this.shutdown.signal.throwIfAborted()
    const redirect = origin + '/api/connectors/' + kind + '/callback'
    if (!isCallback(kind, redirect)) throw unavailable()
    this.attempts.get(kind)?.controller.abort()
    const attempt: Attempt = {
      state: randomBytes(32).toString('base64url'), redirect, authorize, stage: 'preparing',
      deadline: Date.now() + 10 * 60_000, controller: new AbortController(), client: this.host().clientRegistration(kind, redirect),
    }
    this.attempts.set(kind, attempt)
    void this.begin(kind, attempt)
    return this.status(kind)
  }

  private provider(kind: OfficeAppKind, attempt: Attempt): OAuthClientProvider {
    return {
      redirectUrl: attempt.redirect, clientMetadata: metadata(attempt.redirect), state: () => attempt.state,
      clientInformation: () => attempt.client, saveClientInformation: value => { attempt.client = value },
      tokens: () => attempt.tokens, saveTokens: value => { attempt.tokens = validateTokens(kind, value) },
      saveDiscoveryState: value => { attempt.discovery = value }, discoveryState: () => attempt.discovery,
      saveCodeVerifier: value => { attempt.verifier = value }, codeVerifier: () => attempt.verifier!,
      redirectToAuthorization: url => { attempt.url = providerUrl(kind, url).href },
    }
  }
  private async begin(kind: OfficeAppKind, attempt: Attempt) {
    try {
      const result = await auth(this.provider(kind, attempt), oauthOptions(kind, attempt.controller.signal))
      attempt.controller.signal.throwIfAborted()
      if (result !== 'REDIRECT' || !attempt.url || !attempt.verifier || !attempt.client) throw unavailable()
      attempt.stage = 'authorize'
    } catch { this.fail(kind, attempt, 'office_oauth_unavailable') }
  }
  private fail(kind: OfficeAppKind, attempt: Attempt, code: string) {
    if (this.attempts.get(kind) !== attempt) return
    attempt.controller.abort()
    this.attempts.set(kind, { ...attempt, stage: 'failed', code, url: undefined, client: undefined, tokens: undefined, verifier: undefined, discovery: undefined })
  }

  callback(kind: OfficeAppKind, origin: string, params: URLSearchParams) {
    const attempt = this.attempts.get(kind)
    if (!attempt || attempt.stage !== 'authorize' || new URL(attempt.redirect).origin !== origin ||
      params.getAll('state').length !== 1 || params.get('state') !== attempt.state || attempt.deadline <= Date.now()) return false
    const code = params.get('code')
    if (params.has('error') || !code || code.length > 4000 || params.getAll('code').length !== 1) {
      this.fail(kind, attempt, params.has('error') ? 'office_oauth_denied' : 'office_oauth_unavailable')
      return false
    }
    const issuer = params.get('iss')
    if (issuer) {
      try {
        const expected = attempt.discovery?.authorizationServerMetadata?.issuer ?? attempt.discovery?.authorizationServerUrl
        if (!expected || providerUrl(kind, issuer).href !== providerUrl(kind, expected).href) return false
      } catch { return false }
    }
    attempt.stage = 'checking' // Consume the state before any token exchange.
    attempt.url = undefined
    void this.complete(kind, attempt, code)
    return true
  }

  private async complete(kind: OfficeAppKind, attempt: Attempt, code: string) {
    const signal = AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(Math.max(0, attempt.deadline - Date.now()))])
    const client = new Client({ name: 'Roppo', version: '1' })
    try {
      attempt.authorize()
      const result = await auth(this.provider(kind, attempt), { ...oauthOptions(kind, signal), authorizationCode: code })
      const registration = attempt.client, tokens = attempt.tokens
      if (result !== 'AUTHORIZED' || !registration || !tokens) throw unavailable()
      const expiresAt = expiration(tokens)
      const transport = new StreamableHTTPClientTransport(new URL(apps[kind].url), {
        fetch: providerFetch(kind, signal), requestInit: { headers: { authorization: 'Bearer ' + tokens.access_token } },
      })
      await client.connect(transport, { signal, timeout: 15_000 })
      const tools = new Set<string>(), cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 15_000 })
        for (const tool of page.tools) if (tool.name.length && tool.name.length <= 200 && tool.execution?.taskSupport !== 'required') tools.add(tool.name)
        cursor = page.nextCursor
        if (tools.size > 2000 || cursor && (cursors.size >= 50 || cursors.has(cursor))) throw unavailable()
        if (cursor) cursors.add(cursor)
      } while (cursor)
      if (!tools.size) throw unavailable()
      await this.commit(signal, host => {
        signal.throwIfAborted()
        attempt.authorize()
        if (this.attempts.get(kind) !== attempt || attempt.deadline <= Date.now()) throw unavailable()
        host.saveAuthorization(kind, { redirect: attempt.redirect, client: registration, tokens, expiresAt,
          checkedAt: Date.now(), tools: [...tools] })
        this.attempts.delete(kind)
      })
    } catch { this.fail(kind, attempt, 'office_oauth_unavailable') }
    finally { await client.close().catch(() => {}) }
  }

  disconnect(kind: OfficeAppKind) {
    const result = this.host().disconnect(kind)
    this.attempts.get(kind)?.controller.abort()
    this.attempts.delete(kind)
    return result
  }
  close() {
    this.shutdown.abort()
    for (const attempt of this.attempts.values()) attempt.controller.abort()
    this.attempts.clear()
  }
}
