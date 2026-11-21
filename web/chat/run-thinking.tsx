import type { ChatRunState } from '../../src/chat.ts'
import type { ExecutionCall } from '../../src/execution-activity.ts'
import { ThinkingState, type ThinkingStep } from '../ui/run-visualizations.tsx'
import type { Localize } from './composer-commands.tsx'
import { ToolCallDetail, toolLabel, toolStatus } from './tool-trace.tsx'

export function ThinkingActivity({calls,runState,live,L,locale,actor,arrival}: {
  calls: ExecutionCall[]
  runState?: ChatRunState
  live: boolean
  L: Localize
  locale: string
  actor: (id?:string)=>string
  arrival?: boolean
}) {
  const stopped=runState==='failed'||runState==='cancelled'
  const running=!stopped&&runState!=='completed'&&calls.some(call=>call.state==='running')
  const ticking=running&&live
  const start=calls[0]!.startedAt
  const end=Math.max(...calls.map(call=>call.endedAt??call.startedAt))
  const owners=new Map(calls.map(call=>[call.id,call.workerId]))
  const steps:ThinkingStep[]=[]
  for(const call of calls){
    const isTool=call.kind==='tool'
    const failed=call.state==='failed'||call.state==='interrupted'
    if(!isTool&&!call.status&&!failed)continue
    const workerId=call.workerId??(call.parentId?owners.get(call.parentId):undefined)
    const owner=workerId?actor(workerId):call.kind==='subagent'||call.agentId?L('Subagent','子 Agent'):actor()
    const action=isTool?toolLabel(call,L):call.status?.label??L('Model execution','模型执行')
    const label=owner+L(': ','：')+action
    const state=call.state==='running'?'working':call.state==='completed'?'done':call.state
    steps.push({id:call.id,label,state,kind:call.trace?.kind==='search'||call.name==='opencode/websearch'?'search':undefined,
      content:isTool
        ?<ToolCallDetail call={call} label={label} active={ticking&&state==='working'} locale={locale} L={L} actor={actor}/>
        :failed?<>{label}<small className="rv-thinking-step-status">{toolStatus(call,L)}</small></>:undefined})
  }
  return <div className="chat-thinking-activity" data-arrival={arrival}>
    <ThinkingState steps={steps} state={running?'running':stopped?'failed':'done'}
      elapsedMs={end-start} liveSince={ticking?start:undefined} defaultExpanded={ticking} scrollable L={L}/>
  </div>
}
