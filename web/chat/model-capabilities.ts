import {useEffect, useMemo, useState} from 'react'
import {reasoningEfforts, type ModelCapabilities, type ReasoningEffort} from '../../src/reasoning-effort.ts'
import type {Localize} from './composer-commands.tsx'
import {lastRead, rememberRead} from './last-read.ts'

export type LoadModelCapabilities = (backend: string, model?: string, signal?: AbortSignal, refresh?: boolean) => Promise<ModelCapabilities>
const unavailable: ModelCapabilities = {models: [], reasoning: {efforts: [], source: 'unknown'}}
const modelLists = 'roppo.models.catalog', modelEfforts = 'roppo.models.efforts'
type SavedEffort = Pick<ModelCapabilities, 'model' | 'reasoning'>

export const loadModelCapabilities: LoadModelCapabilities = async (backend, model, signal, refresh) => {
  const query = new URLSearchParams({backend, ...(model ? {model} : {}), ...(refresh ? {refresh: '1'} : {})})
  const response = await fetch('/model-connections/capabilities?' + query, {signal, credentials: 'same-origin'})
  if (!response.ok) throw Error('model_capabilities_unavailable')
  return response.json()
}

export function useModelCapabilities(backend: string, model?: string, load: LoadModelCapabilities = loadModelCapabilities,
  scope = 0, refresh?: number) {
  const key = JSON.stringify([scope, backend, model])
  const persist = !!backend && load === loadModelCapabilities
  const cached = useMemo<ModelCapabilities | undefined>(() => {
    if (!persist) return
    const models = lastRead<string[]>(modelLists, backend)
    const effort = lastRead<SavedEffort>(modelEfforts, key)
    if (models || effort) return {...unavailable, ...effort, models: models ?? []}
  }, [backend, key, persist])
  const [result, setResult] = useState<{key: string; refresh?: number; load: LoadModelCapabilities; data?: ModelCapabilities}>()
  const current = result?.key === key && result.load === load
  useEffect(() => {
    if (!backend) return
    const controller = new AbortController()
    const apply = (data?: ModelCapabilities) => {
      if (controller.signal.aborted) return
      if (data && persist) {
        if (!data.catalogUnavailable) rememberRead(modelLists, backend, data.models, 12)
        if (!data.catalogUnavailable || data.reasoning.source !== 'unknown') {
          rememberRead(modelEfforts, key, {model: data.model, reasoning: data.reasoning})
        }
      }
      setResult(last => {
        const previous = last?.key === key && last.load === load ? last.data ?? cached : cached
        if (!data) return {key, refresh, load, data: previous}
        if (!data.catalogUnavailable || !previous) return {key, refresh, load, data}
        return {key, refresh, load, data: {
          ...data,
          model: data.model ?? previous.model,
          models: previous.models.length ? previous.models : data.models,
          reasoning: data.reasoning.source === 'unknown' ? previous.reasoning : data.reasoning,
        }}
      })
    }
    void load(backend, model, controller.signal, refresh !== undefined).then(apply, () => apply())
    return () => controller.abort()
  }, [backend, model, load, key, refresh, persist, cached])
  const data = (current ? result.data : cached) ?? unavailable
  return {...data, efforts: reasoningEfforts.filter(level => data.reasoning.efforts.includes(level)),
    pending: !!backend && (!current || result.refresh !== refresh)}
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
