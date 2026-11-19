/** Exercise the real pinned CLI with a deterministic, local OpenAI-compatible endpoint. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {constants,copyFileSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Runtime} from '../../src/runtime.ts'
import {configSchema} from '../../src/config.ts'
import {Store} from '../../src/store.ts'
import {BackendRegistry} from '../../src/backends/registry.ts'
import {bundledCLI,bundledEngineId} from '../../src/backends/bundled-opencode.ts'
import type {ModelRequest} from '../../src/model.ts'
import {BackendPluginError} from '../../src/backends/plugin-contract.ts'
import type {NativeToolBatch} from '../../src/backends/native-tool-batch.ts'

const root=realpathSync(mkdtempSync(join(tmpdir(),'roppo-harness-')))
const cwd=join(root,'task'),file=join(cwd,'endpoint.txt'),created=join(cwd,'native-result.txt')
mkdirSync(cwd);writeFileSync(file,'old-address\n')
let step=0,router=false,writes=0,runtimeTask=false,subscription=false,hostRouter=false,direct=false
const protocols=new Set<string>()
const events:string[]=[],errors:string[]=[]
const sequence=[['glob',{pattern:'*.txt'}],['grep',{pattern:'old-address'}],['read',{filePath:'endpoint.txt'}],['edit',{filePath:'endpoint.txt',oldString:'old-address',newString:'new-address'}],['write',{filePath:'native-result.txt',content:'native output\n'}],['bash',{command:'pwd',description:'Read the task directory'}],['roppo_superagent_shell',{command:'grep -Fx new-address endpoint.txt',requestId:'verify-endpoint'}]] as const
const nativeEvents=sequence.slice(0,-1).map(([name])=>'opencode/completed/'+name)
const webPaths=['/article-one','/article-two']
const webRequests=new Map<string,{start:number;end:number}>()
let checkParallelFetch=false,requestedFetch=false
let modelFailure:'auth_required'|'rate_limited'|'quota_exhausted'|undefined
let loop=false,batchesIssued=0,unavailableRequests=0
const report=JSON.stringify({state:'ready',summary:'Updated and verified endpoint',reply:'Verified the endpoint change.',question:null,askedBy:null,decision:null,handbacks:[]})
const server=createServer(async(req,res)=>{
 try{
  if(req.method==='GET'&&req.url&&webPaths.includes(req.url)){
   const path=req.url
   const timing={start:performance.now(),end:0};webRequests.set(path,timing)
   await new Promise(ok=>setTimeout(ok,650))
   timing.end=performance.now()
   res.writeHead(200,{'content-type':'text/html'}).end(
    '<html><body>'+('<p>Unrelated garden inventory and irrigation settings.</p>').repeat(2400)+
    '<h2 id="conditional-requests">Conditional cache requests</h2><p>Body of '+path+' describes<br>how the endpoint handles a conditional cache request.</p></body></html>',
   )
   return
  }
  if(req.method==='GET'&&req.url?.startsWith('/unavailable')){unavailableRequests++;res.writeHead(503).end();return}
  let raw='';for await(const chunk of req)raw+=chunk
  const input=JSON.parse(raw)
  if(input.model==='assessment'){
   const text=JSON.stringify({action:'accept',title:'Update endpoint',scope:'Edit and verify the file',reason:'Direct request',rules:[],ruleAssessments:[],targetTicketId:null})
   res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:text}}]}));return
  }
  assert.equal(input.model,'sample')
  const path=req.url!.split('?')[0]
  protocols.add(path!)
  const answer=JSON.stringify({answer:'done'})
  if(path==='/v1/messages'||path==='/v1/responses'){
   const anthropic=path.endsWith('/messages')
   if(anthropic){assert.equal(req.headers['x-api-key'],'fixture-api-key');assert.equal(input.max_tokens,1024)}
   else{assert.equal(req.headers.authorization,subscription?'Bearer fixture-plan-token':'Bearer fixture-api-key');assert.equal(input.max_output_tokens,1024);assert.equal(input.store,false)}
   if(input.tools?.length){for(const name of ['read','bash','websearch','webfetch','webfetch_batch','task','todowrite'])assert(input.tools.some((t:any)=>t.name===name),name)}
   if(modelFailure&&input.tools?.length){
    const status=modelFailure==='auth_required'?401:429
    res.writeHead(status,{'content-type':'application/json',...(modelFailure==='rate_limited'?{'retry-after':'7'}:{})})
    res.end(JSON.stringify({error:{code:modelFailure==='quota_exhausted'?'insufficient_quota':modelFailure}}))
    return
   }
   res.writeHead(200,{'content-type':'text/event-stream'})
   let n=0
   const event=(type:string,data:any)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data,...(anthropic?{}:{sequence_number:n++})})+'\n\n')
   if(anthropic){
    event('message_start',{message:{id:'msg_sample',type:'message',role:'assistant',model:'sample',content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0}}})
    event('content_block_start',{index:0,content_block:{type:'text',text:''}});event('content_block_delta',{index:0,delta:{type:'text_delta',text:answer}})
    event('content_block_stop',{index:0});event('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:5}});event('message_stop',{})
   }else if((loop||checkParallelFetch&&!requestedFetch)&&input.tools?.some((t:any)=>t.name==='webfetch_batch')){
    requestedFetch=true
    const ordinal=++batchesIssued
    const origin='http://127.0.0.1:'+(server.address() as {port:number}).port
    const output=[{type:'function_call',id:'fc_fetch_'+ordinal,call_id:'fetch_pages_'+ordinal,name:'webfetch_batch',status:'completed',
     arguments:JSON.stringify({urls:(loop?['/unavailable','/unavailable-alt']:[...webPaths,webPaths[0],'/unavailable']).map(path=>origin+path)})}]
    const response={id:'resp_fetch_'+ordinal,object:'response',model:'sample',created_at:1,status:'completed',output,usage:{input_tokens:10,output_tokens:5,total_tokens:15}}
    event('response.created',{response:{...response,status:'in_progress',output:[]}})
    for(const [output_index,item] of output.entries()){
     event('response.output_item.added',{output_index,item:{...item,arguments:'',status:'in_progress'}})
     event('response.function_call_arguments.delta',{output_index,item_id:item.id,delta:item.arguments})
     event('response.function_call_arguments.done',{output_index,item_id:item.id,arguments:item.arguments})
     event('response.output_item.done',{output_index,item})
    }
    event('response.completed',{response})
   }else{
    if(checkParallelFetch&&input.tools?.some((t:any)=>t.name==='webfetch_batch')){
     const results=input.input.filter((item:any)=>item.type==='function_call_output')
     assert.equal(results.length,1)
     for(const page of webPaths)assert(raw.includes('Body of '+page)&&raw.includes('Source: http://127.0.0.1:'))
     assert(Buffer.byteLength(JSON.stringify(results[0].output))<8400)
     assert(raw.includes('Fetch failed: HTTP 503'))
     assert(raw.includes('/article-one#conditional-requests'))
     assert(!raw.includes('Unrelated garden inventory'))
    }
    const item={type:'message',id:'msg_sample',role:'assistant',status:'completed',content:[{type:'output_text',text:answer,annotations:[]}]}
    const response={id:'resp_sample',object:'response',model:'sample',created_at:1,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}
    event('response.created',{response:{...response,status:'in_progress',output:[]}})
    event('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}})
    event('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:answer})
    event('response.output_item.done',{output_index:0,item});event('response.completed',{response})
   }
   res.end();return
  }
  assert.equal(path,'/v1/chat/completions')
  assert.equal(req.headers.authorization,'Bearer fixture-api-key')
  assert.equal(input.max_completion_tokens,1024)
  const names=(input.tools??[]).map((t:any)=>t.function.name)
  if(direct){
   assert(names.includes('superagent_shell'));assert(!names.includes('edit'))
   const commands=[{command:"grep -Fx old-address endpoint.txt && printf 'new-address\\n' > endpoint.txt",requestId:'edit-endpoint'},{command:'grep -Fx new-address endpoint.txt',requestId:'verify-endpoint'}]
   const command=commands[step++]
   const message=command?{role:'assistant',content:null,tool_calls:[{id:'call-'+step,type:'function',function:{name:'superagent_shell',arguments:JSON.stringify(command)}}]}:{role:'assistant',content:report}
   res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message}]}));return
  }
  const hasTools=names.length>0
  if(hasTools){
   for(const name of ['read','write','edit','bash','task','websearch','webfetch','todowrite'])assert(names.includes(name),name)
   const previous=input.messages.at(-1)
   if(previous?.role==='tool'){
    if((previous.tool_call_id==='call-1'||previous.tool_call_id==='call-2')&&!router)assert(JSON.stringify(previous.content).includes('endpoint.txt'))
    if(previous.tool_call_id==='call-6'&&!router)assert(JSON.stringify(previous.content).includes(cwd))
    if(hostRouter)assert(JSON.stringify(previous.content).includes('new-address'))
    assert(!/Tool unavailable|Outside the task|permission.*denied|file not found|Error:/i.test(JSON.stringify(previous.content)),JSON.stringify(previous.content))
   }
  }
  let next:readonly [string,Record<string,unknown>]|undefined
  if(hasTools&&hostRouter&&step++===0)next=['read',{filePath:'endpoint.txt'}]
  else if(hasTools&&!router)next=sequence[step++]
  if(next)assert(names.includes(next[0]),next[0]+' missing from '+names)
  const id='answer-'+step
  res.writeHead(200,{'content-type':'text/event-stream'})
  const send=(delta:unknown,finish_reason:string|null)=>res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model:input.model,choices:[{index:0,delta,finish_reason}]})+'\n\n')
  if(next)send({role:'assistant',tool_calls:[{index:0,id:'call-'+step,type:'function',function:{name:next[0],arguments:JSON.stringify(next[1])}}]},null)
  else send({role:'assistant',content:hostRouter?JSON.stringify({reply:'The file contains new-address.'}):runtimeTask?report:answer},null)
  send({},next?'tool_calls':'stop');res.end('data: [DONE]\n\n')
 }catch(error){errors.push(String(error));res.writeHead(400).end()}
})
await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok))
const url='http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1'
process.env.ROPPO_FIXTURE_HARNESS_KEY='fixture-api-key'
const config=configSchema.parse({stateDir:join(root,'state'),sources:[{id:'local',kind:'local',cwd,allowedActors:['alice']}],work:{sandboxDriver:process.platform==='darwin'?'seatbelt':'bubblewrap'},
 backends:{api:{kind:'openai-chat',model:'sample',baseUrl:url,apiKeyEnv:'ROPPO_FIXTURE_HARNESS_KEY',maxOutputTokens:1024}},
 execution:{backend:'api',router:{mode:'host',backend:'api'},workers:[{id:'one',backend:'api'}]}})
let store=new Store(join(config.stateDir,'state.sqlite'))
assert.deepEqual(config.backendPlugins,[]);assert.deepEqual(Object.keys(config.backends),['api'])
const request:ModelRequest={role:'worker',activity:{workerId:'one',ticketId:'sample'},backendId:'api',managed:true,allowNativeTools:true,sandbox:'workspace-write',cwd,
 instructions:'Use the task workspace and finish the requested change.',input:'Update the endpoint and verify it.',schema:{type:'object',properties:{answer:{type:'string'}},required:['answer']},
 tools:['router_read','superagent_read','superagent_shell'].map(name=>({type:'function',name,description:name,inputSchema:{type:'object',properties:{}}})),
 onTool:async(name)=>{assert.equal(name,'superagent_shell');assert.equal(readFileSync(file,'utf8'),'new-address\n');writes++;return {success:true,contentItems:[{type:'inputText',text:'verified'}]}},
 onProgress:e=>events.push(e),signal:AbortSignal.timeout(60000)}
try{
 let registry=new BackendRegistry(config,store)
 const quiet=await registry.run({...request,tools:[],onTool:undefined,input:'Respond with the requested JSON.'})
 assert.equal(store.get<{harness?:string}>('backend-binding',quiet.threadId)?.harness,bundledEngineId)
 await registry.purge(quiet.threadId,cwd)
 const result=await registry.run(request)
 assert.deepEqual(JSON.parse(result.text),{answer:'done'});assert.equal(writes,1)
 assert.deepEqual(events.filter(e=>e.startsWith('opencode/')),nativeEvents)
 assert.equal(readFileSync(created,'utf8'),'native output\n')
 const connection=config.backends.api!;assert(connection.kind==='openai-chat')
 connection.images=true // Changing the fresh-session preset must preserve this active session.
 store.close();store=new Store(join(config.stateDir,'state.sqlite'));registry=new BackendRegistry(config,store)
 const oldCommand=bundledCLI!.command,newCommand=join(root,'new-release','opencode')
 mkdirSync(join(root,'new-release'));copyFileSync(oldCommand,newCommand,constants.COPYFILE_FICLONE)
 bundledCLI!.command=newCommand
 try{
  assert.equal((await registry.run({...request,threadId:result.threadId,input:'Confirm the previous result.'})).threadId,result.threadId)
  assert.equal((await registry.history(result.threadId,cwd)).turns.length,2)
 }finally{bundledCLI!.command=oldCommand}
 connection.images=false
 assert.equal(writes,1);assert((await registry.history(result.threadId,cwd)).turns[0].items.some((i:any)=>i.name==='opencode/edit'))
 writes=0;step=0;writeFileSync(file,'old-address\n');rmSync(created,{force:true})
 const stop=new AbortController();let interrupted=''
 await assert.rejects(registry.run({...request,signal:stop.signal,onThread:id=>{interrupted=id},onProgress:e=>{if(e==='opencode/completed/edit')stop.abort()}}))
 assert(interrupted);assert.equal(readFileSync(file,'utf8'),'new-address\n')
 await assert.rejects(registry.run({...request,threadId:interrupted}),/outcome_unknown/)
 assert.equal(writes,0)
 await registry.purge(interrupted,cwd)
 router=true
 await registry.run({...request,role:'router',sandbox:'read-only',activity:{sourceId:'local'},input:'Inspect the result.'})
 await registry.purge(result.threadId,cwd)
 for(const kind of ['anthropic','openai-responses'] as const){
  const api=config.backends.api!;assert(api.kind==='openai-chat');config.backends[kind]={...api,kind}
  config.execution.router!.backend=kind
  checkParallelFetch=kind==='openai-responses'
  const batches:NativeToolBatch[]=[]
  const response=await registry.run({...request,role:'router',sandbox:'read-only',backendId:kind,activity:{sourceId:'local'},input:'Respond with the requested JSON.',webEvidenceQuery:'Find evidence about conditional cache requests.',onNativeToolBatch:batch=>batches.push(batch)})
  assert.deepEqual(JSON.parse(response.text),{answer:'done'})
  if(checkParallelFetch){
   const timings=[...webRequests.values()]
   assert.equal(timings.length,2)
   const overlap=Math.min(...timings.map(t=>t.end))-Math.max(...timings.map(t=>t.start))
   assert(overlap>0,'Native webfetch calls ran serially')
   assert.equal((await registry.history(response.threadId,cwd)).turns[0].items.filter((i:any)=>i.name==='opencode/webfetch_batch').length,1)
   assert.deepEqual(batches.map(batch=>batch.items.map(item=>[item.status,item.httpStatus])),[[['completed',undefined],['completed',undefined],['failed',503]]])
   assert(batches[0]!.items[0]!.endedAt-batches[0]!.items[0]!.startedAt>=600)
   console.log(JSON.stringify({tool:'opencode/webfetch_batch',calls:1,pages:timings.length,overlapMs:Math.round(overlap),verified:true}))
  }
 }
 checkParallelFetch=false
 const failureRequest={...request,backendId:'openai-responses',sandbox:'read-only' as const}
 for(const code of ['auth_required','rate_limited','quota_exhausted'] as const){
  modelFailure=code
  await assert.rejects(registry.run({...failureRequest,signal:AbortSignal.timeout(15_000)}),error=>{
   assert(error instanceof BackendPluginError)
   assert.equal(error.code,code)
   assert.equal(error.diagnostic?.effectFree,true)
   assert.equal(error.diagnostic?.httpStatus,code==='auth_required'?401:429)
   assert.equal(error.diagnostic?.retryAfterMs,code==='rate_limited'?7000:undefined)
   return true
  })
 }
 modelFailure=undefined
 loop=true
 const loopBatches:NativeToolBatch[]=[],before=unavailableRequests
 const issuedBefore=batchesIssued
 await assert.rejects(registry.run({...failureRequest,onNativeToolBatch:batch=>loopBatches.push(batch),signal:AbortSignal.timeout(15_000)}),
  error=>error instanceof BackendPluginError&&error.code==='read_loop'&&error.diagnostic?.effectFree===true)
 loop=false
 assert.deepEqual(loopBatches.map(batch=>batch.items.map(item=>item.status)),[['failed','failed'],['failed','failed'],['skipped','skipped'],['skipped','skipped']])
 assert.equal(unavailableRequests-before,4)
 console.log(JSON.stringify({scenario:'repeated HTTP 503',httpRequests:unavailableRequests-before,modelBatches:batchesIssued-issuedBefore,stopped:'read_loop'}))
 console.log(JSON.stringify({scenario:'provider errors',codes:['auth_required','rate_limited','quota_exhausted'],retryAfterMs:7000,verified:true}))
 const api=config.backends['openai-responses'];assert(api?.kind==='openai-responses')
 config.backends.plan={...api,baseUrl:'https://api.openai.com/v1',apiKeyEnv:undefined,subscription:{provider:'chatgpt',account:'sample',owner:{source:'local',actor:'alice'},backgroundAuthorized:true}}
 config.execution.router!.backend='plan'
 const accounts=join(config.stateDir,'subscription-accounts');mkdirSync(accounts,{recursive:true})
 writeFileSync(join(accounts,'sample.json'),JSON.stringify({subject:'fixture-account',access_token:'fixture-plan-token',expires_at:Date.now()+3600000}),{mode:0o600})
 const originalFetch=globalThis.fetch
 subscription=true
 globalThis.fetch=(target,options)=>originalFetch(String(target)==='https://api.openai.com/v1/responses'?url+'/responses':target,options)
 try{
  const response=await registry.run({...request,role:'router',backendId:'plan',sandbox:'read-only',principal:{source:'local',actor:'alice'}})
  assert.deepEqual(JSON.parse(response.text),{answer:'done'})
 }finally{globalThis.fetch=originalFetch;subscription=false}
 assert.deepEqual([...protocols].sort(),['/v1/chat/completions','/v1/messages','/v1/responses'])
 runtimeTask=true;router=false;step=0;writeFileSync(file,'old-address\n')
 const normalConfig=configSchema.parse({...config,stateDir:join(root,'runtime-state'),models:{router:'assessment'},execution:{backend:'api',roles:{router:'api'},workers:[{id:'one',backend:'api'}]},sources:[{id:'local',kind:'local',cwd,allowedActors:['alice'],sandbox:'workspace-write',workspace:{mode:'source'}}]})
 for(const engine of ['opencode','direct']){
  direct=engine==='direct';step=0;writeFileSync(file,'old-address\n');rmSync(created,{force:true})
  const trial=structuredClone(normalConfig)
  trial.stateDir=join(root,'runtime-'+engine)
  // The image-capable profile uses Roppo's multimodal API executor.
  if(direct){const api=trial.backends.api!;assert(api.kind==='openai-chat');api.images=true}
  const host=await Runtime.create(trial)
  const start=Date.now()
  try{
   host.receive('local','alice',{id:'update-endpoint',thread:'original-discussion',text:'Update the endpoint and verify it.',addressed:true})
   const deadline=Date.now()+90000
   while(Date.now()<deadline&&!host.store.deliveries().some(d=>d.kind==='reply'&&d.status==='sent')){await host.tick();await new Promise(ok=>setTimeout(ok,100))}
   const delivery=host.store.deliveries().find(d=>d.kind==='reply'&&d.status==='sent')
   assert(delivery,JSON.stringify(host.status().tickets).slice(-2000))
   assert.equal(readFileSync(file,'utf8'),'new-address\n')
   assert(JSON.stringify(delivery).includes('Verified the endpoint change.'));assert(JSON.stringify(delivery).includes('original-discussion'))
   const jobs=host.work.list().filter(job=>job.kind==='shell'&&job.command==='grep -Fx new-address endpoint.txt')
   assert.equal(jobs.length,1);assert.equal(jobs[0]!.state,'completed');assert.equal(jobs[0]!.exitCode,0)
   const calls=host.activity.list().filter(c=>c.kind==='tool'&&c.state==='completed').map(c=>c.name)
   for(const tool of direct?['superagent_shell']:['opencode/glob','opencode/grep','opencode/read','opencode/edit','opencode/write','opencode/bash','superagent_shell'])assert(calls.includes(tool),JSON.stringify(calls))
   console.log(JSON.stringify({engine,elapsedMs:Date.now()-start,tools:calls,verified:true}))
  }finally{await host.close()}
 }
 direct=false
 hostRouter=true;router=true;step=0
 const coordinator=await Runtime.create(configSchema.parse({...normalConfig,stateDir:join(root,'router-state'),execution:{...normalConfig.execution,router:{mode:'host',backend:'api',model:'sample'}}}))
 try{
  coordinator.receive('local','alice',{id:'inspect-endpoint',thread:'router-discussion',text:'Read endpoint.txt and tell me its contents.',addressed:true})
  const deadline=Date.now()+60000
  while(Date.now()<deadline&&!coordinator.store.deliveries().some(d=>d.status==='sent'&&JSON.stringify(d).includes('The file contains new-address.'))){await coordinator.tick();await new Promise(ok=>setTimeout(ok,100))}
  const reply=coordinator.store.deliveries().find(d=>d.status==='sent'&&JSON.stringify(d).includes('The file contains new-address.'))
  assert(reply,JSON.stringify(coordinator.store.deliveries()).slice(-1200));assert(JSON.stringify(reply).includes('router-discussion'))
  assert(coordinator.activity.list().some(c=>c.name==='opencode/read'&&c.state==='completed'))
 }finally{await coordinator.close()}
 assert.deepEqual(errors,[]);console.log('PASS: native file tools, automatic engine selection, read-only Router, restart, interruption after edit, purge, three protocols, synthetic subscription, Runtime-managed shell and delivery')
}catch(error){console.error({root,step,events,errors});throw error}
finally{store.close();server.closeAllConnections();server.close();delete process.env.ROPPO_FIXTURE_HARNESS_KEY}
rmSync(root,{recursive:true,force:true})
