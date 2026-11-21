import type {ModelRequest} from '../backend-sdk.ts'

// Built-ins registered by the pinned OpenCode CLI. OpenCode still selects which
// of its optional tools are available for the active model and feature flags.
export const openCodeBuiltins = [
  'invalid','question','bash','read','glob','grep','edit','write','task',
  'webfetch','todowrite','websearch','skill','apply_patch','execute','lsp','plan_enter','plan_exit',
] as const

const networkTools = new Set(['bash','webfetch','websearch','lsp'])
const webTools = ['websearch','webfetch','webfetch_batch']
export const openCodeReadOnlyTools:ReadonlySet<string>=new Set(['read','glob','grep',...webTools])

export function supportsOpenCodeTools(manifest: {id: string; version: string}, minimumMinor = 2): boolean {
  const [major = 0, minor = 0] = manifest.version.split('.').map(Number)
  return manifest.id === 'opencode-cli' && (major > 1 || major === 1 && minor >= minimumMinor)
}

export function openCodeTools(network: boolean, batch = true): string[] {
  const tools: string[] = openCodeBuiltins.filter(name => network || !networkTools.has(name))
  if (network && batch) tools.push('webfetch_batch')
  return tools
}

export function workspaceTools(mode: ModelRequest['harnessWorkspace']): string[] {
  return mode ? ['read','glob','grep',...(mode === 'edit' ? ['edit'] : [])] : []
}

export function nativeTools(request: ModelRequest): string[] {
  if (request.opencodeNativeTools) {
    const {network}=request.opencodeNativeTools
    if (request.role==='subagent') return network ? [...webTools] : []
    return openCodeTools(network)
  }
  return [...workspaceTools(request.harnessWorkspace),...(request.nativeTool === 'task-list' ? ['todowrite'] : [])]
}
