import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { createInterface, clearLine, cursorTo } from 'node:readline'
import { createInterface as promptInterface } from 'node:readline/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { TerminalClient, CliError, clean, type Snapshot, type Conversation } from './client.ts'
import { command, commandHelp, mentionedFiles, runResult } from './commands.ts'

const help = `Roppo — work with your Router and Workers from this directory.

  roppo [prompt]                  Start an interactive conversation
  roppo -c                        Continue the latest conversation in this project
  roppo -r [id]                   Choose or resume a project conversation
  roppo -p "prompt"               Print the result of one request
  git diff | roppo -p "Review"    Send piped text with an instruction
  roppo login | logout | init     Connect an account or start local setup

  --json                         Return a single JSON result in print mode
  --file PATH                    Attach a file (repeatable)
  --trust-project                Register the project on first use
  --timeout SECONDS              Wait limit for print mode (default 600)
  --cwd DIRECTORY                Select a project directory
  --host URL                     Select a local Roppo instance
  --help, --version

  In a conversation, type /help for tasks, diffs, tools and approvals.`
interface Options {
  print: boolean
  json: boolean
  latest: boolean
  resume?: string
  trust: boolean
  timeout: number
  cwd: string
  host?: string
  files: string[]
  prompt: string
  action?: string
}
export function parseArgs(args: string[]): Options {
  const o: Options = {
      print: false,
      json: false,
      latest: false,
      trust: false,
      timeout: 600,
      cwd: process.cwd(),
      files: [],
      prompt: ''
    },
    words: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!,
      value = () => {
        if (i + 1 >= args.length || args[i + 1]!.startsWith('--'))
          throw new CliError('Missing value for ' + a, 'usage', 2)
        return args[++i]!
      }
    if (a === '--') {
      words.push(...args.slice(i + 1))
      break
    }
    if (a === '--help' || a === '-h') o.action = 'help'
    else if (a === '--version' || a === '-V') o.action = 'version'
    else if (a === '--print' || a === '-p') o.print = true
    else if (a === '--json') o.json = true
    else if (a === '--continue' || a === '-c') o.latest = true
    else if (a === '--resume' || a === '-r')
      o.resume = args[i + 1] && !args[i + 1]!.startsWith('-') ? args[++i] : ''
    else if (a === '--trust-project') o.trust = true
    else if (a === '--cwd') o.cwd = resolve(value())
    else if (a === '--host') o.host = value()
    else if (a === '--timeout') {
      o.timeout = Number(value())
      if (!Number.isFinite(o.timeout) || o.timeout <= 0 || o.timeout > 86400)
        throw new CliError('Choose a timeout between 0 and 86400 seconds.', 'usage', 2)
    } else if (a === '--file') o.files.push(value())
    else if (a.startsWith('-')) throw new CliError('Unknown option ' + a, 'usage', 2)
    else if (!words.length && !o.action && ['init', 'login', 'logout'].includes(a)) o.action = a
    else words.push(a)
  }
  if (o.latest && o.resume !== undefined) throw new CliError('Choose either -c or -r.', 'usage', 2)
  o.prompt = words.join(' ')
  return o
}
async function ask(text: string) {
  const rl = promptInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await rl.question(clean(text))).trim()
  } finally {
    rl.close()
  }
}
async function selectConversation(client: TerminalClient, o: Options, project: string, tty: boolean) {
  if (!o.latest && o.resume === undefined) return client.create(project)
  const list = await client.list(project)
  if (!list.length) throw new CliError('No saved conversations in this project. Start one with roppo.')
  if (o.latest) return list[0]!
  if (o.resume) {
    const match = list.find((c) => c.id === o.resume)
    if (match) return match
    throw new CliError('Conversation not found in this project.')
  }
  if (!tty) throw new CliError('Pass a conversation ID with -r when running a script.', 'usage', 2)
  for (const [i, c] of list.entries())
    process.stderr.write(
      clean(String(i + 1) + '. ' + (c.title || 'New conversation') + '  ' + c.id) + '\n'
    )
  const n = Number(await ask('Resume number › '))
  if (!Number.isInteger(n) || !list[n - 1]) throw new CliError('Invalid selection.')
  return list[n - 1]!
}
const locale = () => Intl.DateTimeFormat().resolvedOptions().locale
const terminalStates = ['completed', 'failed', 'cancelled', 'waiting']
async function printRun(client: TerminalClient, c: Conversation, o: Options) {
  const sent = await client.send(
    c.id,
    o.prompt,
    o.files.map((f) => resolve(o.cwd, f)),
    locale()
  )
  const wait = AbortSignal.timeout(Math.max(1, Math.ceil(o.timeout * 1000)))
  let view: Snapshot | undefined
  let status = 'timeout'
  while (!wait.aborted) {
    try {
      view = await client.view(c.id, sent.runId, wait)
      if (view.run && terminalStates.includes(view.run.state)) {
        status = view.run.state
        break
      }
    } catch (error) {
      if (
        !wait.aborted &&
        !(
          error instanceof CliError &&
          ['host_unavailable', 'configuration_restarting'].includes(error.code)
        )
      )
        throw error
    }
    await delay(600, undefined, { signal: wait }).catch(() => {})
  }
  const result = view
    ? runResult(view, sent.runId, status)
    : { conversationId: c.id, runId: sent.runId, status, text: '', tasks: [], deliveries: [] }
  if (o.json) console.log(JSON.stringify({ ...result, url: client.link(c.id) }))
  else {
    if (result.text) console.log(clean(result.text))
    for (const delivery of result.deliveries)
      console.log(clean(delivery.name + '  ' + client.base + delivery.path))
    if (status !== 'completed') process.stderr.write(clean(status + ' · ' + client.link(c.id)) + '\n')
  }
  switch (status) {
    case 'completed':
      return 0
    case 'waiting':
      return 3
    case 'timeout':
      return 124
    case 'cancelled':
      return 130
    default:
      return 1
  }
}
async function interactive(client: TerminalClient, c: Conversation, o: Options) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: '› '
  })
  const lines = rl[Symbol.asyncIterator]()
  const seen = new Map<string, string>()
  let stopped = false,
    reading = false,
    buffer = '',
    lastState = '',
    preview = ''
  const say = (value: string) => {
    if (stopped) return
    clearLine(process.stdout, 0)
    cursorTo(process.stdout, 0)
    process.stdout.write(clean(value) + '\n')
    if (reading) rl.prompt(true)
  }
  function render(view: Snapshot) {
    for (const m of view.messages) {
      if (m.recipient || !m.text || m.status === 'streaming' || seen.has(m.id)) continue
      seen.set(m.id, m.text)
      if (m.role === 'assistant') say((m.speaker?.label ?? 'Roppo') + ' › ' + m.text)
      else if (!reading) say('You › ' + m.text)
    }
    for (const t of view.tasks) {
      const key = 'task/' + t.id,
        description = [t.workerId, t.state, t.title, t.question].filter(Boolean).join(' · ')
      if (seen.get(key) !== description) {
        seen.set(key, description)
        say(description)
      }
    }
    for (const call of view.calls) {
      if (call.kind !== 'tool') continue
      const key = 'tool/' + call.id
      if (seen.get(key) === call.state) continue
      seen.set(key, call.state)
      if (!reading && call.state !== 'running') continue
      say([call.name, call.action, call.target, call.state].filter(Boolean).join(' · '))
    }
    const stream = view.messages.findLast(
      (m) => m.role === 'assistant' && !m.recipient && m.status === 'streaming'
    )
    const sample = stream
      ? clean(stream.text)
          .replace(/\s+/g, ' ')
          .slice(-Math.max(12, Math.min(70, (process.stdout.columns || 80) - 16)))
      : ''
    if (sample !== preview) {
      preview = sample
      rl.setPrompt(sample ? 'Roppo … ' + sample + '  › ' : '› ')
      rl.prompt(true)
    }
    const state = view.run?.state ?? ''
    if (state && lastState !== state) say('Roppo · ' + state)
    lastState = state
  }
  const refresh = async () => {
    const view = await client.view(c.id)
    if (!stopped) render(view)
  }
  process.stdout.write(
    clean('Roppo  ' + c.project + '\n' + (c.title || 'New conversation') + '  ·  /help for commands') +
      '\n'
  )
  const send = async (text: string, files: string[] = []) =>
    client.send(c.id, text, [...files, ...mentionedFiles(text, o.cwd)], locale())
  let lastError = ''
  rl.on('SIGINT', () => {
    if (rl.line) {
      rl.write(null, { ctrl: true, name: 'u' })
      rl.prompt()
    } else rl.close()
  })
  rl.on('close', () => {
    stopped = true
  })
  const stream = new AbortController()
  let watch: Promise<void> | undefined
  try {
    await refresh()
    reading = true
    if (o.prompt || o.files.length)
      await send(
        o.prompt,
        o.files.map((f) => resolve(o.cwd, f))
      )
    watch = client.watch(
      c.id,
      stream.signal,
      async () => {
        await refresh()
        lastError = ''
      },
      (message) => {
        if (message !== lastError) {
          lastError = message
          say(message)
        }
      }
    )
    rl.prompt()
    for await (const line of lines) {
      if (line.endsWith('\\')) {
        buffer += line.slice(0, -1) + '\n'
        rl.prompt()
        continue
      }
      const text = (buffer + line).trim()
      buffer = ''
      if (text === '/exit' || text === '/quit') {
        rl.close()
        break
      }
      try {
        if (text.startsWith('/')) {
          say(await command(client, c.id, text))
          continue
        }
        if (text) await send(text)
      } catch (e) {
        say((e as Error).message)
        continue
      }
      rl.prompt()
    }
  } finally {
    stopped = true
    stream.abort()
    rl.close()
    process.stdin.pause()
    await watch
  }
  return 0
}
export async function main(args: string[]): Promise<number> {
  let json = args.includes('--json')
  try {
    const o = parseArgs(args)
    json = o.json
    if (o.action === 'help') {
      console.log(help)
      return 0
    }
    if (o.action === 'version') {
      console.log(
        JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
      )
      return 0
    }
    if (o.action === 'init') {
      const child = spawn(fileURLToPath(new URL('../../start.sh', import.meta.url)), ['setup'], {
        stdio: 'inherit'
      })
      return await new Promise<number>((resolve, reject) => {
        child.on('error', reject)
        child.on('exit', (code) => resolve(code ?? 1))
      })
    }
    const tty = !!(process.stdin.isTTY && process.stdout.isTTY)
    const client = new TerminalClient(o.host)
    if (o.action === 'login') {
      await client.login()
      process.stderr.write('Connected to ' + client.base + '\n')
      return 0
    }
    if (o.action === 'logout') {
      await client.logout()
      return 0
    }
    const print = o.print || o.json || !tty
    if (print && !process.stdin.isTTY) {
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) {
        bytes += chunk.length
        if (bytes > 400000) throw new CliError('Input exceeds 100,000 characters.', 'usage', 2)
        chunks.push(chunk)
      }
      const piped = Buffer.concat(chunks).toString('utf8').trim()
      o.prompt = [o.prompt, piped].filter(Boolean).join('\n\n')
    }
    if (o.prompt.length > 100000 || (print && !o.prompt && !o.files.length))
      throw new CliError('Provide a prompt or file (up to 100,000 characters).', 'usage', 2)
    if (!client.signedIn && !print) await client.login()
    const project = await client.project(o.cwd, o.trust)
    if (!project.registered) {
      if (print)
        throw new CliError(
          'First use of this project. Run roppo interactively or pass --trust-project.',
          'project_trust_required'
        )
      if (
        !/^y(es)?$/i.test(
          await ask('Register ' + project.cwd + ' with ' + project.sandbox + ' access? [y/N] ')
        )
      )
        return 0
      await client.project(project.cwd, true)
    }
    const c = await selectConversation(client, o, project.cwd, tty && !print)
    return print ? await printRun(client, c, o) : await interactive(client, c, o)
  } catch (e) {
    const err = e as Error
    if (json)
      console.log(
        JSON.stringify({
          status: 'error',
          code: e instanceof CliError ? e.code : 'cli_error',
          error: err.message
        })
      )
    else process.stderr.write(clean(err.message) + '\n')
    return e instanceof CliError ? e.exit : 1
  }
}
