import {it,expect,vi} from 'vitest'
import {createServer} from 'node:http'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,symlinkSync,linkSync,existsSync,readFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {fileURLToPath} from 'node:url'
import {digest} from '../plugins/cli-shared/files.ts'
import {workspaceGuard} from '../plugins/backend-opencode/workspace.ts'
import {openCodeBuiltins,nativeTools} from '../plugins/backend-opencode/native-tools.ts'
import {openHarnessProvider} from '../src/backends/harness-provider.ts'
import {apiBackendDefinition} from '../src/backend-config.ts'
import {BackendRegistry} from '../src/backends/registry.ts'
import {ProcessBackend,pluginIdentity} from '../src/backends/plugin-process.ts'
import {bundledCLI,bundledEngineId,prepareBundledOpenCode} from '../src/backends/bundled-opencode.ts'
import {stableDigest} from '../src/sources.ts'
import {Store} from '../src/store.ts'
import {Settings} from '../src/settings.ts'
import {workerProfileSchema} from '../src/backend-config.ts'
import {configSchema} from '../src/config.ts'
import type {ModelRequest} from '../src/model.ts'
import {webPageDirectory,webPageFile,webPageCheckpointSchema} from '../src/backends/opencode-web-checkpoint.ts'

const request:ModelRequest={instructions:'',input:'',schema:{type:'object'},cwd:tmpdir()}

it('restricts native tool paths and journals the vendor call ID before editing',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'harness-guard-')))
 const cwd=join(root,'task'),privatePath=join(cwd,'private'),src=join(cwd,'src')
 mkdirSync(cwd);mkdirSync(src);mkdirSync(privatePath)
 const file=join(src,'work.txt'),other=join(root,'outside.txt')
 writeFileSync(file,'inside');writeFileSync(other,'outside');symlinkSync(other,join(cwd,'link'));linkSync(other,join(cwd,'hard'))
 const installed:string[]=[]
 try{
  for(const mode of ['read','edit'] as const){
   const guard=workspaceGuard(root,{...request,cwd,harnessPrivateFiles:[privatePath],harnessWorkspace:mode},mode)
   installed.push(fileURLToPath(guard.url))
   const plugin=await import(guard.url+'/index.mjs')
   const hooks=await plugin.default.server()
   const invoke=(tool:string,args:Record<string,string>)=>hooks['tool.execute.before']({tool,callID:'vendor-'+tool},{args})
   expect(guard.ready()).toBe(true)
   for(const path of ['../outside.txt','link','hard',privatePath])await expect(invoke('read',{filePath:path})).rejects.toThrow()
   await expect(invoke('write',{filePath:file})).rejects.toThrow()
   await expect(invoke('grep',{path:'.'})).rejects.toThrow()
   await expect(invoke('grep',{path:'src',include:'../outside.txt'})).rejects.toThrow()
   const args={filePath:'src/work.txt'}
   await invoke('read',args);expect(args.filePath).toBe(file)
   if(mode==='edit'){await invoke('edit',args);expect(guard.operations().at(-1)).toEqual({id:'vendor-edit',tool:'edit',path:'src/work.txt'})}
   else await expect(invoke('edit',args)).rejects.toThrow()
  }
 }finally{for(const dir of installed)rmSync(dir,{recursive:true,force:true});rmSync(root,{recursive:true,force:true})}
})

it('grants the stock OpenCode tools with the task network and workspace bounds',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'opencode-native-')))
 const cwd=join(root,'work');mkdirSync(cwd)
 const task:ModelRequest={...request,cwd,role:'worker',sandbox:'workspace-write',opencodeNativeTools:{network:true}}
 const guards=[workspaceGuard(root,task,'normal'),workspaceGuard(root,{...task,sandbox:'read-only',opencodeNativeTools:{network:false}},'restricted')]
 try{
  expect(nativeTools(task)).toEqual([...openCodeBuiltins,'webfetch_batch'])
  expect(nativeTools({...task,opencodeNativeTools:{network:false}})).not.toContain('webfetch')
  expect(nativeTools({...task,opencodeNativeTools:{network:false}})).not.toContain('webfetch_batch')
  const invoke=async(index:number)=>{
   const plugin=await import(guards[index]!.url+'/index.mjs')
   const hooks=await plugin.default.server()
   return (tool:string,args:Record<string,string>)=>hooks['tool.execute.before']({tool,callID:'native-'+tool},{args})
  }
  const normal=await invoke(0),restricted=await invoke(1)
  const write={filePath:'results/new.txt'}
  await normal('write',write);expect(write.filePath).toBe(join(cwd,'results/new.txt'))
  const patch={patchText:'*** Begin Patch\n*** Add File: results/patch.txt\n+proof\n*** End Patch'}
  await normal('apply_patch',patch);expect(patch.patchText).toContain('*** Add File: '+join(cwd,'results/patch.txt'))
  const command:Record<string,string>={command:'pwd'}
  await normal('bash',command);expect(command.workdir).toBe(cwd)
  await normal('webfetch',{url:'https://example.org'})
  expect(guards[0]!.operations().at(-1)).toEqual({tool:'webfetch',id:'native-webfetch'})
  await expect(restricted('webfetch',{url:'https://example.org'})).rejects.toThrow(/unavailable/)
  await expect(restricted('bash',{command:'pwd'})).rejects.toThrow(/unavailable/)
  await expect(restricted('write',{filePath:'denied.txt'})).rejects.toThrow(/read-only/)
  await expect(normal('apply_patch',{patchText:'*** Add File: ../outside.txt'})).rejects.toThrow(/scope/)
  await expect(normal('unregistered',{})).rejects.toThrow(/unavailable/)
 }finally{
  for(const guard of guards)rmSync(fileURLToPath(guard.url),{recursive:true,force:true})
  rmSync(root,{recursive:true,force:true})
 }
})


it('ranks focused passages from the CLI archive so links and navigation cannot crowd out definitions',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'opencode-web-evidence-')))
 const directory=join(root,'data','opencode','tool-output')
 mkdirSync(directory,{recursive:true})
 const archive=join(directory,'tool_sample')
 const definitions=[
  ['Request','no-cache','A no-cache request asks the cache to revalidate before it reuses a stored response.'],
  ['Request','no-store','A no-store request forbids storing the request and any response to it.'],
  ['Response','no-cache','A stored response with no-cache must be successfully validated before reuse.'],
  ['Response','no-store','A response with no-store must not be stored in any cache.'],
 ]
 writeFileSync(archive,[
  '# HTTP Caching',
  '## [Table of Contents](#contents)',
  Array(8).fill('- [no-cache and no-store](#nav) Navigation link').join('\n'),
  'Garden irrigation information that should never enter the model context.\n\n'.repeat(1200),
  ...definitions.flatMap(([context,topic,text])=>['## '+context+' directives','### '+topic,text]),
 ].join('\n\n'))
 const task:ModelRequest={...request,webEvidenceQuery:'Compare the no-cache and no-store HTTP directives.',opencodeNativeTools:{network:true}}
 const guard=workspaceGuard(root,task,'web-evidence')
 try{
  const plugin=await import(guard.url+'/index.mjs')
  const hooks=await plugin.default.server()
  const output={title:'Web page',output:'The preview stopped before the definitions.',metadata:{truncated:true,outputPath:archive}}
  const url='https://example.org/cache'
  await hooks['tool.execute.after']({tool:'webfetch',args:{url}},output)
  expect(output.output).toContain('Source: '+url)
  for(const [, , text] of definitions)expect(output.output).toContain(text)
  expect(output.output).not.toMatch(/Navigation link|Garden irrigation/)
  expect(Buffer.byteLength(output.output)).toBeLessThanOrEqual(4000)
 }finally{
  rmSync(fileURLToPath(guard.url),{recursive:true,force:true})
  rmSync(root,{recursive:true,force:true})
 }
})

it('shares a 32-fetch window across concurrent native batches and bounds returned evidence',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'opencode-web-window-')))
 const guard=workspaceGuard(root,{...request,webEvidenceQuery:'Cache directive for a response',opencodeNativeTools:{network:true}},'web-window')
 let release!:()=>void,full!:()=>void,active=0,peak=0
 const waiting=new Promise<void>(resolve=>{release=resolve}),atLimit=new Promise<void>(resolve=>{full=resolve})
 const attempted:string[]=[]
 const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{
  const name=String(url);attempted.push(name);peak=Math.max(peak,++active)
  if(active===32)full()
  await waiting
  active--
  return new Response('The response cache directive requires validation before reuse. '+name,{headers:{'content-type':'text/plain'}})
 })
 try{
  const plugin=await import(guard.url+'/index.mjs'),hooks=await plugin.default.server()
  const batch=hooks.tool.webfetch_batch
  const context={ask:async()=>{},abort:new AbortController().signal}
  const urls=Array.from({length:32},(_,i)=>'https://example.org/'+i)
  const results=Promise.all([batch.execute({urls},context),batch.execute({urls:['https://example.org/overflow']},context)])
  try{
   await Promise.race([atLimit,results])
   expect(attempted).toEqual(urls)
  }finally{release()}
  const [first,second]=await results
  expect(peak).toBe(32)
  expect(first.metadata.pages.map((p:{url:string})=>p.url)).toEqual(urls)
  expect(Buffer.byteLength(first.output)).toBeLessThanOrEqual(48*1024)
  expect(second.output).toContain('https://example.org/overflow')
 }finally{
  release()
  fetch.mockRestore()
  rmSync(fileURLToPath(guard.url),{recursive:true,force:true})
  rmSync(root,{recursive:true,force:true})
 }
})

it('keeps a fast page when the process dies mid-batch and fetches only the missing page',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'opencode-web-replay-')))
 const activation={...request,webEvidenceQuery:'Cache directive for a response',opencodeNativeTools:{network:true}}
 const first=workspaceGuard(root,activation,'old-turn')
 const urls=['https://example.org/fast','https://example.org/slow']
 const child=spawn(process.execPath,['--input-type=module','-e',`
   const urls=${JSON.stringify(urls)}
   globalThis.fetch=async url=>{
    if(String(url)===urls[0])return new Response('# Cache directive\\n\\nThe response cache directive requires validation before reuse.',{headers:{'content-type':'text/plain'}})
    await new Promise(()=>setInterval(()=>{},1000))
   }
   const {default:plugin}=await import(${JSON.stringify(first.url+'/index.mjs')})
   const hooks=await plugin.server()
   await hooks['tool.execute.before']({tool:'webfetch_batch',callID:'call-one'},{args:{urls}})
   await hooks.tool.webfetch_batch.execute({urls},{ask:async()=>{},abort:new AbortController().signal})
 `],{stdio:'ignore'})
 const exited=once(child,'exit')
 const directory=webPageDirectory(root,'old-turn')
 let second:ReturnType<typeof workspaceGuard>|undefined
 try{
  const completed=webPageFile(directory,urls[0]!)
  await vi.waitFor(()=>expect(existsSync(completed)).toBe(true))
  expect(child.exitCode).toBeNull()
  expect(existsSync(webPageFile(directory,urls[1]!))).toBe(false)
  child.kill('SIGKILL')
  expect(await exited).toEqual([null,'SIGKILL'])
  expect(first.operations()).toEqual([{id:'call-one',tool:'webfetch_batch',urls}])
  const saved=webPageCheckpointSchema.parse(JSON.parse(readFileSync(completed,'utf8')))
  expect(saved.excerpts.join('\n')).toContain('requires validation before reuse')
  second=workspaceGuard(root,{...activation,opencodeWebPages:[saved]},'new-turn')
  const hooks=await (await import(second.url+'/index.mjs')).default.server()
  const ask=vi.fn(async()=>{})
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('The slow page explains the cache directive for stale responses.',{headers:{'content-type':'text/plain'}}))
  try{
   // The fresh activation can request the same pages in a different order.
   const result=await hooks.tool.webfetch_batch.execute({urls:[...urls].reverse()},{ask,abort:new AbortController().signal})
   expect(fetch).toHaveBeenCalledTimes(1)
   expect(String(fetch.mock.calls[0]![0])).toBe(urls[1])
   expect(ask).toHaveBeenCalledWith(expect.objectContaining({permission:'webfetch',patterns:[...urls].reverse()}))
   expect(result.metadata.pages).toMatchObject([{url:urls[1],status:'completed'},{url:urls[0],status:'completed',reused:true}])
   expect(result.output).toContain('Source: '+urls[0])
   expect(result.output).toContain('requires validation before reuse')
   expect(result.output).toContain('Source: '+urls[1])
  }finally{fetch.mockRestore()}
 }finally{
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')
  await exited
  for(const guard of [first,second])if(guard)rmSync(fileURLToPath(guard.url),{recursive:true,force:true})
  rmSync(root,{recursive:true,force:true})
 }
})

it('applies the saved API connection, structured output, request budget and step limit on the final wire',async()=>{
 const requests:{url?:string;headers:any;body:any}[]=[]
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk
  requests.push({url:req.url,headers:req.headers,body:JSON.parse(raw)})
  res.writeHead(200,{'content-type':'text/event-stream'}).end('data: [DONE]\n\n')
 })
 await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok))
 const d=apiBackendDefinition.parse({kind:'openai-chat',baseUrl:'http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1',model:'test',maxSteps:1,maxOutputTokens:128,chatTokenField:'max_tokens',parameters:{temperature:0},outputFormat:'json-schema'})
 const gateway=await openHarnessProvider(d,'test',request,async()=>'host-only')
 const bounded=await openHarnessProvider(d,'test',{...request,contextBudget:{maxBytes:200,outputReserveBytes:60,toolReserveBytes:20}})
 const call=(url:string,overrides:Record<string,unknown>={})=>fetch(url,{method:'POST',headers:{authorization:'Bearer untrusted','x-extra-header':'drop'},body:JSON.stringify({stream:true,model:'test',tools:[{type:'function'}],...overrides})})
 try{
  expect((await call(gateway.url+'/responses')).status).toBe(403)
  expect((await call(gateway.url+'/chat/completions',{model:'other'})).status).toBe(400)
  expect((await call(gateway.url+'/chat/completions',{previous_response_id:'private'})).status).toBe(400)
  expect((await call(bounded.url+'/chat/completions',{messages:['x'.repeat(1000)]})).status).toBe(413)
  expect(bounded.failure()).toMatchObject({code:'context_budget_exceeded'})
  const response=await call(gateway.url+'/chat/completions')
  expect(response.ok).toBe(true);await response.text()
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({url:'/v1/chat/completions',headers:{authorization:'Bearer host-only'},body:{temperature:0,max_tokens:128,response_format:{type:'json_schema',json_schema:{schema:request.schema}}}})
  expect(requests[0]!.headers['x-extra-header']).toBeUndefined()
  expect((await call(gateway.url+'/chat/completions')).status).toBe(400)
  expect(requests).toHaveLength(1)
 }finally{await gateway.close();await bounded.close();server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()))}
})

it('retries one pre-response connection reset inside the same harness model step',async()=>{
 let requests=0
 const server=createServer(async(req,res)=>{
  for await(const _chunk of req){}
  if(++requests===1){req.socket.destroy();return}
  res.writeHead(200,{'content-type':'text/event-stream'}).end('data: [DONE]\n\n')
 })
 await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok))
 const backend=apiBackendDefinition.parse({kind:'openai-responses',baseUrl:'http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1',model:'test',maxSteps:1})
 const gateway=await openHarnessProvider(backend,'test',request)
 try{
  const response=await fetch(gateway.url+'/responses',{method:'POST',body:JSON.stringify({stream:true,model:'test',tools:[{type:'function'}]})})
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('data: [DONE]\n\n')
  expect(requests).toBe(2)
 }finally{await gateway.close();server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()))}
})

it('binds subscription harness runs to the authorized principal and original signed-in account',async()=>{
 const root=mkdtempSync(join(tmpdir(),'harness-account-')),stateDir=join(root,'state')
 const config=configSchema.parse({stateDir,work:{sandboxDriver:process.platform==='darwin'?'seatbelt':'bubblewrap'},backends:{
  plan:{kind:'openai-responses',model:'m',baseUrl:'https://api.openai.com/v1',subscription:{provider:'chatgpt',account:'plan',owner:{source:'local',actor:'owner'},backgroundAuthorized:true}},
 },sources:[{id:'local',kind:'local',cwd:root,allowedActors:['owner']}],execution:{backend:'plan',router:{mode:'host'}}})
 const records=new Map<string,any>(),store={get:(kind:string,id:string)=>records.get(kind+id),put:(kind:string,id:string,value:any)=>{records.set(kind+id,value)}}
 const accounts=join(stateDir,'subscription-accounts');mkdirSync(accounts,{recursive:true})
 const login=(subject:string)=>writeFileSync(join(accounts,'plan.json'),JSON.stringify({subject,access_token:'synthetic-token',expires_at:Date.now()+100000}))
 const registry=new BackendRegistry(config,store)
 const spy=vi.spyOn(ProcessBackend.prototype,'run').mockImplementation(async r=>{r.onThread?.('plugin:test');return {threadId:'plugin:test',turnId:'turn',text:'{}'}})
 const activation:ModelRequest={...request,role:'router',managed:true,allowNativeTools:true,principal:{source:'local',actor:'owner'},tools:[{type:'function',name:'router_read',description:'Read',inputSchema:{}}],onTool:async()=>({success:true,contentItems:[]})}
 try{
  await expect(registry.run({...activation,principal:{source:'local',actor:'other'}})).rejects.toThrow(/owner/)
  await expect(registry.run(activation)).rejects.toThrow(/signed out/)
  login('original');await registry.run(activation)
  expect(spy.mock.lastCall![0].harnessWorkspace).toBe('read')
  expect(JSON.stringify(spy.mock.lastCall![0])).not.toContain('synthetic-token')
  login('other');await expect(registry.run({...activation,threadId:'plugin:test'})).rejects.toThrow(/account changed/)
  expect(spy).toHaveBeenCalledTimes(1)
 }finally{spy.mockRestore();rmSync(root,{recursive:true,force:true})}
})

it('resumes a bundled session created in a removed release while retaining its original storage and connection',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'harness-relocation-')))
 const stateDir=join(root,'state'),cwd=join(root,'workspace')
 mkdirSync(stateDir);mkdirSync(cwd)
 const store=new Store(join(stateDir,'state.sqlite'))
 try{
  const api=apiBackendDefinition.parse({kind:'openai-chat',model:'sample',baseUrl:'http://localhost:2080',headers:{'X-Tenant':'original'}})
  const config=configSchema.parse({stateDir,work:{sandboxDriver:process.platform==='darwin'?'seatbelt':'bubblewrap'},execution:{backend:'api'},backends:{api},sources:[{id:'local',kind:'local',cwd,allowedActors:['alice']}]})
  const pkg=await prepareBundledOpenCode(stateDir)
  const command=join(root,'removed-release/node_modules/opencode-ai/bin/opencode')
  const oldIdentity=pluginIdentity({kind:'plugin',plugin:'opencode-cli',env:{},readPaths:[command],writePaths:[],
   config:{command,cliVersion:bundledCLI!.cliVersion,apiProtocol:api.kind}},pkg)
  const threadId='plugin:existing',nativeId='ses_existing'
  const binding={id:'api',kind:api.kind,endpoint:api.baseUrl,harness:bundledEngineId,harnessModel:'sample',harnessDigest:pkg.digest,
   harnessIdentity:stableDigest([bundledEngineId,oldIdentity,api.headers,api.headerEnv,api.apiKeyEnv,api.subscription?.account])}
  const record={id:threadId,backendId:'api',pluginId:'opencode-cli',digest:pkg.digest,stateVersion:pkg.manifest.stateVersion,
   nativeId,cwd,identity:oldIdentity,state:'completed',effectIds:[]}
  store.put('backend-binding',threadId,binding)
  store.put('backend-plugin-thread',threadId,record)
  const registry=new BackendRegistry(config,store)
  expect(registry.describe(threadId,'router')).toMatchObject({id:'api',model:'sample'})
  const folder='00000000-0000-0000-0000-000000000001'
  const data=join(stateDir,'backend-plugin-data','api',oldIdentity,'threads',stableDigest(threadId))
  const session=join(data,'sessions',folder)
  mkdirSync(join(data,'index'),{recursive:true});mkdirSync(session,{recursive:true})
  writeFileSync(join(data,'index',digest(nativeId)+'.json'),JSON.stringify({id:nativeId,folder}))
  writeFileSync(join(session,'session.json'),JSON.stringify({nativeId,cwd,cliVersion:bundledCLI!.cliVersion,turns:[{id:'before-upgrade',state:'completed',input:'Original question',tools:[],text:'Original reply'}]}))
  expect(await registry.history(threadId,cwd)).toMatchObject({id:threadId,turns:[{id:'before-upgrade',items:[{text:'Original question'},{text:'Original reply'}]}]})
  for(const patch of [{digest:'0'.repeat(64)},{id:'plugin:someone-else'},{identity:'0'.repeat(64)}]){
   store.put('backend-plugin-thread',threadId,{...record,...patch})
   expect(()=>registry.describe(threadId)).toThrow(/migration/)
  }
  store.put('backend-plugin-thread',threadId,record)
  store.put('backend-binding',threadId,{...binding,harnessIdentity:'v2:'+binding.harnessIdentity})
  expect(()=>registry.describe(threadId)).toThrow(/migration/)
  store.put('backend-binding',threadId,binding)
  config.backends.api={...api,headers:{'X-Tenant':'changed'}}
  const attempt={...request,threadId,cwd}
  await expect(registry.run(attempt)).rejects.toThrow(/migration/)
  config.backends.api=api
  expect(store.get('backend-binding',threadId)).toEqual(binding)
  expect(await registry.purge(threadId,cwd)).toEqual({local:'verified',provider:'not_managed'})
  store.put('backend-plugin-thread',threadId,{id:threadId,backendId:'api',cwd,deleted:true})
  expect(await new BackendRegistry(config,store).purge(threadId,cwd)).toEqual({local:'verified',provider:'not_managed'})
  await expect(registry.purge(threadId,stateDir)).rejects.toThrow(/workspace or identity/)
  expect(()=>registry.describe(threadId)).toThrow(/deletion fence/)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})

it('migrates saved role preferences and excludes engine selection from new managed Worker profiles',()=>{
 const root=mkdtempSync(join(tmpdir(),'roppo-preset-upgrade-'))
 const store=new Store(join(root,'state.sqlite'))
 try{
  const config=configSchema.parse({stateDir:root,execution:{backend:'api'},backends:{api:{kind:'openai-chat',model:'demo',baseUrl:'http://localhost:2080'}},sources:[{id:'local',kind:'local',cwd:root,allowedActors:['alice']}]})
  const initial=new Settings(store,config).current()
  const legacy={...config.execution,router:{backend:'api',label:'Coord',mode:'host',harness:'old-engine'},workers:[{id:'one',backend:'api',prompt:'Keep the original instruction.',harness:'old-engine'}]}
  store.put('settings','current',{...initial,revision:7,config:{...config,execution:legacy}})
  const settings=new Settings(store,config)
  expect(settings.current().revision).toBe(7)
  expect(config.execution.router).toEqual({backend:'api',label:'Coord',mode:'host'})
  expect(config.execution.workers).toEqual([{id:'one',backend:'api',prompt:'Keep the original instruction.'}])
  expect(workerProfileSchema.safeParse(legacy.workers[0]).success).toBe(false)
  expect(new BackendRegistry(config,store).configured().map(b=>b.id)).toEqual(['api'])
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
