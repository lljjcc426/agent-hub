import { useSyncExternalStore } from 'react'
import {
  copyAppearanceSettings,
  defaultAppearanceSettings,
  getAppearance,
  parseAppearanceSettings,
  setAppearance,
  type AppearanceSettings,
} from './appearance-store.ts'

export type AppearanceSkin = {
  id: string
  name: string
  appearance: AppearanceSettings
}

export type AppearanceSkinState = {
  version: 1
  activeId: string | null
  resetBase: AppearanceSettings
  skins: AppearanceSkin[]
}

export type AppearanceSkinFile = {
  format: 'roppo-skin'
  version: 1
  name: string
  appearance: AppearanceSettings
}

export class AppearanceSkinError extends Error {
  constructor(public readonly code: 'invalid-format' | 'invalid-name' | 'duplicate-name' | 'default-skin' | 'missing-skin' | 'storage') {
    super(code)
    this.name = 'AppearanceSkinError'
  }
}

const storageKey = 'agenthub.configuration.appearance-skins'
const listeners = new Set<() => void>()
const defaultState = (): AppearanceSkinState => ({
  version: 1,
  activeId: 'default',
  resetBase: defaultAppearanceSettings(),
  skins: [],
})

function readState(raw: string | null): AppearanceSkinState {
  if (!raw) return defaultState()
  const value = JSON.parse(raw)
  if (value?.version !== 1 || !Array.isArray(value.skins)
    || (value.activeId !== null && typeof value.activeId !== 'string')) throw new AppearanceSkinError('invalid-format')
  const ids = new Set<string>()
  const skins: AppearanceSkin[] = value.skins.map((skin: AppearanceSkin) => {
    if (typeof skin?.id !== 'string' || !skin.id || skin.id === 'default' || ids.has(skin.id)
      || typeof skin.name !== 'string' || !skin.name.trim()) throw new AppearanceSkinError('invalid-format')
    ids.add(skin.id)
    return { id: skin.id, name: skin.name, appearance: parseAppearanceSettings(skin.appearance) }
  })
  if (value.activeId !== null && value.activeId !== 'default' && !ids.has(value.activeId)) throw new AppearanceSkinError('invalid-format')
  return { version: 1, activeId: value.activeId, resetBase: parseAppearanceSettings(value.resetBase), skins }
}

let state = defaultState()
try { state = readState(localStorage.getItem(storageKey)) } catch {}

function publish(next: AppearanceSkinState) {
  state = next
  listeners.forEach(listener => listener())
}

function commit(next: AppearanceSkinState) {
  try { localStorage.setItem(storageKey, JSON.stringify(next)) }
  catch { throw new AppearanceSkinError('storage') }
  publish(next)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const getAppearanceSkins = (): AppearanceSkinState => state

export function useAppearanceSkins(): AppearanceSkinState {
  return useSyncExternalStore(subscribe, getAppearanceSkins)
}

function checkName(name: string, excludeId?: string): string {
  const normalized = name.trim()
  if (!normalized || normalized.length > 60) throw new AppearanceSkinError('invalid-name')
  const key = normalized.toLocaleLowerCase()
  if (['roppo default', 'roppo 默认'].includes(key)
    || state.skins.some(skin => skin.id !== excludeId && skin.name.toLocaleLowerCase() === key)) throw new AppearanceSkinError('duplicate-name')
  return normalized
}

export function suggestAppearanceSkinName(name: string): string {
  const base = name.trim().slice(0, 60) || 'My skin'
  let candidate = base
  let suffix = 2
  while (['roppo default', 'roppo 默认'].includes(candidate.toLocaleLowerCase())
    || state.skins.some(skin => skin.name.toLocaleLowerCase() === candidate.toLocaleLowerCase())) {
    const ending = ` (${suffix++})`
    candidate = base.slice(0, 60 - ending.length) + ending
  }
  return candidate
}

export function saveAppearanceSkin(name: string): AppearanceSkin {
  const skin: AppearanceSkin = {
    id: crypto.randomUUID(),
    name: checkName(name),
    appearance: copyAppearanceSettings(getAppearance()),
  }
  commit({ ...state, activeId: skin.id, resetBase: copyAppearanceSettings(skin.appearance), skins: [...state.skins, skin] })
  return skin
}

export function selectAppearanceSkin(id: string): void {
  const skin = id === 'default' ? { appearance: defaultAppearanceSettings() } : state.skins.find(skin => skin.id === id)
  if (!skin) throw new AppearanceSkinError('missing-skin')
  const appearance = copyAppearanceSettings(skin.appearance)
  commit({ ...state, activeId: id, resetBase: copyAppearanceSettings(appearance) })
  setAppearance(appearance)
}

export function renameAppearanceSkin(id: string, name: string): void {
  if (id === 'default') throw new AppearanceSkinError('default-skin')
  if (!state.skins.some(skin => skin.id === id)) throw new AppearanceSkinError('missing-skin')
  const normalized = checkName(name, id)
  commit({ ...state, skins: state.skins.map(skin => skin.id === id ? { ...skin, name: normalized } : skin) })
}

export function deleteAppearanceSkin(id: string): void {
  if (id === 'default') throw new AppearanceSkinError('default-skin')
  if (!state.skins.some(skin => skin.id === id)) throw new AppearanceSkinError('missing-skin')
  commit({ ...state, activeId: state.activeId === id ? null : state.activeId, skins: state.skins.filter(skin => skin.id !== id) })
}

export function restoreAppearanceSkins(previous: AppearanceSkinState): void {
  commit(previous)
}

export function resetAppearanceToSkin(): boolean {
  if (JSON.stringify(copyAppearanceSettings(getAppearance())) === JSON.stringify(state.resetBase)) return false
  setAppearance(copyAppearanceSettings(state.resetBase))
  return true
}

export function parseAppearanceSkin(raw: string): AppearanceSkinFile {
  try {
    const value = JSON.parse(raw)
    if (value?.format !== 'roppo-skin' || value.version !== 1 || typeof value.name !== 'string'
      || !value.name.trim() || value.name.trim().length > 60) throw new AppearanceSkinError('invalid-format')
    return { format: 'roppo-skin', version: 1, name: value.name.trim(), appearance: parseAppearanceSettings(value.appearance) }
  } catch { throw new AppearanceSkinError('invalid-format') }
}

export function importAppearanceSkin(parsed: AppearanceSkinFile, name: string, apply: boolean): AppearanceSkin {
  const skin: AppearanceSkin = { id: crypto.randomUUID(), name: checkName(name), appearance: copyAppearanceSettings(parsed.appearance) }
  commit({
    ...state,
    skins: [...state.skins, skin],
    ...(apply ? { activeId: skin.id, resetBase: copyAppearanceSettings(skin.appearance) } : {}),
  })
  if (apply) setAppearance(copyAppearanceSettings(skin.appearance))
  return skin
}

export function exportAppearanceSkin(name?: string): string {
  const active = state.skins.find(skin => skin.id === state.activeId)
  const file: AppearanceSkinFile = {
    format: 'roppo-skin', version: 1,
    name: name?.trim() || active?.name || 'Roppo',
    appearance: copyAppearanceSettings(getAppearance()),
  }
  return JSON.stringify(file, null, 2)
}

window.addEventListener('storage', event => {
  if (event.key !== storageKey && event.key !== null) return
  try { publish(readState(event.newValue)) } catch {}
})
