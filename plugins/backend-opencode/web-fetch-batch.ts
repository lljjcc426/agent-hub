import {toolParallelism} from '../../src/execution-limits.ts'
import {maxWebPageCheckpointBytes} from '../../src/backends/opencode-web-checkpoint.ts'

// Supplies a single parallel web-fetch call to the isolated OpenCode child.
export const webFetchBatchModule = String.raw`
import { capturePageEvidence, renderPageEvidence } from './web-evidence.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

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

function checkpointPage(directory, snapshot) {
  if (!directory) return
  const text = JSON.stringify(snapshot)
  if (Buffer.byteLength(text) > ${maxWebPageCheckpointBytes}) return
  const path = join(directory, createHash('sha256').update(snapshot.url).digest('hex') + '.json')
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (realpathSync(directory) !== directory) return
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } catch {
    // A page can still be returned to the model if its checkpoint cannot be written.
    try { if (realpathSync(directory) === directory) rmSync(temporary, { force: true }) } catch {}
  }
}

async function fetchPage(url, focus, search, signal) {
  const startedAt = Date.now()
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
    const evidence = capturePageEvidence(source, focus, search)
    return { url: url.href, startedAt, endedAt: Date.now(), ...evidence }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : 'Request failed'
    return { url: url.href, startedAt, endedAt: Date.now(), error: message }
  }
}

export function webFetchBatch(focus, search, directory, seed = []) {
  const recovered = new Map(seed.map(page => [page.url, page]))
  return {
    description: 'Fetch up to ' + maxUrls + ' independent HTTP or HTTPS pages concurrently in one call, with a 15-second deadline per page. Returns source URLs and relevant passages. Cite the exact section links supplied with passages. Use this for two or more known URLs.',
    args: {
      urls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: maxUrls,
        description: 'Specific page URLs to retrieve together' },
    },
    async execute({ urls }, context) {
      if (!Array.isArray(urls) || urls.length < 1 || urls.length > maxUrls) throw Error('Provide 1–' + maxUrls + ' URLs')
      const inputs = [...new Set(urls.map(value => targetUrl(value).href))].map(url => new URL(url))
      await context.ask({ permission: 'webfetch', patterns: inputs.map(url => url.href), always: ['*'], metadata: {} })
      const resultLimit = Math.min(4000, Math.floor((maxBatchBytes - (inputs.length - 1) * 7) / inputs.length))
      const query = search()
      const results = await Promise.all(inputs.map(async (url, i) => {
        const reference = Buffer.byteLength(url.href) <= resultLimit - 320 ? url.href : 'URL #' + (i + 1) + ' from tool input'
        const saved = recovered.get(url.href)
        const page = saved ?? await limitedFetch(() => fetchPage(url, focus, query, context.abort))
        if (page.error !== undefined) {
          return { output: 'Source: ' + reference + '\nFetch failed: ' + page.error, page: { ...page, status: 'failed' } }
        }
        checkpointPage(directory, page)
        const { output, evidence } = renderPageEvidence(page, reference, resultLimit)
        return { output, page: { url: page.url, status: 'completed', startedAt: page.startedAt, endedAt: page.endedAt,
          ...evidence, ...(saved ? { reused: true } : {}) } }
      }))
      return {
        title: 'Fetch ' + results.length + ' pages in parallel',
        output: results.map(result => result.output).join('\n\n---\n\n'),
        metadata: { pages: results.map(result => result.page) },
      }
    },
  }
}
`
