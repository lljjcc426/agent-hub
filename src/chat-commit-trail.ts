import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'

export type CommitKind = 'feature' | 'fix' | 'docs' | 'merge' | 'release'
export interface ChatCommit {
  id: string
  message: string
  author: { name: string }
  at: number
  kind?: CommitKind
  body?: string
  files?: number
  added?: number
  removed?: number
  commits?: ChatCommit[]
}

export interface CommitHistory {
  branch: string
  branches: string[]
  commits: ChatCommit[]
  hasMore: boolean
}

export interface CommitRepository { id: string; label: string }
export interface ChatCommitHistory extends Partial<CommitHistory> {
  repositories: CommitRepository[]
  repository?: string
}

export const trailLimit = 20
const mergeLimit = 6
const execute = promisify(execFile)
const gitOptions = [
  '--no-replace-objects', '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never',
]
const gitEnv = {
  PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
}
async function git(cwd: string, args: string[], signal: AbortSignal) {
  const {stdout} = await execute('git', [...gitOptions, ...args], {
    cwd, env: gitEnv, encoding: 'utf8', signal, timeout: 3000, maxBuffer: 2 * 1024 * 1024,
  })
  return stdout
}

export async function commitRepository(cwd: string, signal: AbortSignal) {
  try {
    const directory = await realpath(cwd)
    const root = (await git(directory, ['rev-parse', '--show-toplevel'], signal)).trim()
    // A configured non-Git folder may be inside an unrelated checkout.
    if (await realpath(root) === directory) return directory
  } catch {
    signal.throwIfAborted()
  }
}

export function commitKind(message: string, parents: string[]): CommitKind | undefined {
  if (parents.length > 1) return 'merge'
  const type = /^(feat|fix|docs|release)(?:[!(: ]|$)/i.exec(message)?.[1]?.toLowerCase()
  return type === 'feat' ? 'feature' : type as Exclude<CommitKind, 'feature' | 'merge'> | undefined
}

const format = '%H%x00%P%x00%an%x00%at%x00%s%x00%b'
async function log(cwd: string, refs: string[], limit: number, signal: AbortSignal, firstParent = false) {
  const data = await git(cwd, [
    'log', ...(firstParent ? ['--first-parent'] : []), '-z', '--max-count=' + limit,
    '--encoding=UTF-8', '--format=' + format, ...refs, '--',
  ], signal)
  const fields = data.split('\0')
  const commits: Array<{ entry: ChatCommit; parents: string[] }> = []
  for (let index = 0; index + 5 < fields.length; index += 6) {
    const [id, parentList, author, time, subject, body] = fields.slice(index, index + 6)
    if (!id || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(id)) continue
    const parents = parentList?.split(' ').filter(sha => /^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(sha)) ?? []
    const message = subject?.slice(0, 240) ?? ''
    commits.push({parents, entry: {
      id, message, author: { name: author?.slice(0, 100) ?? '' },
      at: Number(time) * 1000, kind: commitKind(message, parents), body: body?.trim().slice(0, 1800) || undefined,
    }})
  }
  return commits
}

export async function localCommitHistory(cwd: string, requested: string | undefined, signal: AbortSignal): Promise<CommitHistory> {
  const rawRefs = await git(cwd, ['for-each-ref', '--sort=-committerdate', '--count=60',
    '--format=%(HEAD)%00%(refname:lstrip=2)%00%(objectname)', 'refs/heads'], signal)
  const refs = rawRefs.trimEnd().split('\n').filter(Boolean).map(line => line.split('\0'))
  const current = refs.find(([head]) => head === '*')
  const head = await git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)
    .then(stdout => stdout.trim(), () => { signal.throwIfAborted(); return '' })
  const options = new Map(refs.flatMap(([, name, sha]) => name && sha ? [[name, sha] as const] : []))
  if (head && !current) options.set('HEAD', head)
  const branch = requested && options.has(requested) ? requested : current?.[1] ?? (head ? 'HEAD' : options.keys().next().value ?? '')
  const tip = options.get(branch)
  if (!tip) return { branch, branches: [...options.keys()], commits: [], hasMore: false }
  const records = await log(cwd, [tip], trailLimit + 1, signal, true)
  const recent = records.slice(0, trailLimit)
  // First-parent history keeps the merged commits within the merge row.
  for (const record of recent) {
    const [main, ...merged] = record.parents
    if (!main || !merged.length) continue
    const children = await log(cwd, [...merged, '^' + main], mergeLimit, signal)
      .catch(() => { signal.throwIfAborted(); return [] })
    if (children.length) record.entry.commits = children.map(child => child.entry)
  }
  return { branch, branches: [...options.keys()], commits: recent.map(record => record.entry), hasMore: records.length > trailLimit }
}

type RemoteCommit = {
  sha: string
  parents: {sha: string}[]
  commit: {message: string; author?: {name: string; date: string}}
}

// GitHub lists reachable commits by date. Follow the returned first-parent links
// and group only branch commits whose ancestry is actually present in the read.
export function remoteCommitHistory(raw: RemoteCommit[], head = raw[0]?.sha) {
  const nodes = new Map(raw.filter(item => item?.sha && item.commit).map(item => [item.sha, item]))
  const entries = new Map([...nodes].map(([id, item]) => {
    const [subject, ...body] = item.commit.message.split('\n')
    const message = subject?.slice(0, 240) ?? ''
    const entry: ChatCommit = {
      id, message, author: {name: item.commit.author?.name?.slice(0, 100) || ''},
      at: Date.parse(item.commit.author?.date ?? ''), body: body.join('\n').trim().slice(0, 1800) || undefined,
      kind: commitKind(message, item.parents.map(parent => parent.sha)),
    }
    return [id, entry]
  }))
  function ancestry(start?: string) {
    const seen = new Set<string>(), todo = start ? [start] : []
    while (todo.length) {
      const id = todo.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      for (const parent of nodes.get(id)?.parents ?? []) todo.push(parent.sha)
    }
    return seen
  }
  const main: ChatCommit[] = []
  let id = head
  const visited = new Set<string>()
  while (id && main.length < trailLimit && !visited.has(id)) {
    const node = nodes.get(id), entry = entries.get(id)
    if (!node || !entry) break
    visited.add(id)
    const [parent, ...merged] = node.parents
    if (merged.length) {
      const existing = ancestry(parent?.sha)
      const incoming = new Set(merged.flatMap(head => [...ancestry(head.sha)]))
      const commits = [...entries.values()].filter(item => incoming.has(item.id) && !existing.has(item.id)).slice(0, mergeLimit)
      if (commits.length) entry.commits = commits.map(({commits: _nested, ...child}) => child)
    }
    main.push(entry)
    id = parent?.sha
  }
  return { commits: main, hasMore: !!id }
}
