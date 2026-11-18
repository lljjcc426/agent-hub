import {it,expect,vi} from 'vitest'
import {createServer} from 'node:http'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,symlinkSync,linkSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {workspaceGuard} from '../plugins/backend-opencode/workspace.ts'
import {openHarnessProvider} from '../src/backends/harness-provider.ts'
import {apiBackendDefinition} from '../src/backend-config.ts'
import {BackendRegistry} from '../src/backends/registry.ts'
import {ProcessBackend} from '../src/backends/plugin-process.ts'
import {buildBackendPackage} from '../src/backends/plugin-package.ts'
import {configSchema} from '../src/config.ts'
import type {ModelRequest} from '../src/model.ts'

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

it('binds subscription harness runs to the authorized principal and original signed-in account',async()=>{
 const root=mkdtempSync(join(tmpdir(),'harness-account-')),stateDir=join(root,'state')
 const manifest=JSON.parse(readFileSync('plugins/backend-opencode/manifest.json','utf8'))
 const pkg=await buildBackendPackage(resolve('plugins/backend-opencode/index.ts'),manifest,join(root,'package'))
 const config=configSchema.parse({stateDir,backendPlugins:[{directory:pkg.directory,digest:pkg.digest}],backends:{
  plan:{kind:'openai-responses',model:'m',baseUrl:'https://api.openai.com/v1',subscription:{provider:'chatgpt',account:'plan',owner:{source:'local',actor:'owner'},backgroundAuthorized:true}},
  engine:{kind:'plugin',plugin:'opencode-cli',config:{command:'opencode',cliVersion:'1.19.5'}}
 },sources:[{id:'local',kind:'local',cwd:root,allowedActors:['owner']}],execution:{backend:'plan',router:{mode:'host',harness:'engine'}}})
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
