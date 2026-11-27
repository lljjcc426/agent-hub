import {it,expect,vi} from 'vitest'
import {createServer} from 'node:http'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,symlinkSync,linkSync,existsSync,readFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {digest} from '../plugins/cli-shared/files.ts'
import {toolBridge} from '../plugins/cli-shared/mcp.ts'
import {workspaceGuard} from '../plugins/backend-opencode/workspace.ts'
import {openCodeBuiltins,nativeTools} from '../plugins/backend-opencode/native-tools.ts'
import {openHarnessProvider} from '../src/backends/harness-provider.ts'
import {apiBackendDefinition} from '../src/backend-config.ts'
import {BackendRegistry} from '../src/backends/registry.ts'
import {ApiModel} from '../src/backends/api.ts'
import {ProcessBackend,pluginIdentity} from '../src/backends/plugin-process.ts'
import {bundledCLI,bundledEngineId,prepareBundledOpenCode} from '../src/backends/bundled-opencode.ts'
import {stableDigest} from '../src/sources.ts'
import {Store} from '../src/store.ts'
import {Settings} from '../src/settings.ts'
import {Runtime} from '../src/runtime.ts'
import {workerProfileSchema} from '../src/backend-config.ts'
import {configSchema} from '../src/config.ts'
import type {ModelRequest} from '../src/model.ts'
import {webPageDirectory,webPageFile,webPageCheckpointSchema} from '../src/backends/opencode-web-checkpoint.ts'

const request:ModelRequest={instructions:'',input:'',schema:{type:'object'},cwd:tmpdir()}
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yR5cAAAAASUVORK5CYII='

it.skipIf(!bundledCLI)('delivers a successful plain-text OpenCode reply to Chat without another model call',async()=>{
 const root=mkdtempSync(join(tmpdir(),'harness-chat-reply-'))
 const reply='在。\n\n- **任务**还在原来的位置。'
 let replyText=reply,requests=0
 const upstream=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/v1/models'){
   res.writeHead(200,{'content-type':'application/json'})
   res.end(JSON.stringify({data:[{id:'sample',limit:{context:65536,output:4096}}]}))
   return
  }
  for await(const _chunk of req){}
  requests++
  const item={type:'message',id:'msg_'+requests,role:'assistant',status:'completed',
   content:[{type:'output_text',text:replyText,annotations:[]}]}
  const response={id:'resp_'+requests,object:'response',model:'sample',created_at:1,status:'completed',output:[item],
   usage:{input_tokens:10,output_tokens:5,total_tokens:15}}
  res.writeHead(200,{'content-type':'text/event-stream'})
  const send=(type:string,data:object)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n')
  send('response.created',{response:{...response,status:'in_progress',output:[]}})
  send('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}})
  send('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:replyText})
  send('response.output_item.done',{output_index:0,item})
  send('response.completed',{response})
  res.end()
 })
 await new Promise<void>(ok=>upstream.listen(0,'127.0.0.1',ok))
 const baseUrl='http://127.0.0.1:'+(upstream.address() as {port:number}).port+'/v1'
 let host:Runtime|undefined
 try{
  host=await Runtime.create(configSchema.parse({
   stateDir:join(root,'state'),work:{sandboxDriver:process.platform==='darwin'?'seatbelt':'bubblewrap'},
   backends:{api:{kind:'openai-responses',model:'sample',baseUrl,outputFormat:'prompt',compaction:{discover:true}}},
   execution:{backend:'api',router:{mode:'host',backend:'api',model:'sample'},management:{enabled:true}},
   sources:[{id:'local',kind:'local',cwd:root,allowedActors:['owner']}],
  }))
  const runtime=host,conversation=runtime.chat.create('owner')
  const view=()=>runtime.chat.view(conversation.id,'owner')
  const send=async(text:string)=>{
   const {runId}=runtime.chat.send(conversation.id,'owner',{text,clientMessageId:randomUUID(),locale:'zh-CN'})
   const jobId='router:'+runId
   await vi.waitFor(async()=>{
    await runtime.tick()
    const job=runtime.store.db.prepare('select state from jobs where id=?').get(jobId)
    expect(['done','failed']).toContain(job?.state)
   },{timeout:14000,interval:50})
   return {jobId,runId}
  }
  const first=await send('说话呢')
  expect(view().messages.filter(m=>m.runId===first.runId&&m.role==='assistant')).toMatchObject([{text:reply,status:'complete'}])
  expect(runtime.store.get('router-error',first.jobId)).toBeUndefined()
  expect(runtime.chat.contextUsage(conversation.id,'owner')).toMatchObject({inputTokens:10,capacity:65536})
  expect(requests).toBe(1)
  replyText=JSON.stringify({reply:'收到。'})
  const second=await send('再确认一下')
  expect(view().messages.filter(m=>m.runId===second.runId&&m.role==='assistant')).toMatchObject([{text:'收到。',status:'complete'}])
  replyText='{"reply":"不完整'
  const malformed=await send('继续')
  expect(view().messages.filter(m=>m.runId===malformed.runId&&m.role==='assistant'&&m.status==='complete')).toEqual([])
  expect(runtime.store.get('router-error',malformed.jobId)).toMatchObject({error:expect.stringContaining('invalid_output')})
  expect(requests).toBe(3)
 }finally{
  await host?.close()
  upstream.closeAllConnections()
  await new Promise<void>(ok=>upstream.close(()=>ok()))
  rmSync(root,{recursive:true,force:true})
 }
},45000)

it.skipIf(!bundledCLI)('reads a Router tool definition through bundled OpenCode and executes it by its original name',async()=>{
 const root=mkdtempSync(join(tmpdir(),'harness-progressive-tools-'))
 let steps=0,total=0,fixtureError:unknown
 const upstream=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/v1/models'){
   res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({data:[{id:'sample',limit:{context:65536,output:4096}}]}))
   return
  }
  try{
   const chunks=[]
   for await(const chunk of req)chunks.push(chunk)
   const body=JSON.parse(Buffer.concat(chunks).toString()),id=++total
   const tool=body.tools?.find((item:any)=>item.name==='roppo_worker_manage')
   const call=(name:string,args:object)=>({type:'function_call',id:'fc_'+name,call_id:'call_'+name,name,arguments:JSON.stringify(args),status:'completed'})
   const reply='{"reply":"The Worker list was read."}'
   let output:any[]=[{type:'message',id:'msg_'+id,role:'assistant',status:'completed',content:[{type:'output_text',text:reply,annotations:[]}]}]
   if(tool){
    expect(tool.parameters?.properties).not.toHaveProperty('action')
    expect(tool.strict).toBe(false)
    expect(body.tools.some((item:any)=>item.name==='roppo_tool_describe')).toBe(true)
    if(++steps===1){
     expect(body.tools.some((item:any)=>item.name==='roppo_chat_opening')).toBe(true)
     output=[call('roppo_chat_opening',{text:'I will read the Worker list.'}),call('roppo_tool_describe',{name:'roppo_worker_manage'})]
    }
    else if(steps===2){
     const description=JSON.stringify(body.input)
     expect(description).toContain('Mutations require the latest revision and a stable requestId')
     expect(description).toContain('workspaceReviewed')
     output=[call('roppo_worker_manage',{action:'list'})]
    }
   }
   const response={id:'resp_'+id,object:'response',model:'sample',created_at:1,status:'completed',output,usage:{input_tokens:10,output_tokens:5,total_tokens:15}}
   res.writeHead(200,{'content-type':'text/event-stream'})
   const send=(type:string,data:object)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n')
   send('response.created',{response:{...response,status:'in_progress',output:[]}})
   for(const [output_index,item] of output.entries()){
    if(item.type==='function_call'){
     send('response.output_item.added',{output_index,item:{...item,arguments:'',status:'in_progress'}})
     send('response.function_call_arguments.delta',{output_index,item_id:item.id,delta:item.arguments})
     send('response.function_call_arguments.done',{output_index,item_id:item.id,arguments:item.arguments})
    }else{
     send('response.output_item.added',{output_index,item:{...item,status:'in_progress',content:[]}})
     send('response.output_text.delta',{output_index,item_id:item.id,content_index:0,delta:reply})
    }
    send('response.output_item.done',{output_index,item})
   }
   send('response.completed',{response});res.end()
  }catch(error){fixtureError=error;res.writeHead(400).end()}
 })
 await new Promise<void>(ok=>upstream.listen(0,'127.0.0.1',ok))
 const baseUrl='http://127.0.0.1:'+(upstream.address() as {port:number}).port+'/v1'
 let host:Runtime|undefined
 try{
  const runtime=host=await Runtime.create(configSchema.parse({
   stateDir:join(root,'state'),work:{sandboxDriver:process.platform==='darwin'?'seatbelt':'bubblewrap'},
   backends:{api:{kind:'openai-responses',model:'sample',baseUrl,outputFormat:'prompt',compaction:{discover:true}}},
   execution:{backend:'api',router:{mode:'host',backend:'api'},management:{enabled:true}},
   sources:[{id:'local',kind:'local',cwd:root,allowedActors:['owner']}],
  }))
  const chat=runtime.chat.create('owner'),{runId}=runtime.chat.send(chat.id,'owner',{text:'List the available Workers.',clientMessageId:randomUUID(),openingLocale:'en'})
  await vi.waitFor(async()=>{
   await runtime.tick()
   const job=runtime.store.db.prepare('select state from jobs where id=?').get('router:'+runId)
   expect(['done','failed']).toContain(job?.state)
  },{timeout:14000,interval:50})
  expect(fixtureError).toBeUndefined()
  expect(runtime.store.get('router-error','router:'+runId)).toBeUndefined()
  expect(steps).toBe(3)
  expect(runtime.activity.list().filter(call=>call.name==='worker_manage'&&call.state==='completed')).toHaveLength(1)
  expect(runtime.chat.view(chat.id,'owner').messages.some(message=>message.status==='complete'&&message.text==='The Worker list was read.')).toBe(true)
 }finally{
  await host?.close()
  upstream.closeAllConnections()
  await new Promise<void>(ok=>upstream.close(()=>ok()))
  rmSync(root,{recursive:true,force:true})
 }
},25000)

it('transports mixed MCP images and gives malformed images a non-fatal tool result',async()=>{
 const fatal=vi.fn(),invoke=vi.fn(async(name:string)=>{
  if(name==='read')return {success:true,contentItems:[
   {type:'inputImage' as const,imageUrl:'data:image/png;base64,'+png},
   {type:'inputText' as const,text:'fixture'},
  ]}
  if(name==='invalid')return {success:true,contentItems:[
   {type:'inputImage' as const,imageUrl:'data:image/png;base64,_'},{type:'inputText' as const,text:'independent evidence'},
  ]}
  return {success:true,contentItems:[{type:'inputText' as const,text:'still available'}]}
 })
 const bridge=await toolBridge(['read','invalid','text'].map(name=>({type:'function',name,description:name,inputSchema:{}})),invoke,fatal,true)
 const call=async(name:string,id:number)=>{
  const res=await fetch(bridge.url,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name}})})
  return (await res.json() as any).result
 }
 try{
  const image={content:[{type:'image',mimeType:'image/png',data:png},{type:'text',text:'fixture'}],isError:false}
  expect(await call('read',1)).toEqual(image)
  expect(await call('read',1)).toEqual(image)
  expect(await call('invalid',2)).toMatchObject({isError:true,content:[
   {type:'text',text:expect.stringContaining('tool_image_invalid')},{type:'text',text:'independent evidence'},
  ]})
  expect(await call('text',3)).toEqual({content:[{type:'text',text:'still available'}],isError:false})
  expect(invoke).toHaveBeenCalledTimes(3)
  expect(fatal).not.toHaveBeenCalled()
 }finally{await bridge.close()}
})

it('hands off at a verified inference boundary before admitting another network request',async()=>{
 const calls=vi.fn(),ready=vi.fn(()=>false)
 const server=createServer((_req,res)=>{calls();res.writeHead(200,{'content-type':'text/event-stream'}).end('data: [DONE]\n\n')})
 await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok))
 const backend=apiBackendDefinition.parse({kind:'openai-responses',baseUrl:'http://127.0.0.1:'+(server.address() as {port:number}).port,model:'test'})
 const gateway=await openHarnessProvider(backend,'test',{...request,workerCheckpointReady:ready},undefined,Date.now()-1)
 const limited=await openHarnessProvider({...backend,maxSteps:1},'test',{...request,workerCheckpointReady:ready},undefined,Date.now()-1)
 const step=async(url=gateway.url)=>{const r=await fetch(url+'/responses',{method:'POST',body:JSON.stringify({stream:true,model:'test',tools:[{type:'function'}]})});await r.text();return r.status}
 try{
  expect(await step()).toBe(200);expect(ready).not.toHaveBeenCalled()
  expect(await step()).toBe(200);expect(gateway.checkpointed()).toBe(false)
  ready.mockReturnValue(true);expect(await step()).toBe(409);expect(gateway.checkpointed()).toBe(true)
  expect(await step()).toBe(409);expect(calls).toHaveBeenCalledTimes(2)
  expect(await step(limited.url)).toBe(200);expect(await step(limited.url)).toBe(400);expect(limited.checkpointed()).toBe(false)
 }finally{await limited.close();await gateway.close();server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()))}
})

it.each([
 {code:'image_not_supported'},
 {code:'invalid_image',param:'input[0].output[1].image_url'},
])('keeps a Responses session running after $code',async error=>{
 const sent:any[]=[],issues=vi.fn()
 const upstream=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk)
  const input=JSON.parse(Buffer.concat(chunks).toString()).input
  sent.push(input)
  if(sent.length===1)res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error}))
  else res.writeHead(200,{'content-type':'text/event-stream'}).end('data: [DONE]\n\n')
 })
 await new Promise<void>(ok=>upstream.listen(0,'127.0.0.1',ok))
 const port=(upstream.address() as {port:number}).port
 const profile=apiBackendDefinition.parse({kind:'openai-responses',model:'sample',baseUrl:'http://127.0.0.1:'+port+'/v1'})
 const provider=await openHarnessProvider(profile,'sample',{...request,onBackendIssue:issues},async()=> 'fixture')
 const media={type:'input_image',image_url:'data:image/png;base64,'+png}
 const output={type:'function_call_output',call_id:'read-1',output:[{type:'input_text',text:'receipt'},media]}
 const other={...output,call_id:'read-2'},input=[output,other]
 const call=()=>fetch(provider.url+'/responses',{method:'POST',body:JSON.stringify({model:'sample',stream:true,input})})
 try{
  expect(await (await call()).text()).toContain('[DONE]')
  expect(await (await call()).text()).toContain('[DONE]')
  expect(sent[0]).toEqual(input)
  const text=[output.output[0],{type:'input_text',text:expect.stringContaining('tool_image_rejected')}]
  expect(sent[1]).toEqual([{...output,output:text},error.param?other:{...other,output:text}])
  expect(sent[2]).toEqual(sent[1])
  expect(issues).toHaveBeenCalledExactlyOnceWith({code:'unsupported',httpStatus:400,willRetry:true})
  expect(provider.failure()).toBeUndefined()
 }finally{
  await provider.close()
  upstream.closeAllConnections()
  await new Promise<void>(ok=>upstream.close(()=>ok()))
 }
})

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

it('limits native OpenCode tools on managed subagents to authorized web reads',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'opencode-child-')))
 const cwd=join(root,'work');mkdirSync(cwd)
 const config=configSchema.parse({stateDir:join(root,'state'),
  work:{network:true,sandboxDriver:process.platform==='darwin'?'seatbelt':'bubblewrap'},
  execution:{backend:'api'},backends:{api:{kind:'openai-responses',model:'sample',baseUrl:'http://127.0.0.1:1/v1'}},
  sources:[{id:'local',kind:'local',cwd,allowedActors:['owner']}]})
 const records=new Map<string,any>()
 const store={get:(kind:string,id:string)=>records.get(kind+id),put:(kind:string,id:string,value:any)=>{records.set(kind+id,value)}}
 const result={threadId:'fixture',turnId:'turn',text:'{}'}
 const cli=vi.spyOn(ProcessBackend.prototype,'run').mockResolvedValue(result)
 const api=vi.spyOn(ApiModel.prototype,'run').mockResolvedValue(result)
 const activation:ModelRequest={...request,cwd,role:'subagent',managed:true,allowNativeTools:true,
  tools:[{type:'function',name:'superagent_read',description:'Read',inputSchema:{}}],
  onTool:async()=>({success:true,contentItems:[]})}
 const guard=workspaceGuard(root,{...activation,opencodeNativeTools:{network:true}},'web')
 try{
  await new BackendRegistry(config,store).run(activation)
  expect(cli).toHaveBeenCalledOnce()
  expect(cli.mock.lastCall![0]).toMatchObject({allowNativeTools:true,role:'subagent'})
  expect(cli.mock.lastCall![0].harnessWorkspace).toBeUndefined()
  expect(nativeTools({...activation,opencodeNativeTools:{network:true}})).toEqual(['websearch','webfetch','webfetch_batch'])
  expect(nativeTools({...activation,opencodeNativeTools:{network:false}})).toEqual([])
  const plugin=await import(guard.url+'/index.mjs')
  const hooks=await plugin.default.server()
  await hooks['tool.execute.before']({tool:'websearch',callID:'search'},{args:{query:'public documentation'}})
  await expect(hooks['tool.execute.before']({tool:'bash',callID:'shell'},{args:{command:'pwd'}})).rejects.toThrow(/unavailable/)
  await expect(hooks['tool.execute.before']({tool:'write',callID:'write'},{args:{filePath:'draft.txt'}})).rejects.toThrow(/unavailable/)
  await new BackendRegistry(config,store).run({...activation,allowNativeTools:false})
  await new BackendRegistry(config,store).run({...activation,options:{tools:['superagent_read']}})
  await new BackendRegistry({...config,work:{...config.work,network:false}},store).run(activation)
  expect(cli).toHaveBeenCalledOnce()
  expect(api).toHaveBeenCalledTimes(3)
 }finally{
  cli.mockRestore();api.mockRestore()
  rmSync(fileURLToPath(guard.url),{recursive:true,force:true})
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

it.each([
 {statuses:[502,503,200],status:200},
 {statuses:[504,504,504],status:504},
 {statuses:[503],status:503,retryAfter:'60'},
 {statuses:[403],status:403},
])('keeps returned tool results in the same inference step for $statuses',async({statuses,status,retryAfter})=>{
 const bodies:string[]=[],issues=vi.fn()
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[]
  for await(const chunk of req)chunks.push(chunk)
  const next=statuses[bodies.length]??500
  bodies.push(Buffer.concat(chunks).toString())
  if(next===200)res.writeHead(200,{'content-type':'text/event-stream'}).end('data: [DONE]\n\n')
  else res.writeHead(next,retryAfter?{'retry-after':retryAfter}:{}).end()
 })
 await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok))
 const backend=apiBackendDefinition.parse({kind:'openai-responses',baseUrl:'http://127.0.0.1:'+(server.address() as {port:number}).port,model:'test',maxSteps:1})
 const gateway=await openHarnessProvider(backend,'test',{...request,onBackendIssue:issues})
 try{
  const item={type:'function_call_output',call_id:'finished-command',output:'job completed'}
  const response=await fetch(gateway.url+'/responses',{method:'POST',body:JSON.stringify({stream:true,model:'test',tools:[{type:'function'}],input:[item]})})
  expect(response.status).toBe(status);await response.text()
  expect(bodies).toHaveLength(statuses.length)
  expect(new Set(bodies).size).toBe(1)
  expect(JSON.parse(bodies[0]!).input).toEqual([item])
  expect(issues.mock.calls.map(([issue])=>issue)).toEqual(statuses.slice(0,-1).map(httpStatus=>({code:'transient',willRetry:true,httpStatus})))
  if(retryAfter)expect(response.headers.get('retry-after')).toBe(retryAfter)
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
 const activation:ModelRequest={...request,role:'router',managed:true,coordinationTurn:true,principal:{source:'local',actor:'owner'},tools:[{type:'function',name:'router_read',description:'Read',inputSchema:{}}],onTool:async()=>({success:true,contentItems:[]})}
 try{
  await expect(registry.run({...activation,principal:{source:'local',actor:'other'}})).rejects.toThrow(/owner/)
  await expect(registry.run(activation)).rejects.toThrow(/signed out/)
  login('original');await registry.run(activation)
  expect(spy.mock.lastCall![0].harnessWorkspace).toBeUndefined()
  expect(spy.mock.lastCall![0].allowNativeTools).toBeUndefined()
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
