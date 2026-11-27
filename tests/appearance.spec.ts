import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { AppearanceMode, AppearanceSettings, AppearanceUpdate } from '../web/chat/appearance-store.ts'

const source = readFileSync(new URL('../src/ui/theme-init.js', import.meta.url), 'utf8')
const key = 'agenthub.configuration.appearance'
const legacyKey = 'agenthub.configuration.theme'

type Runtime = {
  getSnapshot(): AppearanceSettings
  getMode(): AppearanceMode
  setAppearance(value: AppearanceUpdate): void
  exportTheme(mode: AppearanceMode): string
  importTheme(value: string, mode: AppearanceMode): void
  isTheme(value: string): boolean
  motionPreference: {
    readonly matches: boolean
    addEventListener(type: 'change', listener: EventListener): void
    removeEventListener(type: 'change', listener: EventListener): void
  }
}

// The bootstrap only needs root attributes and a style node; no layout or DOM renderer is simulated.
function boot(storage = new Map<string, string>(), dark = false, reducedMotion = false) {
  const window = new EventTarget() as EventTarget & { roppoAppearance: Runtime }
  const root = { dataset: {} as Record<string, string>, lang: 'en', toggleAttribute: vi.fn() }
  const style = { id: '', textContent: '' }
  const media = (matches: boolean) => Object.assign(new EventTarget(), { matches })
  const scheme = media(dark), motion = media(reducedMotion)
  const writes = vi.fn((name: string, value: string) => storage.set(name, value))
  const changes = vi.fn()
  window.addEventListener('roppo:appearancechange', changes)
  runInNewContext(source, {
    window, Event,
    document: { documentElement: root, head: { append() {} }, createElement: () => style },
    localStorage: { getItem: (name: string) => storage.get(name) ?? null, setItem: writes },
    matchMedia: (query: string) => query.includes('color-scheme') ? scheme : motion,
  })
  return {
    runtime: window.roppoAppearance, root, style, writes, changes,
    receiveStorage: (name: string | null, value: string | null) => window.dispatchEvent(Object.assign(new Event('storage'), { key: name, newValue: value })),
    setSystemDark: (value: boolean) => { scheme.matches = value; scheme.dispatchEvent(new Event('change')) },
    setReducedMotion: (value: boolean) => { motion.matches = value; motion.dispatchEvent(new Event('change')) },
  }
}

describe('appearance persistence and system preferences', () => {
  it('migrates the legacy dark choice once while preserving unrelated preferences', () => {
    const storage = new Map([[legacyKey, 'dark'], ['agenthub.configuration.language', 'zh-CN']])
    const first = boot(storage)
    expect(first.runtime.getSnapshot().mode).toBe('dark')
    expect(first.root.dataset.theme).toBe('dark')
    expect(JSON.parse(storage.get(key)!)).toMatchObject({ version: 1, mode: 'dark' })
    expect(first.writes).toHaveBeenCalledExactlyOnceWith(key, expect.any(String))
    expect(storage.get(legacyKey)).toBe('dark')
    expect(storage.get('agenthub.configuration.language')).toBe('zh-CN')
    expect(boot(storage).writes).not.toHaveBeenCalled()
  })

  it('defaults to system mode and follows dark colors without persisting a preference', () => {
    const app = boot(undefined, true)
    expect(app.runtime.getSnapshot().mode).toBe('system')
    expect(app.runtime.getMode()).toBe('dark')
    expect(app.root.dataset.theme).toBe('dark')
    expect(app.style.textContent).not.toContain('--c-bg:')
    expect(app.writes).not.toHaveBeenCalled()
  })

  it('persists appearance updates and applies them in another open tab without writeback', () => {
    const storage = new Map([[legacyKey, 'light']])
    const first = boot(storage), second = boot(storage)
    second.writes.mockClear()
    first.runtime.setAppearance(previous => ({ ...previous, mode: 'dark', fullWidth: true, uiSize: 16, contentSize: 18, codeSize: 14 }))
    const saved = storage.get(key)!
    expect(first.writes).toHaveBeenLastCalledWith(key, saved)
    second.receiveStorage(key, saved)
    expect(second.runtime.getSnapshot()).toEqual(first.runtime.getSnapshot())
    expect(second.root.dataset).toMatchObject({ theme: 'dark', appearanceFullWidth: 'true' })
    expect(second.writes).not.toHaveBeenCalled()
    expect(second.changes).toHaveBeenCalledOnce()
    expect(boot(storage).runtime.getSnapshot()).toEqual(first.runtime.getSnapshot())
  })

  it('adapts user message bubbles to a custom palette and restores the original default colors', () => {
    const app = boot()
    expect(app.style.textContent).not.toContain('--team-user-bubble:')
    app.runtime.setAppearance(previous => ({ ...previous, profiles: { ...previous.profiles,
      light: { ...previous.profiles.light, background: '#101010', foreground: '#f0f0f0', accent: '#4499cc' },
    } }))
    expect(app.style.textContent).toContain('--team-user-bubble:#162027')
    app.runtime.setAppearance(previous => ({ ...previous, profiles: { ...previous.profiles,
      light: { ...previous.profiles.light, background: '#ffffff', foreground: '#1b1b1b', accent: '#222222' },
    } }))
    expect(app.style.textContent).not.toContain('--team-user-bubble:')
  })

  it('ignores unrelated or invalid storage events and resets when the preference is removed', () => {
    const app = boot()
    app.runtime.setAppearance(previous => ({ ...previous, mode: 'dark' }))
    const snapshot = app.runtime.getSnapshot()
    app.writes.mockClear(); app.changes.mockClear()
    app.receiveStorage('unrelated', '{}')
    app.receiveStorage(key, JSON.stringify({ ...snapshot, codeSize: 100 }))
    expect(app.runtime.getSnapshot()).toBe(snapshot)
    expect(app.changes).not.toHaveBeenCalled()
    app.receiveStorage(key, null)
    expect(app.runtime.getSnapshot().mode).toBe('system')
    expect(app.root.dataset.theme).toBe('light')
    expect(app.writes).not.toHaveBeenCalled()
  })

  it('follows system colors in system mode and always honors OS reduced motion', () => {
    const app = boot()
    app.runtime.setAppearance(previous => ({ ...previous, mode: 'system' }))
    app.writes.mockClear(); app.changes.mockClear()
    app.setSystemDark(true)
    expect(app.runtime.getMode()).toBe('dark')
    expect(app.runtime.getSnapshot().mode).toBe('system')
    app.setReducedMotion(true)
    expect(app.root.dataset.appearanceMotion).toBe('on')
    expect(app.changes).toHaveBeenCalledTimes(2)
    expect(app.writes).not.toHaveBeenCalled()
    app.runtime.setAppearance(previous => ({ ...previous, mode: 'light', motion: 'off' }))
    expect(app.root.dataset.appearanceMotion).toBe('on')
    app.changes.mockClear()
    app.setSystemDark(false); app.setSystemDark(true); app.setReducedMotion(false)
    expect(app.runtime.getMode()).toBe('light')
    expect(app.root.dataset.appearanceMotion).toBe('off')
    expect(app.changes).toHaveBeenCalledOnce()
  })

  it('notifies motion consumers only when the resolved preference changes and supports unsubscribing', () => {
    const app = boot(), preference = app.runtime.motionPreference, values: boolean[] = []
    const listener = () => { values.push(preference.matches) }
    expect(preference.matches).toBe(false)
    preference.addEventListener('change', listener)
    app.runtime.setAppearance(previous => ({ ...previous, mode: 'dark', uiSize: 16 }))
    expect(values).toEqual([])
    app.runtime.setAppearance(previous => ({ ...previous, motion: 'on' }))
    app.runtime.setAppearance(previous => ({ ...previous, motion: 'system' }))
    app.setReducedMotion(true)
    expect(values).toEqual([true, false, true])
    app.runtime.setAppearance(previous => ({ ...previous, motion: 'off' }))
    expect(preference.matches).toBe(true)
    expect(app.root.dataset.appearanceMotion).toBe('on')
    expect(values).toEqual([true, false, true])
    app.setReducedMotion(false)
    expect(preference.matches).toBe(false)
    expect(values).toEqual([true, false, true, false])
    preference.removeEventListener('change', listener)
    app.runtime.setAppearance(previous => ({ ...previous, motion: 'on' }))
    expect(preference.matches).toBe(true)
    expect(values).toEqual([true, false, true, false])
  })
})

describe('theme sharing', () => {
  it('exports only the selected palette and imports it into the requested mode', () => {
    const app = boot()
    app.runtime.setAppearance(previous => ({ ...previous, contentSize: 20, profiles: { ...previous.profiles, light: { ...previous.profiles.light, preset: 'custom', background: '#f5f0e8', foreground: '#243344', accent: '#6750a4', contrast: 72 } } }))
    const shared = app.runtime.exportTheme('light')
    expect(shared).toBe('roppo-theme-v1:' + JSON.stringify({ mode: 'light', preset: 'custom', colors: { background: '#f5f0e8', foreground: '#243344', accent: '#6750a4' }, contrast: 72 }))
    expect(app.runtime.isTheme(shared)).toBe(true)
    const target = boot(), before = target.runtime.getSnapshot()
    target.runtime.importTheme(shared, 'dark')
    expect(target.runtime.getSnapshot()).toMatchObject({ mode: before.mode, contentSize: before.contentSize, profiles: { light: before.profiles.light, dark: { preset: 'custom', accentName: 'custom', background: '#f5f0e8', foreground: '#243344', accent: '#6750a4', contrast: 72 } } })
    expect(target.writes).toHaveBeenCalledOnce()
  })

  it('retains valid colors from an unknown preset as a custom theme', () => {
    const app = boot()
    const shared = 'roppo-theme-v1:' + JSON.stringify({ mode: 'dark', preset: 'another-app-theme', colors: { background: '#101020', foreground: '#F0F0F0', accent: '#4499cc' }, contrast: 100 })
    app.runtime.importTheme(shared, 'dark')
    expect(app.runtime.getSnapshot().profiles.dark).toMatchObject({ preset: 'custom', foreground: '#F0F0F0', contrast: 100 })
  })

  it.each([
    ['unsupported format', '{"mode":"light"}'],
    ['malformed JSON', 'roppo-theme-v1:{'],
    ['invalid color', 'roppo-theme-v1:' + JSON.stringify({ mode: 'light', colors: { background: '#fff', foreground: '#222222', accent: '#4488cc' }, contrast: 50 })],
    ['invalid contrast', 'roppo-theme-v1:' + JSON.stringify({ mode: 'light', colors: { background: '#ffffff', foreground: '#222222', accent: '#4488cc' }, contrast: 101 })],
    ['system instead of a concrete palette', 'roppo-theme-v1:' + JSON.stringify({ mode: 'system', colors: { background: '#ffffff', foreground: '#222222', accent: '#4488cc' }, contrast: 50 })],
  ])('rejects %s without changing or persisting settings', (_label, shared) => {
    const app = boot(), before = app.runtime.getSnapshot()
    expect(app.runtime.isTheme(shared)).toBe(false)
    expect(() => app.runtime.importTheme(shared, 'light')).toThrow()
    expect(app.runtime.getSnapshot()).toBe(before)
    expect(app.writes).not.toHaveBeenCalled()
    expect(app.changes).not.toHaveBeenCalled()
  })
})
