import {toolParallelism} from '../../src/execution-limits.ts'

// Supplies a single parallel web-fetch call to the isolated OpenCode child.
export const webFetchBatchModule = String.raw`
import { pageEvidence } from './web-evidence.mjs'

const maxUrls = ${toolParallelism}
const maxBatchBytes = 48 * 1024
const maxPageBytes = 5 * 1024 * 1024
const deadlineMs = 15000
const waiting = []
let active = 0

async function limitedFetch(run) {
  await new Promise(resolve => {
    const start = () => { active++; resolve() }
    if (active < maxUrls) start()
    else waiting.push(start)
  })
  try {
    return await run()
  } finally {
    active--
    waiting.shift()?.()
  }
}

async function readPage(response) {
  if (Number(response.headers.get('content-length')) > maxPageBytes) {
    await response.body?.cancel()
    throw Error('Response exceeds the 5 MB page limit')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxPageBytes) {
        await reader.cancel()
        throw Error('Response exceeds the 5 MB page limit')
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    return chunks.join('') + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function htmlText(html, sourceUrl) {
  const cleaned = new HTMLRewriter().on('head,script,style,noscript,iframe,object,embed,svg,nav,footer,[hidden],.toc-link-back,.pilcrow', {
    element(tag) { tag.remove() },
  }).transform(html)
  const parts = []
  const block = {
    element(tag) {
      parts.push('\n\n')
      tag.onEndTag(() => { parts.push('\n\n') })
    },
  }
  new HTMLRewriter().on('h1,h2,h3,h4,h5,h6', {
    element(tag) {
      parts.push('\n\n' + '#'.repeat(Number(tag.tagName[1])) + ' ')
      const id = tag.getAttribute('id')
      tag.onEndTag(() => {
        if (id) {
          const section = new URL(sourceUrl)
          section.hash = id
          parts.push(' [Section link](' + section.href.replaceAll('(', '%28').replaceAll(')', '%29') + ')')
        }
        parts.push('\n\n')
      })
    },
  }).on('p,li,dt,dd,pre,blockquote,tr', block).on('br', {
    element() { parts.push(' ') },
  }).onDocument({
    text(chunk) { parts.push(chunk.text.replace(/&nbsp;|&#160;|\s+/gu, ' ')) },
  }).transform(cleaned)
  return parts.join('')
}

function targetUrl(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 2000) throw Error('Use a URL of at most 2,000 bytes')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Error('Use an HTTP or HTTPS URL without embedded credentials')
  }
  return url
}

async function fetchPage(url, index, focus, search, signal, resultLimit) {
  const startedAt = Date.now()
  const reference = Buffer.byteLength(url.href) <= resultLimit - 320 ? url.href : 'URL #' + index + ' from tool input'
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/markdown,text/plain,application/json,application/xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw Error('HTTP ' + response.status)
    }
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (mime && !mime.startsWith('text/') && !/^application\/(?:xhtml\+xml|json|xml)$/u.test(mime)) {
      await response.body?.cancel()
      throw Error('Unsupported response type ' + mime)
    }
    const text = await readPage(response)
    const source = mime === 'text/html' || mime === 'application/xhtml+xml' ? htmlText(text, response.url || url.href) : text
    const { output, evidence } = pageEvidence(source, focus, search(), reference, resultLimit)
    return { output, page: { url: url.href, status: 'completed', startedAt, endedAt: Date.now(), ...evidence } }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : 'Request failed'
    return { output: 'Source: ' + reference + '\nFetch failed: ' + message,
      page: { url: url.href, status: 'failed', startedAt, endedAt: Date.now(), error: message } }
  }
}

export function webFetchBatch(focus, search) {
  return {
    description: 'Fetch up to ' + maxUrls + ' independent HTTP or HTTPS pages concurrently in one call, with a 15-second deadline per page. Returns source URLs and relevant passages. Cite the exact section links supplied with passages. Use this for two or more known URLs.',
    args: {
      urls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: maxUrls,
        description: 'Specific page URLs to retrieve together' },
    },
    async execute({ urls }, context) {
      if (!Array.isArray(urls) || urls.length < 1 || urls.length > maxUrls) throw Error('Provide 1–' + maxUrls + ' URLs')
      const inputs = [...new Set(urls)].map(targetUrl)
      await context.ask({ permission: 'webfetch', patterns: inputs.map(url => url.href), always: ['*'], metadata: {} })
      const resultLimit = Math.min(4000, Math.floor((maxBatchBytes - (inputs.length - 1) * 7) / inputs.length))
      const results = await Promise.all(inputs.map((url, i) =>
        limitedFetch(() => fetchPage(url, i + 1, focus, search, context.abort, resultLimit))))
      return {
        title: 'Fetch ' + results.length + ' pages in parallel',
        output: results.map(result => result.output).join('\n\n---\n\n'),
        metadata: { pages: results.map(result => result.page) },
      }
    },
  }
}
`
