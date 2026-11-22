import WebSocket from 'ws'
import { z } from 'zod'
import { officeJson, officeUrl, type BotCredentials } from '../office-bot-registration.ts'

const topic = '/v1.0/im/bot/messages/get'
const wireId = z.string().min(1).max(200).regex(/^[^\x00-\x20\x7f]+$/)
const groupMessage = z.object({
  conversationType: z.union([z.literal('2'), z.literal(2)]),
  conversationId: wireId, senderStaffId: wireId, msgId: wireId,
  robotCode: wireId.optional(), isInAtList: z.boolean().optional(),
  conversationTitle: z.string().max(200).optional(),
  msgtype: z.string(), text: z.object({ content: z.string().max(100_000) }).optional(), content: z.unknown().optional(),
})

export function dingtalkMessage(input: unknown, botId: string) {
  const result = groupMessage.safeParse(input)
  if (!result.success || result.data.robotCode && result.data.robotCode !== botId) return
  const data = result.data
  let text = data.msgtype === 'text' ? data.text?.content?.trim() : undefined
  if (data.msgtype === 'richText') {
    let content = data.content
    if (typeof content === 'string') {
      try { content = JSON.parse(content) } catch { return }
    }
    const parts = z.object({ richText: z.array(z.object({ text: z.string().optional() })).max(100) }).safeParse(content)
    if (parts.success) text = parts.data.richText.flatMap(item => item.text ?? []).join('\n').trim()
  }
  if (!text || text.length > 100_000) return
  return { chat: data.conversationId, actor: data.senderStaffId, id: data.msgId, title: data.conversationTitle, text, addressed: data.isInAtList }
}

type State = 'connecting' | 'ready' | 'reconnecting' | 'connection-error'
type Message = (body: unknown) => void

/** DingTalk's documented Stream endpoint and callback acknowledgement. */
export class DingtalkStream {
  private readonly controller = new AbortController()
  private socket?: WebSocket
  private retry?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private failures = 0

  constructor(private readonly credentials: BotCredentials, private readonly state: (state: State) => void, private readonly message: Message) {}

  start() { void this.open() }
  close() {
    this.controller.abort()
    clearTimeout(this.retry)
    clearInterval(this.heartbeat)
    this.socket?.terminate()
  }

  private reconnect(failed: boolean) {
    clearInterval(this.heartbeat)
    if (this.controller.signal.aborted) return
    this.state(failed ? 'connection-error' : 'reconnecting')
    this.retry = setTimeout(() => this.open(), Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5)))
    this.retry.unref()
  }

  private async open() {
    const { signal } = this.controller
    if (signal.aborted) return
    this.state(this.failures ? 'reconnecting' : 'connecting')
    try {
      const grant = await officeJson('https://api.dingtalk.com/v1.0/gateway/connections/open', signal, {
        clientId: this.credentials.id, clientSecret: this.credentials.secret, subscriptions: [{ type: 'CALLBACK', topic }],
      })
      signal.throwIfAborted()
      const address = officeUrl(grant.endpoint, 'dingtalk.com', 'wss:')
      address.searchParams.set('ticket', z.string().min(1).max(4000).parse(grant.ticket))
      const socket = this.socket = new WebSocket(address, { handshakeTimeout: 12_000, maxPayload: 1_000_000, followRedirects: false })
      let healthy = true
      socket.on('error', () => socket.terminate())
      socket.once('close', () => { this.socket = undefined; this.reconnect(false) })
      socket.on('pong', () => { healthy = true })
      socket.once('open', () => {
        this.failures = 0
        this.state('ready')
        this.heartbeat = setInterval(() => {
          if (!healthy) { socket.terminate(); return }
          healthy = false
          socket.ping()
        }, 25_000)
        this.heartbeat.unref()
      })
      socket.on('message', data => {
        let frame
        try { frame = JSON.parse(data.toString()) } catch { return }
        const { headers, type } = frame ?? {}
        if (type === 'SYSTEM') {
          if (headers?.topic === 'disconnect') socket.terminate()
          if (headers?.topic === 'ping') socket.send(JSON.stringify({ code: 200, headers, message: 'OK', data: frame.data }))
          return
        }
        if (type !== 'CALLBACK' || headers?.topic !== topic || !wireId.safeParse(headers.messageId).success) return
        let body
        try { body = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data } catch { return }
        try { this.message(body) } catch { return } // Retain the provider's ability to redeliver an uncommitted message.
        socket.send(JSON.stringify({ code: 200, headers: { contentType: 'application/json', messageId: headers.messageId }, message: 'OK', data: '{"response":null}' }))
      })
    } catch { this.reconnect(true) }
  }
}
