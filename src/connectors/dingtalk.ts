import { MessageSource, UncertainDelivery, bodyDigest, type Incoming, type SourceContext } from '../sources.ts'
import type { SourceConfig } from '../config.ts'
import { dingtalkBotSettings } from '../connector-config.ts'
import type { OutboundMessage, Trigger } from '../vendor/dsh-core/index.ts'
import { DingtalkStream, dingtalkMessage } from './dingtalk-stream.ts'
import { captureOfficeGroup } from '../office-groups.ts'
import { botCredentials, officeJson } from '../office-bot-registration.ts'

type DingMessage = NonNullable<ReturnType<typeof dingtalkMessage>>
type Inbox = { trigger: Trigger; message: DingMessage; receivedAt: number }
type Token = { value: string; expiresAt: number }

export class DingtalkSource extends MessageSource {
  private stream?: DingtalkStream
  private ctx?: SourceContext
  private ready = false
  private readonly shutdown = new AbortController()
  private token?: Token
  private fetchingToken?: Promise<Token>

  constructor(config: SourceConfig) { super(config) }
  private get credentials() {
    const { appIdEnv, appSecretEnv } = dingtalkBotSettings.parse(this.config.options.dingtalk)
    return botCredentials.parse({ id: process.env[appIdEnv], secret: process.env[appSecretEnv] })
  }
  async identity() { return { id: this.credentials.id, type: 'bot', verified: this.ready } }
  start(ctx: SourceContext) {
    if (this.shutdown.signal.aborted) return
    this.ctx = ctx
    if (this.stream) return
    const credentials = this.credentials
    this.stream = new DingtalkStream(credentials, status => {
      this.ready = status === 'ready'
      ctx.store.put('source-live', this.config.id, { source: this.config.id, status, at: Date.now(), authenticated: this.ready })
    }, body => {
      const event = dingtalkMessage(body, credentials.id)
      if (event) this.receive(event)
    })
    this.stream.start()
  }

  private allowed(chat: string) { return this.config.listenScopes?.includes(chat) === true }
  validThread(thread: string) {
    try { return thread.startsWith('group:') && this.allowed(decodeURIComponent(thread.slice(6))) } catch { return false }
  }
  observe(input: Incoming, actor: string, human: boolean) {
    if (!input.scope || input.thread !== 'group:' + encodeURIComponent(input.scope) || !input.at) throw Error('A scoped DingTalk message is required')
    return this.receive({ id: input.id, chat: input.scope, actor, text: input.text, title: undefined, addressed: false }, human, input.at)
  }

  private receive(message: DingMessage, human = true, at?: string) {
    const ctx = this.ctx
    if (!ctx || !this.config.enabled || this.shutdown.signal.aborted || !at && !this.ready) return { disposition: 'unavailable' }
    if (message.addressed && captureOfficeGroup(ctx.store, this.config.id, { id: message.chat, label: message.title, actor: message.actor }, message.text)) return
    if (!this.allowed(message.chat)) return { disposition: 'ignored' }
    const key = this.config.id + ':' + bodyDigest(message.id)
    if (ctx.store.get<Inbox>('dingtalk-inbox', key)) return { disposition: 'duplicate' }
    const thread = 'group:' + encodeURIComponent(message.chat)
    const trigger = this.trigger({ id: 'message:' + bodyDigest(message.id), thread, text: message.text, addressed: message.addressed === true, scope: message.chat, at }, message.actor, human)
    trigger.meta = { ...trigger.meta, messageId: message.id, messageKey: key, chat: message.chat }
    trigger.channel!.address = { chat: message.chat, messageKey: key }
    return ctx.store.atomic(() => {
      ctx.store.put('dingtalk-inbox', key, { trigger, message, receivedAt: Date.now() } satisfies Inbox)
      const outcome = ctx.receive(trigger)
      if (message.addressed === false) ctx.store.put('office-group-observed', this.config.id + ':' + message.chat, { at: Date.now() })
      return outcome
    })
  }

  async context(thread: string) {
    if (!this.ctx || !this.config.enabled || !this.validThread(thread)) throw Error('DingTalk group is unavailable')
    return this.ctx.store.list<Inbox>('dingtalk-inbox').filter(r => r.trigger.source === this.config.id && r.trigger.channel?.thread === thread)
      .sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 20).reverse()
      .map(({ message }) => ({ id: message.id, from: message.actor, chat: message.chat, text: message.text }))
  }
  async read(request: { resource: string; trigger?: Trigger; pageSize: number }) {
    const trigger = request.trigger
    if (!this.ctx || !this.config.enabled || !trigger || trigger.source !== this.config.id || !this.validThread(trigger.threads[0]?.id ?? '')) throw Error('A configured DingTalk group is required')
    const row = this.ctx.store.get<Inbox>('dingtalk-inbox', String(trigger.meta.messageKey))
    if (!row || row.trigger.id !== trigger.id) throw Error('DingTalk message unavailable')
    if (request.resource === 'conversation') return this.context(trigger.threads[0]!.id)
    if (request.resource !== 'message') throw Error('DingTalk resource unavailable')
    const { id, actor, chat, text } = row.message
    return { id, from: actor, chat, text }
  }

  private accessToken(): Promise<Token> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return Promise.resolve(this.token)
    const { id, secret } = this.credentials
    this.fetchingToken ??= officeJson('https://api.dingtalk.com/v1.0/oauth2/accessToken', this.shutdown.signal, { appKey: id, appSecret: secret })
      .then(result => {
        if (typeof result.accessToken !== 'string' || !result.accessToken || !Number.isFinite(result.expireIn)) throw Error('DingTalk access token unavailable')
        return this.token = { value: result.accessToken, expiresAt: Date.now() + result.expireIn * 1000 }
      }).finally(() => { this.fetchingToken = undefined })
    return this.fetchingToken
  }

  async deliver(message: OutboundMessage) {
    const ctx = this.ctx
    const anchor = ctx?.store.get<Inbox>('dingtalk-inbox', message.channel.address.messageKey ?? '')
    const check = () => {
      if (!this.config.enabled || !anchor || anchor.trigger.source !== this.config.id || anchor.trigger.channel?.thread !== message.channel.thread ||
        anchor.message.chat !== message.channel.address.chat || !this.validThread(message.channel.thread)) throw Error('DingTalk delivery is outside the original group')
      this.shutdown.signal.throwIfAborted()
    }
    check()
    if (Buffer.byteLength(message.text) > 20_000) throw Error('DingTalk reply exceeds the text limit')
    const { value } = await this.accessToken()
    check()
    await ctx?.beforeExternalWrite?.()
    check()
    // The active group-send API outlives an individual message's temporary reply URL.
    try {
      const response = await fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15_000)]),
        headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': value },
        body: JSON.stringify({ robotCode: this.credentials.id, openConversationId: anchor!.message.chat,
          msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: 'Roppo', text: message.text }) }),
      })
      const result = await response.json()
      if (!response.ok || typeof result.processQueryKey !== 'string' || !result.processQueryKey) throw Error('DingTalk send unconfirmed')
    } catch { throw new UncertainDelivery('DingTalk send outcome unknown; check the original group before retrying') }
  }

  async close() {
    this.shutdown.abort()
    this.stream?.close()
    await this.fetchingToken?.catch(() => {})
    this.ready = false
    this.ctx = undefined
  }
}
