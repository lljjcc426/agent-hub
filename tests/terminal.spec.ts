import { expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
  readdirSync,
  realpathSync
} from 'node:fs'
import { join } from 'node:path'
import { terminalCredentialFiles } from '../src/terminal/profile.ts'
import { projectRoot } from '../src/terminal/project.ts'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { TerminalPairing } from '../src/terminal/pairing.ts'
import { clean, localOrigin } from '../src/terminal/client.ts'
import { parseArgs } from '../src/terminal/main.ts'
import { configSchema, type Config } from '../src/config.ts'
import { Runtime } from '../src/runtime.ts'
import { serve } from '../src/server.ts'
import type { ModelRequest } from '../src/model.ts'

it('expires terminal pairs, rejects a wrong secret and consumes the credential once', () => {
  let now = 0
  const pairs = new TerminalPairing(() => now),
    p = pairs.start()
  expect(pairs.claim(p.id, p.secret).token).toBeUndefined()
  expect(() => pairs.claim(p.id, 'wrong')).toThrow()
  pairs.approve(p.id, () => 'credential')
  expect(pairs.claim(p.id, p.secret)).toEqual({ token: 'credential' })
  expect(() => pairs.claim(p.id, p.secret)).toThrow()
  const next = pairs.start()
  now = 181000
  expect(() => pairs.approve(next.id, () => 'unused')).toThrow()
})
it('validates local origins, escapes terminal controls and parses project options', () => {
  expect(() => localOrigin('http://127.0.0.1@other.example')).toThrow()
  expect(() => localOrigin('https://example.org')).toThrow()
  expect(clean('\x1b[2Jone\r\u202etwo')).toBe('onetwo')
  expect(parseArgs(['-p', '--json', '--file', 'notes', '--', '-line'])).toMatchObject({
    print: true,
    json: true,
    prompt: '-line',
    files: ['notes']
  })
  expect(() => parseArgs(['-r', 'id', '-c'])).toThrow()
})
it('includes each saved terminal credential in the host private files', () => {
  const saved = process.env.ROPPO_CLI_HOME,
    home = mkdtempSync(join(tmpdir(), 'roppo-cli-profile-'))
  try {
    process.env.ROPPO_CLI_HOME = home
    const file = join(home, '1'.repeat(64) + '.json')
    writeFileSync(file, '{}')
    writeFileSync(join(home, 'host.json'), '{}')
    expect(terminalCredentialFiles()).toContain(file)
    expect(terminalCredentialFiles()).not.toContain(join(home, 'host.json'))
  } finally {
    if (saved === undefined) delete process.env.ROPPO_CLI_HOME
    else process.env.ROPPO_CLI_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
})
it('pairs the actual executable, binds projects, waits for its Worker, resumes and revokes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'roppo-terminal-')),
    project = join(root, 'project'),
    other = join(root, 'other'),
    home = join(root, 'cli')
  mkdirSync(project)
  mkdirSync(other)
  writeFileSync(join(project, 'notes.txt'), 'visible')
  const config = configSchema.parse({
    stateDir: join(root, 'state'),
    port: 0,
    work: { sandboxDriver: 'disabled' },
    execution: {
      router: { mode: 'host' },
      management: { enabled: true },
      workers: [{ id: 'research', backend: 'codex' }]
    },
    sources: [
      {
        id: 'local',
        kind: 'local',
        cwd: project,
        allowedActors: ['operator'],
        workspace: { mode: 'source' }
      }
    ]
  })
  const cwds: string[] = []
  const create = (config: Config) =>
    new Runtime(config, {
      model: {
        async run(r: ModelRequest) {
          cwds.push(realpathSync(r.cwd))
          const threadId = r.threadId ?? randomUUID(),
            turnId = randomUUID()
          r.onThread?.(threadId)
          r.onTurn?.(turnId)
          let result: unknown
          if (r.role === 'worker') {
            await delay(200)
            result = {
              state: 'ready',
              summary: 'Reviewed the file',
              reply: 'Worker complete',
              question: null,
              askedBy: null,
              handbacks: []
            }
          } else {
            const input = JSON.parse(r.input)
            if (input.kind === 'user_message' && input.trigger.text === 'slow') await delay(1400)
            if (input.kind === 'user_message' && input.trigger.text.includes('delegate')) {
              const assigned = await r.onTool!(
                'worker_manage',
                {
                  action: 'assign',
                  id: 'research',
                  revision: 0,
                  requestId: randomUUID(),
                  text: 'Review notes'
                },
                'assign'
              )
              if (!assigned.success) throw Error('fixture could not assign the Worker')
              result = { reply: 'Work assigned' }
            } else
              result = {
                reply:
                  input.kind === 'user_message'
                    ? 'Echo ' + input.trigger.text
                    : 'Reviewed the Worker result'
              }
          }
          return { threadId, turnId, text: JSON.stringify(result) }
        }
      }
    })
  const host = await serve(create(config), { createRuntime: create })
  const bin = fileURLToPath(new URL('../bin/roppo.mjs', import.meta.url))
  const cli = (args: string[], stdin = '', onError?: (line: string) => void) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: project,
      env: { ...process.env, CI: '1', ROPPO_HOST: host.url, ROPPO_CLI_HOME: home },
      stdio: 'pipe'
    })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      onError?.(String(chunk))
    })
    child.stdin.end(stdin)
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    })
  }
  const post = (path: string, data: unknown, headers: Record<string, string> = {}) =>
    fetch(host.url + path, {
      method: 'POST',
      headers: { origin: host.url, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(data)
    })
  try {
    const setup = await post(
      '/account/setup',
      { username: 'local', displayName: 'Test', password: randomUUID() },
      { authorization: 'Bearer ' + readFileSync(host.tokenPath, 'utf8').trim() }
    )
    expect(setup.status).toBe(201)
    const cookie = setup.headers.getSetCookie()[0]!.split(';')[0]!
    let approved: Promise<Response> | undefined
    const login = await cli(['login'], '', (line) => {
      const id = line.match(/pair#([0-9a-f]{32})/)
      if (id) approved = post('/api/terminal/pair/approve', { id: id[1] }, { cookie })
    })
    expect((await approved)?.status).toBe(200)
    expect(login.code, login.stderr).toBe(0)
    const profile = join(home, readdirSync(home).find((f) => f !== 'host.json')!)
    expect(statSync(profile).mode & 0o777).toBe(0o600)
    const credential = JSON.parse(readFileSync(profile, 'utf8')).token
    const auth = { authorization: 'Roppo-CLI ' + credential }
    expect((await fetch(host.url + '/settings', { headers: auth })).status).toBe(401)
    const forged = cookie.split('=')[0] + '=terminal:' + credential
    expect((await fetch(host.url + '/settings', { headers: { cookie: forged } })).status).toBe(401)
    const first = await cli(['-p', 'delegate', '--json', '--file', 'notes.txt'], 'piped context')
    expect(first.code, first.stderr + first.stdout).toBe(0)
    const run = JSON.parse(first.stdout)
    expect(run).toMatchObject({
      status: 'completed',
      text: 'Reviewed the Worker result',
      tasks: [{ workerId: 'research', state: 'completed' }]
    })
    expect(cwds.every((c) => c === realpathSync(project))).toBe(true)
    const next = await cli(['-c', '-p', 'second', '--json'])
    expect(next.code, next.stdout + next.stderr).toBe(0)
    expect(JSON.parse(next.stdout)).toMatchObject({
      conversationId: run.conversationId,
      text: 'Echo second'
    })
    const view = (await (
      await fetch(
        host.url +
          '/api/chat/conversations/' +
          run.conversationId +
          '?run=' +
          encodeURIComponent(run.runId),
        { headers: auth }
      )
    ).json()) as any
    expect(view.messages[0]).toMatchObject({
      text: 'delegate\n\npiped context',
      attachments: [{ name: 'notes.txt' }]
    })
    expect(view.messages.every((m: any) => m.runId === run.runId)).toBe(true)
    expect((await cli(['-p', 'x', '--json', '--cwd', other])).code).toBe(1)
    const bound = await cli(['-p', 'other', '--cwd', other, '--trust-project', '--json'])
    expect(bound.code, bound.stdout + bound.stderr).toBe(0)
    const cross = await cli(['-r', run.conversationId, '-p', 'x', '--cwd', other])
    expect(cross.code).toBe(1)
    expect(cross.stderr).toContain('not found in this project')
    const crossTask = await post(
      '/api/terminal/tasks',
      { conversation: JSON.parse(bound.stdout).conversationId, ticket: run.tasks[0].id, action: 'stop' },
      auth
    )
    expect(crossTask.status).toBe(404)
    const resumed = await cli(['-p', 'slow', '--timeout', '0.04', '--json', '-r', run.conversationId])
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(124)
    const timeout = JSON.parse(resumed.stdout)
    expect(timeout).toMatchObject({ status: 'timeout', conversationId: run.conversationId })
    const old = (await (
      await fetch(
        host.url +
          '/api/chat/conversations/' +
          run.conversationId +
          '?run=' +
          encodeURIComponent(run.runId),
        { headers: auth }
      )
    ).json()) as any
    expect(old.run.state).toBe('completed')
    const cancelled = await post(
      '/api/chat/conversations/' + run.conversationId + '/cancel',
      { runId: timeout.runId },
      auth
    )
    expect(cancelled.status).toBe(200)
    const get = async (path: string) =>
      (await (await fetch(host.url + path, { headers: auth })).json()) as any
    expect(
      (
        await get(
          '/api/chat/conversations/' + run.conversationId + '?run=' + encodeURIComponent(timeout.runId)
        )
      ).run.state
    ).toBe('cancelled')
    const task = run.tasks[0].id
    const pending = host.runtime.approvals.request(task, {
      id: randomUUID(),
      method: 'item/commandExecution/requestApproval',
      params: { command: 'read fixture' }
    })
    const taskQuery = (action: string, extra: object = {}) =>
      post(
        '/api/terminal/tasks',
        { conversation: run.conversationId, ticket: task, action, ...extra },
        auth
      )
    const requests = (await (await taskQuery('approvals')).json()) as any
    expect(requests.pending).toHaveLength(1)
    expect(
      (
        await get(
          '/api/chat/conversations/' + run.conversationId + '?run=' + encodeURIComponent(run.runId)
        )
      ).run.state
    ).toBe('waiting')
    expect(
      (await taskQuery('answer', { approval: requests.pending[0].id, answer: 'decline' })).status
    ).toBe(200)
    await expect(pending).resolves.toEqual({ decision: 'decline' })
    expect((await taskQuery('diff')).status).toBe(404)
    // Exercise the real Git diff path against an isolated task worktree.
    execFileSync('git', ['init', '-q', project])
    execFileSync('git', ['-C', project, 'add', 'notes.txt'])
    execFileSync('git', [
      '-C',
      project,
      '-c',
      'user.name=QA',
      '-c',
      'user.email=qa@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'Initial'
    ])
    const nested = join(project, 'sub')
    mkdirSync(nested)
    expect(await projectRoot(nested)).toEqual({ cwd: realpathSync(project), git: true, committed: true })
    const child = join(nested,'child')
    mkdirSync(child)
    const registered = [{ ...config.sources.find(s=>s.kind==='local')!, cwd:nested }]
    expect(await projectRoot(child,registered)).toEqual({cwd:realpathSync(nested),git:false,committed:false})
    const dir = join(
      config.stateDir,
      'work',
      createHash('sha256').update(task).digest('hex').slice(0, 20)
    )
    mkdirSync(join(config.stateDir, 'work'), { recursive: true })
    execFileSync('git', ['-C', project, 'worktree', 'add', '--quiet', '--detach', dir])
    writeFileSync(join(dir, 'notes.txt'), 'change in task')
    writeFileSync(join(dir, 'new.txt'), 'not committed')
    host.runtime.store.put('run', task, { ...host.runtime.store.get<object>('run', task), cwd: dir })
    const diff = (await (await taskQuery('diff')).json()) as any
    expect(diff.diff).toContain('+change in task')
    expect(diff.untracked).toEqual(['new.txt'])
    expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('visible')
    expect((await cli(['logout'])).code).toBe(0)
    expect((await fetch(host.url + '/api/chat/readiness', { headers: auth })).status).toBe(401)
  } finally {
    host.server.closeAllConnections()
    await new Promise<void>((r) => host.server.close(() => r()))
    await host.closeRuntime()
    rmSync(root, { recursive: true, force: true })
  }
}, 90000)
