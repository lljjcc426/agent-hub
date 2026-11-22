import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppearanceSettings, AppearanceUpdate } from '../web/chat/appearance-store.ts'

const source = readFileSync(new URL('../src/ui/theme-init.js', import.meta.url), 'utf8')
const appearanceKey = 'agenthub.configuration.appearance'
const skinsKey = 'agenthub.configuration.appearance-skins'

type Runtime = {
  getSnapshot(): AppearanceSettings
  setAppearance(next: AppearanceUpdate): void
  defaultSettings(): AppearanceSettings
}

// Run the real bootstrap and store with only the browser primitives they consume.
async function boot(storage = new Map<string, string>()) {
  const window = new EventTarget() as EventTarget & { roppoAppearance: Runtime }
  const writes = vi.fn((name: string, value: string) => storage.set(name, value))
  const localStorage = { getItem: (name: string) => storage.get(name) ?? null, setItem: writes }
  const changes = vi.fn()
  window.addEventListener('roppo:appearancechange', changes)
  runInNewContext(source, {
    window, Event, localStorage,
    document: {
      documentElement: { dataset: {}, lang: 'en', toggleAttribute() {} },
      head: { append() {} }, createElement: () => ({ id: '', textContent: '' }),
    },
    matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
  })
  vi.resetModules()
  vi.stubGlobal('window', window)
  vi.stubGlobal('localStorage', localStorage)
  const store = await import('../web/chat/appearance-skins-store.ts')
  return {
    store, storage, writes, changes, runtime: window.roppoAppearance,
    receiveStorage: (value: string | null) => window.dispatchEvent(Object.assign(new Event('storage'), { key: skinsKey, newValue: value })),
  }
}

function customized(base: AppearanceSettings): AppearanceSettings {
  return {
    ...base, mode: 'dark', separate: true, uiSize: 17, contentSize: 21, codeSize: 16,
    motion: 'off', smart: false, fullWidth: true, diff: 'sign',
    profiles: {
      light: { preset: 'custom', accentName: 'custom', contrast: 72, background: '#f4edda', foreground: '#253341', accent: '#7650a4' },
      dark: { preset: 'custom', accentName: 'blue', contrast: 81, background: '#152032', foreground: '#efefdc', accent: '#5599dd' },
    },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('appearance skins', () => {
  it('uses the immutable system default without replacing an existing appearance on startup', async () => {
    const defaults = await boot()
    expect(defaults.store.getAppearanceSkins()).toMatchObject({ activeId: 'default', resetBase: { mode: 'system' }, skins: [] })
    const existing = customized(defaults.runtime.getSnapshot())
    const app = await boot(new Map([[appearanceKey, JSON.stringify(existing)]]))
    expect(app.runtime.getSnapshot()).toEqual(existing)
    app.store.selectAppearanceSkin('default')
    expect(app.runtime.getSnapshot()).toEqual(app.runtime.defaultSettings())
    expect(app.runtime.getSnapshot().mode).toBe('system')
    expect(() => app.store.renameAppearanceSkin('default', 'Renamed')).toThrow()
    expect(() => app.store.deleteAppearanceSkin('default')).toThrow()
  })

  it('captures all settings, keeps temporary edits separate, and resets only when changed', async () => {
    const app = await boot()
    const saved = customized(app.runtime.getSnapshot())
    app.runtime.setAppearance(saved)
    const skin = app.store.saveAppearanceSkin('夜间专注')
    expect(skin.appearance).toEqual(saved)
    expect(app.store.getAppearanceSkins()).toMatchObject({ activeId: skin.id, resetBase: saved })

    app.runtime.setAppearance(previous => ({ ...previous, mode: 'light', contentSize: 18, profiles: { ...previous.profiles, dark: { ...previous.profiles.dark, accent: '#bb5522' } } }))
    expect(app.store.getAppearanceSkins().skins[0]!.appearance).toEqual(saved)
    expect(app.store.resetAppearanceToSkin()).toBe(true)
    expect(app.runtime.getSnapshot()).toEqual(saved)
    app.writes.mockClear(); app.changes.mockClear()
    expect(app.store.resetAppearanceToSkin()).toBe(false)
    expect(app.writes).not.toHaveBeenCalled()
    expect(app.changes).not.toHaveBeenCalled()
  })

  it('switches directly and supports renaming and deleting active or inactive skins', async () => {
    const app = await boot()
    const firstSettings = customized(app.runtime.getSnapshot())
    app.runtime.setAppearance(firstSettings)
    const first = app.store.saveAppearanceSkin('Focus')
    app.runtime.setAppearance(previous => ({ ...previous, mode: 'light', uiSize: 15 }))
    const second = app.store.saveAppearanceSkin('Reading')
    app.store.selectAppearanceSkin(first.id)
    expect(app.runtime.getSnapshot()).toEqual(firstSettings)
    app.store.renameAppearanceSkin(second.id, '阅读')
    app.store.renameAppearanceSkin(first.id, '专注')
    expect(app.store.getAppearanceSkins().skins.map(skin => skin.name)).toEqual(['专注', '阅读'])
    expect(app.runtime.getSnapshot()).toEqual(firstSettings)
    app.store.deleteAppearanceSkin(second.id)
    expect(app.store.getAppearanceSkins().activeId).toBe(first.id)

    const beforeDeletion = app.store.getAppearanceSkins()
    app.store.deleteAppearanceSkin(first.id)
    expect(app.store.getAppearanceSkins()).toMatchObject({ activeId: null, resetBase: firstSettings, skins: [] })
    expect(app.runtime.getSnapshot()).toEqual(firstSettings)
    app.runtime.setAppearance(previous => ({ ...previous, uiSize: 19 }))
    app.store.restoreAppearanceSkins(beforeDeletion)
    expect(app.runtime.getSnapshot().uiSize).toBe(19)
    expect(app.store.getAppearanceSkins().activeId).toBe(first.id)
    app.store.resetAppearanceToSkin()
    expect(app.runtime.getSnapshot()).toEqual(firstSettings)
  })

  it('exports the current complete appearance and imports with or without applying, including after refresh', async () => {
    const app = await boot()
    app.store.saveAppearanceSkin('Original')
    const appearance = customized(app.runtime.getSnapshot())
    app.runtime.setAppearance(appearance)
    const raw = app.store.exportAppearanceSkin('Shared skin')
    expect(JSON.parse(raw)).toEqual({ format: 'roppo-skin', version: 1, name: 'Shared skin', appearance })
    const parsed = app.store.parseAppearanceSkin(raw)

    app.store.selectAppearanceSkin('default')
    const beforeImport = app.runtime.getSnapshot()
    const added = app.store.importAppearanceSkin(parsed, 'Imported only', false)
    expect(added.appearance).toEqual(appearance)
    expect(app.runtime.getSnapshot()).toEqual(beforeImport)
    expect(app.store.getAppearanceSkins().activeId).toBe('default')
    const applied = app.store.importAppearanceSkin(parsed, 'Imported and applied', true)
    expect(app.runtime.getSnapshot()).toEqual(appearance)
    expect(app.store.getAppearanceSkins()).toMatchObject({ activeId: applied.id, resetBase: appearance })

    const reloaded = await boot(app.storage)
    expect(reloaded.runtime.getSnapshot()).toEqual(appearance)
    expect(reloaded.store.getAppearanceSkins()).toEqual(app.store.getAppearanceSkins())
    reloaded.store.selectAppearanceSkin(added.id)
    expect(reloaded.runtime.getSnapshot()).toEqual(appearance)
  })

  it('rejects conflicting or empty names without changing the library and suggests an available name', async () => {
    const app = await boot()
    const first = app.store.saveAppearanceSkin('Focus')
    const second = app.store.saveAppearanceSkin('Reading')
    const before = app.store.getAppearanceSkins()
    app.writes.mockClear()
    expect(() => app.store.saveAppearanceSkin(' Focus ')).toThrow()
    expect(() => app.store.renameAppearanceSkin(second.id, first.name)).toThrow()
    expect(() => app.store.saveAppearanceSkin('   ')).toThrow()
    expect(app.store.getAppearanceSkins()).toBe(before)
    expect(app.writes).not.toHaveBeenCalled()
    const suggestion = app.store.suggestAppearanceSkinName('Focus')
    expect(suggestion).not.toBe('Focus')
    expect(app.store.saveAppearanceSkin(suggestion).name).toBe(suggestion)
  })

  it('rejects malformed, unsupported or incomplete imports without changing saved or applied settings', async () => {
    const app = await boot()
    app.store.saveAppearanceSkin('Keep')
    const before = app.store.getAppearanceSkins(), appearance = app.runtime.getSnapshot()
    const shared = JSON.parse(app.store.exportAppearanceSkin('Shared'))
    app.writes.mockClear(); app.changes.mockClear()
    for (const raw of ['{', JSON.stringify({ ...shared, version: 2 }), JSON.stringify({ ...shared, appearance: { ...shared.appearance, profiles: { light: shared.appearance.profiles.light } } })]) {
      expect(() => app.store.parseAppearanceSkin(raw)).toThrow()
    }
    expect(app.store.getAppearanceSkins()).toBe(before)
    expect(app.runtime.getSnapshot()).toBe(appearance)
    expect(app.writes).not.toHaveBeenCalled()
    expect(app.changes).not.toHaveBeenCalled()

    const parsed = app.store.parseAppearanceSkin(JSON.stringify({ ...shared, privateData: 'excluded', appearance: { ...shared.appearance, privateData: 'excluded', profiles: { ...shared.appearance.profiles, light: { ...shared.appearance.profiles.light, privateData: 'excluded' } } } }))
    expect(parsed).toEqual(shared)
  })

  it('reports a skin-library write failure without accepting a change in memory or applying an import', async () => {
    const app = await boot()
    const skin = app.store.saveAppearanceSkin('Keep')
    const parsed = app.store.parseAppearanceSkin(app.store.exportAppearanceSkin('Shared'))
    const before = app.store.getAppearanceSkins(), appearance = app.runtime.getSnapshot()
    app.writes.mockImplementation(() => { throw new Error('storage full') })
    expect(() => app.store.renameAppearanceSkin(skin.id, 'Lost rename')).toThrow()
    expect(() => app.store.importAppearanceSkin(parsed, 'Lost import', true)).toThrow()
    expect(app.store.getAppearanceSkins()).toBe(before)
    expect(app.runtime.getSnapshot()).toBe(appearance)
  })

  it('syncs skin metadata and reset baseline from another tab without writing it back', async () => {
    const app = await boot()
    app.runtime.setAppearance(customized(app.runtime.getSnapshot()))
    const skin = app.store.saveAppearanceSkin('Shared')
    const incoming = { ...app.store.getAppearanceSkins(), skins: [{ ...skin, name: 'Renamed elsewhere' }] }
    app.writes.mockClear()
    app.receiveStorage(JSON.stringify(incoming))
    expect(app.store.getAppearanceSkins()).toEqual(incoming)
    expect(app.writes).not.toHaveBeenCalled()
  })
})
