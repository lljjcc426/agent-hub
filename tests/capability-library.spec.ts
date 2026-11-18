import {afterEach,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {configSchema} from '../src/config.ts'
import {profileInventory} from '../src/capability-profiles.ts'
import {codexInventory,withPreviousCatalog} from '../src/capability-codex.ts'
import {clientConfig} from '../src/clients.ts'
import {skillText} from '../src/capability-data.ts'

const dirs:string[]=[]
function setup(){
  const home=mkdtempSync(join(tmpdir(),'roppo-library-'));dirs.push(home)
  const write=(file:string,value:unknown)=>{const p=join(home,file);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,typeof value==='string'?value:JSON.stringify(value));return p}
  const source={id:'local',kind:'local',cwd:home,allowedActors:['operator']}
  return {home,write,source}
}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
it('enumerates configured CLI families, exact incoming bridges and installed plugin capabilities without leaking launch or credential values',()=>{
  const {home,write,source}=setup(),endpoint='http://127.0.0.1:4357',secret='fixture-private-value'
  const config=configSchema.parse({stateDir:join(home,'state'),sources:[source],backends:{...Object.fromEntries(['claude-code','gemini-cli','opencode-cli'].map(id=>[id,{kind:'plugin',plugin:id}])),secondary:{kind:'plugin',plugin:'codex-cli'}}})
  write('.codex/config.toml','[mcp_servers.codex-docs]\ncommand="private-command"\n[mcp_servers.codex-docs.env]\nTOKEN="'+secret+'"\n')
  write('.agents/skills/report/SKILL.md','---\nname: Report\ndescription: Publish a report\n---\n# Read evidence')
  write('.claude.json',{mcpServers:{claudeDocs:{command:secret}}})
  write('.mcp.json',{mcpServers:{projectDocs:{command:secret}}})
  write('.gemini/settings.json',{mcpServers:{geminiDocs:{disabled:true}}})
  write('.gemini/extensions/extra/gemini-extension.json',{name:'extra',mcpServers:{extDocs:{command:secret}}})
  write('.config/opencode/opencode.jsonc','{ // Comment\n "mcp": {"openDocs":{"enabled":true}}, "plugin":["@acme/tools"] }')
  const cached='.codex/plugins/cache/remote/reading'
  write(cached+'/.codex-remote-plugin-install.json',{remote_plugin_id:'reading'})
  write(cached+'/1.0/.codex-plugin/plugin.json',{name:'reading',version:'1.0',skills:'./skills',apps:'./.app.json'})
  write(cached+'/1.0/skills/notes/SKILL.md','# Notes')
  write(cached+'/1.0/.app.json',{apps:{notes:{id:'notes-app'}}})
  write(cached+'/1.0/.mcp.json',{mcpServers:{notesMcp:{command:secret}}})
  write('.codex/plugins/cache/deleted/stale/1.0/.codex-plugin/plugin.json',{name:'stale'})
  write('.cursor/mcp.json',clientConfig({client:'cursor',url:endpoint,name:'custom-alias',tokenFile:join(config.stateDir,'access-token')}).config)
  write('.qwen/settings.json',{mcpServers:{unrelated:{command:secret}}})
  const inventory=profileInventory(config,home,endpoint,{}),names=inventory.entries.map(v=>v.name)
  expect(names).toEqual(expect.arrayContaining(['codex-docs','Report','claudeDocs','projectDocs','geminiDocs','extra','extDocs','openDocs','@acme/tools','reading','notes','notesMcp','custom-alias']))
  expect(inventory.sourceGroups.get('CLI · codex')).toBe('Codex')
  expect(inventory.sourceGroups.get('CLI · secondary')).toBe('Codex')
  expect(inventory.sourceGroups.get('Codex · secondary')).toBe('Codex')
  expect(inventory.sourceGroups.get('CLI · gemini-cli')).toBe('Gemini CLI')
  expect(names).not.toContain('unrelated');expect(names).not.toContain('stale')
  expect(inventory.entries.find(x=>x.name==='geminiDocs')?.status).toBe('disabled')
  expect(inventory.entries.find(x=>x.name==='notes'&&x.kind==='app')?.status).toBe('declared')
  expect(inventory.entries.find(x=>x.name==='Report')?.content?.()).toContain('# Read evidence')
  expect(JSON.stringify(inventory.entries)).not.toContain(secret)
  const path=write('private/key',secret);mkdirSync(join(home,'bad'));symlinkSync(path,join(home,'bad/SKILL.md'))
  expect(skillText(join(home,'bad/SKILL.md'))).toBeUndefined()
})
it('consumes paginated native registries, keeps successful catalogs on a source error and exposes typed tool parameters',async()=>{
  const {write,home}=setup(),path=write('guide/SKILL.md','# Real instructions')
  const script=write('cli.cjs',`
const readline=require('node:readline')
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(!m.id)return
  const next=!!m.params.cursor;let result
  if(m.method==='initialize')result={}
  if(m.method==='plugin/list')result={marketplaces:[{name:'local',plugins:[{id:'one',name:'One',installed:true,enabled:true},{id:'x',name:'uninstalled',installed:false}]}]}
  if(m.method==='skills/list')result={data:[{skills:[{name:'guide',path:${JSON.stringify(path)},enabled:true}]}]}
  if(m.method==='mcpServerStatus/list')result={data:[{name:next?'codex_apps':'first',toolListMeta:{'openai/apps':[{connectorId:'no-tools'}]},runtimeStatus:'connected',tools:{fetch:{name:'fetch',_meta:{connector_id:'tracked',connector_name:'App',link_id:'private-link'},inputSchema:{properties:{id:{type:'string',default:'private default'}},required:['id']}}}}],nextCursor:next?null:'page-2'}
  if(m.method==='app/list'){
    if(!global.retry){global.retry=true;process.stdout.write(JSON.stringify({id:m.id,error:{code:-32603,message:'temporary upstream failure'}})+'\\n');return}
    result={data:[{id:'tracked',name:'App',isAccessible:true,isEnabled:true}],nextCursor:null}
  }
  process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')
})
`)
  const r=await codexInventory({command:process.execPath,args:[script],cwd:home,projects:[home],source:'Codex test'})
  expect(r.entries.map(e=>e.name).sort()).toEqual(['App','One','codex_apps','first','guide','no-tools'])
  expect(r.entries.find(e=>e.name==='guide')?.content?.()).toBe('# Real instructions')
  expect(r.entries.find(e=>e.name==='codex_apps')?.tools?.[0]?.inputs).toEqual([{name:'id',required:true,type:'string'}])
  expect(r.entries.find(e=>e.name==='App')?.tools?.map(t=>t.name)).toEqual(['fetch'])
  expect(r.warnings).toEqual([])
  const failed={entries:[],warnings:['Codex test · Apps'],complete:[]}
  expect(withPreviousCatalog(failed,r).entries.find(e=>e.name==='App')?.status).toBe('cached')
  expect(withPreviousCatalog({...failed,complete:['app']},r).entries.some(e=>e.name==='App')).toBe(false)
  expect(JSON.stringify(r)).not.toMatch(/credential hidden|private default|private-link/)
})

it('serves workspace metadata only to the operator, resolves real content and keeps role restrictions on harness bridges',async()=>{
  const {home,source}=setup()
  const {Runtime}=await import('../src/runtime.ts'),{serve}=await import('../src/server.ts')
  const {readFileSync}=await import('node:fs')
  const config=configSchema.parse({stateDir:join(home,'state'),port:0,sources:[source],
    backends:{api:{kind:'openai-chat',baseUrl:'http://127.0.0.1:4100',model:'fixture',headers:{'X-Internal':'private-header'}}},
    execution:{backend:'api',router:{backend:'api',tools:['router_read']},workers:[{id:'reviewer',backend:'api',tools:[]}]},
    prompts:{skills:{summary:'Use verified totals.'}}})
  const service=await serve(new Runtime(config,{model:{async run(){throw Error('Unexpected model call')}}}),{clientHome:home})
  try{
    const endpoint=service.url+'/api/capability-library',headers={authorization:'Bearer '+readFileSync(service.tokenPath,'utf8').trim()}
    expect((await fetch(endpoint)).status).toBe(401)
    const snapshot=await (await fetch(endpoint,{headers})).json()
    expect(JSON.stringify(snapshot)).not.toMatch(/private-header|Use verified totals/)
    expect(snapshot.items.some((i:any)=>i.name==='AgentHub MCP'&&i.tools.some((t:any)=>t.name==='worker_manage'))).toBe(true)
    const skill=snapshot.items.find((i:any)=>i.name==='summary')
    expect(skill.sourceGroup).toBe('Roppo')
    expect(await (await fetch(endpoint+'?id='+skill.id,{headers})).json()).toMatchObject({body:'Use verified totals.',sourceGroup:skill.sourceGroup})
    expect((await fetch(endpoint+'?id=../../config.json',{headers})).status).toBe(404)
    const harness=snapshot.items.find((i:any)=>i.kind==='mcp'&&i.source==='OpenCode harness')
    if((await import('../src/backends/bundled-opencode.ts')).bundledCLI){
      expect(harness.sourceGroup).toBe('OpenCode harness')
      expect(harness.tools.map((t:any)=>t.name)).toEqual(['router_read'])
    }
  }finally{service.server.closeAllConnections();await new Promise<void>(r=>service.server.close(()=>r()));await service.closeRuntime()}
})
