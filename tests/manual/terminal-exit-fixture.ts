// Driven by terminal-exit.py in a PTY. No host connection or user data is used.
import { interactiveTui } from '../../src/terminal/tui.ts'
import type { TerminalClient, Snapshot } from '../../src/terminal/client.ts'

const view = { conversation: { id: 'personal', sequence: 0, contextVersion: 0 },
  workers: [], calls: [], browsers: [], messages: [], approvals: [], tasks: [], schedules: [], deliveries: [], run: null } as unknown as Snapshot
const client = {
  view: async () => {
    if (process.argv.includes('--fail')) throw Error('Host unavailable')
    return view
  },
  request: async () => ({ approvalMode: 'ask', workers: [], connections: [] }),
  watch: async (_id: string, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
} as unknown as TerminalClient

process.stdout.write('SHELL_BEFORE\n')
try {
  await interactiveTui(client, view.conversation, {
    cwd: process.cwd(), preferences: { theme: 'dark', motion: 'reduced', animation: false },
    settingsSources: [], prompt: '', files: []
  })
} catch (error) {
  if (!process.argv.includes('--fail') || (error as Error).message !== 'Host unavailable') throw error
}
process.stdout.write(`SHELL_RETURN raw=${process.stdin.isRaw}\n`)
