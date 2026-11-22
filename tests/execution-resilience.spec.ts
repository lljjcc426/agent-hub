import {randomUUID} from 'node:crypto'
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as wait} from 'node:timers/promises'
import {afterEach,expect,it,vi} from 'vitest'
import {BackendPluginError} from '../src/backends/plugin-contract.ts'
import {configSchema} from '../src/config.ts'
import type {Model,ModelRequest} from '../src/model.ts'
import {Runtime} from '../src/runtime.ts'
import {serve} from '../src/server.ts'
import {ToolDispatch} from '../src/tool-dispatch.ts'

const cleanups:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();vi.unstubAllGlobals()})
const objective='Carry out the requested work and verify the result.'
const repository='fixture/project'
const expectedHead='a'.repeat(40),mergeSha='b'.repeat(40)
const ready={state:'ready',summary:'Local file verified',reply:'Local file verified',question:null,askedBy:null,handbacks:[]}

function fixture(worker:(request:ModelRequest,attempt:number)=>Promise<void>){
 const root=mkdtempSync(join(tmpdir(),'roppo-resilience-'))
 const config=configSchema.parse({stateDir:join(root,'state'),port:0,acceptMode:'auto',work:{sandboxDriver:'disabled'},
  execution:{router:{mode:'host'},management:{enabled:true,maxWorkers:2},workers:[{id:'one',backend:'codex'}]},
  sources:[{id:'local',kind:'local',cwd:root,workspace:{mode:'source'},allowedActors:['alice']}]})
 let now=Date.now(),attempts=0,goalId:string
 const model:Model={async run(request){
  const input=JSON.parse(request.input),threadId=request.threadId??randomUUID(),turnId=randomUUID()
  let output:unknown={reply:''}
  if(input.kind==='goal_verification'){
   for(const evidence of input.evidence)await request.onTool!('goal_evidence',{id:evidence.id},'read-'+evidence.id)
   output={checks:input.criteria.map((criterion:{id:string})=>({
    criterionId:criterion.id,verdict:'passed',explanation:'Read the retained output file',
    evidenceIds:input.evidence.filter((e:{criterionIds:string[]})=>criterion.id==='__goal__'||e.criterionIds.includes(criterion.id)).map((e:{id:string})=>e.id),
   }))}
  }else if(request.role==='worker'){
   await worker(request,++attempts)
   writeFileSync(join(request.cwd,'result.json'),'{"total":42}')
   output=ready
  }else if(request.tools?.some(tool=>tool.name==='chat_opening')){
   await request.onTool!('chat_opening',{text:'I will check the task.'},'fixture-opening')
  }
  request.onThread?.(threadId);request.onTurn?.(turnId)
  return {threadId,turnId,text:JSON.stringify(output)}
 }}
 let host=new Runtime(config,{model,clock:()=>now})
 cleanups.push(async()=>{await host.close();rmSync(root,{recursive:true,force:true})})
 host.scopes.command({action:'scope.put',operationId:'entry-scope',expectedRevision:0,scope:{id:'team',tenantId:'org',name:'Team',
  managers:[JSON.stringify(['local','alice'])],workerIds:['one'],sourceIds:['local'],backendIds:['codex']}})
 const goal=()=>host.goals.get(goalId)!
 const ticketId=()=>goal().taskIds[0]!
 return {
  get host(){return host},goal,ticketId,attempts:()=>attempts,advance:(duration:number)=>{now+=duration},
  start(){
   const chat=host.chat.create('alice')
   host.chat.setApprovalMode('alice','full')
   const {runId}=host.chat.send(chat.id,'alice',{clientMessageId:randomUUID(),text:objective,openingLocale:'en'})
   const context=host.scopes.context(host.store.triggers.get(runId)!,'local:chat:'+chat.id)!
   goalId=host.goals.command({action:'start',operationId:'start',expectedRevision:0,title:'Verified delivery',objective,
    authorizationQuote:objective,maxReplans:0,criteria:[{id:'total',description:'The retained JSON total is 42',
     check:{kind:'json_equals',path:'result.json',pointer:'/total',expected:42}}],
    nodes:[{id:'build',title:'Build',instruction:'Produce result.json',workerId:'one',criterionIds:['total']}]},context).id
  },
  async until(predicate:()=>boolean){
   for(let i=0;i<1000;i++){await host.tick();if(predicate())return;await wait(5)}
   throw Error('Task did not settle: '+JSON.stringify(goal()))
  },
  async restart(){await host.close();host=new Runtime(config,{model,clock:()=>now})},
  async trace(){
   const http=await serve(host)
   try{
    const token=readFileSync(http.tokenPath,'utf8').trim()
    const response=await fetch(http.url+'/api/execution-trace?ticketId='+encodeURIComponent(ticketId()),{headers:{authorization:'Bearer '+token}})
    expect(response.status).toBe(200)
    return (await response.json()).tasks[0]
   }finally{
    http.server.closeAllConnections()
    await new Promise<void>(resolve=>http.server.close(()=>resolve()))
   }
  },
 }
}

function githubTransport(){
 const fetchLocal=fetch
 let comments=0,merges=0,confirm=false,lookups=0
 vi.stubGlobal('fetch',async(input:URL|string|Request,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url)
  if(url.hostname==='api.github.com'){
   if(url.pathname==='/user')return Response.json({login:'fixture-user'})
   if(url.pathname==='/repos/'+repository)return Response.json({full_name:repository,default_branch:'main'})
   if(url.pathname.endsWith('/pulls/1/merge')&&init?.method==='PUT'){
    merges++;return Response.json({merged:true,sha:mergeSha})
   }
   if(url.pathname.endsWith('/pulls/1')){
    lookups++;return confirm?Response.json({merged:true,head:{sha:expectedHead},merge_commit_sha:mergeSha}):new Response(null,{status:503})
   }
   return new Response(null,{status:404})
  }
  if(url.hostname==='api.githubcopilot.com'){
   const message=JSON.parse(String(init?.body))
   const result=(value:object)=>Response.json({jsonrpc:'2.0',id:message.id,result:value})
   if(message.id===undefined)return new Response(null,{status:202})
   if(message.method==='initialize')return result({protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}})
   if(message.method==='tools/list')return result({tools:[{name:'add_issue_comment',inputSchema:{type:'object',
    properties:{owner:{type:'string'},repo:{type:'string'},issue_number:{type:'integer'},body:{type:'string'}},
    required:['owner','repo','issue_number','body']}}]})
   if(message.method==='tools/call'){comments++;throw Error('Fixture connection ended after submission')}
  }
  if(url.hostname==='127.0.0.1')return fetchLocal(input,init)
  throw Error('Fixture received an unexpected outgoing request')
 })
 return {comments:()=>comments,merges:()=>merges,lookups:()=>lookups,confirm:()=>{confirm=true}}
}

it('holds a ready deliverable after an unconfirmed GitHub write, including after restart',async()=>{
 const remote=githubTransport(),f=fixture(async request=>{
  const receipt=await request.onTool!('github_write',{repository,action:'comment',number:1,body:'Fixture comment'},'write')
  expect(receipt).not.toHaveProperty('permission')
  expect(receipt).toMatchObject({success:false,contentItems:[{text:expect.stringContaining('"status":"uncertain"')}]})
 })
 await f.host.github.connect({token:'ghp_RESILIENCE_FIXTURE',repositories:[repository]},()=>{})
 f.start()
 await f.until(()=>f.goal().state==='held')
 const task=await f.trace()
 expect(task).toMatchObject({state:'uncertain',unknownEffects:true,blocker:{kind:'outcomeUnknown'}})
 expect(()=>f.host.retry(f.ticketId())).toThrow('awaiting confirmation')
 await f.restart();await f.until(()=>f.goal().state==='held')
 expect(f.host.store.list('goal-release')).toEqual([])
 expect(f.host.store.tickets.get(f.ticketId())?.ended).toBeUndefined()
 expect(remote.comments()).toBe(1)
})

it('confirms the same remote merge via readback and releases the retained deliverable',async()=>{
 const remote=githubTransport(),f=fixture(async request=>{
  const receipt=await request.onTool!('github_write',{repository,action:'merge_pull',number:1,expectedHead},'merge')
  expect(receipt).not.toHaveProperty('permission')
  expect(receipt).toMatchObject({success:false,contentItems:[{text:expect.stringContaining('"status":"uncertain"')}]})
 })
 await f.host.github.connect({token:'ghp_RESILIENCE_FIXTURE',repositories:[repository]},()=>{})
 f.start();await f.until(()=>f.goal().state==='held')
 expect(remote.lookups()).toBeGreaterThan(0)
 expect(f.host.store.list('goal-release')).toEqual([])
 await f.restart();remote.confirm()
 await f.until(()=>f.goal().state==='completed')
 expect(f.host.store.list('goal-release')).toHaveLength(1)
 expect(remote.merges()).toBe(1)
 expect(f.attempts()).toBe(1)
},12_000)

it('keeps a provider failure after a dispatched write behind the effects fence',async()=>{
 const remote=githubTransport(),f=fixture(async request=>{
  const receipt=await request.onTool!('github_write',{repository,action:'comment',number:1,body:'Fixture comment'},'write')
  expect(receipt).not.toHaveProperty('permission')
  expect(receipt).toMatchObject({success:false,contentItems:[{text:expect.stringContaining('"status":"uncertain"')}]})
  throw new BackendPluginError('rate_limited','codex',{operation:'run',reason:'provider_status',httpStatus:429,retryAfterMs:1,effectFree:true})
 })
 await f.host.github.connect({token:'ghp_RESILIENCE_FIXTURE',repositories:[repository]},()=>{})
 f.start();await f.until(()=>f.goal().state==='held')
 expect(await f.trace()).toMatchObject({unknownEffects:true,blocker:{kind:'outcomeUnknown'}})
 f.advance(60_000);await f.host.tick()
 expect(f.attempts()).toBe(1)
 expect(remote.comments()).toBe(1)
 expect(f.host.store.list('goal-release')).toEqual([])
})

it.each([['auth_required','authRequired'],['quota_exhausted','quotaExhausted']] as const)(
 'reports %s before any tool runs without treating it as an unknown write',async(code,kind)=>{
  const f=fixture(async()=>{throw new BackendPluginError(code,'codex')})
  f.start();await f.until(()=>f.goal().state==='held')
  expect(await f.trace()).toMatchObject({failure:{code,stage:'startup'},blocker:{kind},unknownEffects:false})
  expect(f.attempts()).toBe(1)
 }
)

it('honors a provider retry delay across host restart and resumes the original task',async()=>{
 const f=fixture(async(_request,attempt)=>{
  if(attempt===1)throw new BackendPluginError('rate_limited','codex',{operation:'run',reason:'provider_status',httpStatus:429,retryAfterMs:12_000,effectFree:true})
 })
 f.start();await f.until(()=>Boolean(f.goal().nodes?.[0]?.retryAt))
 const id=f.ticketId(),retryAt=f.goal().nodes![0]!.retryAt!
 expect(await f.trace()).toMatchObject({unknownEffects:false,failure:{code:'rate_limited',stage:'provider',retryAfterMs:12_000},
  blocker:{kind:'rateLimited',retryPolicy:{mode:'scheduled',notBefore:retryAt}}})
 await f.restart();f.advance(11_999);await f.host.tick()
 expect(f.attempts()).toBe(1)
 expect(f.goal().nodes![0]!.retryAt).toBe(retryAt)
 f.advance(1);await f.until(()=>f.goal().state==='completed')
 expect(f.ticketId()).toBe(id)
 expect(f.attempts()).toBe(2)
})

it('removes cancelled reads from the queue while an independent operation is still draining',async()=>{
 const controller=new AbortController(),dispatcher=new ToolDispatch(controller.signal)
 let notifyStarted!:()=>void,finish!:()=>void
 const started=new Promise<void>(resolve=>{notifyStarted=resolve})
 const drain=new Promise<void>(resolve=>{finish=resolve})
 const exclusive=dispatcher.run(false,()=>{notifyStarted();return drain})
 await started
 const read=vi.fn(),queued=dispatcher.run(true,read)
 controller.abort()
 await expect(queued).rejects.toMatchObject({name:'AbortError'})
 expect(read).not.toHaveBeenCalled()
 finish();await exclusive
})
