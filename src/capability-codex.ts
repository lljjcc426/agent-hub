import {setTimeout as delay} from 'node:timers/promises'
import type {CapabilityKind} from './capability-types.ts'
import {realpathSync} from 'node:fs'
import {AppServer} from '../plugins/backend-codex/model.ts'
import {identifier,object,skillText,toolInfo,type Entry} from './capability-data.ts'

export interface CodexInventory {entries:Entry[];warnings:string[];complete:CapabilityKind[]}
export async function codexInventory(options:{command:string;args?:string[];environment?:Record<string,string>;cwd:string;projects:string[];source:string;declaredMcpIds?:string[];signal?:AbortSignal},progress?:(result:CodexInventory)=>void):Promise<CodexInventory>{
  const {source,projects}=options
  const client=new AppServer(options.command,options.args??[],options.cwd,undefined,undefined,undefined,options.environment)
  const stop=()=>client.fail(Error('Inventory stopped'))
  options.signal?.addEventListener('abort',stop,{once:true})
  if(options.signal?.aborted)stop()
  const timer=setTimeout(()=>client.fail(Error('Inventory timeout')),100_000)
  const entries=new Map<string,Entry>(),warnings:string[]=[],complete:CapabilityKind[]=[]
  const snapshot=():CodexInventory=>({entries:[...entries.values()],warnings:[...new Set(warnings)],complete:[...complete]})
  async function readCatalog(method:string,params:Record<string,unknown>){
    for(let attempt=0;;attempt++){
      try{return await client.call(method,params)}
      catch(error){
        const code=(error as {diagnostic?:{rpcCode?:number}}).diagnostic?.rpcCode
        if(code!==-32603||attempt>=2||options.signal?.aborted)throw error
        await delay(750*2**attempt,undefined,{signal:options.signal})
      }
    }
  }
  function add(key:string,item:Omit<Entry,'id'|'source'>){
    const id=identifier(source,item.kind,key)
    entries.set(id,{...item,id,source})
  }
  function app(key:string,name:string,description?:string,tools?:Entry['tools'],facts?:string[]){
    const existing=entries.get(identifier(source,'app',key))
    add(key,{kind:'app',name:name===key?existing?.name??name:name,status:tools||existing?.status==='connected'?'connected':'cli',
      description:description??existing?.description,tools:tools??existing?.tools,facts:[...new Set([key,...(existing?.facts??[]),...(facts??[])])]})
  }
  function mcpServer(s:any){
    if(typeof s.name!=='string')return
    const raw=Object.entries(object(s.tools))
    const tools=raw.map(([name,t])=>toolInfo({name:t.name??name,description:t.description,inputSchema:t.inputSchema}))
    add(s.pluginId?s.pluginId+'/'+s.name:s.name,{kind:'mcp',name:s.name,status:s.runtimeStatus==='disabled'?'disabled':s.runtimeStatus==='connected'?'connected':['authenticationRequired','failed','cancelled'].includes(s.runtimeStatus)?'unavailable':'cli',facts:[s.pluginId,s.runtimeStatus].filter(Boolean),tools})
    if(s.name!=='codex_apps')return
    // This is the connected MCP catalog. The separate app directory may be offline
    // or contain available apps that expose no MCP tools in this account.
    const groups=new Map<string,{name:string;description?:string;tools:NonNullable<Entry['tools']>}>()
    for(const meta of Array.isArray(s.toolListMeta?.['openai/apps'])?s.toolListMeta['openai/apps']:[])
      if(typeof meta?.connectorId==='string')groups.set(meta.connectorId,{name:meta.connectorId,tools:[]})
    for(const [index,[,t]] of raw.entries()){
      const meta=object(t._meta),key=meta.connector_id
      if(typeof key!=='string')continue
      const group=groups.get(key)??{name:key,tools:[]}
      if(typeof meta.connector_name==='string')group.name=meta.connector_name
      if(typeof meta.connector_description==='string')group.description=meta.connector_description
      group.tools.push(tools[index]!)
      groups.set(key,group)
    }
    for(const [key,g] of groups)app(key,g.name,g.description,g.tools,['codex_apps'])
  }
  async function pages(method:string,visit:(row:any)=>void){
    let cursor:string|undefined
    const seen=new Set<string>()
    do{
      const page=await readCatalog(method,{limit:method==='app/list'?1000:100,...(cursor?{cursor}:{})})
      for(const row of page.data)visit(row)
      progress?.(snapshot())
      cursor=page.nextCursor
      if(cursor&&(seen.has(cursor)||seen.size>=200))throw Error('Incomplete cursor')
      if(cursor)seen.add(cursor)
    }while(cursor)
  }
  async function readMcpServers(){
    await pages('mcpServerStatus/list',mcpServer)
    // A cold app server can finish its first page before plugin MCPs are registered.
    if(options.declaredMcpIds?.some(id=>!entries.has(id)))await pages('mcpServerStatus/list',mcpServer)
  }
  function collectPlugins(catalog:any){
    if(catalog.marketplaceLoadErrors?.length)warnings.push(source+' · Plugins')
    for(const market of catalog.marketplaces)for(const plugin of market.plugins){
      if(!plugin.installed)continue
      add(plugin.id,{kind:'plugin',name:plugin.interface?.displayName||plugin.name,status:plugin.enabled?'cli':'disabled',
        description:plugin.interface?.shortDescription||undefined,version:plugin.localVersion??plugin.version??undefined,facts:[market.name,plugin.id]})
    }
  }
  async function installedPlugins(){
    try{
      collectPlugins(await readCatalog('plugin/installed',{cwds:projects}))
      return
    }catch(error){
      const code=(error as {diagnostic?:{rpcCode?:number}}).diagnostic?.rpcCode
      // Older app servers can report an unknown request as Invalid Request.
      if(code!==-32601&&!(code===-32600&&/unknown (variant|method)|method not found/i.test(String(error))))throw error
    }
    // Preserve discovery across local and remote markets on clients without an installed inventory.
    const legacy=[{}, {marketplaceKinds:['local','vertical','workspace-directory','shared-with-me','created-by-me-remote']}]
    const results=await Promise.allSettled(legacy.map(extra=>readCatalog('plugin/list',{cwds:projects,...extra}).then(collectPlugins)))
    if(results.some(result=>result.status==='rejected'))warnings.push(source+' · Plugins')
  }
  try{
    await client.call('initialize',{clientInfo:{name:'roppo-library',version:'1.0'},capabilities:{experimentalApi:true}})
    client.notify('initialized')
    const plugins=installedPlugins()
    // Codex materializes plugin-provided MCPs and skills while resolving installed plugins.
    // Its first parallel MCP response can otherwise omit servers without a pagination cursor.
    const pluginsSettled=plugins.catch(()=>{})
    const tasks:Record<string,Promise<void>>={
      Plugins:plugins,
      Skills:pluginsSettled.then(()=>readCatalog('skills/list',{cwds:projects.length?projects:[options.cwd]})).then(r=>{
        for(const group of r.data){
          if(group.errors?.length)warnings.push(source+' · Skills')
          for(const s of group.skills){if(typeof s.path!=='string'||typeof s.name!=='string')continue
            let path=s.path;try{path=realpathSync(path)}catch{/* A remote CLI may only advertise metadata. */}
            add(path,{kind:'skill',name:s.name,status:s.enabled?'cli':'disabled',description:s.description,
              facts:[s.pluginId,s.scope].filter(Boolean),hasContent:true,content:()=>skillText(s.path)})
          }
        }
      }),
      MCP:pluginsSettled.then(readMcpServers),
      Apps:pages('app/list',a=>{if(a.isEnabled&&a.isAccessible)app(a.id,a.name,a.description??undefined,undefined,a.pluginDisplayNames??[])}),
    }
    const kinds:Record<string,CapabilityKind>={Skills:'skill',Plugins:'plugin',MCP:'mcp',Apps:'app'}
    await Promise.all(Object.entries(tasks).map(async ([label,task])=>{
      const warning=source+' · '+label
      try{await task;if(!warnings.includes(warning))complete.push(kinds[label]!)}catch{warnings.push(warning)}
      finally{progress?.(snapshot())}
    }))
  }catch{warnings.push(source+' · App Server')}
  finally{options.signal?.removeEventListener('abort',stop);clearTimeout(timer);await client.close()}
  return snapshot()
}

// Failed or unfinished catalogs can use the previous observation from the same configuration.
// A successful catalog is authoritative, including an empty or shortened response.
export function withPreviousCatalog(next:CodexInventory,previous?:CodexInventory):CodexInventory {
  if(!previous)return next
  const current=new Set(next.entries.map(row=>row.id))
  const cached=previous.entries.filter(e=>!next.complete.includes(e.kind)&&!current.has(e.id)).map(e=>({...e,status:'cached' as const}))
  return {...next,entries:[...next.entries,...cached]}
}
