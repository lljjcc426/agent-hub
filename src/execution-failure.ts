import {BackendPluginError,type BackendErrorCode} from './backends/plugin-contract.ts'
import {ContextBudgetExceeded} from './context-budget.ts'
import {OperationError} from './operation-errors.ts'

export interface ExecutionFailure {
 code:BackendErrorCode
 stage:'startup'|'provider'|'execution'
 retryAfterMs?:number
 readOnlyHistory?:true
}

export function backendFailure(error:unknown){
 if(error instanceof BackendPluginError)return {code:error.code,diagnostic:error.diagnostic}
 if(error instanceof OperationError&&error.code!=='operation_failed')return {code:error.code}
 if(error instanceof ContextBudgetExceeded)return {code:'context_budget_exceeded' as const}
}

export function safeWorkerFailure(error:unknown,turnStarted:boolean,toolInvoked:boolean):ExecutionFailure|undefined {
 const failure=backendFailure(error)
 if(!failure||toolInvoked||turnStarted&&!failure.diagnostic?.effectFree)return
 const {code,diagnostic}=failure
 if(!['auth_required','provider_rejected','quota_exhausted','rate_limited','transient','configuration_invalid','context_budget_exceeded','unsupported','read_loop'].includes(code))return
 return {
  code,
  stage:diagnostic?.reason==='provider_status'||error instanceof OperationError?'provider':turnStarted?'execution':'startup',
  ...(diagnostic?.retryAfterMs!==undefined?{retryAfterMs:diagnostic.retryAfterMs}:{}),
  ...(diagnostic?.readOnlyHistory?{readOnlyHistory:true}:{}),
 }
}
