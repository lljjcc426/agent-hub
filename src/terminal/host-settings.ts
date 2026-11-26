import { z } from 'zod'
import { configuredReasoningEffort, reasoningOverride } from '../agent-options.ts'
import { reasoningEfforts } from '../reasoning-effort.ts'
import type { BackendDefinition } from '../backend-config.ts'
import type { Runtime } from '../runtime.ts'
import { SettingsError } from '../settings.ts'

export const terminalHostChange = z.discriminatedUnion('action', [
  z.object({ action: z.literal('model'), revision: z.number().int().nonnegative(), backend: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), model: z.string().trim().min(1).max(300).optional() }).strict(),
  z.object({ action: z.literal('effort'), revision: z.number().int().nonnegative(), effort: z.enum(reasoningEfforts).nullable() }).strict(),
  z.object({ action: z.literal('permissions'), mode: z.enum(['ask', 'full']) }).strict()
])
export function terminalHostSettings(runtime: Runtime, owner: string) {
  const { config, revision } = runtime.settings.current()
  const backend = config.execution.router?.backend ?? config.execution.roles.router ?? config.execution.backend
  const definition = config.backends[backend]
  const definitions: Record<string, BackendDefinition> = { codex: { kind: 'codex' }, ...config.backends }
  return {
    revision,
    backend,
    model: config.execution.router?.model ?? config.models.router ?? definition?.model ?? (backend === 'codex' ? config.model : undefined),
    effort: configuredReasoningEffort(definition?.kind ?? 'codex', config.execution.router, definition?.defaults, definition && 'parameters' in definition ? definition.parameters : undefined, config.effort),
    approvalMode: runtime.chat.space(owner).approvalMode,
    connections: Object.entries(definitions)
      .map(([id, d]) => ({ id, label: d.label ?? id, kind: d.kind, model: d.model }))
  }
}
export type HostSettings = ReturnType<typeof terminalHostSettings>
export function changeTerminalHostSettings(runtime: Runtime, owner: string, change: z.infer<typeof terminalHostChange>) {
  if (change.action === 'permissions') {
    runtime.chat.setApprovalMode(owner, change.mode)
  } else {
    const { config, revision } = runtime.settings.current()
    if (change.revision !== revision) throw new SettingsError('settings_conflict', 'Settings changed. Open the picker again.', 409)
    const current = config.execution.router?.backend ?? config.execution.roles.router ?? config.execution.backend
    const backend = change.action === 'model' ? change.backend : current
    if (backend !== 'codex' && !Object.hasOwn(config.backends, backend)) throw Error('Unknown model connection: ' + backend)
    const router = { ...config.execution.router, backend }
    if (change.action === 'model') {
      if (backend !== current) {
        delete router.parameters
        delete router.nativeTool
      }
      router.model = change.model
    }
    Object.assign(router, reasoningOverride(config.backends[backend]?.kind ?? 'codex', router.parameters, change.action === 'effort' ? change.effort : null))
    runtime.updateSettings(revision, {
      execution: { ...config.execution, router },
      ...(change.action === 'model' ? { models: Object.fromEntries(Object.entries(config.models).filter(([key]) => key !== 'router')) } : {})
    })
  }
  return terminalHostSettings(runtime, owner)
}
