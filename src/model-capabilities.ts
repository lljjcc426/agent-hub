import {apiHeaders} from './backends/api-request.ts'
import {apiModelCatalog,catalogIds as ids,catalogJson,catalogRecord as record,catalogRows,selectableModelIds} from './backends/model-catalog.ts'
import {isApiBackend,type ApiDefinition,type BackendDefinition} from './backend-config.ts'
import {connectionFingerprint} from './connection-library.ts'
import {isReasoningEffort,reasoningEfforts,type ModelCapabilities,type ReasoningCapability} from './reasoning-effort.ts'
import type {Runtime} from './runtime.ts'

const unknown:ReasoningCapability={efforts:[],source:'unknown'}
const listLifetime=120_000
const retryDelay=10_000

function capability(levels:unknown[],preferred:unknown,source:ReasoningCapability['source']):ReasoningCapability {
  const efforts=[...new Set(levels.filter(isReasoningEffort))]
  return {efforts,source,...(isReasoningEffort(preferred)&&efforts.includes(preferred)?{defaultEffort:preferred}:{})}
}

export function catalogReasoning(row:unknown):ReasoningCapability|undefined {
  const model=record(row)
  if(Array.isArray(model?.supportedReasoningEfforts))
    return capability(model.supportedReasoningEfforts.map(level=>record(level)?.reasoningEffort??level),model.defaultReasoningEffort,'catalog')
  if(Array.isArray(model?.supported_reasoning_efforts))
    return capability(model.supported_reasoning_efforts,model.default_reasoning_effort,'catalog')
  const deepseek=record(model?.effort)
  if(Array.isArray(deepseek?.supported_levels))
    return capability(deepseek.supported_levels,deepseek.default_level,'catalog')
  const published=record(model?.capabilities)
  if(Array.isArray(published?.reasoning_effort))
    return capability(published.reasoning_effort,published.default_reasoning_effort,'catalog')
  const anthropic=record(published?.effort)
  if(anthropic?.supported===false)return capability([],undefined,'catalog')
  if(anthropic&&reasoningEfforts.some(level=>typeof record(anthropic[level])?.supported==='boolean')){
    return capability(reasoningEfforts.filter(level=>record(anthropic[level])?.supported===true),undefined,'catalog')
  }
}

const apiBase=(definition:ApiDefinition)=>definition.baseUrl.replace(/\/+$/,'')
function officialProvider(definition:ApiDefinition){
  const base=new URL(definition.baseUrl)
  const path=base.pathname.replace(/\/+$/,'')
  if(base.origin==='https://api.openai.com'&&path==='/v1'&&definition.kind!=='anthropic')return 'openai'
  if(base.origin==='https://api.anthropic.com'&&path==='/v1'&&definition.kind==='anthropic')return 'anthropic'
  if(base.origin==='https://api.deepseek.com'&&(definition.kind==='openai-chat'&&['','/v1'].includes(path)||definition.kind==='anthropic'&&path==='/anthropic'))return 'deepseek'
  if(base.origin==='https://generativelanguage.googleapis.com'&&path==='/v1beta/openai'&&definition.kind==='openai-chat')return 'gemini'
}

// Published model specifications used when the provider metadata omits the effort field.
// These exact IDs are scoped to the official API, never to an OpenAI-compatible proxy.
const officialSpecs:Record<string,Record<string,ReasoningCapability>>={
  // https://developers.openai.com/api/docs/models
  openai:{
    'gpt-6.1-terra':capability(['none','low','medium','high','xhigh','max'],'medium','official'),
    'gpt-6.1-sol':capability(['low','medium','high','xhigh','max'],'medium','official'),
    'gpt-6-astra':capability(['low','medium','high','xhigh','max'],undefined,'official'),
    'gpt-6-sol':capability(['none','low','medium','high','xhigh','max'],'medium','official'),
    'gpt-5.4':capability(['none','low','medium','high','xhigh'],'none','official'),
  },
  // https://platform.claude.com/docs/en/build-with-claude/effort
  anthropic:{
    'claude-opus-5-5':capability(['low','medium','high','xhigh','max'],'medium','official'),
    'claude-sonnet-5-5':capability(['low','medium','high','xhigh','max'],'high','official'),
    'claude-haiku-5-5':capability(['low','medium','high','xhigh','max'],'medium','official'),
  },
  // https://api-docs.deepseek.com/zh-cn/api/list-models/
  deepseek:{
    'deepseek-flash':capability(['low','high','max'],'high','official'),
    'deepseek-v4-pro':capability(['low','high','max'],'high','official'),
  },
  // https://ai.google.dev/gemini-api/docs/openai and /thinking
  gemini:{
    'gemini-4-hydrogen':capability(['low','medium','high','xhigh'],'high','official'),
    'gemini-4-neon':capability(['low','medium','high','xhigh'],'high','official'),
    'gemini-4-carbon':capability(['low','medium','high'],'medium','official'),
    'gemini-4-argon':capability(['low','medium','high'],'medium','official'),
    'gemini-3.1-pro-preview':capability(['low','medium','high'],'high','official'),
    'gemini-3.1-flash-lite':capability(['minimal','low','medium','high'],'minimal','official'),
    'gemini-3-flash-preview':capability(['minimal','low','medium','high'],'high','official'),
    'gemini-3-pro-preview':capability(['low','high'],'high','official'),
    'gemini-2.5-pro':capability(['low','medium','high'],undefined,'official'),
    'gemini-2.5-flash':capability(['none','low','medium','high'],undefined,'official'),
    'gemini-2.5-flash-lite':capability(['none','low','medium','high'],'none','official'),
  },
}

const knownOpenAiChatModels=new Set(['gpt-6.1-terra','gpt-5.4'])

export function openAiReasoningSpec(markdown:string,model:string,chat=false):ReasoningCapability|undefined {
  const id=/^\s*(?:-\s+)?Model ID:\s*`?([^\s`]+)/m.exec(markdown)?.[1]
  if(id!==model)return
  if(chat&&!/^\s*(?:-\s+)?Supported endpoints:[^\n]*\bchat_completions\b/m.test(markdown))return
  const paragraph=markdown.split(/\r?\n\s*\r?\n/).find(text=>/`?reasoning\.effort`? supports\b/i.test(text))
  const declaration=paragraph?.match(/`?reasoning\.effort`? supports\s*:?\s*([^.]+)/i)?.[1]
  if(!declaration)return
  const levels=[...declaration.matchAll(/\b(none|minimal|low|medium|high|xhigh|max|ultra)\b`?(\s*\(default\))?/g)]
  const result=capability(levels.map(level=>level[1]),levels.find(level=>level[2])?.[1],'official')
  return result.efforts.length?result:undefined
}

type Cached<T>={expires:number;result:Promise<T>}

export class ModelCapabilityCatalog {
  private connections=new WeakMap<Runtime,Map<string,Cached<unknown[]>&{fingerprint:string}>>()
  private specs=new Map<string,Cached<ReasoningCapability|undefined>>()

  private catalog(host:Runtime,id:string,definition:BackendDefinition){
    let cache=this.connections.get(host)
    if(!cache){cache=new Map();this.connections.set(host,cache)}
    const fingerprint=connectionFingerprint(host,definition),saved=cache.get(id)
    if(saved?.fingerprint===fingerprint&&saved.expires>Date.now())return saved.result
    const entry={fingerprint,expires:Date.now()+listLifetime,result:this.load(host,id,definition).catch(()=>{
      entry.expires=Date.now()+retryDelay
      return []
    })}
    cache.set(id,entry)
    return entry.result
  }
  private async load(host:Runtime,id:string,definition:BackendDefinition){
    if(isApiBackend(definition)){
      if(definition.subscription)return catalogRows(await host.subscriptions.models(definition.subscription.account))??[]
      return apiModelCatalog(definition)
    }
    return catalogRows(await host.model.catalog?.(id))??[]
  }
  private official(definition:ApiDefinition,model:string,preview:boolean){
    const provider=officialProvider(definition)
    if(!provider)return Promise.resolve(undefined)
    const specs=officialSpecs[provider]!
    const chat=definition.kind==='openai-chat'
    const allowed=provider!=='openai'||!chat||knownOpenAiChatModels.has(model)
    const initial=allowed&&Object.hasOwn(specs,model)?specs[model]:undefined
    if(initial||provider!=='openai'||preview||!/^[a-z0-9][a-z0-9._-]{0,120}$/i.test(model))return Promise.resolve(initial)
    const key=definition.kind+':'+model,saved=this.specs.get(key)
    if(saved&&saved.expires>Date.now())return saved.result
    const result=(async()=>{
      try {
        const response=await fetch('https://developers.openai.com/api/docs/models/'+encodeURIComponent(model)+'.md',{
          headers:{Accept:'text/markdown'},signal:AbortSignal.timeout(3000),redirect:'error',
        })
        if(response.ok&&response.headers.get('content-type')?.includes('text/markdown'))
          return openAiReasoningSpec(await response.text(),model,chat)
      }catch{/* Official specifications are an optional source for this model. */}
    })()
    if(this.specs.size>=128)this.specs.delete(this.specs.keys().next().value!)
    this.specs.set(key,{expires:Date.now()+listLifetime,result})
    return result
  }
  async read(host:Runtime,backend:string,model?:string,preview=false):Promise<ModelCapabilities>{
    const definition=Object.hasOwn(host.config.backends,backend)?host.config.backends[backend]:(backend==='codex'?{kind:'codex' as const}:undefined)
    if(!definition)return {models:model?[model]:[],reasoning:unknown}
    const rows=preview?[]:await this.catalog(host,backend,definition)
    const defaultModel=ids(rows.find(row=>record(row)?.isDefault===true))[0]
    const selected=model??definition.model??(definition.kind==='codex'?host.config.model:undefined)??defaultModel
    const offered=selectableModelIds(rows,isApiBackend(definition)?definition:undefined)
    const available=[...new Set([...offered,...[definition.model,selected].filter((id):id is string=>!!id)])]
    if(!selected)return {models:available,reasoning:unknown}
    const row=rows.find(row=>ids(row).includes(selected))
    let reasoning=catalogReasoning(row)
    if(!reasoning&&isApiBackend(definition)&&(!definition.subscription||row)){
      if(!preview&&officialProvider(definition)==='anthropic'){
        try{reasoning=catalogReasoning(await catalogJson(apiBase(definition)+'/models/'+encodeURIComponent(selected),apiHeaders(definition)))}catch{/* No model metadata. */}
      }
      reasoning??=await this.official(definition,selected,preview)
    }
    return {model:selected,models:available,reasoning:reasoning??unknown}
  }
}
