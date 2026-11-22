import { randomBytes, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WSClient } from '@wecom/aibot-node-sdk'
import { z } from 'zod'
import { configSchema, type Config } from './config.ts'
import { OnboardingError, setupWorkspace, type Onboarding } from './onboarding.ts'
import { atomicPrivateFile } from './managed-config.ts'
import type { Runtime } from './runtime.ts'
import { DingtalkStream, dingtalkMessage } from './connectors/dingtalk-stream.ts'
import { botCredentials, startOfficeRegistration, type BotCredentials, type OfficeBotKind } from './office-bot-registration.ts'
import { groupChallenge, observeOfficeGroup, type GroupChallenge, type OfficeGroup } from './office-groups.ts'

const pendingFile = z.object({ id: z.string().uuid(), credentials: botCredentials, expiresAt: z.number() }).strict()
type Pending = z.infer<typeof pendingFile>
type Group = Pick<OfficeGroup, 'id' | 'label'>
type SavedGroups = { label: string; scopes: Group[] }
export type OfficePairingView =
  | { stage: 'idle' }
  | { stage: 'preparing' | 'starting' | 'applying'; id: string }
  | { stage: 'scan'; id: string; qrUrl: string; pageUrl: string; expiresAt: number }
  | { stage: 'groups'; id: string; code: string; groups: Group[]; selected: string[] }
  | { stage: 'failed'; id: string; code: string }
  | { stage: 'connected'; id: string; sourceId: string; groupCount: number }
type Attempt = {
  id: string; sourceId?: string; controller: AbortController; view: OfficePairingView;
  pending?: Pending; challenge?: GroupChallenge; ready?: boolean; selection?: string[]; disconnect?: () => void;
}

const labels = { dingtalk: 'DingTalk', wecom: 'WeCom' }
const failure = (code: string, status = 400) => new OnboardingError(code, code, status)
const sourceKey = (kind: OfficeBotKind, id: string) => kind + '-' + id.slice(0, 12)
const pick = ({ id, label }: OfficeGroup): Group => ({ id, label })

export class OfficeBotPairing {
  private readonly attempts = new Map<OfficeBotKind, Attempt>()
  constructor(private readonly host: () => Runtime, private readonly onboarding: Onboarding) {}

  private file(kind: OfficeBotKind) { return join(this.host().config.stateDir, 'setup', kind + '-pairing.json') }
  private removeFile(kind: OfficeBotKind) {
    try { unlinkSync(this.file(kind)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  private saved(kind: OfficeBotKind) {
    const path = this.file(kind)
    try {
      if (!lstatSync(path).isFile()) throw Error('Expected a private pairing file')
      const saved = pendingFile.parse(JSON.parse(readFileSync(path, 'utf8')))
      if (saved.expiresAt > Date.now() && !this.host().config.sources.some(s => s.id === sourceKey(kind, saved.id))) return saved
      this.removeFile(kind)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw failure('office_pairing_storage')
    }
  }
  status(kind: OfficeBotKind): OfficePairingView {
    const attempt = this.attempts.get(kind)
    if (!attempt) return { stage: 'idle' }
    if (attempt.view.stage === 'applying' || attempt.view.stage === 'connected' || attempt.view.stage === 'failed') return attempt.view
    const host = this.host()
    const source = attempt.sourceId ? host.config.sources.find(s => s.id === attempt.sourceId) : undefined
    const challenge = source ? host.store.get<GroupChallenge>('office-group-challenge', source.id) : attempt.challenge
    if (!challenge || challenge.id !== attempt.id) return attempt.view
    if (challenge.expiresAt <= Date.now()) {
      this.stop(attempt)
      return attempt.view = { stage: 'failed', id: attempt.id, code: 'office_groups_expired' }
    }
    const current = source?.listenScopes ?? []
    const scopes = source && host.store.get<SavedGroups>('entry-label', source.id)?.scopes || []
    const groups = new Map(current.map(id => [id, scopes.find(group => group.id === id) ?? { id }]))
    for (const group of challenge.groups) groups.set(group.id, pick(group))
    if (!source && !attempt.ready) return { stage: 'starting', id: attempt.id }
    return { stage: 'groups', id: attempt.id, code: challenge.code, groups: [...groups.values()], selected: current }
  }

  start(kind: OfficeBotKind, sourceId: string | undefined, reset: boolean, authorize: () => void) {
    authorize()
    const old = this.attempts.get(kind)
    if (old?.view.stage === 'applying') throw failure('configuration_busy', 409)
    const current = this.status(kind)
    if (!reset && old?.sourceId === sourceId && !['idle', 'connected', 'failed'].includes(current.stage)) return current
    const host = this.host()
    const source = sourceId ? host.config.sources.find(s => s.kind === kind && s.id === sourceId && s.enabled && s.options.officePairing === true) : undefined
    if (sourceId && !source) throw failure('office_bot_unavailable', 404)
    if (old) this.stop(old)
    if (!sourceId && reset) this.removeFile(kind)
    const pending = !sourceId ? this.saved(kind) : undefined
    const id = pending?.id ?? randomUUID(), attempt: Attempt = { id, sourceId, controller: new AbortController(), view: { stage: 'preparing', id }, pending }
    this.attempts.set(kind, attempt)
    if (source) host.store.put('office-group-challenge', source.id, groupChallenge(id))
    else void this.enroll(kind, attempt, authorize)
    return this.status(kind)
  }

  private stop(attempt: Attempt) {
    attempt.controller.abort()
    attempt.disconnect?.()
    attempt.disconnect = undefined
  }

  private async enroll(kind: OfficeBotKind, attempt: Attempt, authorize: () => void) {
    const signal = attempt.controller.signal
    try {
      if (!attempt.pending) {
        const registration = await startOfficeRegistration(kind, signal)
        signal.throwIfAborted()
        const expiresAt = Date.now() + registration.ttl
        attempt.view = { stage: 'scan', id: attempt.id, qrUrl: registration.qrUrl, pageUrl: registration.pageUrl, expiresAt }
        while (Date.now() < expiresAt) {
          await delay(registration.interval, undefined, { signal, ref: false })
          if (Date.now() >= expiresAt) break
          const result = await registration.poll(signal).catch(error => {
            if (error instanceof z.ZodError) throw failure('office_scan_unavailable')
            return 'waiting' as const
          })
          signal.throwIfAborted()
          if (result === 'waiting') continue
          if (result === 'denied') throw failure('office_scan_denied')
          if (result === 'expired') break
          authorize()
          const pending = { id: attempt.id, credentials: result, expiresAt: Date.now() + 30 * 60_000 }
          atomicPrivateFile(this.file(kind), JSON.stringify(pending))
          attempt.pending = pending
          break
        }
        if (!attempt.pending) throw failure('office_scan_expired')
      }
      attempt.view = { stage: 'starting', id: attempt.id }
      this.discover(kind, attempt, attempt.pending.credentials)
    } catch (error) {
      if (!signal.aborted) {
        this.stop(attempt)
        attempt.view = { stage: 'failed', id: attempt.id, code: error instanceof OnboardingError ? error.code : 'office_scan_unavailable' }
      }
    }
  }

  private discover(kind: OfficeBotKind, attempt: Attempt, credentials: BotCredentials) {
    const challenge = attempt.challenge = groupChallenge(attempt.id)
    const signal = attempt.controller.signal
    const observe = (group: OfficeGroup, text: string) => {
      if (!signal.aborted && attempt.ready) observeOfficeGroup(challenge, group, text)
    }
    if (kind === 'dingtalk') {
      const stream = new DingtalkStream(credentials, status => { attempt.ready = status === 'ready' }, body => {
        const event = dingtalkMessage(body, credentials.id)
        if (event?.addressed) observe({ id: event.chat, label: event.title, actor: event.actor }, event.text)
      })
      attempt.disconnect = () => stream.close()
      stream.start()
    } else {
      const client = new WSClient({
        botId: credentials.id, secret: credentials.secret, wsUrl: 'wss://openws.work.weixin.qq.com',
        wsOptions: { maxPayload: 1_000_000, followRedirects: false }, requestTimeout: 5000, maxAuthFailureAttempts: 3,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      })
      const id = z.string().min(1).max(200).regex(/^[^\x00-\x20\x7f]+$/)
      client.on('authenticated', () => { attempt.ready = true })
      client.on('disconnected', () => { attempt.ready = false })
      client.on('reconnecting', () => { attempt.ready = false })
      client.on('error', () => { attempt.ready = false })
      client.on('message', frame => {
        const body = frame.body
        if (!body || body.aibotid !== credentials.id || body.chattype !== 'group' || body.msgtype !== 'text' || !body.text?.content) return
        const chat = id.safeParse(body.chatid), actor = id.safeParse(body.from?.userid)
        if (chat.success && actor.success) observe({ id: chat.data, actor: actor.data }, body.text.content)
      })
      attempt.disconnect = () => client.disconnect()
      client.connect()
    }
    void delay(30_000, undefined, { signal, ref: false }).then(() => {
      if (!attempt.ready) {
        this.stop(attempt)
        attempt.view = { stage: 'failed', id: attempt.id, code: 'office_bot_unavailable' }
      }
    }).catch(() => {})
    void delay(challenge.expiresAt - Date.now(), undefined, { signal, ref: false }).then(() => {
      if (attempt.view.stage === 'applying') return
      this.stop(attempt)
      attempt.view = { stage: 'failed', id: attempt.id, code: 'office_groups_expired' }
    }).catch(() => {})
  }

  async apply(kind: OfficeBotKind, id: string, selection: string[], rebuild: (config: Config) => Promise<void>, authorize: () => void) {
    authorize()
    const attempt = this.attempts.get(kind), view = this.status(kind)
    if (!attempt || id !== attempt.id) throw failure('office_pairing_missing', 404)
    if (view.stage === 'connected') {
      if (attempt.selection?.length !== new Set(selection).size || !attempt.selection.every(id => selection.includes(id)))
        throw failure('office_group_unavailable', 409)
      return view
    }
    if (view.stage !== 'groups') throw failure('office_bot_unavailable', 409)
    const groups = [...new Set(selection)].map(id => view.groups.find(group => group.id === id))
    if (!groups.length || groups.some(group => !group)) throw failure('office_group_unavailable', 409)
    const host = this.host(), old = host.config.sources.find(s => s.id === attempt.sourceId)
    const challenge = old ? host.store.get<GroupChallenge>('office-group-challenge', old.id) : attempt.challenge
    if (!challenge || challenge.id !== id || challenge.expiresAt <= Date.now()) throw failure('office_groups_expired')
    const ids = groups.map(group => group!.id)
    const actors = [...new Set([...(old?.allowedActors ?? []), ...challenge.groups.filter(item => ids.includes(item.id)).map(item => item.actor)])]
    const sourceId = attempt.sourceId ?? sourceKey(kind, id)
    if (old) {
      if (!old.enabled) throw failure('office_bot_unavailable', 409)
      host.updateSettings(host.settings.current().revision, { sources: host.config.sources.map(s => s.id === sourceId ? { ...s, listenScopes: ids, allowedActors: actors } : s) })
    } else {
      const pending = attempt.pending
      if (!pending || pending.expiresAt <= Date.now()) throw failure('office_pairing_missing')
      const env = 'AGENTHUB_SETUP_' + id.replaceAll('-', '').toUpperCase()
      const source = configSchema.shape.sources.element.parse({
        id: sourceId, kind, label: labels[kind], tokenEnv: env + '_EVENTS',
        options: {
          officePairing: true, officeBotPrincipal: pending.credentials.id,
          ...(kind === 'dingtalk' ? { dingtalk: { appIdEnv: env + '_BOT', appSecretEnv: env + '_SECRET' } } : {}),
        },
        cwd: setupWorkspace(host.config, join(host.config.stateDir, 'workspace', sourceId)),
        workspace: { mode: 'source' }, sandbox: 'read-only', listenScopes: ids, allowedActors: actors,
        ...(kind === 'wecom' ? { wecom: { botIdEnv: env + '_BOT', secretEnv: env + '_SECRET', directMessages: false } } : {}),
      })
      const plan = this.onboarding.sourcePlan(host.settings.current().revision, source, {
        [env + '_BOT']: pending.credentials.id, [env + '_SECRET']: pending.credentials.secret,
        [env + '_EVENTS']: randomBytes(32).toString('base64url'),
      })
      attempt.view = { stage: 'applying', id }
      try {
        await this.onboarding.apply(plan.id, async config => {
          attempt.disconnect?.()
          attempt.disconnect = undefined
          attempt.ready = false
          await rebuild(config)
        }, authorize)
      } catch (error) {
        if (attempt.ready) attempt.view = { stage: 'starting', id }
        else {
          this.stop(attempt)
          attempt.view = { stage: 'failed', id, code: error instanceof OnboardingError ? error.code : 'setup_apply_failed' }
        }
        throw error
      }
    }
    this.stop(attempt)
    attempt.pending = undefined
    attempt.challenge = undefined
    attempt.selection = ids
    attempt.view = { stage: 'connected', id, sourceId, groupCount: ids.length }
    this.host().store.put('entry-label', sourceId, { label: labels[kind], scopes: groups })
    if (old) this.host().store.db.prepare("DELETE FROM records WHERE kind='office-group-challenge' AND id=?").run(sourceId)
    else try { this.removeFile(kind) } catch { /* The committed source wins on the next read. */ }
    return attempt.view
  }

  close() { for (const attempt of this.attempts.values()) this.stop(attempt) }
}
