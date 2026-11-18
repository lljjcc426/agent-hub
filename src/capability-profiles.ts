import {existsSync,readdirSync,readFileSync,statSync,realpathSync} from 'node:fs'
import {basename,dirname,join,resolve} from 'node:path'
import {parse as toml} from 'smol-toml'
import {parse as jsonc,type ParseError} from 'jsonc-parser'
import type {Config} from './config.ts'
import {clientIds,clientInfo,type ClientId} from './clients.ts'
import {cliProfilePaths} from './cli-mcp-profile.ts'
import {workerProfiles} from './worker-pool.ts'
import {object,identifier,skillText,strings,type Entry} from './capability-data.ts'
import {codexInventory} from './capability-codex.ts'

const pluginClient:Record<string,ClientId>={'codex-cli':'codex','claude-code':'claude-code','gemini-cli':'gemini','opencode-cli':'opencode'}
const display:Partial<Record<ClientId,string>>={codex:'Codex',gemini:'Gemini CLI','claude-code':'Claude Code',opencode:'OpenCode'}
export const clientGroup=(client:ClientId)=>display[client]??client
const dirs=(path:string)=>{try{return readdirSync(path,{withFileTypes:true}).filter(e=>e.isDirectory()||e.isSymbolicLink()).map(e=>e.name)}catch{return []}}
export function profileInventory(config:Config,home:string,endpoint:string,env:NodeJS.ProcessEnv){
  const rows=new Map<string,Entry>(),warnings=new Set<string>()
  const native=new Map<string,Parameters<typeof codexInventory>[0]>()
  const projects=[...new Set(config.sources.map(s=>resolve(s.cwd)))].filter(p=>existsSync(p))
  function read(path:string,label:string){
    if(!existsSync(path))return {}
    try{
      const st=statSync(path);if(!st.isFile()||st.size>4_000_000)throw Error()
      const data=readFileSync(path,'utf8'),errors:ParseError[]=[]
      const value=path.endsWith('.toml')?toml(data):jsonc(data,errors,{allowTrailingComma:true})
      if(errors.length)throw Error()
      return object(value)
    }catch{if(label)warnings.add(label);return {}}
  }
  function add(source:string,key:string,item:Omit<Entry,'source'|'id'>){
    if(typeof item.name!=='string'||!item.name.trim())return
    const id=identifier(source,item.kind,key)
    rows.set(id,{...item,source,id,description:typeof item.description==='string'?item.description:undefined,version:typeof item.version==='string'?item.version:undefined})
  }
  function skills(path:string,source:string,disabled=false){
    const scan=(dir:string)=>{
      const file=join(dir,'SKILL.md'),body=skillText(file);if(!body)return
      const front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1]??''
      const field=(k:string)=>new RegExp('^'+k+':\\s*([^\\n]+)','m').exec(front)?.[1]?.trim().replace(/^["']|["']$/g,'')
      add(source,realpathSync(file),{kind:'skill',name:field('name')||basename(dir),description:field('description'),status:disabled?'disabled':'cli',hasContent:true,content:()=>skillText(file)})
    }
    for(const name of dirs(path)){
      if(name==='.system')for(const child of dirs(join(path,name)))scan(join(path,name,child))
      else if(!name.startsWith('.'))scan(join(path,name))
    }
  }
  function mcp(root:Record<string,any>,key:string,source:string,namespace='',plugin?:{id:string;disabled:boolean}){
    for(const [name,value] of Object.entries(object(root[key]))){
      const entry=object(value)
      add(source,(plugin?plugin.id+'/':namespace)+name,{kind:'mcp',name,status:plugin?.disabled||entry.enabled===false||entry.disabled||strings(root.disabledMcpServers).includes(name)||strings(root.mcp?.excluded).includes(name)?'disabled':plugin?'declared':'cli',
        tools:strings(entry.enabled_tools??entry.includeTools).filter(n=>!strings(entry.disabled_tools??entry.excludeTools).includes(n)).map(name=>({name})),facts:plugin?[plugin.id]:namespace?[namespace]:undefined})
    }
  }
  const paths=cliProfilePaths(home,env)
  const standard=(id:ClientId)=>id==='codex'?paths.codex:id==='opencode'?paths.opencode:id==='gemini'?paths.gemini:id==='claude-code'?paths.claude:join(home,clientInfo[id].file)
  interface Profile {client:ClientId;path:string;source:string;backend?:string}
  const profiles=new Map<string,Profile>()
  const sourceGroups=new Map<string,string>()
  function register(client:ClientId,path=standard(client),source=clientGroup(client),backend?:string){
    sourceGroups.set(source,clientGroup(client))
    if(backend)sourceGroups.set('CLI · '+backend,clientGroup(client))
    profiles.set(source+'\n'+path,{client,path,source,backend})
  }
  const ids=new Set([...Object.keys(config.backends),config.execution.backend,...Object.values(config.execution.roles),config.execution.router?.backend,...workerProfiles(config).map(w=>w.backend)])
  for(const id of ids){
    if(!id)continue
    const d=config.backends[id],client=d?.kind==='plugin'?pluginClient[d.plugin]:d?.kind==='codex'||!d&&id==='codex'?'codex':undefined
    if(!client)continue
    const mapped={...env};if(d?.kind==='plugin'||d?.kind==='codex')for(const [k,ref] of Object.entries(d.env??{}))mapped[k]=env[ref]
    const p=cliProfilePaths(home,mapped)
    register(client,client==='claude-code'?p.claude:client==='codex'?p.codex:client==='gemini'?p.gemini:p.opencode,clientGroup(client)+(id===client?'':' · '+id),id)
  }
  for(const {transport:t} of Object.values(config.toolConnections))if(t.kind==='cli-mcp'){
    const client=t.cli==='claude'?'claude-code':t.cli
    if(![...profiles.values()].some(p=>p.path===t.profile&&p.client===client))register(client,t.profile,clientGroup(client)+(t.profile===standard(client)?'':' · '+basename(dirname(t.profile))))
  }
  for(const client of clientIds){
    const path=standard(client)
    if(profiles.size&&[...profiles.values()].some(p=>p.path===path&&p.client===client))continue
    const root=read(path,'')
    const attached=Object.values(object(root[clientInfo[client].root])).some(s=>{
      const args=Array.isArray(s?.command)?s.command:strings(s?.args),i=args.indexOf('mcp')
      return i>=0&&args[i+1]===endpoint&&args[i+2]===join(config.stateDir,'access-token')
    })
    if(attached)register(client)
  }
  for(const {client,path,source,backend} of profiles.values()){
    const root=read(path,source),key=clientInfo[client].root
    mcp(root,key,source)
    for(const project of projects){
      const local=clientInfo[client].project
      if(local)mcp(read(join(project,local),source),key,source,basename(project)+' · '+identifier(project).slice(0,5)+' / ')
      if(client==='claude-code')mcp(object(root.projects?.[project]),key,source,basename(project)+' / ')
    }
    if(client==='codex'){
      const d=backend?config.backends[backend]:undefined,opts=d?.kind==='plugin'?d.config:{}
      if(backend||path===paths.codex)native.set(source,{command:d?.kind==='codex'?d.command??config.codex:typeof opts.command==='string'?opts.command:config.codex,args:d?.kind==='codex'?d.args:strings(opts.args),environment:d?.kind==='codex'||d?.kind==='plugin'?d.env:undefined,cwd:home,projects,source})
      // File-backed fallback remains available when native discovery is offline.
      skills(join(dirname(path),'skills'),source);skills(join(home,'.agents/skills'),source)
      for(const project of projects)skills(join(project,'.agents/skills'),source)
      for(const [name,settings] of Object.entries(object(root.plugins)))add(source,name,{kind:'plugin',name:name.split('@')[0]??name,status:settings?.enabled===false?'disabled':'cli',facts:[name]})
      const cache=join(dirname(path),'plugins/cache')
      for(const market of dirs(cache))for(const name of dirs(join(cache,market))){
        const pluginId=name+'@'+market,folder=join(cache,market,name),registered=object(root.plugins)[pluginId]
        if(!registered&&!existsSync(join(folder,'.codex-remote-plugin-install.json')))continue
        const versions=dirs(folder).filter(v=>existsSync(join(folder,v,'.codex-plugin/plugin.json')))
        // Multiple cached builds do not identify the active version. Native discovery resolves it.
        if(versions.length!==1){
          if(!registered)add(source,pluginId,{kind:'plugin',name,status:versions.length?'installed':'unavailable',facts:[pluginId]})
          continue
        }
        const parent=join(folder,versions[0]!),manifest=read(join(parent,'.codex-plugin/plugin.json'),source)
        if(typeof manifest.name!=='string')continue
        const disabled=registered?.enabled===false
        add(source,pluginId,{kind:'plugin',name:object(manifest.interface).displayName||manifest.name,description:manifest.description,status:disabled?'disabled':'installed',version:manifest.version,facts:[pluginId]})
        const local=(value:unknown,fallback:string)=>{
          const rel=typeof value==='string'?value:fallback,resolved=resolve(parent,rel)
          return resolved.startsWith(parent+'/')?resolved:undefined
        }
        for(const v of Array.isArray(manifest.skills)?manifest.skills:[manifest.skills]){
          const dir=local(v,'skills');if(dir)skills(dir,source,disabled)
        }
        const mf=local(manifest.mcpServers,'.mcp.json')
        if(mf)mcp(read(mf,source),'mcpServers',source,'',{id:pluginId,disabled})
        mcp({mcpServers:manifest.mcpServers},'mcpServers',source,'',{id:pluginId,disabled})
        const af=local(manifest.apps,'.app.json')
        if(af)for(const [slug,app] of Object.entries(object(read(af,source).apps))){
          if(typeof app?.id==='string')add(source,app.id,{kind:'app',name:slug,status:disabled?'disabled':'declared',facts:[pluginId,app.id]})
        }
      }
    }else if(['claude-code','gemini','opencode'].includes(client)){
      const base=client==='claude-code'?join(home,'.claude'):dirname(path)
      skills(join(base,'skills'),source)
      if(client==='opencode'){skills(join(base,'skill'),source);skills(join(home,'.agents/skills'),source);skills(join(home,'.claude/skills'),source)}
      for(const project of projects){
        const folder=client==='claude-code'?'.claude':client==='gemini'?'.gemini':'.opencode'
        skills(join(project,folder,'skills'),source)
        if(client==='opencode'){skills(join(project,'.agents/skills'),source);skills(join(project,'.claude/skills'),source)}
      }
      if(client==='gemini')for(const dir of dirs(join(base,'extensions'))){
        const folder=join(base,'extensions',dir),meta=read(join(folder,'gemini-extension.json'),source)
        if(typeof meta.name!=='string')continue
        add(source,meta.name,{kind:'plugin',name:meta.name,status:'installed',version:meta.version})
        mcp(meta,'mcpServers',source,meta.name+' / ');skills(join(folder,'skills'),source)
      }
      if(client==='claude-code'){
        const records=read(join(base,'plugins/installed_plugins.json'),source),settings=read(join(base,'settings.json'),source)
        for(const [name,installs] of Object.entries(object(records.plugins)))for(const p of Array.isArray(installs)?installs:[]){
          if(p.projectPath&&!projects.includes(p.projectPath)||typeof p.installPath!=='string')continue
          const label=name+' / ',meta=read(join(p.installPath,'.claude-plugin/plugin.json'),source)
          add(source,name+'@'+(p.projectPath??''),{kind:'plugin',name:meta.name??name,status:settings.enabledPlugins?.[name]===false?'disabled':'installed',description:meta.description,version:p.version,facts:[name]})
          mcp(read(join(p.installPath,'.mcp.json'),source),'mcpServers',source,label);mcp(meta,'mcpServers',source,label);skills(join(p.installPath,'skills'),source)
        }
      }
      if(client==='opencode'){
        for(const entry of Array.isArray(root.plugin)?root.plugin:[]){
          const n=Array.isArray(entry)?entry[0]:entry
          if(typeof n!=='string')continue
          // Only expose the package name. Registry URLs and inline options can contain credentials.
          let name=n
          if(n.includes('://')){try{name=basename(new URL(n).pathname)||'OpenCode plugin'}catch{continue}}
          add(source,n,{kind:'plugin',name,status:'cli'})
        }
        for(const dir of [base,...projects.map(p=>join(p,'.opencode'))])for(const kind of ['tools','tool','plugins','plugin']){
          const folder=join(dir,kind);if(!existsSync(folder))continue
          try{for(const f of readdirSync(folder))if(/\.[cm]?[jt]s$/.test(f))add(source,join(folder,f),{kind:kind.startsWith('tool')?'tool':'plugin',name:f,status:'cli',facts:[basename(dir)]})}catch{warnings.add(source)}
        }
      }
    }
  }
  const entries=[...rows.values()]
  for(const profile of native.values())profile.declaredMcpIds=entries.filter(e=>e.source===profile.source&&e.kind==='mcp'&&e.status==='declared').map(e=>e.id)
  return {entries,warnings:[...warnings],native:[...native.values()],sourceGroups}
}
