import {TransientModelError} from '../model.ts'

export class ApiConnectionError extends TransientModelError {
 constructor(readonly code:'connection_timeout'|'connection_unreachable') { super(code) }
}
export class ApiOutputLimitError extends Error {
 constructor(){super('The model exhausted its output token budget before completing the reply')}
}
export class ApiResponseError extends Error {
 constructor(readonly status:number,readonly code?:string,readonly parameter?:string){
  super(['HTTP '+status,code,parameter].filter(Boolean).join(' · '))
 }
}

/** Retain diagnostic identifiers, never provider messages that can echo credentials or prompts. */
export async function apiResponseError(response:Response,secrets:string[]){
 const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0
 if(reader)try{
  for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>16384)break;chunks.push(chunk.value)}
 }finally{await reader.cancel()}
 let value:any
 try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{}
 const identifier=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_.\[\]-]{1,100}$/.test(v)&&!secrets.some(s=>s&&v.includes(s))?v:undefined
 return new ApiResponseError(response.status,identifier(value?.error?.code)??identifier(value?.error?.type),identifier(value?.error?.param))
}

export function apiCheckFailure(error:unknown):{code:string;detail?:string}{
 if(error instanceof ApiResponseError){
  const code=error.status===401?'api_key_rejected':error.status===403?'model_access_denied':error.status===404?'model_not_found':
   error.status===402?'api_quota_exhausted':error.status===429?(/quota|balance|credit/.test(error.code??'')?'api_quota_exhausted':'api_rate_limited'):
   error.status>=500?'provider_unavailable':'api_request_invalid'
  return {code,detail:error.message}
 }
 if(error instanceof ApiConnectionError)return {code:error.code}
 if(error instanceof ApiOutputLimitError)return {code:'model_output_limit'}
 if(error instanceof TransientModelError)return {code:'connection_unreachable'}
 const text=String(error)
 return {code:/Subscription sign-in/.test(text)?'subscription_sign_in_required':/environment variable/.test(text)?'api_key_required':/schema|budget|output|usable response|invalid JSON|incomplete/.test(text)?'model_reply_invalid':'connection_failed'}
}
