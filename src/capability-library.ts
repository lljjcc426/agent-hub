import {chatStatusTool} from './chat-status.ts'
import {codeModeTool} from './code-mode.ts'
import {evidenceTools} from './goal-evidence.ts'
import {builtinSources} from './source-plugins.ts'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {homedir} from 'node:os'
import {realpathSync} from 'node:fs'
import {createOperatorMcp} from './mcp.ts'
import type {Runtime} from './runtime.ts'
import {workerProfiles} from './worker-pool.ts'
import {promptStatus} from './prompts.ts'
import {memoryContexts} from './memory-workspace.ts'
import {marketState} from './plugin-market-state.ts'
import {viewCatalog} from './workspace-view-package.ts'
import {backendPackages} from './backends/plugin-package.ts'
import {bundledCLI} from './backends/bundled-opencode.ts'
import {openCodeTools,supportsOpenCodeTools} from '../plugins/backend-opencode/native-tools.ts'
import {isApiBackend} from './backend-config.ts'
import {nativeToolFor} from './cli-native-tools.ts'
import {verifyCliMcpGrant} from './cli-mcp-profile.ts'
import {clientGroup,profileInventory} from './capability-profiles.ts'
import {codexInventory,withPreviousCatalog,type CodexInventory} from './capability-codex.ts'
import {identifier,skillText,toolInfo,type Entry} from './capability-data.ts'
import type {CapabilitySnapshot,CapabilityTool} from './capability-types.ts'
import type {Config} from './config.ts'
import type {ChatSkillCatalog,SelectedChatSkill} from './chat-skills.ts'

function teamSkillEntries(config:Config):Entry[]{
  return Object.entries(config.prompts.skills).map(([name,body])=>({
    id:identifier('Roppo','skill','team/'+name),source:'Roppo',kind:'skill',name,
    status:'configured',roles:['Router','Worker'],content:()=>body,hasContent:true,
  }))
}

async function bridgeCatalog(){
  const server=createOperatorMcp('',''),client=new Client({name:'roppo-library',version:'1'})
  const [reader,writer]=InMemoryTransport.createLinkedPair()
  try{await server.connect(writer);await client.connect(reader);return (await client.listTools()).tools.map(toolInfo)}
  finally{await Promise.allSettled([client.close(),server.close()])}
}
let bridge:Promise<CapabilityTool[]>|undefined
function hostEntries(host:Runtime,owner:string,bridgeTools:CapabilityTool[]){
  const config=host.config,workers=workerProfiles(config),rows=new Map<string,Entry>()
  function put(source:string,key:string,item:Omit<Entry,'id'|'source'>){
    const id=identifier(source,item.kind,key);rows.set(id,{...item,id,source})
  }
  put('Roppo','operator',{kind:'mcp',name:'AgentHub MCP',status:'builtin',tools:bridgeTools,facts:['stdio'],roles:['Operator']})
  const router=config.execution.router
  const routerBackend=router?.backend??config.execution.roles.router??config.execution.backend
  const assigned=(role:{backend?:string;tools?:string[];toolConnections?:string[]},backend:string,key:'tools'|'toolConnections')=>role[key]??config.backends[backend]?.defaults?.[key]
  for(const tool of host.routerToolCatalog()){
    const grant=assigned(router??{},routerBackend,'tools')
    put('Roppo','router/'+tool.name,{kind:'tool',name:tool.name,status:grant&&!grant.includes(tool.name)?'disabled':'conditional',description:tool.description,roles:['Router'],tools:[toolInfo(tool)]})
  }
  for(const tool of [...host.availableWorkerSpecs(),chatStatusTool,codeModeTool]){
    const roles=workers.filter(w=>w.state!=='retiring'&&w.state!=='paused'&&(assigned(w,w.backend,'tools')??[tool.name]).includes(tool.name)).map(w=>w.id)
    put('Roppo','worker/'+tool.name,{kind:'tool',name:tool.name,status:roles.length?'conditional':'disabled',description:tool.description,roles,tools:[toolInfo(tool)]})
  }
  for(const tool of evidenceTools)put('Roppo','verifier/'+tool.name,{kind:'tool',name:tool.name,status:'conditional',description:tool.description,roles:['Verifier'],tools:[toolInfo(tool)]})
  for(const [id,c] of Object.entries(config.toolConnections)){
    const t=c.transport
    const roles=workers.filter(w=>w.state!=='retiring'&&w.state!=='paused'&&assigned(w,w.backend,'toolConnections')?.includes(id)&&(t.kind!=='cli-mcp'||t.workers.includes(w.id))).map(w=>w.id)
    let valid=c.enabled
    if(valid&&t.kind==='cli-mcp')try{verifyCliMcpGrant(t,c.allowedTools)}catch{valid=false}
    put('Roppo','connection/'+id,{kind:t.kind==='plugin'?'tool':'mcp',name:c.label??id,sourceGroup:t.kind==='cli-mcp'?clientGroup(t.cli==='claude'?'claude-code':t.cli):undefined,status:!c.enabled?'disabled':valid?'configured':'unavailable',tools:c.allowedTools.map(name=>({name})),facts:[id,t.kind,...(t.kind==='cli-mcp'?[t.cli,t.server]:[])],roles,inspectable:valid})
  }
  for(const p of promptStatus(config).filter(p=>p.id.startsWith('skill/'))){
    const text=p.override?.text??p.default
    put('Roppo',p.id,{kind:'skill',name:p.id.slice(6),status:'builtin',roles:['Router','Worker'],description:text,content:()=>text,hasContent:true})
  }
  for(const skill of teamSkillEntries(config))rows.set(skill.id,skill)
  if(host.store.list('skill-version').length)for(const {label,context:c} of memoryContexts(host,owner)){
    for(const skill of host.skills.list(c.route.scopeId,c)){
      const v=host.skills.resolve(skill,c.route.scopeId,c.route.entryId,c)
      put('Roppo',JSON.stringify([v.entryId,v.id,v.version]),{kind:'skill',name:v.template.title,status:skill.state==='retired'?'disabled':skill.state==='candidate'?'candidate':'configured',version:String(v.version),
        description:v.template.objective,facts:[label],steps:v.template.nodes.map(n=>n.instruction),inputs:skill.parameters.map(p=>p.name+' · '+p.label),criteria:v.template.criteria.map(c=>c.description)})
    }
  }
  const market=marketState(host.store),adapters=host.sourceRegistry.catalog()
  for(const p of market.installed){
    const entry=market.catalogs.flatMap(c=>c.plugins).find(c=>c.id===p.id),adapter=adapters.find(a=>a.pluginId===p.id)
    put('Roppo',p.id,{kind:'plugin',name:p.name.en,status:p.enabled&&p.active?'configured':p.enabled?'installed':'disabled',version:p.selected.version,description:entry?.description.en,facts:[p.id,p.category],tools:adapter?.tools?.map(toolInfo)})
  }
  for(const adapter of adapters){
    if(adapter.pluginId&&market.installed.some(p=>p.id===adapter.pluginId))continue
    put('Roppo','source/'+adapter.kind,{kind:'plugin',name:adapter.label,status:adapter.pluginId||!builtinSources.catalog().some(a=>a.kind===adapter.kind)?'configured':'builtin',
      tools:adapter.tools?.map(toolInfo),version:adapter.version,facts:[adapter.kind]})
  }
  const views=viewCatalog(config)
  for(const ref of config.viewPlugins){
    if(market.installed.some(p=>p.id===ref.id))continue
    const v=views.find(v=>v.id===ref.id)
    put('Roppo',ref.id,{kind:'plugin',name:v?.label.en??ref.id,status:!ref.enabled?'disabled':v?.available?'configured':'unavailable',version:v?.version??undefined,facts:v?.capabilities})
  }
  const packages=backendPackages(config)
  for(const pkg of packages.values()){
    const m=pkg.manifest
    put('Roppo','backend/'+m.id,{kind:'plugin',name:m.label,status:'configured',version:m.version,facts:[m.id,m.type]})
  }
  for(const s of config.sources)put('Roppo',s.id,{kind:'app',name:s.label??adapters.find(a=>a.kind===s.kind)?.label??s.id,status:s.enabled?'configured':'disabled',
    facts:[s.id,s.kind,...Object.entries(s.capabilities).filter(([,v])=>v).map(([k])=>k)]})
  const backends=new Set([...Object.keys(config.backends),config.execution.backend,routerBackend,...workers.map(w=>w.backend)])
  for(const id of backends){
    const d=config.backends[id],native=nativeToolFor(d)
    const manifest=d?.kind==='plugin'?packages.get(d.plugin)?.manifest:undefined
    if(manifest&&supportsOpenCodeTools(manifest)){
      const roles=workers.filter(w=>w.backend===id&&w.state!=='paused'&&w.state!=='retiring'&&assigned(w,id,'tools')===undefined).map(w=>w.id)
      for(const name of openCodeTools(config.work.network,supportsOpenCodeTools(manifest,3)))put('CLI · '+id,name,{kind:'tool',name,status:roles.length?'conditional':'disabled',roles,version:manifest.version})
      continue
    }
    const roles=workers.filter(w=>w.backend===id&&w.nativeTool===native&&w.state!=='paused'&&w.state!=='retiring').map(w=>w.id)
    if(native)put('CLI · '+id,native,{kind:'tool',name:native,status:roles.length?'conditional':'disabled',roles})
  }
  const eligible=[...backends].filter(id=>{const d=config.backends[id];return d&&isApiBackend(d)&&!d.images})
  if(eligible.length&&bundledCLI){
    const roles=workers.filter(w=>eligible.includes(w.backend)&&w.state!=='paused'&&w.state!=='retiring'&&assigned(w,w.backend,'tools')===undefined).map(w=>w.id)
    for(const name of openCodeTools(config.work.network)){
      put('OpenCode harness',name,{kind:'tool',name,status:roles.length&&config.work.sandboxDriver!=='disabled'?'conditional':'disabled',roles,version:bundledCLI.cliVersion,facts:eligible.map(id=>config.backends[id]?.label??id)})
    }
  }
  const managedTools=[...rows.values()].filter(e=>e.source==='Roppo'&&e.kind==='tool'&&e.roles?.length&&e.status==='conditional')
  const bridgeFor=(source:string,name:string,roles:string[],enabled:boolean)=>{
    const tools=new Map<string,CapabilityTool>()
    for(const e of managedTools)if(e.roles?.some(r=>roles.includes(r)))for(const t of e.tools??[])tools.set(t.name,t)
    put(source,'bridge/'+name,{kind:'mcp',name,status:enabled&&tools.size?'conditional':'disabled',roles,tools:[...tools.values()]})
  }
  const roleIds=(id:string)=>[...(id===routerBackend?['Router']:[]),...workers.filter(w=>w.backend===id&&w.state!=='paused'&&w.state!=='retiring').map(w=>w.id)]
  if(eligible.length&&bundledCLI)bridgeFor('OpenCode harness','roppo',eligible.flatMap(roleIds),config.work.sandboxDriver!=='disabled')
  for(const id of backends){
    const d=config.backends[id],roles=roleIds(id),source='CLI · '+id
    if(d?.kind==='codex'||id==='codex'&&!d||d?.kind==='plugin'&&d.plugin==='codex-cli'){
      if(roles.includes('Router'))bridgeFor(source,'roppo-router',['Router'],true)
      if(roles.some(r=>r!=='Router'))bridgeFor(source,'roppo-worker',roles.filter(r=>r!=='Router'),true)
    }else if(d?.kind==='plugin'&&['gemini-cli','claude-code','opencode-cli'].includes(d.plugin))bridgeFor(source,'roppo',roles,true)
  }
  return rows
}
interface ExternalCache {controller:AbortController;revision:number;started:number;pending:boolean;profile:ReturnType<typeof profileInventory>;native:Map<string,CodexInventory>}
function canonicalProject(path:string){
  try{return realpathSync(path)}catch{return path}
}
export class CapabilityLibrary {
  private external=new WeakMap<Runtime,ExternalCache>()
  constructor(private home=homedir(),private env:NodeJS.ProcessEnv=process.env){}
  private catalogs(host:Runtime,endpoint:string,refresh:boolean){
    const rev=host.settings.current().revision,old=this.external.get(host),now=Date.now()
    if(old&&old.revision===rev&&(old.pending||now-old.started<(refresh?3000:300_000)))return old
    old?.controller.abort()
    const profile=profileInventory(host.config,this.home,endpoint,this.env)
    const cache:ExternalCache={controller:new AbortController(),revision:rev,started:now,pending:!!profile.native.length,profile,native:new Map()}
    this.external.set(host,cache)
    void Promise.all(profile.native.map(async p=>{
      const previous=old?.revision===rev?old.native.get(p.source):undefined
      const update=(v:CodexInventory)=>cache.native.set(p.source,withPreviousCatalog(v,previous))
      if(previous)update({entries:[],warnings:[],complete:[]})
      try{update(await codexInventory({...p,signal:cache.controller.signal},update))}catch{update({entries:[],warnings:[p.source],complete:[]})}
    })).finally(()=>{cache.pending=false})
    return cache
  }
  close(host:Runtime){this.external.get(host)?.controller.abort();this.external.delete(host)}
  private runnableSkills(host:Runtime,endpoint:string,project:string|undefined){
    const external=this.catalogs(host,endpoint,false)
    const rows=new Map(external.profile.entries.map(e=>[e.id,e]))
    for(const catalog of external.native.values())for(const entry of catalog.entries)
      rows.set(entry.id,entry)
    const cwd=project&&canonicalProject(project)
    const files=[...rows.values()].filter(e=>e.kind==='skill'&&e.skillFile&&e.status==='cli'&&
      (!e.skillProjects||e.skillProjects.some(p=>canonicalProject(p)===cwd)))
    const refreshing=external.profile.native.some(p=>!external.native.get(p.source)?.complete.includes('skill'))&&external.pending
    return {items:[...teamSkillEntries(host.config),...files],refreshing}
  }
  chatSkills(host:Runtime,endpoint:string,project:string|undefined):ChatSkillCatalog {
    const {items,refreshing}=this.runnableSkills(host,endpoint,project)
    const distinct=new Map<string,Entry>()
    for(const item of items){
      const key=item.skillFile??item.id
      if(!distinct.has(key))distinct.set(key,item)
    }
    return {items:[...distinct.values()].map(({id,name,source,description})=>({id,name,source,description})).sort((a,b)=>a.name.localeCompare(b.name)),refreshing}
  }
  chatSkill(host:Runtime,endpoint:string,project:string|undefined,id:string):SelectedChatSkill|undefined {
    const item=this.runnableSkills(host,endpoint,project).items.find(e=>e.id===id)
    if(!item)return
    const instructions=item.skillFile?skillText(item.skillFile):item.content?.()
    if(!instructions?.trim())return
    return {id:item.id,name:item.name,instructions,...(item.skillFile?{file:item.skillFile}:{})}
  }
  async read(host:Runtime,owner:string,endpoint:string,opts:{id?:string;inspect?:boolean;refresh?:boolean}={}){
    const external=this.catalogs(host,endpoint,!!opts.refresh)
    const all=hostEntries(host,owner,await (bridge??=bridgeCatalog().catch(e=>{bridge=undefined;throw e})))
    const warnings=new Set(external.profile.warnings)
    for(const e of external.profile.entries)all.set(e.id,e)
    for(const catalog of external.native.values()){
      for(const e of catalog.entries)all.set(e.id,e)
      for(const warning of catalog.warnings)warnings.add(warning)
    }
    const groupOf=(e:Entry)=>e.sourceGroup??external.profile.sourceGroups.get(e.source)??e.source
    if(opts.id){
      const entry=all.get(opts.id);if(!entry)return undefined
      const {content,skillFile,skillProjects,...fields}=entry
      const item={...fields,sourceGroup:groupOf(entry)}
      if(opts.inspect&&item.inspectable){
        const key=Object.keys(host.config.toolConnections).find(id=>identifier('Roppo',item.kind,'connection/'+id)===item.id)
        if(key)try{return {...item,tools:(await host.toolConnections.inspect(key)).map(toolInfo),status:'connected'}}catch{return {...item,status:'unavailable'}}
      }
      const body=content?.()
      return {...item,body,...(content&&body===undefined?{status:'unavailable'}:{})}
    }
    const items=[...all.values()].map(({content,steps,criteria,inputs,skillFile,skillProjects,...item})=>({...item,sourceGroup:groupOf(item),tools:item.tools?.map(({name})=>({name}))}))
    return {items,warnings:[...warnings],refreshing:external.pending} satisfies CapabilitySnapshot
  }
}
