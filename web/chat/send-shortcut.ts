export type SendShortcut = 'enter' | 'modifier-enter'

export const sendShortcutStorageKey = 'roppo.chat.sendShortcut'

export function parseSendShortcut(value: string | null): SendShortcut {
  return value === 'modifier-enter' ? value : 'enter'
}

export const sendModifier = typeof navigator !== 'undefined' && /^(Mac|iPhone|iPad|iPod)/.test(navigator.platform)
  ? { eventKey: 'metaKey', name: 'Meta', label: '⌘' } as const
  : { eventKey: 'ctrlKey', name: 'Control', label: 'Ctrl' } as const

export const modifierEnterLabel = sendModifier.label + ' + Enter'
