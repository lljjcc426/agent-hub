import { useEffect, useState } from 'react'
import type { ChatSessions } from '../../src/chat.ts'
import { ThinkingState, type ThinkingStep } from '../ui/run-visualizations.tsx'
import type { Localize } from './composer-commands.tsx'
import { toolLabel, toolStatus } from './tool-trace.tsx'

type Snapshot = ReturnType<ChatSessions['view']>
const hidden = new Set(['superagent_status','chat_opening','superagent_plan'])

export function ChatRunThinking({snapshot,L}: {snapshot:Snapshot; L:Localize}) {
  const run = snapshot.run
  const active = run?.state === 'running' || run?.state === 'queued'
  const [now,setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const tick = () => setNow(Date.now())
    tick()
    const timer = window.setInterval(tick,1000)
    return () => window.clearInterval(timer)
  },[active])
  if (!run || (!active && run.state !== 'completed')) return null
  const calls = snapshot.calls.filter(call => call.runId === run.id && !hidden.has(call.name))
  const start = calls.find(call => call.kind === 'router')?.startedAt ?? run.createdAt
  const end = Math.max(start,...calls.flatMap(call => call.endedAt && call.state !== 'interrupted' ? [call.endedAt] : []))
  if (!active && end === start) return null
  const steps = calls.flatMap((call): ThinkingStep[] => {
    const state = active && call.state === 'running' ? 'working' : 'done'
    if (call.kind !== 'tool') return call.status ? [{id:call.id,label:call.status.label,state}] : []
    return [{
      id:call.id,
      label:toolLabel(call,L),
      kind:call.trace?.kind === 'search' ? 'search' : undefined,
      state,
      detail:call.state === 'failed' || call.state === 'interrupted' ? toolStatus(call,L) : undefined,
    }]
  })
  return <div className="run-activity chat-run-thinking roppo-ui">
    <ThinkingState steps={steps.slice(-8)} state={active ? 'running' : 'done'}
      elapsedMs={(active ? now : end) - start} defaultExpanded={active} L={L}/>
  </div>
}
