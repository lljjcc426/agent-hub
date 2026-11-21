export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type ReasoningEffort = typeof reasoningEfforts[number]

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (reasoningEfforts as readonly string[]).includes(value)
}

export interface ReasoningCapability {
  efforts: ReasoningEffort[]
  defaultEffort?: ReasoningEffort
  source: 'catalog' | 'official' | 'unknown'
}

export interface ModelCapabilities {
  model?: string
  models: string[]
  reasoning: ReasoningCapability
  catalogUnavailable?: boolean
}
