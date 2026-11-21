import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js'
import type {z} from 'zod'
import {BrowserError, type BrowserFrame, type browserConfigSchema} from './browser-contract.ts'
import type {BrowserDriver, DriverSession} from './browser-driver.ts'
import {inputMessages, type BrowserInput} from './browser-input.ts'
import {computerCommand} from './computer-command.ts'
import {egoBrowserScript} from './ego-browser-script.ts'

type LoginState = {cookies: unknown[]; origins: unknown[]}
type EgoRequest = {operation: string; args?: unknown[]; create?: boolean; page?: string}
type Frame = Omit<BrowserFrame, 'seq'>
const resultMarker = 'ROPPO_EGO_RESULT '
const helperPath = 'ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/Current/Helpers/ego-browser'

export class EgoBrowserDriver implements BrowserDriver {
  readonly provider = 'ego-lite'
  private readonly active = new Map<string, string>()
  private readonly login = new Map<string, LoginState>()
  private readonly snapshots = new Map<string, string>()

  constructor(private root: string, private settings: z.infer<typeof browserConfigSchema>) {}

  private command() {
    return computerCommand(this.settings.egoCommand, 'ego-browser', process.platform === 'darwin'
      ? [join('/Applications', helperPath), join(homedir(), 'Applications', helperPath)]
      : [])
  }

  async version() {
    const command = this.command()
    return command ? 'Ego Lite • ego-browser' : 'Ego Lite • installation required'
  }

  private async invoke(session: DriverSession, request: EgoRequest, signal?: AbortSignal) {
    const command = this.command()
    if (!command) {
      throw new BrowserError('ego_browser_missing', 'Install Ego Lite on the Roppo host to use Worker browsing.', 503)
    }
    const publicProfile = this.settings.egoProfile ?? 'Roppo'
    const bindings = this.settings.egoProfiles ?? {}
    const profile = session.profileId ? bindings[session.profileId] ?? 'Roppo ' + session.profileId : publicProfile
    const otherProfiles = Object.entries(bindings).filter(([id])=>id!==session.profileId).map(([,name])=>name)
    if (session.profileId) otherProfiles.push(publicProfile)
    const parameters = {
      space: 'Roppo Work ' + session.id,
      profile,
      otherProfiles,
      active: request.page ?? this.active.get(session.id),
      ...request,
      args: request.args ?? [],
    }
    const program = 'const request = ' + JSON.stringify(parameters) + ';\n' + egoBrowserScript
    const outputText = await new Promise<string>((resolve, reject) => {
      const child = execFile(command, ['nodejs'], {
        cwd: this.root,
        env: getDefaultEnvironment(),
        encoding: 'utf8',
        maxBuffer: 12 * 1024 * 1024,
        timeout: this.settings.timeoutMs,
        signal,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new BrowserError(signal?.aborted ? 'browser_cancelled' : 'ego_browser_execution',
            signal?.aborted ? 'Browser operation was cancelled.' :
              'Ego Lite did not respond. Check that its first-run setup is complete and that it can open a Task Space.', 503))
        } else resolve(stdout + '\n' + stderr)
      })
      child.stdin?.on('error', () => {})
      child.stdin?.end(program)
    })
    const output = outputText.split(/\r?\n/).findLast(line => line.startsWith(resultMarker))
    if (!output) throw new BrowserError('ego_browser_protocol', 'Ego Lite returned no browser action result.', 502)
    const response = JSON.parse(output.slice(resultMarker.length))
    if (!response.ok) {
      const code = String(response.code)
      const messages: Record<string, string> = {
        ROPPO_EGO_PROFILE_REQUIRED: 'Create an Ego Lite profile named "' + profile +
          '" or set the corresponding browser.egoProfile / browser.egoProfiles binding.',
        ROPPO_EGO_PROFILE_SHARED: 'Choose a distinct Ego Lite profile for each Roppo login grant.',
        ROPPO_EGO_STALE_SNAPSHOT: 'The page changed since the last snapshot. Read it again before acting.',
        ROPPO_EGO_SPACE_MISSING: 'This Ego Lite Task Space closed. Open a new browser and inspect the site before repeating a write.',
        ROPPO_EGO_LAST_TAB: 'Keep at least one tab open, or close the session.',
        ROPPO_EGO_TAB_MISSING: 'This Ego Lite tab has closed. Refresh the page state.',
        EGO_TASK_SPACE_NAME_IN_USE: 'This Ego Lite Task Space has been taken over. Return it to agent control in Ego Lite.',
      }
      throw new BrowserError(code==='ROPPO_EGO_STALE_SNAPSHOT'?'browser_stale_snapshot':code.toLowerCase(),
        messages[code] ?? 'Ego Lite could not complete the action (' + code + '). Read the page state before repeating an action.')
    }
    if (response.active && !request.page) this.active.set(session.id, response.active)
    return response.value ?? {}
  }

  async run(session: DriverSession, [command, arg, value, last]: string[], signal?: AbortSignal) {
    let request: EgoRequest
    switch (command) {
      case 'open': {
        const state = this.login.get(session.id)
        this.login.delete(session.id)
        request = state ? {operation: 'load', args: [state, arg]} :
          {operation: 'open', args: [arg], create: !this.active.has(session.id)}
        break
      }
      case 'tab':
        request = arg === 'list' ? {operation: 'list'} : arg === 'new' ? {operation: 'new', args: [value ?? 'about:blank']} :
          arg === 'close' ? {operation: 'close_tab', args: [value]} : {operation: 'select', args: [arg]}
        break
      case 'get':
        request = {operation: 'title'}
        break
      case 'fill':
      case 'click': {
        const ref = arg?.replace(/^@?e(\d+)$/, '@$1')
        const snapshot = ref!==arg ? this.snapshots.get(session.id) : undefined
        if(ref!==arg&&!snapshot)throw new BrowserError('browser_stale_snapshot', 'Read a fresh snapshot before acting.')
        request = {operation: command, args: [ref, command==='fill'?value:null, snapshot,
          command==='click'&&value==='--download'?join(session.directory,'downloads'):null]}
        break
      }
      case 'screenshot':
        request = {operation: 'screenshot', args: [arg, value === '--full']}
        break
      case 'upload':
      case 'scroll':
        request = {operation: command, args: [arg, value]}
        break
      case 'set':
        request = {operation: 'viewport', args: [Number(value), Number(last)]}
        break
      case 'snapshot':
      case 'back':
      case 'forward':
      case 'reload':
        request = {operation: command}
        break
      case 'press':
        request = {operation: 'press', args: [arg]}
        break
      default:
        throw new BrowserError('ego_browser_action', 'Unsupported Ego Lite browser action.')
    }
    const result = await this.invoke(session, request, signal)
    if (command === 'snapshot') {
      this.snapshots.set(session.id,createHash('sha256').update(String(result.snapshot)).digest('hex'))
      result.snapshot = String(result.snapshot).replace(/\bref=@?(\d+)\b/g, 'ref=e$1').replace(/(\[)@(\d+)(?=\])/g, '$1@e$2')
    }
    return result
  }

  async evaluate(session: DriverSession, expression: string, signal?: AbortSignal) {
    return this.invoke(session, {operation: 'evaluate', args: [expression]}, signal)
  }

  async state(): Promise<never> {
    throw new BrowserError('ego_browser_profile', 'Export saved sign-ins from a personal browser profile.')
  }

  async load(session: DriverSession, state: LoginState, signal?: AbortSignal) {
    signal?.throwIfAborted()
    this.login.set(session.id, state)
  }

  async readFrame(session: DriverSession, signal: AbortSignal, tab?: string): Promise<Frame> {
    const page = tab ? tab.replace(/^t/, 'p') : this.active.get(session.id)
    const frame = await this.invoke(session, {operation: 'frame', page}, signal)
    if (typeof frame.data !== 'string' || frame.data.length > 8_000_000 ||
        !(frame.width > 0) || !(frame.height > 0)) {
      throw new BrowserError('ego_browser_frame', 'Ego Lite returned an invalid page frame.')
    }
    return {...frame, at: Date.now()}
  }

  async frames(session: DriverSession, callback: (frame: BrowserFrame) => void, status?: (connected: boolean) => void) {
    const controller = new AbortController()
    let sequence = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const frame = await this.readFrame(session, controller.signal)
        if (!controller.signal.aborted) {
          status?.(true)
          callback({...frame, seq: ++sequence})
        }
      } catch {
        if (!controller.signal.aborted) status?.(false)
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 400)
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
      status?.(false)
    }
  }

  async input(session: DriverSession, event: BrowserInput) {
    if (event.type === 'text') {
      await this.invoke(session, {operation: 'input', args: [[{method: 'Input.insertText', params: {text: event.text}}]]})
      return
    }
    const messages = inputMessages(event).map(({type, eventType, ...params}) => ({
      method: type === 'input_mouse' ? 'Input.dispatchMouseEvent' : 'Input.dispatchKeyEvent',
      params: {...params, type: eventType},
    }))
    await this.invoke(session, {operation: 'input', args: [messages]})
  }

  async close(session: DriverSession) {
    this.login.delete(session.id)
    try {
      if (this.command()) await this.invoke(session, {operation: 'close'})
    } finally {
      this.active.delete(session.id)
      this.snapshots.delete(session.id)
    }
  }
}
