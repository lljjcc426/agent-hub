import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import protobuf from 'protobufjs/minimal.js'
import { WebSocketServer } from 'ws'
import { configSchema, type Config } from '../../../src/config.ts'
import { Runtime } from '../../../src/runtime.ts'
import { serve } from '../../../src/server.ts'

const root = resolve(process.argv[2]!)
mkdirSync(join(root, 'workspace'), { recursive: true })
const flag = (file: string) => existsSync(join(root, file))
const groups = [{ chat_id: 'oc_build', name: '研发协作' }, { chat_id: 'oc_launch', name: '发布准备' }, { chat_id: 'oc_other', name: '另一个群' }]
const settings = { PingInterval: 60, ReconnectCount: 5, ReconnectInterval: 1, ReconnectNonce: 1 }
const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' })
await new Promise<void>(resolve => sockets.once('listening', resolve))
const port = (sockets.address() as { port: number }).port
const messages = new Map<string, { chat_id: string; message_id: string; create_time: string; chat_type: 'group'|'p2p'; sender: { id: string; id_type: string; sender_type: string }; body: { content: string } }>()
function frame(method: number, headers: Record<string, string>, payload: unknown) {
  const writer = protobuf.Writer.create().uint32(8).uint64(1).uint32(16).uint64(1).uint32(24).int32(1).uint32(32).int32(method)
  for (const [key, value] of Object.entries(headers)) writer.uint32(42).fork().uint32(10).string(key).uint32(18).string(value).ldelim()
  return writer.uint32(66).bytes(Buffer.from(JSON.stringify(payload))).finish()
}
sockets.on('connection', socket => socket.once('message', () => socket.send(frame(0, { type: 'pong' }, settings))))
const emitter = setInterval(() => {
  if (!flag('events.json') || !sockets.clients.size) return
  const events: { chat: string; message: string; ago?: number; type?: 'group'|'p2p'; actor?:string }[] = JSON.parse(readFileSync(join(root, 'events.json'), 'utf8'))
  unlinkSync(join(root, 'events.json'))
  for (const { chat, message, ago = 0, type = 'group', actor = 'ou_pairing_owner' } of events) {
    const create_time = String(Date.now() - ago)
    messages.set(message, { chat_id: chat, message_id: message, create_time, chat_type: type,
      sender: { id: actor, id_type: 'open_id', sender_type: 'user' },
      body: { content: JSON.stringify({ text: 'Fixture group message' }) } })
    const packet = frame(1, { type: 'event', message_id: message, sum: '1', seq: '0', trace_id: message },
      { schema: '2.0', header: { event_id: message, event_type: 'im.message.receive_v1', create_time },
        event: { message: { chat_id: chat, message_id: message, chat_type: type } } })
    for (const socket of sockets.clients) socket.send(packet)
  }
}, 80)

let attempts = 0
defaultHttpInstance.defaults.adapter = async req => {
  const url = new URL(req.url!)
  let data
  if (url.pathname === '/oauth/v1/app/registration') {
    const action = new URLSearchParams(req.data).get('action')
    if (action === 'begin') data = { device_code: 'fixture-' + ++attempts, interval: .15, expires_in: flag('expire-qr') ? 2 : 90,
      verification_uri_complete: 'https://open.feishu.cn/fixture/confirm?attempt=' + attempts }
    else if (action === 'poll') data = flag('approve') ? {
      client_id: 'cli_1234567890abcdef', client_secret: 'fixture-do-not-expose',
      user_info: { open_id: 'ou_pairing_owner', tenant_brand: 'feishu' },
    } : { error: 'authorization_pending' }
    else throw Error('Unexpected registration request')
  } else if (url.pathname === '/callback/ws/endpoint') {
    data = { code: 0, data: { URL: 'ws://127.0.0.1:' + port + '/?device_id=fixture&service_id=1', ClientConfig: settings } }
  } else throw Error('Unexpected SDK request')
  return { data, status: 200, statusText: 'OK', headers: {}, config: req }
}

const nativeFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  if (url.hostname === '127.0.0.1') return nativeFetch(input, init)
  if (url.hostname !== 'open.feishu.cn') throw Error('Unexpected fixture network destination')
  const path = url.pathname.replace(/^\/open-apis\//, '')
  if (path === 'auth/v3/tenant_access_token/internal') {
    const auth = JSON.parse(String(init?.body))
    if (auth.app_id !== 'cli_1234567890abcdef' || auth.app_secret !== 'fixture-do-not-expose') return Response.json({ code: 1 })
    return Response.json({ code: 0, tenant_access_token: 'fixture-api-token', expire: 7200 })
  }
  if (new Headers(init?.headers).get('authorization') !== 'Bearer fixture-api-token') return Response.json({ code: 1 })
  if (path === 'bot/v3/info') return Response.json({ code: 0, bot: { open_id: 'ou_fixture_bot', app_name: 'Roppo' } })
  if (path === 'im/v1/chats') return Response.json({ code: 0, data: { items: flag('show-groups') ? groups : [] } })
  if (path === 'im/v1/messages') return Response.json(flag('deny-read') ? { code: 99991672 } : { code: 0, data: { items: [] } })
  if (path.startsWith('im/v1/messages/') && path.endsWith('/reply') && init?.method === 'POST') {
    const anchor = path.split('/')[3]!
    const body = JSON.parse(String(init.body))
    appendFileSync(join(root,'reply-receipts.jsonl'),JSON.stringify({anchor,private:body.reply_in_thread===false})+'\n')
    return Response.json({code:0,data:{message_id:'om_replied_'+anchor}})
  }
  if (path.startsWith('im/v1/messages/')) {
    const message = messages.get(path.split('/')[3]!)
    return Response.json(message ? { code: 0, data: { items: [message] } } : { code: 1 })
  }
  throw Error('Unexpected API request')
}

const config = configSchema.parse({ stateDir: join(root, 'state'), port: 0, execution:{router:{mode:'host'}}, work: { sandboxDriver: 'disabled', network: false },
  sources: [{ id: 'local', kind: 'local', cwd: join(root, 'workspace'), allowedActors: ['operator'] }] })
const model = { async run() { return { threadId: 'fixture', turnId: 'fixture', text: '{"reply":"Fixture response"}' } } }
const makeRuntime = (next: Config, _activationId?: string, startupSourceIds?: readonly string[]) => {
  if (flag('fail-rebuild') && next.sources.some(source => source.kind === 'feishu')) {
    unlinkSync(join(root, 'fail-rebuild'))
    throw Error('Simulated failure before starting the new runtime')
  }
  return new Runtime(next, { model, startupSourceIds })
}
const host = await serve(makeRuntime(config), { createRuntime: makeRuntime, clientHome: join(root, 'client') })
const token = readFileSync(host.tokenPath, 'utf8').trim()
const account = { username: 'connector-test', password: 'Roppo-connectors-fixture!2026', remember: true }
const existing = (await (await fetch(host.url + '/account/status')).json()).configured
const login = await fetch(host.url + '/account/' + (existing ? 'login' : 'setup'), { method: 'POST',
  headers: { authorization: 'Bearer ' + token, origin: host.url, 'content-type': 'application/json' },
  body: JSON.stringify(existing ? account : { ...account, displayName: 'Connector test' }) })
if (!login.ok) throw Error('Fixture could not open its local account')
const cookie = login.headers.get('set-cookie')!.split(';')[0]!
writeFileSync(join(root, 'browser.json'), JSON.stringify({ base: host.url, cookie }), { mode: 0o600 })
console.log('ready')
async function close() {
  clearInterval(emitter)
  host.server.closeAllConnections()
  await new Promise<void>(resolve => host.server.close(() => resolve()))
  await host.closeRuntime()
  for (const socket of sockets.clients) socket.terminate()
  sockets.close()
}
process.once('SIGTERM', () => void close())
process.once('SIGINT', () => void close())
