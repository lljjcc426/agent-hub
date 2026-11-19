import {useEffect, useState} from 'react'
import {reasoningEfforts, type ModelCapabilities, type ReasoningEffort} from '../../src/reasoning-effort.ts'
import type {Localize} from './composer-commands.tsx'

export type LoadModelCapabilities = (backend: string, model?: string, signal?: AbortSignal) => Promise<ModelCapabilities>
const unavailable: ModelCapabilities = {models: [], reasoning: {efforts: [], source: 'unknown'}}

export const loadModelCapabilities: LoadModelCapabilities = async (backend, model, signal) => {
  const query = new URLSearchParams({backend, ...(model ? {model} : {})})
  const response = await fetch('/model-connections/capabilities?' + query, {signal, credentials: 'same-origin'})
  if (!response.ok) throw Error('model_capabilities_unavailable')
  return response.json()
}

export function useModelCapabilities(backend: string, model?: string, load: LoadModelCapabilities = loadModelCapabilities, scope = 0) {
  const [result, setResult] = useState<{backend: string; model?: string; scope: number; load: LoadModelCapabilities; data: ModelCapabilities}>()
  const current = result?.backend === backend && result.model === model && result.scope === scope && result.load === load
  useEffect(() => {
    if (!backend) return
    const controller = new AbortController()
    const apply = (data: ModelCapabilities) => {
      if (!controller.signal.aborted) setResult({backend, model, scope, load, data})
    }
    void load(backend, model, controller.signal).then(apply, () => apply(unavailable))
    return () => controller.abort()
  }, [backend, model, load, scope])
  const data = current ? result.data : unavailable
  return {...data, efforts: reasoningEfforts.filter(level => data.reasoning.efforts.includes(level)), pending: !!backend && !current}
}

const labels = {
  none: ['Off', '关闭'], minimal: ['Minimal', '最少'], low: ['Low', '低'], medium: ['Medium', '中等'],
  high: ['High', '高'], xhigh: ['Extra high', '超高'], max: ['Maximum', '极高'], ultra: ['Ultra', '最高'],
} as const

export function effortLabel(effort: ReasoningEffort | null, L: Localize) {
  if (effort === null) return L('Model default', '模型默认')
  const [en, zh] = labels[effort]
  return L(en, zh)
}
