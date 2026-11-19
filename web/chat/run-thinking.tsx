import { useEffect, useState } from 'react'
import type { ExecutionCall } from '../../src/execution-activity.ts'
import { ThinkingState, type ThinkingStep } from '../ui/run-visualizations.tsx'
import type { Localize } from './composer-commands.tsx'
import { ToolCallDetail, toolLabel } from './tool-trace.tsx'

export function ThinkingActivity({calls,model,live,L,locale,actor,arrival}: {
  calls: ExecutionCall[]
  model?: ExecutionCall
  live: boolean
  L: Localize
  locale: string
  actor: (id?:string)=>string
  arrival?: boolean
}) {
  const records=model?[model,...calls]:calls
  const running=records.some(call=>call.state==='running')
  const failed=model?.state==='failed'||model?.state==='interrupted'||
    (!model&&calls.length>0&&calls.every(call=>call.state==='failed'||call.state==='interrupted'))
  const ticking=running&&live
  const [now,setNow]=useState(Date.now)
  useEffect(()=>{
    if(!ticking)return
    const tick=()=>setNow(Date.now())
    tick()
    const timer=window.setInterval(tick,1000)
    return ()=>window.clearInterval(timer)
  },[ticking])
  const start=Math.min(...records.map(call=>call.startedAt))
  const end=Math.max(...records.map(call=>call.endedAt??call.startedAt))
  const steps:ThinkingStep[]=calls.map(call=>{
    const active=call.state==='running'
    const label=toolLabel(call,L)
    return {id:call.id,label,state:active?'working':'done',kind:call.trace?.kind==='search'?'search':undefined,
      content:<ToolCallDetail call={call} label={label} active={active&&live} locale={locale} L={L} actor={actor}/>}
  })
  if(model?.status)steps.unshift({id:model.id,label:model.status.label,state:model.state==='running'?'working':'done'})
  return <div className="chat-thinking-activity" data-arrival={arrival}>
    <ThinkingState steps={steps} state={running?'running':failed?'failed':'done'}
      elapsedMs={(ticking?now:end)-start} defaultExpanded={ticking} L={L}/>
  </div>
}
