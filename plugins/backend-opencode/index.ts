import {modelSteps} from '../../src/execution-limits.ts'
import {workspaceTools,nativeTools} from './native-tools.ts'
import {workspaceGuard} from './workspace.ts'
import {join} from 'node:path'
import {existsSync,realpathSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
import {createCliPlugin} from '../cli-shared/backend.ts'
import {BackendAdapterError} from '../backend-sdk.ts'
import {privateFile,readJson,digest,endpoint} from '../cli-shared/files.ts'
import {isolatedEnvironment} from '../cli-shared/environment.ts'
import type {CliDriver} from '../cli-shared/contract.ts'
import {nativeToolBatchSchema} from '../../src/backends/native-tool-batch.ts'
import {toolParallelism} from '../../src/execution-limits.ts'

function batchReport(part:any){
 const pages=part?.state?.metadata?.pages
 if(part?.tool!=='webfetch_batch'||!Array.isArray(pages)||!pages.length||pages.length>toolParallelism)return
 const items=pages.map(page=>({
  target:typeof page?.url==='string'&&page.url.length<=6100?createHash('sha256').update(page.url).digest('hex').slice(0,16):undefined,
  status:page?.status,queuedAt:page?.queuedAt,startedAt:page?.startedAt,endedAt:page?.endedAt,
  reused:page?.reused,failure:page?.failure,httpStatus:page?.httpStatus,
 }))
 const report=nativeToolBatchSchema.safeParse({callId:part.callID,items})
 return report.success?report.data:undefined
}
export const opencodeDriver:CliDriver={
 workspaceTools,nativeTools,workspaceGuard,
 taskListTool:'todowrite',
 id:'opencode-cli',version:'1.19.5',credentialEnvs:['ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY','OPENCODE_API_KEY'],
 anonymous:config=>config.authMode==='anonymous'&&!config.baseUrl&&/^opencode\/(?:[a-z0-9.-]+-free|big-pickle)$/.test(config.model??''),
 credentialKeys(config){const provider=config.provider??config.model?.split('/')[0];return ({anthropic:['ANTHROPIC_API_KEY'],openai:['OPENAI_API_KEY'],google:['GEMINI_API_KEY'],opencode:['OPENCODE_API_KEY']} as Record<string,string[]>)[provider??'']??[]},
 upstream(config,model){
  if(config.baseUrl)return config.baseUrl
  const provider=config.provider??(model??config.model)?.split('/')[0],urls:Record<string,string>={anthropic:'https://api.anthropic.com/v1',openai:'https://api.openai.com/v1',google:'https://generativelanguage.googleapis.com/v1beta',opencode:'https://opencode.ai/zen/v1'}
  if(!provider||!urls[provider])throw new BackendAdapterError('configuration_invalid')
  return urls[provider]!
 },
 discoverSession(root){
  const path=join(root,'data','opencode','opencode.db');if(!existsSync(path))return
  const db=new DatabaseSync(path,{readOnly:true})
  try{
   const sessions=db.prepare('SELECT id,directory FROM session WHERE parent_id IS NULL').all()
   if(sessions.length!==1||realpathSync(String(sessions[0]!.directory))!==realpathSync(join(root,'work')))throw new BackendAdapterError('invalid_output')
   return String(sessions[0]!.id)
  }finally{db.close()}
 },
 auth(directory,config){
  const source=join(directory,'auth.json'),credential=readJson(source)
  const provider=config.provider??config.model?.split('/')[0],account=provider?credential?.[provider]:undefined
  if(!account?.key&&!account?.refresh)return
  return {identity:digest(JSON.stringify([provider,account.type,account.key??account.accountId??account.refresh])),files:[{source,target:'data/opencode/auth.json'}]}
 },
 prepare({config,root,cwd,nativeId,request,mcp,prompt,guardPlugin,toolImages}){
  if(request.options?.effort)throw new BackendAdapterError('unsupported')
  const selected=request.model??config.model
  if(!selected)throw new BackendAdapterError('configuration_invalid')
  const model=config.apiProtocol?'roppo-api/'+selected:selected
  const provider=config.apiProtocol?'roppo-api':config.provider??config.model?.split('/')[0]??model.split('/')[0]!
  if(!model.includes('/')||provider!==model.split('/')[0])throw new BackendAdapterError('configuration_invalid')
  const allowed=nativeTools(request)
  const permission={'*':'deny','roppo_*':'allow',...Object.fromEntries(allowed.map(tool=>[tool,'allow'])),
   ...(guardPlugin?{external_directory:{'*':'deny',[cwd]:'allow',[join(cwd,'**')]:'allow'}}:{})}
  const tools={'*':false,'roppo_*':true,...Object.fromEntries(allowed.map(tool=>[tool,true]))}
  const agentPrompt=request.instructions+(allowed.includes('webfetch_batch')
   ?'\nFor public text research, use websearch to discover official or primary sources. Read known URLs directly with webfetch for one page or webfetch_batch for several pages. Batch independent URLs, reuse successful excerpts, and check that the returned content supports each citation. If a URL is missing, use the official documentation index or search to find its current address. Use the browser only for pages that need authenticated access, interaction, or rendering to retrieve the required content. With supplied URLs and an independent search, emit any required roppo_chat_opening, websearch and webfetch_batch together in the first response. Wait for search results only when the URLs must be discovered first.'
   :'')
  const adapters={'openai-chat':'@ai-sdk/openai-compatible','openai-responses':'@ai-sdk/openai',anthropic:'@ai-sdk/anthropic'}
  const providerOptions=config.apiProtocol?{npm:adapters[config.apiProtocol],name:'Roppo API',models:{[selected]:{
   name:selected,...(toolImages?{attachment:true,modalities:{input:['text','image'],output:['text']}}:{})}},
   options:{apiKey:'roppo-loopback',baseURL:endpoint(config.baseUrl)}}:{options:{baseURL:endpoint(config.baseUrl)}}
  const settings={...(config.apiProtocol||request.opencodeNativeTools?.network===false?{lsp:false,formatter:false}:{}),model,small_model:model,enabled_providers:[provider],default_agent:'roppo',autoupdate:false,share:'disabled',plugin:guardPlugin?[guardPlugin]:[],instructions:[],compaction:{auto:false},watcher:{ignore:['**']},permission,
   agent:{...(request.managed?{title:{disable:true}}:{}),roppo:{mode:'primary',prompt:agentPrompt,steps:request.options?.maxSteps??modelSteps.default,tools,permission}},
   // The first browser call may include provisioning Chromium on a fresh host.
   mcp:{roppo:{type:'remote',url:mcp.url,headers:{Authorization:'Bearer '+mcp.token},oauth:false,enabled:true,timeout:300_000}},
   ...(config.baseUrl?{provider:{[provider]:providerOptions}}:{})}
  privateFile(config.apiProtocol?join(root,'config','opencode','opencode.json'):join(root,'opencode.json'),JSON.stringify(settings))
  const env={...isolatedEnvironment(root),OPENCODE_DISABLE_DEFAULT_PLUGINS:'1',...(config.apiProtocol?{npm_config_offline:'true',npm_config_fetch_retries:'0',npm_config_registry:'http://127.0.0.1:1/',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_LSP_DOWNLOAD:'1'}:{}),...(config.apiProtocol?{}:{OPENCODE_CONFIG:join(root,'opencode.json'),OPENCODE_CONFIG_CONTENT:JSON.stringify(settings)}),OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_CLAUDE_CODE:'1',OPENCODE_DISABLE_EXTERNAL_SKILLS:'1'}
  if (allowed.includes('websearch')) Object.assign(env,{OPENCODE_ENABLE_EXA:'1'})
  const args=['run',...(guardPlugin?[]:['--pure']),'--format','json','--dir',join(root,'work'),'--agent','roppo','--model',model,...(nativeId?['--session',nativeId]:[])]
  const variant=request.options?.parameters?.variant;if(variant)args.push('--variant',String(variant))
  return {args,env,stdin:prompt}
 },
 event(value){
  if(value.type==='error')return {error:JSON.stringify(value.error)}
  return {session:value.sessionID,...(value.type==='text'?{text:value.part?.text}:{}),...(value.type==='tool_use'?{tool:value.part?.tool,callId:value.part?.callID,toolError:value.part?.state?.status==='error',batch:batchReport(value.part)}:{}),
   ...(value.type==='step_finish'&&value.part?.tokens?{usage:{id:value.part.id,inputTokens:value.part.tokens.input+(value.part.tokens.cache?.read??0)+(value.part.tokens.cache?.write??0),outputTokens:value.part.tokens.output,reasoningOutputTokens:value.part.tokens.reasoning,cachedInputTokens:value.part.tokens.cache?.read}}:{}),...(value.type==='step_finish'&&value.part?.reason==='stop'?{done:true}:{})}
 },
 toolName:name=>name.startsWith('roppo_')?name.slice('roppo_'.length):undefined,
}
export default createCliPlugin(opencodeDriver)
