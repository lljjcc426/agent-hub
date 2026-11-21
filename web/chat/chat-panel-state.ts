export type TeamTab = 'activity' | 'agents' | 'schedules'

export function initialTeamPanel(saved: string, resources: string, legacy: string): {
  open: boolean; tab: TeamTab; launchBrowser?: boolean
} {
  if (saved === 'closed') return { open: false, tab: 'activity' }
  if (saved === 'activity' || saved === 'agents' || saved === 'schedules') return { open: true, tab: saved }
  if (saved === 'launch-browser') return { open: true, tab: 'agents', launchBrowser: true }
  try {
    const previous = JSON.parse(resources)
    const active = typeof previous?.active === 'string' && Array.isArray(previous.tabs)
      && previous.tabs.find((tab: { id: string }) => tab?.id === previous.active)
    if (['new', 'files', 'browser', 'activity', 'memory'].includes(active?.kind) && typeof previous.visible === 'boolean') {
      return { open: previous.visible && active.kind !== 'memory',
        tab: previous.view !== 'team' && active.kind === 'browser' ? 'agents' : 'activity' }
    }
  } catch {}
  return { open: ['activity', 'browser', 'files'].includes(legacy), tab: legacy === 'browser' ? 'agents' : 'activity' }
}
