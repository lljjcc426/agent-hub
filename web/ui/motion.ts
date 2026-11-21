import type { AppearanceMotionPreference } from '../chat/appearance-store.ts'

export function getMotionPreference(): AppearanceMotionPreference {
  return window.roppoAppearance?.motionPreference ?? matchMedia('(prefers-reduced-motion: reduce)')
}
