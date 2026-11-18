import type {BackendDefinition} from './backend-config.ts'
export type CliNativeTool='cached-web-search'|'task-list'
export function nativeToolFor(backend?:BackendDefinition):CliNativeTool|undefined {
  if(!backend||backend.kind==='codex'||backend.kind==='plugin'&&backend.plugin==='codex-cli')return 'cached-web-search'
  if(backend.kind==='plugin'&&['claude-code','gemini-cli','opencode-cli'].includes(backend.plugin))return 'task-list'
}
