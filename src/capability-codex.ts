import {realpathSync} from 'node:fs'
import {AppServer} from '../plugins/backend-codex/model.ts'
import {identifier,object,skillText,toolInfo,type Entry} from './capability-data.ts'

export interface CodexInventory {entries:Entry[];warnings:string[]}
export async function codexInventory(options:{command:string;args?:string[];environment?:Record<string,string>;cwd:string;projects:string[];source:string;signal?:AbortSignal},progress?:(result:CodexInventory)=>void):Promise<CodexInventory>{
  const {source,projects}=options
  const client=new AppServer(options.command,options.args??[],options.cwd,undefined,undefined,undefined,options.environment)
  const stop=()=>client.fail(Error('Inventory stopped'))
  options.signal?.addEventListener('abort',stop,{once:true})
  if(options.signal?.aborted)stop()
  const timer=setTimeout(()=>client.fail(Error('Inventory timeout')),100_000)
  const entries=new Map<string,Entry>(),warnings:string[]=[]
  function add(key:string,item:Omit<Entry,'id'|'source'>){
    const id=identifier(source,item.kind,key)
    entries.set(id,{...item,id,source})
  }
  async function pages(method:string,visit:(row:any)=>void){
    let cursor:string|undefined
    const seen=new Set<string>()
    do{
      const page=await client.call(method,{limit:100,...(cursor?{cursor}:{})})
      for(const row of page.data)visit(row)
      cursor=page.nextCursor
      if(cursor&&(seen.has(cursor)||seen.size>=200))throw Error('Incomplete cursor')
      if(cursor)seen.add(cursor)
    }while(cursor)
  }
  try{
    await client.call('initialize',{clientInfo:{name:'roppo-library',version:'1.0'},capabilities:{experimentalApi:true}})
    client.notify('initialized')
    const tasks:Record<string,Promise<void>>={
      Skills:client.call('skills/list',{cwds:projects.length?projects:[options.cwd]}).then(r=>{
        for(const group of r.data){
          if(group.errors?.length)warnings.push(source+' · Skills')
          for(const s of group.skills){if(typeof s.path!=='string'||typeof s.name!=='string')continue
            let path=s.path;try{path=realpathSync(path)}catch{/* A remote CLI may only advertise metadata. */}
            add(path,{kind:'skill',name:s.name,status:s.enabled?'cli':'disabled',description:s.description,
              facts:[s.pluginId,s.scope].filter(Boolean),hasContent:true,content:()=>skillText(s.path)})
          }
        }
      }),
      Plugins:Promise.all([{}, {marketplaceKinds:['local','vertical','workspace-directory','shared-with-me','created-by-me-remote']}].map(async extra=>{
        try{
          const r=await client.call('plugin/list',{cwds:projects,...extra})
          if(r.marketplaceLoadErrors?.length)warnings.push(source+' · Plugins')
          for(const m of r.marketplaces)for(const p of m.plugins)if(p.installed)add(p.id,{kind:'plugin',name:p.interface?.displayName||p.name,status:p.enabled?'cli':'disabled',
            description:p.interface?.shortDescription||undefined,version:p.localVersion??p.version??undefined,facts:[m.name,p.id]})
        }catch{warnings.push(source+' · Plugins')}
      })).then(()=>{}),
      MCP:pages('mcpServerStatus/list',s=>add(s.pluginId?s.pluginId+'/'+s.name:s.name,{kind:'mcp',name:s.name,status:s.runtimeStatus==='disabled'?'disabled':s.runtimeStatus==='connected'?'connected':['authenticationRequired','failed','cancelled'].includes(s.runtimeStatus)?'unavailable':'cli',
        facts:[s.pluginId,s.runtimeStatus].filter(Boolean),tools:Object.entries(object(s.tools)).map(([name,t])=>toolInfo({name:t.name??name,description:t.description,inputSchema:t.inputSchema}))})),
      Apps:pages('app/list',a=>{if(a.isEnabled&&a.isAccessible)add(a.id,{kind:'app',name:a.name,status:'cli',description:a.description??undefined,facts:[a.id,...(a.pluginDisplayNames??[])]})}),
    }
    await Promise.all(Object.entries(tasks).map(async ([label,task])=>{try{await task}catch{warnings.push(source+' · '+label)}finally{progress?.({entries:[...entries.values()],warnings:[...warnings]})}}))
  }catch{warnings.push(source+' · App Server')}
  finally{options.signal?.removeEventListener('abort',stop);clearTimeout(timer);await client.close()}
  return {entries:[...entries.values()],warnings:[...new Set(warnings)]}
}
