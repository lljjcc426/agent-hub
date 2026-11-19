import type {AgentOptions,ApiDefinition} from './backend-config.ts'
import {isReasoningEffort} from './reasoning-effort.ts'

/** Omission inherits, null is a provider value, arrays replace. Never mutate defaults. */
export function mergeParameters(base:Record<string,unknown>={},override:Record<string,unknown>={}):Record<string,unknown>{
 const result=structuredClone(base)
 for(const [key,value] of Object.entries(override)){
  if(['__proto__','prototype','constructor'].includes(key))throw Error('Invalid parameter key')
  result[key]=value&&typeof value==='object'&&!Array.isArray(value)?mergeParameters(isRecord(result[key])?result[key]:{},value as Record<string,unknown>):structuredClone(value)
 }
 return result
}
function isRecord(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v)}
export function mergeOptions(base:AgentOptions={},override:AgentOptions={}):AgentOptions{return {...structuredClone(base),...structuredClone(override),parameters:mergeParameters(base.parameters,override.parameters),...((base.browser||override.browser)?{browser:{...base.browser,...override.browser}}:{})}}
function effortGroup(kind:ApiDefinition['kind']){
 return kind==='openai-responses'?'reasoning':kind==='anthropic'?'output_config':undefined
}
function providerEffort(kind:ApiDefinition['kind'],parameters:Record<string,unknown>):unknown{
 const group=effortGroup(kind)
 return group?(isRecord(parameters[group])?parameters[group].effort:undefined):parameters.reasoning_effort
}
export function configuredReasoningEffort(kind:string,profile:AgentOptions={},defaults:AgentOptions={},
 parameters?:AgentOptions['parameters'],codexEffort?:AgentOptions['effort']):AgentOptions['effort']{
 if(profile.effort!==undefined)return profile.effort
 if(defaults.effort!==undefined)return defaults.effort
 if(kind==='openai-chat'||kind==='openai-responses'||kind==='anthropic'){
  const raw=providerEffort(kind,mergeParameters(mergeParameters(parameters,defaults.parameters),profile.parameters))
  if(isReasoningEffort(raw))return raw
 }
 if(kind==='codex')return codexEffort
}
function writeProviderEffort(kind:ApiDefinition['kind'],parameters:Record<string,unknown>,effort:NonNullable<AgentOptions['effort']>|null){
 const group=effortGroup(kind)
 if(!group){
  if(effort===null)delete parameters.reasoning_effort
  else parameters.reasoning_effort=effort
  return
 }
 const fields=isRecord(parameters[group])?{...parameters[group]}:{}
 if(effort===null)delete fields.effort
 else fields.effort=effort
 if(Object.keys(fields).length)parameters[group]=fields
 else delete parameters[group]
}
export function reasoningOverride(kind:string,parameters:Record<string,unknown>|undefined,effort:NonNullable<AgentOptions['effort']>|null):Pick<AgentOptions,'effort'|'parameters'>{
 if(kind!=='openai-chat'&&kind!=='openai-responses'&&kind!=='anthropic')return {effort}
 const next=structuredClone(parameters??{})
 writeProviderEffort(kind,next,effort)
 return {effort,parameters:Object.keys(next).length?next:undefined}
}
export function apiOptions(d:ApiDefinition,o:AgentOptions):ApiDefinition{
 const parameters=mergeParameters(d.parameters,o.parameters)
 if(o.effort!==undefined){
  const raw=providerEffort(d.kind,parameters)
  if(o.effort!==null&&raw!==undefined&&raw!==o.effort)throw Error('Conflicting reasoning effort in form and provider parameters')
  writeProviderEffort(d.kind,parameters,o.effort)
 }
 return {...d,parameters,...(o.maxOutputTokens!==undefined?{maxOutputTokens:o.maxOutputTokens}:{}),...(o.maxSteps!==undefined?{maxSteps:o.maxSteps}:{}),...(o.maxToolCalls!==undefined?{maxToolCalls:o.maxToolCalls}:{})}
}
