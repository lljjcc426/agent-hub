import {backendAdmission} from './backend-admission.ts'
import type {Config} from './config.ts'
import {agentOptionsSchema,type BackendDefinition} from './backend-config.ts'
import {backendPackages} from './backends/plugin-package.ts'
import {codexParameterNames} from '../plugins/backend-codex/options.ts'

export function configuredWorkerBackends(config:Config):Record<string,BackendDefinition>{
 return {codex:{kind:'codex',model:config.model},...config.backends}
}

/** Public connection metadata. Credentials, endpoints and launch configuration stay on the host. */
export function workerConnectionCatalog(config:Config,ids:string[]){
 const definitions=configuredWorkerBackends(config),packages=backendPackages(config)
 return ids.map(id=>{
  const definition=definitions[id]!,kind=definition.kind
  const unsupportedOptions=kind==='codex'?['maxOutputTokens','maxSteps','maxToolCalls']:[]
  const plugin=kind==='plugin'?packages.get(definition.plugin)?.manifest:undefined
  return {id,admission:backendAdmission(config,id),label:definition.label??(id==='codex'?'Codex':id),kind,model:definition.model??(kind==='codex'?config.model:undefined),
   ...(kind==='plugin'?{optionSupport:'adapter_defined'}:{options:Object.keys(agentOptionsSchema.shape).filter(key=>!unsupportedOptions.includes(key))}),unsupportedOptions,
   parameterSupport:kind==='codex'?{namespaces:codexParameterNames,description:'Use the listed names in thread, turn or config. API-only limits are unavailable.'}:
    kind==='plugin'?{schema:plugin?.parametersSchema,description:'Adapter-defined parameters and options; only capabilities declared by the adapter are confirmed.'}:
    {description:'Use parameters and effort levels supported by the selected model. AgentHub sends effort through the provider’s reasoning field.'},
   ...(plugin?{capabilities:plugin.capabilities}:{}),
  }
 })
}
