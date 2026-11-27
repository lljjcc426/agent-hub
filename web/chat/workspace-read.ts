import { useEffect, useState } from 'react'
import { useWorkspaceTransport } from './workspace-context.tsx'

export function useWorkspaceRead<T>(path: string | null) {
  const { binding, readSignal } = useWorkspaceTransport()
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{ path: string; binding: typeof binding; data?: T; error?: string }>()
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    const signal = AbortSignal.any([readSignal, controller.signal])
    void binding.request<T>(path, undefined, false, undefined, signal).then(
      data => { if (!signal.aborted) setResult({ path, binding, data }) },
      () => { if (!signal.aborted) setResult({ path, binding, error: 'unavailable' }) },
    )
    return () => controller.abort()
  }, [path, binding, readSignal, revision])
  const current = result?.binding === binding && result.path === path ? result : undefined
  return { data: current?.data, error: current?.error, refresh: () => setRevision(n => n + 1) }
}
