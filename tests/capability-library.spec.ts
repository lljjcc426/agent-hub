import {afterEach,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {configSchema} from '../src/config.ts'
import {profileInventory} from '../src/capability-profiles.ts'
import {codexInventory,withPreviousCatalog} from '../src/capability-codex.ts'
import {clientConfig} from '../src/clients.ts'
import {identifier,skillText} from '../src/capability-data.ts'

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
  const multi='.codex/plugins/cache/remote/multi'
  write(multi+'/.codex-remote-plugin-install.json',{remote_plugin_id:'multi'})
  for(const version of ['1','2'])write(multi+'/'+version+'/.codex-plugin/plugin.json',{name:'multi',version})
  write('.codex/plugins/cache/deleted/stale/1.0/.codex-plugin/plugin.json',{name:'stale'})
  write('.cursor/mcp.json',clientConfig({client:'cursor',url:endpoint,name:'custom-alias',tokenFile:join(config.stateDir,'access-token')}).config)
  write('.qwen/settings.json',{mcpServers:{unrelated:{command:secret}}})
  const inventory=profileInventory(config,home,endpoint,{}),names=inventory.entries.map(v=>v.name)
  expect(names).toEqual(expect.arrayContaining(['codex-docs','Report','claudeDocs','projectDocs','geminiDocs','extra','extDocs','openDocs','@acme/tools','reading','notes','notesMcp','custom-alias']))
  expect(inventory.sourceGroups.get('CLI · codex')).toBe('Codex')
  expect(inventory.sourceGroups.get('CLI · secondary')).toBe('Codex')
  expect(inventory.sourceGroups.get('Codex · secondary')).toBe('Codex')
  expect(inventory.sourceGroups.get('CLI · gemini-cli')).toBe('Gemini CLI')
  expect(inventory.entries.filter(e=>e.name==='multi'&&e.source==='Codex')).toMatchObject([{kind:'plugin',status:'installed'}])
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
let pluginsReady=false,mcpReads=0
readline.createInterface({input:process.stdin}).on('line',async line=>{
  const m=JSON.parse(line);if(!m.id)return
  const next=!!m.params.cursor;let result
  if(m.method==='initialize')result={}
  if(m.method==='plugin/list'){process.stdout.write(JSON.stringify({id:m.id,error:{code:-32603,message:'Remote marketplace unreachable'}})+'\\n');return}
  if(m.method==='plugin/installed'){await new Promise(done=>setTimeout(done,20));pluginsReady=true;result={marketplaces:[{name:'local',plugins:[{id:'one',name:'One',installed:true,enabled:true},{id:'x',name:'uninstalled',installed:false}]}]}}
  if(m.method==='skills/list')result={data:[{skills:[{name:'guide',path:${JSON.stringify(path)},enabled:true}]}]}
  if(m.method==='mcpServerStatus/list')result={data:[{name:next?'codex_apps':'first',toolListMeta:{'openai/apps':[{connectorId:'no-tools'}]},runtimeStatus:'connected',tools:{fetch:{name:'fetch',_meta:{connector_id:'tracked',connector_name:'App',link_id:'private-link'},inputSchema:{properties:{id:{type:'string',default:'private default'}},required:['id']}}}}],nextCursor:next?null:'page-2'}
  if(m.method==='mcpServerStatus/list'&&!next&&++mcpReads>1)result.data.push({pluginId:'p',name:'late',tools:{}})
  if(m.method==='app/list'){
    if(!global.retry){global.retry=true;process.stdout.write(JSON.stringify({id:m.id,error:{code:-32603,message:'temporary upstream failure'}})+'\\n');return}
    result={data:[{id:'tracked',name:'App',isAccessible:true,isEnabled:true}],nextCursor:null}
  }
  if(!pluginsReady&&['mcpServerStatus/list','skills/list'].includes(m.method))result={data:[]}
  process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')
})
`)
  const r=await codexInventory({command:process.execPath,args:[script],cwd:home,projects:[home],source:'Codex test',declaredMcpIds:[identifier('Codex test','mcp','p/late')]})
  expect(r.entries.map(e=>e.name).sort()).toEqual(['App','One','codex_apps','first','guide','late','no-tools'])
  expect(r.entries.find(e=>e.name==='guide')?.content?.()).toBe('# Real instructions')
  expect(r.entries.find(e=>e.name==='codex_apps')?.tools?.[0]?.inputs).toEqual([{name:'id',required:true,type:'string'}])
  expect(r.entries.find(e=>e.name==='App')?.tools?.map(t=>t.name)).toEqual(['fetch'])
  expect(r.warnings).toEqual([])
  const failed={entries:[],warnings:['Codex test · Apps'],complete:[]}
  expect(withPreviousCatalog(failed,r).entries.find(e=>e.name==='App')?.status).toBe('cached')
  expect(withPreviousCatalog({...failed,complete:['app']},r).entries.some(e=>e.name==='App')).toBe(false)
  expect(JSON.stringify(r)).not.toMatch(/credential hidden|private default|private-link/)
})

it.each(['legacy','partial'] as const)('preserves installed entries when a %s Codex catalog responds',async mode=>{
  const {write,home}=setup()
  const script=write('plugins.cjs',`
const readline=require('node:readline')
readline.createInterface({input:process.stdin}).on('line',line=>{
  const {id,method,params}=JSON.parse(line);if(!id)return
  const send=msg=>process.stdout.write(JSON.stringify({id,...msg})+'\\n')
  const catalog=(id,errors=[])=>({marketplaces:[{name:'local',plugins:[{id,name:id,installed:true,enabled:false}]}],marketplaceLoadErrors:errors})
  if(method==='plugin/installed'){
    if(${JSON.stringify(mode)}==='legacy')return send({error:{code:-32601,message:'Method not found'}})
    return send({result:catalog('partial-entry',[{message:'unreadable installed directory'}])})
  }
  if(method==='plugin/list')return send({result:catalog(params.marketplaceKinds?'external':'local')})
  send({result:{data:[]}})
})
`)
  const r=await codexInventory({command:process.execPath,args:[script],cwd:home,projects:[home],source:'Codex'})
  expect(r.entries.map(entry=>entry.name).sort()).toEqual(mode==='legacy'?['external','local']:['partial-entry'])
  expect(r.entries.every(entry=>entry.status==='disabled')).toBe(true)
  expect(r.warnings).toEqual(mode==='legacy'?[]:['Codex · Plugins'])
  expect(r.complete.includes('plugin')).toBe(mode==='legacy')
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

it('passes the selected local skill to only its authorized Chat turn and deduplicates retries',async()=>{
  const {home,write,source}=setup()
  const clean=write('one/.agents/skills/release-review/SKILL.md','---\nname: release-review\n---\nUse the release evidence checklist.')
  write('two/.agents/skills/private-review/SKILL.md','---\nname: private-review\n---\nUse the private checklist.')
  const {Runtime}=await import('../src/runtime.ts'),{serve}=await import('../src/server.ts')
  const config=configSchema.parse({stateDir:join(home,'state'),port:0,work:{sandboxDriver:'disabled'},
    sources:[{...source,cwd:join(home,'one')},{...source,id:'other',cwd:join(home,'two')}],
    backends:{api:{kind:'openai-chat',baseUrl:'http://127.0.0.1:4100',model:'fixture'}},
    execution:{backend:'api',router:{mode:'host',backend:'api'},workers:[{id:'reviewer',backend:'api'}]},
    prompts:{skills:{summary:'Summarize verified totals.'}}})
  const turns:Record<string,unknown>[]=[]
  const host=new Runtime(config,{model:{async run(request){
    turns.push(JSON.parse(request.input))
    return {threadId:request.threadId??randomUUID(),turnId:randomUUID(),text:JSON.stringify({reply:'Checked.'})}
  }}})
  host.scopes.command({action:'scope.put',operationId:'skills-test-scope',expectedRevision:0,
    scope:{id:'work',tenantId:'work',name:'Work',managers:[JSON.stringify(['local','operator'])],sourceIds:['local','other'],
      workerIds:['reviewer'],backendIds:['api']}})
  const service=await serve(host,{clientHome:home})
  try{
    const owner='local-operator',chat=host.chat.create(owner),other=host.chat.create(owner,{cwd:join(home,'two'),sourceId:'other'})
    const headers={authorization:'Bearer '+readFileSync(service.tokenPath,'utf8').trim(),'content-type':'application/json'}
    const get=(id:string)=>fetch(service.url+'/api/chat/skills?conversation='+id,{headers}).then(r=>r.json())
    const catalog=await get(chat.id),otherCatalog=await get(other.id)
    const selected=catalog.items.find((s:{name:string})=>s.name==='release-review')
    const privateSkill=otherCatalog.items.find((s:{name:string})=>s.name==='private-review')
    expect(catalog.items.map((s:{name:string})=>s.name)).toEqual(['release-review','summary'])
    expect(privateSkill).toBeDefined()
    expect(JSON.stringify(catalog)).not.toContain(home)
    const post=(body:unknown)=>fetch(service.url+'/api/chat/conversations/'+chat.id+'/messages',{method:'POST',headers,body:JSON.stringify(body)})
    const input={text:'Check the previous release.',clientMessageId:randomUUID()}
    const rejected=await post({...input,skillId:privateSkill.id})
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({code:'skill_unavailable'})
    const sent=await post({...input,skillId:selected.id})
    expect(sent.status).toBe(202)
    const first=await sent.json()
    rmSync(clean)
    expect(await (await post({...input,skillId:selected.id})).json()).toEqual({runId:first.runId,duplicate:true})
    expect(await (await post(input)).json()).toMatchObject({code:'message_conflict'})
    expect((await post({...input,text:'Ordinary follow-up.',clientMessageId:randomUUID()})).status).toBe(202)
    for(let i=0;i<100&&turns.length<2;i++){
      await host.tick()
      await new Promise(resolve=>setTimeout(resolve,5))
    }
    expect(turns).toHaveLength(2)
    expect(turns[0]?.selectedSkill).toMatchObject({name:'release-review',instructions:expect.stringContaining('Use the release evidence checklist.')})
    expect(turns[1]?.selectedSkill).toBeUndefined()
    const messages=host.chat.view(chat.id,owner).messages
    expect(messages.find(m=>m.clientMessageId===input.clientMessageId)?.skill).toEqual({id:selected.id,name:'release-review'})
    expect(JSON.stringify(messages)).not.toContain('Use the release evidence checklist.')
  }finally{service.server.closeAllConnections();await new Promise<void>(r=>service.server.close(()=>r()));await service.closeRuntime()}
})
