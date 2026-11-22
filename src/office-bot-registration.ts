import { z } from 'zod'

export const officeBotKinds = ['dingtalk', 'wecom'] as const
export type OfficeBotKind = typeof officeBotKinds[number]
export type BotCredentials = { id: string; secret: string }
export const botCredentials = z.object({
  id: z.string().min(1).max(200).regex(/^[^\x00-\x20\x7f]+$/),
  secret: z.string().min(1).max(500).regex(/^[^\x00-\x20\x7f]+$/),
}).strict()

type Registration = {
  qrUrl: string
  pageUrl: string
  ttl: number
  interval: number
  poll(signal: AbortSignal): Promise<BotCredentials | 'waiting' | 'expired' | 'denied'>
}

export async function officeJson(url: string | URL, signal: AbortSignal, body?: object) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...(body && { 'content-type': 'application/json' }) },
    ...(body && { method: 'POST', body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  })
  if (!response.ok) throw Error('Office provider request failed')
  return response.json()
}

export function officeUrl(value: string, domain: string, protocol = 'https:') {
  const url = new URL(value)
  if (url.protocol !== protocol || url.username || url.password || url.port || url.hash ||
    (url.hostname !== domain && !url.hostname.endsWith('.' + domain))) throw Error('Unexpected office provider URL')
  return url
}

async function dingtalk(signal: AbortSignal): Promise<Registration> {
  // DingTalk's published DSH registration template creates an internal app and robot.
  const source = 'DING_DSH'
  const request = async (action: string, body: object, signal: AbortSignal) => {
    const result = await officeJson('https://oapi.dingtalk.com/app/registration/' + action, signal, body)
    if (result?.errcode !== 0) throw Error('DingTalk registration failed')
    return result
  }
  const init = await request('init', { source }, signal)
  const nonce = z.string().min(1).max(4000).parse(init.nonce)
  const result = await request('begin', { nonce }, signal)
  const code = z.string().min(1).max(4000).parse(result.device_code)
  const url = officeUrl(result.verification_uri_complete, 'dingtalk.com')
  url.searchParams.set('source', source)
  const seconds = z.number().positive().optional()
  return {
    qrUrl: url.href, pageUrl: url.href,
    ttl: Math.min(seconds.parse(result.expires_in) ?? 600, 600) * 1000,
    interval: Math.max(seconds.parse(result.interval) ?? 3, 1) * 1000,
    async poll(signal) {
      const result = await request('poll', { device_code: code }, signal)
      if (result.status === 'SUCCESS') return botCredentials.parse({ id: result.client_id, secret: result.client_secret })
      if (result.status === 'EXPIRED') return 'expired'
      if (result.status === 'FAIL') return 'denied'
      return 'waiting'
    },
  }
}

async function wecom(signal: AbortSignal): Promise<Registration> {
  // Same first-party smart-bot QR exchange as WecomTeam/wecom-cli.
  const source = 'wecom_cli_external'
  const plat = { darwin: '1', win32: '2', linux: '3' }[process.platform as string] ?? '0'
  const root = 'https://work.weixin.qq.com/ai/qc/'
  const { data } = await officeJson(root + 'generate?' + new URLSearchParams({ source, plat }), signal)
  const scode = z.string().min(1).max(4000).parse(data?.scode)
  const qrUrl = officeUrl(data?.auth_url, 'weixin.qq.com').href
  return {
    qrUrl, pageUrl: root + 'gen?' + new URLSearchParams({ source, scode }), ttl: 300_000, interval: 3_000,
    async poll(signal) {
      const { data } = await officeJson(root + 'query_result?' + new URLSearchParams({ scode }), signal)
      if (data?.status !== 'success') return 'waiting'
      return botCredentials.parse({ id: data.bot_info?.botid, secret: data.bot_info?.secret })
    },
  }
}

export const startOfficeRegistration = (kind: OfficeBotKind, signal: AbortSignal) => kind === 'dingtalk' ? dingtalk(signal) : wecom(signal)
