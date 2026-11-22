import { randomBytes } from 'node:crypto'
import type { SourceConfig } from './config.ts'
import type { Store } from './store.ts'

export type OfficeGroup = { id: string; label?: string; actor: string }
export type GroupChallenge = { id: string; code: string; expiresAt: number; groups: OfficeGroup[] }

export function pairedOfficeBot(source: SourceConfig) {
  return (source.kind === 'dingtalk' || source.kind === 'wecom') && source.options.officePairing === true
}

type Activation = { sourceId: string; groups: Record<string, number> }
const activationKind = 'office-group-activation'

/** Keep each group's boundary stable across restarts and unrelated settings changes. */
export function syncOfficeGroupActivations(store: Store, sources: SourceConfig[], previous: SourceConfig[]) {
  const saved = new Map(store.list<Activation>(activationKind).map(item => [item.sourceId, item.groups]))
  const now = Date.now()
  for (const source of sources.filter(pairedOfficeBot)) {
    // A legacy release can edit the common source settings while the bot is inactive.
    const carried = previous.find(item => item.id === source.id)?.kind === 'webhook' ? {} : saved.get(source.id) ?? {}
    const ids = source.enabled && source.capabilities.events ? [...new Set(source.listenScopes ?? [])] : []
    const groups = Object.fromEntries(ids.map(id => [id, Object.hasOwn(carried, id) ? carried[id]! : now]))
    if (ids.some(id => !Object.hasOwn(carried, id)) || ids.length !== Object.keys(saved.get(source.id) ?? {}).length)
      store.put(activationKind, source.id, { sourceId: source.id, groups } satisfies Activation)
    saved.delete(source.id)
  }
  for (const id of saved.keys()) store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(activationKind, id)
}

export function officeGroupActivatedAt(store: Store, sourceId: string, groupId: string) {
  const groups = store.get<Activation>(activationKind, sourceId)?.groups
  return groups && Object.hasOwn(groups, groupId) ? groups[groupId] : undefined
}

export const groupChallenge = (id: string): GroupChallenge => ({
  id, code: 'ROPPO-' + randomBytes(5).toString('hex').toUpperCase(), expiresAt: Date.now() + 15 * 60_000, groups: [],
})

export function groupCodeMatches(text: string, code: string) {
  const value = text.trim()
  return value === code || value.endsWith(' ' + code) || value.endsWith('\n' + code)
}

export function observeOfficeGroup(challenge: GroupChallenge, group: OfficeGroup, text: string) {
  if (challenge.expiresAt <= Date.now() || !groupCodeMatches(text, challenge.code)) return false
  if (challenge.groups.length < 50 && !challenge.groups.some(item => item.id === group.id)) challenge.groups.push(group)
  return true
}

export function captureOfficeGroup(store: Store, source: string, group: OfficeGroup, text: string) {
  const challenge = store.get<GroupChallenge>('office-group-challenge', source)
  if (!challenge || !observeOfficeGroup(challenge, group, text)) return false
  store.put('office-group-challenge', source, challenge)
  return true
}
