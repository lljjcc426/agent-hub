import {openHarnessProvider} from './harness-provider.ts'
import {hostPrivateFiles} from '../private-files.ts'
import {resolve} from 'node:path'
import {realpathSync,existsSync} from 'node:fs'
import {stableDigest} from '../sources.ts'
import {nativeToolFor} from '../cli-native-tools.ts'
import {ProcessBackend,pluginIdentity} from './plugin-process.ts'
import {backendPackages} from './plugin-package.ts'
import type {Config} from '../config.ts'
import {validateBackendSelection,type BackendDefinition,type AgentOptions,type ApiDefinition,isApiBackend} from '../backend-config.ts'
import {mergeOptions,apiOptions} from '../agent-options.ts'
import {appendAgentPrompt} from '../managed-instructions.ts'
import {SubscriptionAccounts} from './subscription.ts'
import {CodexModel,nativeContextProfile} from '../../plugins/backend-codex/model.ts'
import type {BackendDescription,Model,ModelRequest,ModelResult} from '../model.ts'
import {ApiModel,type ThreadStore} from './api.ts'
interface Binding {
 id:string;kind:string;endpoint?:string;identity?:string
 harness?:string;harnessIdentity?:string;harnessModel?:string;harnessAccount?:string
}
/** New work follows role settings; existing conversations stay bound to their original backend. */
export class BackendRegistry implements Model {
 private writers=new Set<string>()
 constructor(private config:Config,private store:ThreadStore){validateBackendSelection(config)}
 selected(role:'router'|'worker'|'subagent'='worker'){return (role==='router'?this.config.execution.router?.backend:undefined)??this.config.execution.roles[role]??this.config.execution.backend}
 definition(id:string):BackendDefinition{
  const d=this.config.backends[id]??(id==='codex'?{kind:'codex' as const}:undefined)
  if(!d)throw Error('Backend '+id+' is no longer configured; existing threads cannot migrate implicitly')
  return d
 }
 private binding(id:string):Binding{const d=this.definition(id);if(d.kind==='plugin'){const pkg=backendPackages(this.config).get(d.plugin);if(!pkg)throw Error('Unknown execution backend plugin');return {id,kind:d.kind,identity:pluginIdentity(d,pkg)}}return {id,kind:d.kind,identity:JSON.stringify(d.kind==='codex'?{command:d.command??this.config.codex,args:d.args??[],env:d.env??{}}:{account:d.subscription?.account,owner:d.subscription?.owner,apiKeyEnv:d.apiKeyEnv,headerEnv:d.headerEnv??{}}),...(d.kind!=='codex'?{endpoint:d.baseUrl.replace(/\/+$/,'')}:{})}}
 private forThread(threadId:string,deleting=false):string{
  if(!deleting&&this.store.get('context-session-fence',threadId))throw Error('Context permissions changed; this history is quarantined')
  if(!deleting&&(this.store.get('backend-deleted',threadId)||this.store.get('backend-delete-pending',threadId)))throw Error('Backend history deletion fence is active; explicit fresh context required')
  const saved=this.store.get<Binding>('backend-binding',threadId)
  if(saved){const current=this.binding(saved.id);if(saved.kind!==current.kind||saved.endpoint!==current.endpoint||saved.identity!==undefined&&saved.identity!==current.identity)throw Error('Thread backend identity or endpoint changed; explicit migration is required');return saved.id}
  if(threadId.startsWith('api:')||threadId.startsWith('plugin:'))throw Error('Thread has no backend binding')
  return 'codex' // Pre-registry native Codex conversations retain their original executor.
 }
 private harness(id:string,engineId:string){
  const api=this.definition(id),engine=this.definition(engineId)
  if(api.kind==='codex'||api.kind==='plugin'||engine.kind!=='plugin'||engine.plugin!=='opencode-cli')throw Error('Invalid model and OpenCode harness combination')
  const pkg=backendPackages(this.config).get(engine.plugin)
  if(!pkg?.manifest.capabilities.harnessProtocols?.includes(api.kind))throw Error('Install an OpenCode backend package that supports the selected API protocol')
  const {command,args,cliVersion}=engine.config
  const definition={kind:'plugin' as const,plugin:engine.plugin,env:{},readPaths:engine.readPaths,writePaths:[],
   config:{command,...(args?{args}:{}),cliVersion,apiProtocol:api.kind}}
  const identity=stableDigest([engineId,pluginIdentity(definition,pkg),api.headers,api.headerEnv,api.apiKeyEnv,api.subscription?.account])
  return {api,identity,model:new ProcessBackend(id,definition,pkg,this.config,this.store,true)}
 }
 private harnessSubscription(id:string,subscription:NonNullable<ApiDefinition['subscription']>,principal:ModelRequest['principal'],previous?:Binding){
  const accounts=new SubscriptionAccounts(this.config.stateDir)
  const subject=()=>accounts.signedInSubject(subscription.account)
  const account=subject()
  if(!account||previous&&previous.harnessAccount!==account)throw Error('Subscription account changed or signed out; a new session is required')
  const assertAuthorized=()=>{
   const current=this.definition(id)
   const selected=isApiBackend(current)?current.subscription:undefined
   if(!selected?.backgroundAuthorized||selected.account!==subscription.account||
      selected.owner.source!==principal?.source||selected.owner.actor!==principal?.actor||subject()!==account){
    throw Error('Subscription authorization changed')
   }
  }
  return {account,credential:async()=>{
   assertAuthorized()
   const token=await accounts.credential(subscription.account)
   assertAuthorized()
   return token
  }}
 }
 private threadModel(threadId:string,deleting=false,id=this.forThread(threadId,deleting)){
  const saved=this.store.get<Binding>('backend-binding',threadId)
  if(!saved?.harness)return this.model(id)
  const engine=this.harness(id,saved.harness)
  if(engine.identity!==saved.harnessIdentity)throw Error('Bound harness configuration changed; explicit migration required')
  return engine.model
 }
 private model(id:string,options:AgentOptions={}):Model{
  const d=this.definition(id)
  if(d.kind==='plugin'){const pkg=backendPackages(this.config).get(d.plugin);if(!pkg)throw Error('Unknown execution backend plugin');return new ProcessBackend(id,d,pkg,this.config,this.store)}
  if(d.kind==='codex')return new CodexModel({...this.config,model:d.model??this.config.model,codex:d.command??this.config.codex,turnTimeoutMs:options.timeoutMs??this.config.turnTimeoutMs},d.args??[],d.env)
  const definition=apiOptions(d,options)
  return new ApiModel(id,definition,this.store,options.timeoutMs??this.config.turnTimeoutMs,d.subscription?()=>new SubscriptionAccounts(this.config.stateDir).credential(d.subscription!.account):undefined)
 }
 describe(threadId?:string,role:'router'|'worker'|'subagent'='worker'):BackendDescription{
  if(!threadId){const id=this.selected(role);return {...this.model(id).describe!(),id}}
  const id=this.forThread(threadId)
  const model=this.store.get<Binding>('backend-binding',threadId)?.harnessModel
  return {...this.threadModel(threadId,false,id).describe!(),id,...(model?{model}:{})}
 }
 configured(){return [...new Set([...Object.keys(this.config.backends),this.selected('router'),this.selected('worker'),this.selected('subagent'),...(this.config.execution.workers??[]).map(w=>w.backend)])].map(id=>({...this.model(id).describe!(),id,...(this.definition(id).label?{label:this.definition(id).label}:{})}))}
 async run(r:ModelRequest):Promise<ModelResult>{
  const id=r.threadId?this.forThread(r.threadId):r.backendId??this.selected(r.role??(r.ephemeral?'router':'worker'))
  const definition=structuredClone(this.definition(id)),role=r.role??(r.ephemeral?'router':'worker')
  const options=mergeOptions(definition.defaults,r.options??(role==='router'?this.config.execution.router:undefined))
  const profile=role==='worker'?this.config.execution.workers?.find(w=>w.id===r.activity?.workerId):role==='router'?this.config.execution.router:undefined
  const profileBackend=profile?.backend??this.selected(role)
  const {allowNativeTools,nativeTool:ignored,harnessWorkspace:unusedWorkspace,harnessProviderUrl:unusedProvider,harnessPrivateFiles:unusedFiles,...activation}=r
  const hostedTurn=allowNativeTools===true&&r.managed===true&&!r.ephemeral&&role!=='subagent'
  const interactive=hostedTurn&&r.onTool&&r.tools?.length
  const granted=profileBackend===id&&profile?.nativeTool===nativeToolFor(definition)?profile?.nativeTool:undefined
  r=interactive&&granted?{...activation,nativeTool:granted,instructions:r.instructions+'\nThe operator grants the native CLI '+granted+' tool for this task.'}:activation
  if(definition.kind!=='codex'&&definition.kind!=='plugin'&&definition.subscription){
   const sub=definition.subscription
   if(!sub.backgroundAuthorized||!r.principal||r.principal.source!==sub.owner.source||r.principal.actor!==sub.owner.actor)throw Error('Subscription requires its owner and authorized background activity')
  }
  const previous=r.threadId?this.store.get<Binding>('backend-binding',r.threadId):undefined
  const engineId=r.threadId?previous?.harness:hostedTurn&&profileBackend===id?profile?.harness:undefined
  const engine=engineId?this.harness(id,engineId):undefined
  if(engine&&previous&&engine.identity!==previous.harnessIdentity)throw Error('Bound harness configuration changed; explicit migration required')
  if(engine&&hostedTurn&&(profile?.harness!==engineId||profileBackend!==id))throw Error('Role harness changed; start a new session or migrate this task')
  if(r.threadId&&this.writers.has(r.threadId))throw Error('Backend thread already has an active writer')
  let locked=r.threadId;if(locked)this.writers.add(locked)
  const binding=this.binding(id)
  const legacyContext=definition.kind==='codex'&&r.managed&&!!r.threadId&&this.store.get<{version:number}>('native-context',r.threadId)?.version!==nativeContextProfile
  const compact=legacyContext&&!r.skipContextCompaction
  let harnessProvider:Awaited<ReturnType<typeof openHarnessProvider>>|undefined
  let nativeThread=r.threadId
  r.onBackend?.(id)
  try{
   let executor:Model,runOptions=options
   if(engine){
    const d=apiOptions(engine.api,options)
    const model=previous?.harnessModel??r.model??profile?.model??d.model
    Object.assign(binding,{harness:engineId,harnessIdentity:engine.identity,harnessModel:model})
    const authorization=d.subscription?this.harnessSubscription(id,d.subscription,r.principal,previous):undefined
    if(authorization)binding.harnessAccount=authorization.account
    harnessProvider=await openHarnessProvider(d,model,r,authorization?.credential)
    // Only ordinary assigned work can access task files. The task sandbox and tool grant still apply.
    const canRead=interactive&&r.tools?.some(t=>t.name===(role==='router'?'router_read':'superagent_read'))
    const canEdit=role==='worker'&&r.sandbox==='workspace-write'&&r.tools?.some(t=>t.name==='superagent_shell')
    const workspace=canRead?(canEdit?'edit':'read'):undefined
    const configuration=r.onConfiguration
    r.onModel?.(model)
    r={...r,role,model,harnessProviderUrl:harnessProvider.url,harnessWorkspace:workspace,
     harnessPrivateFiles:[resolve(this.config.stateDir),...hostPrivateFiles()].map(p=>existsSync(p)?realpathSync.native(p):p),
     onConfiguration:value=>configuration?.({...value,requested:options,sent:{...value.sent,parameters:d.parameters,
      maxOutputTokens:d.maxOutputTokens,maxToolCalls:d.maxToolCalls,maxSteps:d.maxSteps}})}
    runOptions={...options,parameters:{},effort:undefined,maxOutputTokens:undefined,maxSteps:d.maxSteps,maxToolCalls:d.maxToolCalls}
    executor=engine.model
   }else executor=this.model(id,options)
   return await executor.run({...r,options:runOptions,compactBeforeTurn:!!compact,onContextReady:()=>{if(definition.kind==='codex'&&r.managed&&nativeThread&&(!legacyContext||compact))this.store.put('native-context',nativeThread,{version:nativeContextProfile,at:Date.now(),compacted:!!compact});r.onContextReady?.()},instructions:appendAgentPrompt(r.instructions,options.prompt,options.persona),model:r.model??(!r.threadId&&role==='router'?this.config.execution.router?.model:undefined),onThread:threadId=>{nativeThread=threadId;if(!locked){locked=threadId;this.writers.add(threadId)}this.store.put('backend-binding',threadId,binding);r.onThread?.(threadId)}})}
  catch(error){throw harnessProvider?.failure()??error}
  finally{if(locked)this.writers.delete(locked);await harnessProvider?.close()}
 }
 async probe(id:string){const model=this.model(id);if(!(model instanceof ProcessBackend))throw Error('Probe requires an execution backend package');return model.probe()}
 async history(threadId:string,cwd:string){return this.threadModel(threadId).history!(threadId,cwd)}
 async purge(threadId:string,cwd:string){if(this.writers.has(threadId))throw Error('Thread writer must stop before deletion');const model=this.threadModel(threadId,true);if(!model.purge)throw Error('Backend cannot verify local history deletion');const result=await model.purge(threadId,cwd);this.store.put('backend-deleted',threadId,{threadId,at:Date.now()});return result}
 async expose(threadId:string,cwd:string){const model=this.threadModel(threadId);if(!model.describe?.().nativeTakeover)throw Error('This backend has no native desktop chat; inspect its history in the AgentHub resource panel');await model.expose!(threadId,cwd)}
 async catalog(provider?:string){
  // Preserve the pre-registry models/<native-provider> resource in Codex setups.
  const legacy=provider&&provider!=='codex'&&!this.config.backends[provider]&&this.definition(this.selected()).kind==='codex'
  const id=legacy?this.selected():provider??this.selected(),catalog=await this.model(id).catalog?.(legacy?provider:this.definition(id).kind==='codex'?undefined:id)
  return {...catalog,backendId:id,roles:{router:this.selected('router'),worker:this.selected('worker'),subagent:this.selected('subagent')},backends:this.configured()}
 }
}
