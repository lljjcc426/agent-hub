import {modelWindowSchema,type ApiDefinition} from '../backend-config.ts'
import {apiHeaders} from './api-request.ts'

type CatalogEndpoint = Pick<ApiDefinition,'kind'|'baseUrl'|'apiKeyEnv'|'headers'|'headerEnv'>
const maxModels=1000

export function catalogModelWindow(rows:unknown[],model:string){
  const row=catalogRecord(rows.find(row=>catalogIds(row).includes(model)))
  if(!row)return
  const limit=catalogRecord(row.limit),provider=catalogRecord(row.top_provider)
  const parsed=modelWindowSchema.safeParse({context:row.context_window??row.context_length??limit?.context,
    output:row.max_output_tokens??provider?.max_completion_tokens??limit?.output})
  if(parsed.success)return parsed.data
}

export function catalogRecord(value:unknown):Record<string,unknown>|undefined {
  return value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : undefined
}

export function catalogRows(body:unknown):unknown[]|undefined {
  const envelope=catalogRecord(body), data=envelope?.data
  const rows=Array.isArray(data)?data:envelope?.models??catalogRecord(data)?.models??catalogRecord(envelope?.output)?.models
  return Array.isArray(rows)?rows:undefined
}

export function catalogIds(row:unknown):string[] {
  const item=catalogRecord(row)
  return (typeof row==='string'?[row]:[item?.model,item?.id,item?.slug])
    .filter((id):id is string=>typeof id==='string'&&id.trim().length>0&&id.length<=300)
}

export async function catalogJson(url:string,headers:Record<string,string>,signal=AbortSignal.timeout(5_000)):Promise<unknown> {
  const response=await fetch(url,{headers,signal,redirect:'error'})
  if(!response.ok)throw Error('Model catalog unavailable (HTTP '+response.status+')')
  const text=await response.text()
  if(text.length>2_000_000)throw Error('Model catalog is too large')
  return JSON.parse(text)
}

function catalogRequest(endpoint:CatalogEndpoint) {
  const url=new URL(endpoint.baseUrl), path=url.pathname.replace(/\/+$/,'')
  url.pathname=path+'/models'
  let kind=endpoint.kind, paginated=false
  if(url.origin==='https://api.anthropic.com'&&path==='/v1'&&kind==='anthropic') {
    url.searchParams.set('limit',String(maxModels))
  } else if(['https://openrouter.ai','https://eu.openrouter.ai'].includes(url.origin)&&path==='/api/v1'&&kind!=='anthropic') {
    url.pathname=path+'/models/user'
  } else if(url.origin==='https://api.x.ai'&&path==='/v1'&&kind!=='anthropic') {
    url.pathname=path+'/language-models'
  } else if(url.protocol==='https:'&&['/compatible-mode/v1','/apps/anthropic'].includes(path)&&
    (url.hostname.endsWith('.maas.aliyuncs.com')||url.hostname==='dashscope-us.aliyuncs.com')) {
    url.pathname='/api/v1/models'
    url.searchParams.set('capabilities','TG')
    url.searchParams.set('page_size','100')
    url.searchParams.set('page_no','1')
    kind='openai-chat'
    paginated=true
  } else if(url.origin==='https://api.deepseek.com'&&path==='/anthropic'&&kind==='anthropic') {
    url.pathname='/models'
    kind='openai-chat'
  }
  return {url,kind,paginated}
}

export async function apiModelCatalog(endpoint:CatalogEndpoint,credential?:string,timeoutMs=5_000) {
  const {url,kind,paginated}=catalogRequest(endpoint)
  const headers=apiHeaders({...endpoint,kind},credential), signal=AbortSignal.timeout(timeoutMs)
  const first=await catalogJson(url.href,headers,signal), rows=catalogRows(first)
  if(!rows)throw Error('Invalid model catalog')
  if(!paginated)return rows
  const output=catalogRecord(catalogRecord(first)?.output)
  const total=output?.total, size=output?.page_size
  if(typeof total!=='number'||typeof size!=='number'||!Number.isSafeInteger(total)||!Number.isSafeInteger(size)||size<1)return rows
  const result=[...rows]
  const pages=Math.ceil(Math.min(total,maxModels)/size)
  for(let page=2;page<=pages;page++){
    url.searchParams.set('page_no',String(page))
    const entries=catalogRows(await catalogJson(url.href,headers,signal))
    if(!entries)throw Error('Invalid model catalog page')
    if(!entries.length)break
    result.push(...entries)
  }
  return result
}

const endpoints:Record<ApiDefinition['kind'],string>={
  'openai-chat':'chat_completions','openai-responses':'responses',anthropic:'anthropic_messages',
}
const knownEndpoints=new Set(Object.values(endpoints))
const openAiNonChat=/^(?:gpt-image-|chatgpt-image-|dall-e-|text-embedding-|text-search-|whisper-|tts-|omni-moderation-|text-moderation-|sora-)/
const geminiNonChat=/^(?:gemini-embedding-|text-embedding-|imagen-|veo-|lyria-|aqa$)/
const excludesText=(modalities:unknown)=>Array.isArray(modalities)&&!modalities.some(value=>typeof value==='string'&&value.toLowerCase()==='text')

/** Catalogs omit capability fields on some services. Filter explicit mismatches and official non-chat model families. */
export function selectableModelIds(rows:unknown[],endpoint?:Pick<CatalogEndpoint,'baseUrl'|'kind'>) {
  const origin=endpoint&&new URL(endpoint.baseUrl).origin
  const expected=endpoint&&endpoints[endpoint.kind]
  const models=new Set<string>()
  for(const row of rows) {
    const entry=catalogRecord(row), id=catalogIds(row)[0]
    if(!id||entry?.hidden===true||entry?.active===false||entry?.lifecycle==='retired')continue
    const capabilities=catalogRecord(entry?.capabilities)
    if(expected==='chat_completions'&&capabilities?.completion_chat===false)continue
    const architecture=catalogRecord(entry?.architecture), inference=catalogRecord(entry?.inference_metadata)
    const input=entry?.input_modalities??architecture?.input_modalities??inference?.request_modality
    const output=entry?.output_modalities??architecture?.output_modalities??inference?.response_modality
    if(excludesText(input)||excludesText(output))continue
    const offered=entry?.supported_endpoints
    if(expected&&Array.isArray(offered)&&offered.some(value=>knownEndpoints.has(value))&&!offered.includes(expected))continue
    if(origin==='https://api.openai.com'&&openAiNonChat.test(id))continue
    if(origin==='https://generativelanguage.googleapis.com'&&geminiNonChat.test(id))continue
    if(origin==='https://api.groq.com'&&id.startsWith('whisper-'))continue
    models.add(id)
    if(models.size===maxModels)break
  }
  return [...models]
}
