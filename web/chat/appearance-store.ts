import { useSyncExternalStore } from 'react'

export type AppearanceMode = 'light' | 'dark'
export type AppearanceProfile = {
  preset: string
  accentName: string
  contrast: number
  background: string
  foreground: string
  accent: string
}
export type AppearanceSettings = {
  version: 1
  mode: AppearanceMode | 'system'
  separate: boolean
  uiSize: number
  contentSize: number
  codeSize: number
  motion: 'system' | 'on' | 'off'
  smart: boolean
  fullWidth: boolean
  diff: 'color' | 'sign'
  profiles: Record<AppearanceMode, AppearanceProfile>
}
export type AppearancePreset = {
  id: string
  name: string
  light: Pick<AppearanceProfile, 'background' | 'foreground' | 'accent'>
  dark: Pick<AppearanceProfile, 'background' | 'foreground' | 'accent'>
}
export type AppearanceUpdate = AppearanceSettings | ((previous: AppearanceSettings) => AppearanceSettings)
export type AppearanceMotionPreference = {
  readonly matches: boolean
  addEventListener(type: 'change', listener: EventListener): void
  removeEventListener(type: 'change', listener: EventListener): void
}

type AppearanceRuntime = {
  getSnapshot(): AppearanceSettings
  getMode(): AppearanceMode
  motionPreference: AppearanceMotionPreference
  setAppearance(next: AppearanceUpdate): void
  presets: AppearancePreset[]
  defaultSettings(): AppearanceSettings
  exportTheme(mode: AppearanceMode): string
  importTheme(value: string, mode: AppearanceMode): void
  isTheme(value: string): boolean
}

declare global {
  interface Window {
    roppoAppearance: AppearanceRuntime
  }
}

const runtime = window.roppoAppearance
const subscribe = (listener: () => void) => {
  window.addEventListener('roppo:appearancechange', listener)
  return () => window.removeEventListener('roppo:appearancechange', listener)
}

export const appearancePresets = runtime.presets
export const defaultAppearanceSettings = runtime.defaultSettings
export const setAppearance = runtime.setAppearance
export const getAppearance = runtime.getSnapshot

export function useAppearance(): [AppearanceSettings, (next: AppearanceUpdate) => void] {
  return [useSyncExternalStore(subscribe, runtime.getSnapshot), runtime.setAppearance]
}

const modeSnapshot = (): AppearanceMode => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'

export function useAppearanceMode(): AppearanceMode {
  return useSyncExternalStore(subscribe, modeSnapshot)
}

export function exportAppearanceTheme(mode: AppearanceMode): string {
  return runtime.exportTheme(mode)
}

export function importAppearanceTheme(value: string, mode: AppearanceMode): void {
  runtime.importTheme(value, mode)
}

export function isAppearanceTheme(value: string, _mode: AppearanceMode): boolean {
  return runtime.isTheme(value)
}
