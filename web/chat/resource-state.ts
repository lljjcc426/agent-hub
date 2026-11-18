export type ResourceKind = 'new' | 'files' | 'browser' | 'activity';
type WorkspaceKind = Exclude<ResourceKind, 'activity'>;
export type ToolKind = Exclude<WorkspaceKind, 'new'>;
export type ResourceTab = { id: string; kind: WorkspaceKind };
export type ResourceState = {
  tabs: ResourceTab[];
  active: string;
  visible: boolean;
  view: 'team' | 'tools';
  recent: { kind: ToolKind; at: number }[];
};
const kinds: ResourceKind[] = ['new', 'files', 'browser', 'activity'];
type SavedTab = { id: string; kind: ResourceKind | 'memory' };
const tab = (kind: WorkspaceKind): ResourceTab => ({ id: crypto.randomUUID(), kind });
export const resourceKey = (conversationId: string | null) => 'roppo.resources.' + (conversationId ?? 'new');
export function initialResources(raw: string, legacy = ''): ResourceState {
  try {
    const value = JSON.parse(raw);
    if (!value || !Array.isArray(value.tabs) || value.tabs.length < 1 || value.tabs.length > 12) throw Error();
    const ids = new Set<string>(), tools = new Set<string>();
    const savedTabs: SavedTab[] = value.tabs.map((t: SavedTab) => {
      if (!t || typeof t.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(t.id) || ids.has(t.id) || !(t.kind === 'memory' || kinds.includes(t.kind)) || (t.kind !== 'new' && tools.has(t.kind))) throw Error();
      ids.add(t.id); tools.add(t.kind);
      return { id: t.id, kind: t.kind };
    });
    // Older layouts stored the overview as a workspace tab.
    const savedActive = savedTabs.find(t => t.id === value.active)?.kind;
    const tabs = savedTabs.filter((t): t is ResourceTab => t.kind !== 'memory' && t.kind !== 'activity');
    if (!tabs.length) tabs.push(tab('new'));
    const recent: ResourceState['recent'] = Array.isArray(value.recent)
      ? value.recent.filter((r: ResourceState['recent'][number]) =>
        r && ['files','browser'].includes(r.kind) && Number.isFinite(r.at) && r.at >= 0 && r.at <= 8.64e15
      ).slice(0,2)
      : [];
    const lastOpen = recent.find(r => tabs.some(t => t.kind === r.kind));
    const active = tabs.find(t => t.id === value.active) ?? tabs.find(t => t.kind === lastOpen?.kind) ?? tabs[0]!;
    const oldHome = savedActive === 'activity' || (!value.view && !value.visible && savedActive === 'new');
    const view = value.view === 'team' || oldHome ? 'team' : 'tools';
    return { tabs, active: active.id, view, visible: value.visible === true && savedActive !== 'memory', recent };
  } catch {
    const first = tab(legacy === 'files' || legacy === 'browser' ? legacy : 'new');
    return { tabs: [first], active: first.id, visible: first.kind !== 'new' || legacy === 'activity', view: first.kind === 'new' ? 'team' : 'tools', recent: [] };
  }
}
export function openResource(state: ResourceState, kind: ResourceKind, at = Date.now()): ResourceState {
  if (kind === 'activity') return {...state, view:'team', visible:true};
  const existing = state.tabs.find(t => t.kind === kind);
  const next = existing ?? tab(kind);
  // One launcher and one view of each tool; reopening restores its existing tab.
  return { tabs: existing ? state.tabs : [...state.tabs, next], active: next.id, visible: true, view:'tools',
    recent: kind === 'new' ? state.recent : [{kind,at}, ...state.recent.filter(r => r.kind !== kind)] };
}
export function closeResource(state: ResourceState, id: string): ResourceState {
  const index = state.tabs.findIndex(t => t.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter(t => t.id !== id);
  if (!tabs.length) { const first = tab('new'); return {...state, tabs:[first],active:first.id}; }
  return {...state,tabs,active:state.active === id ? tabs[Math.min(index,tabs.length-1)]!.id : state.active};
}
/** New-tab input accepts web URLs only; a non-URL remains a tool search. */
export function resourceUrl(value: string): string | null {
  const text = value.trim();
  if (!text || /\s/.test(text)) return null;
  if (!/^https?:\/\//i.test(text) && !/^(localhost|127\.0\.0\.1|\[[\da-f:]+\]|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]|$)/i.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : (/^(localhost|127\.0\.0\.1)([:/]|$)/i.test(text) ? 'http://' : 'https://') + text);
    return ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
