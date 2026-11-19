import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { registerApp } from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import { configSchema, type Config } from './config.ts'
import { atomicPrivateFile } from './managed-config.ts'
import { Onboarding, OnboardingError, setupWorkspace } from './onboarding.ts'
import type { Runtime } from './runtime.ts'
import { feishuApi, feishuLifecycleEvents } from '../plugins/feishu/feishu.ts'

const chatId = z.string().regex(/^oc_[A-Za-z0-9_-]{1,180}$/)
const openId = z.string().regex(/^ou_[A-Za-z0-9_-]{1,180}$/)
const pendingSchema = z.object({
  id: z.string().uuid(),
  appId: z.string().regex(/^cli_[A-Za-z0-9_-]+$/),
  secret: z.string().min(1).max(16000),
  brand: z.enum(['feishu', 'lark']),
  actor: openId.optional(),
}).strict()
type Pending = z.infer<typeof pendingSchema>
type Group = { id: string; label: string }
export type FeishuPairingView =
  | { stage: 'idle' }
  | { stage: 'preparing' | 'saved' | 'checking'; id: string }
  | { stage: 'scan'; id: string; url: string }
  | { stage: 'groups'; id: string; botName: string; groups: Group[] }
  | { stage: 'failed'; id: string; code: string; saved?: boolean }
  | { stage: 'connected'; id: string; sourceId: string; groupCount: number; memberRequired: boolean }

export const feishuGroupSelection = z.object({
  id: pendingSchema.shape.id,
  groups: z.array(chatId).min(1).max(50),
}).strict()

const sourceId = (id: string) => 'feishu-qr-' + id
const error = (code: string, status = 409) => new OnboardingError(code, code, status)
const registerFeishu: typeof registerApp = async options => (await import('@larksuiteoapi/node-sdk')).registerApp(options)

export function feishuRegistrationOptions(signal: AbortSignal, onQRCodeReady: Parameters<typeof registerApp>[0]['onQRCodeReady']): Parameters<typeof registerApp>[0] {
  return {
    source: 'roppo',
    createOnly: true,
    appPreset: { name: 'Roppo' },
    addons: {
      preset: false,
      scopes: { tenant: ['im:chat:readonly', 'im:message:readonly', 'im:message.group_msg',
        'im:message:send_as_bot', 'im:resource'] },
      events: { items: { tenant: ['im.message.receive_v1', ...feishuLifecycleEvents] } },
    },
    signal,
    onQRCodeReady,
  }
}

/** All application credentials stay on the host, even between confirmation and group selection. */
export class FeishuPairing {
  private view: FeishuPairingView = { stage: 'idle' }
  private enrollment?: AbortController
  private discovery?: { id: string; promise: Promise<FeishuPairingView> }

  constructor(
    private readonly host: () => Runtime,
    private readonly onboarding: Onboarding,
    private readonly file: string,
  ) {}

  private pending(): Pending | undefined {
    try {
      if (!lstatSync(this.file).isFile()) throw error('feishu_saved_unreadable', 503)
      const parsed = pendingSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')))
      if (parsed.success) return parsed.data
      throw error('feishu_saved_unreadable', 503)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error('feishu_saved_unreadable', 503)
    }
  }

  private connected(id: string): Extract<FeishuPairingView, { stage: 'connected' }> | undefined {
    const source = this.host().config.sources.find(item => item.id === sourceId(id) && item.kind === 'feishu')
    if (source?.enabled) return { stage: 'connected', id, sourceId: source.id, groupCount: source.feishu!.chats.length, memberRequired: !source.allowedActors.length }
  }

  status(): FeishuPairingView {
    const saved = this.pending()
    if (saved) return this.connected(saved.id) ?? ('id' in this.view && this.view.id === saved.id ? this.view : { stage: 'saved', id: saved.id })
    return this.view
  }

  start(): FeishuPairingView {
    const current = this.status()
    if (this.enrollment) return current
    if (this.pending()) {
      if (current.stage !== 'connected') return current
      unlinkSync(this.file)
    }
    const id = randomUUID()
    const controller = new AbortController()
    this.enrollment = controller
    this.view = { stage: 'preparing', id }
    const preparationTimeout = setTimeout(() => {
      controller.abort()
      this.enrollment = undefined
      this.view = { stage: 'failed', id, code: 'feishu_qr_unavailable' }
    }, 20_000)
    preparationTimeout.unref()
    void this.enroll(id, controller.signal, preparationTimeout).finally(() => {
      clearTimeout(preparationTimeout)
      if (this.enrollment === controller) this.enrollment = undefined
    })
    return this.view
  }

  private async enroll(id: string, signal: AbortSignal, preparationTimeout: ReturnType<typeof setTimeout>) {
    try {
      const result = await registerFeishu(feishuRegistrationOptions(signal, ({ url }) => {
        signal.throwIfAborted()
        clearTimeout(preparationTimeout)
        const link = new URL(url)
        if (link.protocol !== 'https:' || link.username || link.password ||
            !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(link.hostname)) throw error('feishu_qr_unavailable')
        this.view = { stage: 'scan', id, url: link.href }
      }))
      signal.throwIfAborted()
      const actor = openId.safeParse(result.user_info?.open_id)
      const saved = pendingSchema.safeParse({ id, appId: result.client_id, secret: result.client_secret,
        brand: result.user_info?.tenant_brand ?? 'feishu', actor: actor.success ? actor.data : undefined })
      if (!saved.success) throw error('feishu_registration_incomplete')
      atomicPrivateFile(this.file, JSON.stringify(saved.data))
      this.view = { stage: 'saved', id }
      await this.refresh(id, true)
    } catch (cause) {
      if (signal.aborted) return
      const code = (cause as { code?: string })?.code
      this.view = { stage: 'failed', id, code: code === 'expired_token' ? 'feishu_qr_expired'
        : code === 'access_denied' ? 'feishu_qr_denied' : 'feishu_qr_unavailable' }
    }
  }

  refresh(id: string, afterApproval = false): Promise<FeishuPairingView> {
    const saved = this.pending()
    if (!saved || saved.id !== id) throw error('feishu_pairing_missing')
    if (this.discovery?.id === id) return this.discovery.promise
    this.view = { stage: 'checking', id }
    const promise = this.discover(saved, afterApproval).finally(() => {
      if (this.discovery?.id === id) this.discovery = undefined
    })
    this.discovery = { id, promise }
    return promise
  }

  private async discover(saved: Pending, afterApproval: boolean): Promise<FeishuPairingView> {
    const update = (view: FeishuPairingView) => {
      if ('id' in this.view && this.view.id !== saved.id) return this.status()
      return (this.view = this.connected(saved.id) ?? view)
    }
    let code = 'feishu_bot_unavailable'
    for (const wait of afterApproval ? [0, 900, 1800] : [0]) {
      const connected = this.connected(saved.id)
      if (connected) return update(connected)
      if (wait) await delay(wait, undefined, { ref: false })
      try {
        const { botName, groups } = await this.inspect(saved)
        return update({ stage: 'groups', id: saved.id, botName, groups })
      } catch (cause) {
        code = cause instanceof OnboardingError ? cause.code : 'feishu_bot_unavailable'
        if (code !== 'feishu_bot_unavailable') break
      }
    }
    return update({ stage: 'failed', id: saved.id, saved: true, code })
  }

  private async inspect(saved: Pending) {
    const base = feishuApi(saved.brand)
    const request = async (path: string, init: RequestInit) => {
      const response = await fetch(base + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(12_000) })
      const data = await response.json()
      if (!response.ok || data.code !== 0) throw error(path.startsWith('im/v1/') ? 'feishu_chat_access' : 'feishu_bot_unavailable')
      return data
    }
    const auth = await request('auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: saved.appId, app_secret: saved.secret }),
    })
    if (typeof auth.tenant_access_token !== 'string' || !auth.tenant_access_token) throw error('feishu_bot_unavailable')
    const get = (path: string) => request(path, { headers: { authorization: 'Bearer ' + auth.tenant_access_token } })
    const botInfo = await get('bot/v3/info')
    const bot = botInfo.bot ?? botInfo.data?.bot
    const identity = openId.safeParse(bot?.open_id)
    if (!identity.success) throw error('feishu_bot_unavailable')
    const botName = typeof bot.app_name === 'string' && bot.app_name.trim() ? bot.app_name.trim().slice(0, 100) : 'Roppo'
    const groups = new Map<string, Group>()
    let cursor = ''
    const cursors = new Set<string>()
    do {
      const query = new URLSearchParams({ page_size: '100', ...(cursor ? { page_token: cursor } : {}) })
      const { data } = await get('im/v1/chats?' + query)
      if (!Array.isArray(data?.items)) throw error('feishu_bot_unavailable')
      for (const item of data.items) {
        const id = chatId.safeParse(item?.chat_id)
        if (id.success) groups.set(id.data, { id: id.data, label: typeof item.name === 'string' ? item.name.trim().slice(0, 200) : '' })
      }
      if (!data.has_more) break
      cursor = typeof data.page_token === 'string' ? data.page_token : ''
      if (!cursor || cursors.has(cursor) || cursors.size >= 49) throw error('feishu_bot_unavailable')
      cursors.add(cursor)
    } while (cursor)
    return { identity: identity.data, botName, groups: [...groups.values()], get }
  }

  async prepare(input: z.infer<typeof feishuGroupSelection>) {
    const existing = this.connected(input.id)
    if (existing) return { existing } as const
    const saved = this.pending()
    if (!saved || saved.id !== input.id) throw error('feishu_pairing_missing')
    const selection = [...new Set(input.groups)]
    const available = await this.inspect(saved).catch(cause => {
      throw cause instanceof OnboardingError ? cause : error('feishu_bot_unavailable')
    })
    const groups = selection.map(id => available.groups.find(group => group.id === id))
    if (groups.some(group => !group)) throw error('feishu_group_unavailable')
    // Exercise the same read API as the connector, with an empty time window.
    const now = String(Math.floor(Date.now() / 1000))
    for (let offset = 0; offset < selection.length; offset += 5) {
      await Promise.all(selection.slice(offset, offset + 5).map(id => available.get('im/v1/messages?' + new URLSearchParams({
        container_id_type: 'chat', container_id: id, page_size: '1', start_time: now,
      })))).catch(() => { throw error('feishu_chat_access') })
    }
    return { saved, selection, groups: groups as Group[], botName: available.botName, identity: available.identity }
  }

  async apply(prepared: Awaited<ReturnType<FeishuPairing['prepare']>>, rebuild: (config: Config) => Promise<void>, authorize: () => void) {
    if (prepared.existing) return prepared.existing
    const { saved, selection, groups, botName, identity } = prepared
    const existing = this.connected(saved.id)
    if (existing) return existing
    if (this.pending()?.id !== saved.id) throw error('feishu_pairing_missing')
    const host = this.host(), id = sourceId(saved.id)
    const env = 'AGENTHUB_SETUP_' + saved.id.replaceAll('-', '').toUpperCase()
    const config = configSchema.shape.sources.element.parse({
      id, label: botName, kind: 'feishu', pollSeconds: 5,
      cwd: setupWorkspace(host.config, join(host.config.stateDir, 'workspace', id)),
      sandbox: 'read-only', workspace: { mode: 'source' },
      allowedActors: saved.actor ? [saved.actor] : [],
      // Keep new metadata in the existing extension slot so old releases can
      // still load the source with their HTTP polling adapter.
      options: { feishuPairing: { brand: saved.brand, startsAt: Date.now() } },
      feishu: { appIdEnv: env + '_APP', appSecretEnv: env + '_SECRET',
        chats: selection, mentionId: identity, liveEvents: true },
    })
    const plan = this.onboarding.sourcePlan(host.settings.current().revision, config, {
      [config.feishu!.appIdEnv!]: saved.appId, [config.feishu!.appSecretEnv!]: saved.secret,
    })
    await this.onboarding.apply(plan.id, rebuild, authorize)
    this.host().store.put('entry-label', id, { label: botName, scopes: groups })
    this.view = this.connected(saved.id)!
    try { unlinkSync(this.file) } catch { /* A committed source also makes the saved pairing resumable and safe to replace. */ }
    return this.view
  }

  close() { this.enrollment?.abort() }
}
