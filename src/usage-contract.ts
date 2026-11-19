/** Browser-safe numeric accounting. No provider payloads, prompts or native history. */
export type UsageField='inputTokens'|'cachedInputTokens'|'cacheWriteInputTokens'|'outputTokens'|'reasoningOutputTokens'|'totalTokens'
export type TokenCounts=Record<UsageField,number|null>
export type UsagePurpose='router'|'worker'|'subagent'|'verification'|'replanning'|'plan_review'|'memory'|'auxiliary'|'watchdog'
export interface UsageGroup {purpose:UsagePurpose;calls:number;reportedCalls:number;unknownCalls:number;partialCalls:number;steps:number;tokens:TokenCounts}
export interface UsageSummary {since:number|null;calls:number;reportedCalls:number;unknownCalls:number;partialCalls:number;steps:number;tokens:TokenCounts;fieldReported:Record<UsageField,number>;groups:UsageGroup[];legacyUntrackedCalls:number;watchdogUnavailable?:boolean}

export type UsagePeriod = 7 | 30
export interface UsageVolume {
  calls: number
  incompleteCalls: number
  tokens: {total: number; input: number; output: number; unsplit: number} | null
}
export interface ModelUsageVolume extends UsageVolume {model: string | null}
export interface UsageDay extends UsageVolume {date: string; models: ModelUsageVolume[]}
export interface UsageStatistics {
  total: UsageVolume
  days: UsageDay[]
  models: ModelUsageVolume[]
  watchdogUnavailable?: boolean
}
