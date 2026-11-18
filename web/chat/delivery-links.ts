import type { ChatDelivery } from '../../src/chat-deliveries.ts'

export function downloadUrl(file: Pick<ChatDelivery, 'id' | 'conversationId'>) {
  return '/api/chat/conversations/' + file.conversationId + '/deliveries/' + file.id
}

/** Resolve model-written file references against this message's actual handoffs. */
export function deliveryHref(raw: string, files: ChatDelivery[]) {
  const href = raw.trim()
  if (/^(?:https?:|mailto:|tel:|\/\/|#|\/api\/chat\/|\/configure(?:[/#?]|$)|\/chat(?:[/#?]|$))/i.test(href)) return href

  const path = href.split(/[?#]/, 1)[0]!
  let name: string
  try {
    name = decodeURIComponent(path.split(/[/\\]/).at(-1) ?? '')
  } catch {
    return ''
  }
  const matches = files.filter(file => file.name === name)
  if (matches.length === 1) return downloadUrl(matches[0]!)

  const localPath = /^(?:file:|sandbox:|\/(?:tmp|private|home|Users|var|mnt|workspace)\/)/i.test(href)
  const fileName = /\.[\w-]{1,12}$/.test(name)
  return localPath || fileName ? '' : href
}
