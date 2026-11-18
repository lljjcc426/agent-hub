import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.ts'
import {
  ChatPermissions,
  actionFacts,
  permissionCard,
  type PermissionActor,
} from '../src/chat-permissions.ts'
import { toolTrace } from '../src/tool-trace.ts'

const databases: { root: string; store: Store }[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'chat-permission-'))
  const store = new Store(join(root, 'state.sqlite'))
  databases.push({ root, store })
  return { store, permissions: new ChatPermissions(store) }
}
afterEach(() => {
  for (const { root, store } of databases.splice(0)) {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
const actor: PermissionActor = {
  mode: 'ask',
  conversationId: 'chat',
  runId: 'turn',
  triggerId: 'trigger',
  workerId: 'router',
}
const receipt = { success: true, contentItems: [{ type: 'inputText' as const, text: 'saved' }] }

it('claims an approved operation once across concurrent retries, including reordered arguments', async () => {
  const { permissions } = fixture()
  let count = 0,
    wakes = 0
  const args = { action: 'update', id: 'item', requestId: 'request-1' }
  let done!: () => void
  const wait = new Promise<void>((resolve) => {
    done = resolve
  })
  const write = async () => {
    count++
    await wait
    return receipt
  }
  const perform = (value: Record<string, unknown>) =>
    permissions.run(actor, 'change', value, actionFacts('change', value), write)
  await perform(args)
  const [saved] = permissions.forChat('chat')
  permissions.decide(saved!.id, true, () => wakes++)
  permissions.decide(saved!.id, true, () => wakes++)
  const initial = perform(args),
    retry = perform({ id: 'item', requestId: 'request-2', action: 'update' })
  expect(count).toBe(1)
  done()
  await Promise.all([initial, retry])
  expect(await perform(args)).toEqual(receipt)
  expect(wakes).toBe(1)
  expect(permissions.forChat('chat')).toHaveLength(1)
})

it('retains an uncertain effect after interruption and never replays it on approval or retry', async () => {
  const { permissions, store } = fixture()
  const full = { ...actor, mode: 'full' as const }
  let count = 0
  const started = () => {
    count++
    return new Promise<typeof receipt>(() => {})
  }
  void permissions.run(full, 'publish', { target: 'report' }, { target: 'report' }, started)
  const recovered = new ChatPermissions(store),
    saved = recovered.forChat('chat')[0]!
  expect(permissionCard(saved).executionState).toBe('uncertain')
  recovered.decide(saved.id, true, () => {
    throw Error('unexpected resume')
  })
  const outcome = await recovered.run(
    full,
    'publish',
    { target: 'report' },
    { target: 'report' },
    started,
    saved.id
  )
  expect(outcome.permission).toBe('uncertain')
  expect(count).toBe(1)
})

it('invalidates consent when a bound destination revision changes', async () => {
  const { permissions } = fixture()
  let writes = 0
  const call = (version: string, id?: string) =>
    permissions.run(
      actor,
      'publish',
      { target: 'draft' },
      { target: 'draft', version },
      async () => {
        writes++
        return receipt
      },
      id
    )
  await call('A')
  const first = permissions.forChat('chat')[0]!
  permissions.decide(first.id, true, () => {})
  expect((await call('B', first.id)).permission).toBe('cancelled')
  await call('B')
  expect(permissions.forChat('chat').map((a) => a.phase)).toEqual(['cancelled', 'pending'])
  expect(writes).toBe(0)
})

it('keeps file and command labels useful without persisting queries, shell arguments or tool output', () => {
  expect(toolTrace('superagent_read', { resource: 'files/src/test.ts' })).toEqual({
    kind: 'read',
    label: 'test.ts',
  })
  expect(toolTrace('superagent_shell', { command: "sed -n '4,6p' src/file.ts" })).toEqual({
    kind: 'read',
    label: 'file.ts',
  })
  expect(toolTrace('superagent_shell', { command: 'git status --short' })).toEqual({
    kind: 'command',
    label: 'git status --short',
  })
  expect(toolTrace('superagent_shell', {command: 'rg -n "private value" src/store.ts'})).toEqual({
    kind: 'search',
    label: 'store.ts',
  })
  expect(toolTrace('superagent_shell', {command: 'npm run build'})).toEqual({kind: 'command', label: 'npm run build'})
  for (const [name, args] of [
    ['superagent_shell', { command: 'rg private-value' }],
    ['superagent_shell', { command: 'node -e private-value' }],
    ['router_read', { resource: 'model-tool-receipt/private-value' }],
  ] as const)
    expect(JSON.stringify(toolTrace(name, args))).not.toContain('private-value')
})

it('reads the exit status of historical shell approvals and follows their background job', async () => {
  const { store, permissions } = fixture()
  const worker = { ...actor, ticketId: 'ticket', mode: 'full' as const }
  const original = { id: 'job-1', ticketId: 'ticket', state: 'failed', exitCode: 2 }
  await permissions.run(worker, 'superagent_shell', { command: 'check' }, {}, async () => ({
    success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(original) }],
  }))
  const action = permissions.forChat('chat')[0]!
  expect(permissionCard({ ...action, jobId: undefined }, store).executionState).toBe('failed')
  store.put('work', 'job-1', { ...original, ticketId: 'other', state: 'completed', exitCode: 0 })
  expect(permissionCard(action, store).executionState).toBe('failed')
  store.put('work', 'job-1', { ...original, state: 'running', exitCode: null })
  expect(permissionCard(action, store).executionState).toBe('executing')
  store.put('work', 'job-1', { ...original, state: 'cancelled' })
  expect(permissionCard(action, store).executionState).toBe('cancelled')
  store.put('work', 'job-1', { ...original, state: 'completed', exitCode: 0 })
  expect(permissionCard(action, store).executionState).toBe('complete')
})

it('keeps the first authored notice without changing the approval identity on retry', async () => {
  const { permissions } = fixture()
  const args = {command:'check'}
  for (const notice of ['This check needs approval.', 'Please approve the same check.'])
    await permissions.run(actor, 'superagent_shell', args, {}, async () => receipt, undefined, notice)
  const actions = permissions.forChat('chat')
  expect(actions).toHaveLength(1)
  expect(permissionCard(actions[0]!).notice).toBe('This check needs approval.')
})
