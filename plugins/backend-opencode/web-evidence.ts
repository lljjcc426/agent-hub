// Kept with the managed adapter so the isolated OpenCode child can load it without npm.
export const webEvidenceModule = String.raw`
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const inputLimit = 8 * 1024 * 1024
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
const eastAsian = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const ignored = new Set(('about an and are as at be by can compare could did do does for from had has have how i in is it its me of on or our please show that the their them then there these this those to use used was we what when where which who why will with would you your search fetch webfetch websearch page pages results http https markdown text url '+
  '的 了 和 与 或 是 在 请 用 查 搜索 网页 抓取 结果 来源 工具 同一 并行 确认 实测 模型 说明 区别').split(' '))

function terms(focus, search) {
  const weights = new Map()
  for (const query of [search, focus]) {
    const chunks = query.slice(0, 4000).normalize('NFKC').toLowerCase()
      .replace(/https?:\/\/\S+/gu, ' ').match(/[\p{L}\p{N}\p{M}]+(?:[-_.][\p{L}\p{N}\p{M}]+)*/gu) ?? []
    for (const chunk of chunks) {
      const words = eastAsian.test(chunk)
        ? Array.from(segmenter.segment(chunk)).filter(part => part.isWordLike).map(part => part.segment)
        : [chunk]
      for (const word of words) {
        if (word.length < 2 || word.length > 64 || ignored.has(word)) continue
        const weight = (/[-_.]/u.test(word) ? 5 : 1) + (query === focus ? 1 : 0)
        weights.set(word, Math.max(weights.get(word) ?? 0, weight))
      }
    }
  }
  return new Map([...weights].sort((a, b) => b[1] - a[1]).slice(0, 32))
}

function fullText(root, result) {
  const file = result.metadata?.outputPath
  if (!result.metadata?.truncated || typeof file !== 'string') return result.output
  try {
    const directory = realpathSync(join(root, 'data', 'opencode', 'tool-output'))
    const path = realpathSync(file)
    if (dirname(path) !== directory) return result.output
    const info = statSync(path)
    if (info.isFile() && info.size <= inputLimit) {
      return readFileSync(path, 'utf8')
    }
  } catch {
    // The CLI's visible excerpt is still available if its temporary copy expired.
  }
  return result.output
}

function excerpt(body, anchor) {
  if (body.length <= 800) return body
  const first = Math.max(0, anchor - 200)
  const boundary = body.indexOf(' ', first)
  const start = first > 0 && boundary >= first && boundary < anchor ? boundary + 1 : first
  const cap = Math.min(body.length, start + 800)
  const end = cap < body.length ? Math.max(start + 720, body.lastIndexOf(' ', cap)) : cap
  return (start ? '… ' : '') + body.slice(start, end).trim() + (end < body.length ? ' …' : '')
}

function plainMarkdown(value) {
  return value.replace(/\[([^\]\n]+)\]\([^\n)]*\)/gu, '$1')
}

function passages(source, weights) {
  const patterns = [...weights.keys()].sort((a, b) => b.length - a.length).map(word => {
    const literal = word.replace(/[.*+?^{}()|[\]\\]/gu, '\\$&')
    return eastAsian.test(word) ? literal : '(?<![\\p{L}\\p{N}])' + literal + '(?![\\p{L}\\p{N}])'
  })
  const pattern = patterns.length ? new RegExp(patterns.join('|'), 'gu') : /(?!)/
  const candidates = new Map()
  const headings = []
  for (const block of source.split(/\r?\n[ \t]*\r?\n+/u)) {
    const paragraph = block.trim()
    const headingLine = /^(#{1,6}|(?:\d+\.)+)\s+[^\n]{1,400}(?:\r?\n|$)/u.exec(paragraph)
    if (headingLine) {
      const marker = headingLine[1]
      const depth = marker.startsWith('#') ? marker.length : marker.split('.').length - 1
      headings.length = depth
      headings[depth - 1] = headingLine[0].trim().replace(/\s+\[Skip to TOC\]\([^)]*\)/giu, '')
    }
    const body = paragraph.slice(headingLine?.[0].length ?? 0).replace(/\s+/gu, ' ').trim()
    if (body.length < 24 || /^(?:\x60{3}|~{3}|\.\.\.\d+|(?:[-*]\s+)?\[[^\]]+\]\([^)]+\)(?:\s+[-*]\s+\[|$))/u.test(body)) continue
    if ((body.match(/\]\(/gu) ?? []).length >= 6 && /\s[-*]\s+\[/u.test(body)) continue
    const lower = body.normalize('NFKC').toLowerCase()
    const heading = headings.at(-1) ?? ''
    const trail = headings.filter(Boolean).slice(-2)
    const section = plainMarkdown(heading.replace(/\s+\[Section link\]\([^)]*\)$/u, '')).normalize('NFKC').toLowerCase()
    const hits = new Set()
    let anchor = 0
    let best = 0
    let score = 0
    for (const match of lower.matchAll(pattern)) {
      const weight = weights.get(match[0]) ?? 0
      if (weight > best) {
        best = weight
        anchor = match.index
      }
      if (!hits.has(match[0])) {
        hits.add(match[0])
        score += weight
      }
    }
    for (const match of new Set([...section.matchAll(pattern)].map(m => m[0]))) {
      const weight = weights.get(match) ?? 0
      score += (hits.has(match) ? 3 : 1) * weight
      hits.add(match)
    }
    const title = section.replace(/^#{1,6}\s+/u, '').replace(/^(?:\d+\\?\.)+\s+/u, '').replace(/\x60/gu, '').trim()
    const topic = weights.get(title) ?? 0
    if (topic >= 6 && hits.has(title)) score += 4 * topic
    if (score === 0 && weights.size > 0) continue
    const text = excerpt(body, anchor)
    if (!candidates.has(text)) candidates.set(text, { trail, text, hits, score })
  }

  const selected = []
  const covered = new Set()
  const selectedSections = new Set()
  const ranked = [...candidates.values()]
  const relevance = item => (selectedSections.has(item.trail.join('\n')) ? item.score / 3 : item.score)
    + [...item.hits].reduce((total, hit) => total + (covered.has(hit) ? 0 : 2 * weights.get(hit)), 0)
  while (ranked.length && selected.length < 4) {
    ranked.sort((a, b) => relevance(b) - relevance(a))
    const next = ranked.shift()
    for (const hit of next.hits) covered.add(hit)
    const trail = next.trail.join('\n')
    selectedSections.add(trail)
    selected.push((trail ? trail + '\n' : '') + next.text)
  }
  return selected
}

export function capturePageEvidence(source, focus, search) {
  return { sourceBytes: Buffer.byteLength(source), excerpts: passages(source, terms(focus, search)) }
}

export function renderPageEvidence({ sourceBytes, excerpts }, url, resultLimit = 4000) {
  if (Buffer.byteLength(url) > 2000) url = new URL(url).origin + ' (long URL in tool input)'
  let output = 'Source: ' + url + '\n'
  let count = 0
  for (const passage of excerpts) {
    const next = '\n' + passage + '\n'
    if (Buffer.byteLength(output + next) > resultLimit) continue
    output += next
    count++
  }
  output = count ? output.trimEnd() : output + 'No passage matched the task in the retrieved text.'
  return { output, evidence: { sourceBytes, evidenceBytes: Buffer.byteLength(output), passages: count } }
}

export function pageEvidence(source, focus, search, url, resultLimit = 4000) {
  return renderPageEvidence(capturePageEvidence(source, focus, search), url, resultLimit)
}

export function focusWebFetch(root, focus, search, args, result) {
  if (typeof result.output !== 'string' || result.attachments?.length) return
  const url = typeof args.url === 'string' ? args.url : result.title
  const focused = pageEvidence(fullText(root, result), focus, search, url)
  result.output = focused.output
  result.metadata = { ...result.metadata, webEvidence: focused.evidence }
}
`
