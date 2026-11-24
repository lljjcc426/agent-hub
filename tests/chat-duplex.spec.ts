import {afterEach,expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Runtime} from '../src/runtime.ts'
import {configSchema} from '../src/config.ts'
import {serve} from '../src/server.ts'
import {RouterHandoff} from '../src/router-handoff.ts'
import type {ModelRequest} from '../src/model.ts'

const roots:string[]=[],hosts:Runtime[]=[]
afterEach(async()=>{for(const h of hosts.splice(0))await h.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})})
const gate=()=>{let release!:()=>void;const wait=new Promise<void>(r=>{release=r});return {wait,release}}
async function settle(h:Runtime,done:()=>boolean){for(let i=0;i<500;i++){await h.tick();await new Promise(r=>setTimeout(r,2));if(done())return}throw Error('Chat did not settle')}
function fixture(run:(r:ModelRequest)=>Promise<unknown>,scoped=false){
 const root=mkdtempSync(join(tmpdir(),'chat-duplex-'));roots.push(root)
 const config=configSchema.parse({stateDir:join(root,'state'),port:0,work:{sandboxDriver:'disabled'},execution:{router:{mode:'host'},management:{enabled:true},workers:[{id:'research',backend:'codex'}]},sources:[{id:'local',kind:'local',cwd:root,allowedActors:['operator']}]})
 const calls:ModelRequest[]=[],model={async run(r:ModelRequest){calls.push(r);const threadId=r.threadId??randomUUID(),turnId=randomUUID();r.onThread?.(threadId);r.onTurn?.(turnId);return {threadId,turnId,text:JSON.stringify(await run(r))}}}
 const h=new Runtime(config,{model});hosts.push(h)
 if(scoped)h.scopes.command({action:'scope.put',operationId:'external',expectedRevision:0,scope:{id:'external',tenantId:'external',name:'External',managers:[JSON.stringify(['local','operator'])],workerIds:['research'],backendIds:['codex'],sourceIds:['local']}})
 const c=h.chat.create('local-operator')
 const send=(text:string,clientMessageId=randomUUID())=>h.chat.send(c.id,'local-operator',{text,clientMessageId})
 const view=()=>h.chat.view(c.id,'local-operator')
 return {h,c,send,view,model,config,calls,root}
}

it.each([false,true])('accepts continuous input and serializes the Router without leaking future queued instructions (scoped=%s)',async scoped=>{
 const first=gate();let active=0,maximum=0
 const f=fixture(async r=>{active++;maximum=Math.max(maximum,active);const text=JSON.parse(r.input).trigger.text;if(text==='First request')await first.wait;active--;return {reply:'Reply to '+text}},scoped)
 f.send('First request');f.send('Second request')
 try{
  await settle(f.h,()=>f.calls.length===1)
  expect(f.calls[0]!.input).not.toContain('Second request')
  const activeReply=f.view().reply!
  expect(activeReply.state).toBe('running')
  f.send('Third request')
  for(let i=0;i<5;i++)await f.h.tick()
  expect(f.calls).toHaveLength(1);expect(f.view().messages.filter(m=>m.role==='user')).toHaveLength(3)
  expect(f.view().reply?.id).toBe(activeReply.id)
 }finally{first.release()}
 await settle(f.h,()=>!f.view().reply)
 expect(maximum).toBe(1)
 expect(f.calls[1]!.input).not.toContain('Third request')
 expect(f.calls.slice(1).map(r=>r.threadId)).toEqual([f.calls[1]!.threadId,f.calls[1]!.threadId])
 expect(f.calls[1]!.threadId).toBeTruthy()
 expect(f.view().messages.filter(m=>m.role==='assistant').map(m=>m.text)).toEqual(['Reply to First request','Reply to Second request','Reply to Third request'])
})

it('keeps its Worker running during further conversation and reports completion without another user prompt',async()=>{
 const first=gate(),work=gate(),later=gate();let worker:ModelRequest|undefined,laterStarted=false,active=0,maximum=0
 const f=fixture(async r=>{
  if(r.role==='worker'){worker=r;await work.wait;return {state:'ready',summary:'Verified',reply:'Background result',question:null,askedBy:null,handbacks:[]}}
  active++;maximum=Math.max(maximum,active)
  try{
   const input=JSON.parse(r.input)
   if(input.kind==='worker_result')return {reply:'The background task is complete.'}
   if(input.trigger.text==='Keep talking'){laterStarted=true;await later.wait;return {reply:'We can keep talking.'}}
   const result=await r.onTool!('worker_manage',{action:'assign',revision:0,requestId:'background',id:'research',text:'Check the repository'},'assign')
   expect(result.success).toBe(true)
   r.onOutput?.({id:'answer',type:'delta',phase:'answer',text:'{"reply":"Started'});
   await first.wait
   return {reply:'Started the background task.'}
  }finally{active--}
 },true)
 f.h.chat.send(f.c.id,'local-operator',{text:'Please fix the bug',clientMessageId:randomUUID(),locale:'en-GB',timeZone:'Asia/Kathmandu'})
 try{
  await settle(f.h,()=>!!worker&&f.view().messages.some(m=>m.status==='streaming'))
  expect(JSON.parse(worker!.input).runtimeContext).toMatchObject({role:'worker',channel:'chat',timeZone:'Asia/Kathmandu',timeZoneSource:'browser',locale:'en-GB'})
  f.send('Keep talking')
  expect(worker!.signal!.aborted).toBe(false)
  expect(f.h.store.list('router-cancelled')).toEqual([])
  first.release()
  await settle(f.h,()=>laterStarted)
  expect(f.view().workers[0]!.tasks[0]!.state).toBe('running')
  work.release()
  await settle(f.h,()=>f.h.store.tickets.list().some(t=>!!t.ended))
  expect(f.view().messages.some(m=>m.text==='The background task is complete.')).toBe(false)
 }finally{first.release();work.release();later.release()}
 await settle(f.h,()=>f.view().messages.some(m=>m.text==='The background task is complete.'))
 expect(maximum).toBe(1)
 expect(f.calls.filter(r=>r.role==='worker')).toHaveLength(1)
 expect(f.view().workers[0]!.tasks[0]!.state).toBe('completed')
 expect(f.view().messages.filter(m=>m.role==='user')).toHaveLength(2)
 expect(f.h.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='failed'").get()!.n).toBe(0)
})

it('ends a stalled Router reply after a confirmed assignment and answers the next message while the Worker runs',async()=>{
 const work=gate(),router=gate()
 let assigned=false,worker:ModelRequest|undefined
 const f=fixture(async request=>{
  if(request.role==='worker'){
   worker=request
   await work.wait
   return {state:'ready',summary:'Verified',reply:'Investigation complete',question:null,askedBy:null,handbacks:[]}
  }
  const input=JSON.parse(request.input)
  if(input.kind==='worker_result')return {reply:'排查完成。'}
  const call=(name:string,args:unknown)=>request.onTool!(name,args,randomUUID())
  if(input.trigger.text==='你有在看吗'){
   const receipt=await call('worker_manage',{action:'list'})
   expect(JSON.parse(receipt.contentItems[0]!.text!).workers[0].status).toBe('running')
   return {reply:'在，Worker 正在查。'}
  }
  const receipt=await call('worker_manage',{action:'assign',revision:0,requestId:'long-research',id:'research',text:'Investigate the issue'})
  expect(JSON.parse(receipt.contentItems[0]!.text!)).toMatchObject({ticketId:expect.any(String),status:'queued'})
  assigned=true
  const signal=request.signal!
  const stopped=new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))
  await Promise.race([stopped,router.wait])
  signal.throwIfAborted()
  return {reply:'Late reply'}
 },true)
 const first=f.send('查一下这个问题')
 try{
  await settle(f.h,()=>assigned&&!!worker)
  f.send('你有在看吗')
  await settle(f.h,()=>f.view().messages.some(message=>message.text==='在，Worker 正在查。'))
  expect(f.view().messages.filter(message=>!message.recipient).map(message=>message.text)).toEqual([
   '查一下这个问题','你有在看吗','已交给 research 处理。','在，Worker 正在查。',
  ])
  expect(f.h.store.get('router-result','router:'+first.runId)).toMatchObject({reply:'已交给 research 处理。'})
  expect(f.calls[0]!.signal!.aborted).toBe(true)
  const followup=f.calls.find(request=>request.role==='router'&&JSON.parse(request.input).trigger?.text==='你有在看吗')!
  expect(followup.threadId).toBeUndefined()
  expect(JSON.parse(followup.input).continuity.history.map((event:{text:string})=>event.text)).toContain('已交给 research 处理。')
  expect(worker!.signal!.aborted).toBe(false)
  expect(f.view().workers[0]!.tasks.map(task=>task.state)).toEqual(['running'])
 }finally{router.release();work.release()}
 await settle(f.h,()=>f.view().messages.some(message=>message.text==='排查完成。'))
 expect(f.calls.filter(request=>request.role==='worker')).toHaveLength(1)
})

it('delivers progress questions to the Router while a dispatched plan runs',async()=>{
 const work=gate(),stalled=gate()
 const requestText='Continuously investigate the build failure'
 let worker:ModelRequest|undefined
 const f=fixture(async r=>{
  if(r.role==='worker'){
   worker=r
   await work.wait
   return {state:'waiting',summary:'Build investigated',reply:'',question:null,askedBy:null,handbacks:[]}
  }
  const input=JSON.parse(r.input)
  if(input.trigger.text==='Any progress?'){
   expect(input.tasks).toEqual([expect.objectContaining({workerId:'research'})])
   return {reply:'The model checked the investigation.'}
  }
  if(input.trigger.text!==requestText)return {reply:'I can answer while the investigation runs.'}
  const result=await r.onTool!('router_goal',{action:'start',operationId:'build-plan',expectedRevision:0,
   title:'Build investigation',objective:'Find the cause of the build failure',authorizationQuote:requestText,
   criteria:[{id:'cause',description:'Explain the cause of the failure'}],
   nodes:[{id:'investigate',title:'Investigate',instruction:'Inspect the failed build',workerId:'research',criterionIds:['cause']}]},'plan')
  expect(JSON.parse(result.contentItems[0]!.text!)).toMatchObject({state:'active'})
  await Promise.race([stalled.wait,new Promise<void>(resolve=>r.signal!.addEventListener('abort',()=>resolve(),{once:true}))])
  r.signal!.throwIfAborted()
  return {reply:'A late reply'}
 },true)
 const first=f.send(requestText)
 try{
  await settle(f.h,()=>!!worker)
  const status=f.h.chat.send(f.c.id,'local-operator',{text:'Any progress?',clientMessageId:randomUUID(),locale:'zh-CN'})
  expect(f.h.store.get('router-dispatch','router:'+first.runId)).toMatchObject({items:[{kind:'plan',label:'Build investigation'}]})
  f.send('Are you still there?')
  await settle(f.h,()=>f.view().messages.some(m=>m.text==='I can answer while the investigation runs.'))
  expect(f.view().messages.find(m=>m.runId===status.runId&&m.role==='assistant')?.text).toBe('The model checked the investigation.')
  expect(f.view().messages.some(m=>m.text==='I queued “Build investigation” for execution.')).toBe(true)
  expect(worker!.signal!.aborted).toBe(false)
  expect(f.view().workers[0]!.tasks.map(t=>t.state)).toEqual(['running'])
 }finally{stalled.release();work.release()}
 expect(f.h.store.tickets.list()).toHaveLength(1)
 expect(f.calls.filter(r=>r.role==='worker')).toHaveLength(1)
})

it('rejects direct execution and confirms an accepted assignment after the Router provider fails',async()=>{
 let started=0
 const work=gate()
 const forbidden=['github_read','github_write','github_git','workspace_browser','chat_deliver_file','chat_artifact_deliver','code_mode','superagent_shell']
 const f=fixture(async r=>{
  if(r.role==='worker'){
   started++
   await work.wait
   return {state:'ready',summary:'Verified',reply:'Done',question:null,askedBy:null,handbacks:[]}
  }
  if(JSON.parse(r.input).kind==='worker_result')return {reply:'Verified.'}
  expect(r.tools?.filter(t=>forbidden.includes(t.name))).toEqual([])
  expect(r.allowNativeTools).toBe(false)
  expect(r.options?.toolConnections).toEqual([])
  for(const name of forbidden){
   const denied=await r.onTool!(name,{},'direct-'+name)
   expect(denied.success).toBe(false)
   expect(JSON.parse(denied.contentItems[0]!.text!).code).toBe('worker_required')
  }
  const receipt=await r.onTool!('worker_manage',{action:'assign',id:'research',revision:0,requestId:'assignment',text:'Inspect the build log'},'assign')
  expect(receipt.success).toBe(true)
  throw Error('Provider closed after receiving the assignment')
 },true)
 const first=f.send('Inspect the build log')
 try{
  await settle(f.h,()=>started===1&&f.view().messages.some(m=>m.text==='I assigned this to research.'))
  expect(f.h.store.get('router-dispatch','router:'+first.runId)).toMatchObject({items:[{kind:'assign',label:'research'}]})
  expect(f.h.store.tickets.list()).toHaveLength(1)
 }finally{work.release()}
 await settle(f.h,()=>f.view().messages.some(m=>m.text==='Verified.'))
 expect(started).toBe(1)
})

it('finishes the active tool receipt before retiring the Router writer',async()=>{
 vi.useFakeTimers()
 const parent=new AbortController(),handoff=new RouterHandoff(parent.signal,false),effect=gate()
 const receipt={success:true,contentItems:[]}
 const admitted=handoff.tool(async()=>{await effect.wait;return receipt})
 handoff.record('Research',false)
 try{
  await vi.advanceTimersByTimeAsync(6000)
  expect(handoff.signal.aborted).toBe(false)
  const next=vi.fn(async()=>receipt)
  expect((await handoff.tool(next)).success).toBe(false)
  expect(next).not.toHaveBeenCalled()
  effect.release()
  expect(await admitted).toEqual(receipt)
  await vi.runAllTimersAsync()
  expect(handoff.yielded).toBe(true)
  expect(parent.signal.aborted).toBe(false)
  expect(handoff.reply()).toBe('Your follow-up was received.')
 }finally{effect.release();handoff.dispose();vi.useRealTimers()}
})

it('accepts consecutive HTTP messages while preserving authentication and conversation ownership',async()=>{
 const f=fixture(async r=>({reply:'Reply to '+JSON.parse(r.input).trigger.text})),server=await serve(f.h)
 try{
  const headers={authorization:'Bearer '+readFileSync(join(f.root,'state/access-token'),'utf8').trim(),'content-type':'application/json'}
  const path=server.url+'/api/chat/conversations/'+f.c.id+'/messages'
  const body=JSON.stringify({text:'First request',clientMessageId:randomUUID(),timeZone:'America/New_York'})
  expect((await fetch(path,{method:'POST',body})).status).toBe(401)
  expect((await fetch(path,{method:'POST',headers:{...headers,origin:'https://other.example'},body})).status).toBe(403)
  const other=f.h.chat.create('another-owner')
  expect((await fetch(server.url+'/api/chat/conversations/'+other.id+'/messages',{method:'POST',headers,body})).status).toBe(404)
  expect((await fetch(path,{method:'POST',headers,body})).status).toBe(202)
  const second=await fetch(path,{method:'POST',headers,body:JSON.stringify({text:'Second request',clientMessageId:randomUUID(),timeZone:'Mars/Olympus'})})
  expect(second.status).toBe(202)
  const {runId}=await second.json() as {runId:string}
  expect(f.h.chat.clientContext(runId)?.clientTimeZone).toBeUndefined()
  expect(f.view().messages.filter(m=>m.role==='user')).toHaveLength(2)
 }finally{await server.closeRuntime();hosts.splice(hosts.indexOf(f.h),1);server.server.closeAllConnections();await new Promise<void>(resolve=>server.server.close(()=>resolve()))}
})

it('recovers queued messages after restart without duplicate admission or overlapping Router turns',async()=>{
 const f=fixture(async r=>({reply:'Reply to '+JSON.parse(r.input).trigger.text})),messageId=randomUUID()
 const sent=f.h.chat.send(f.c.id,'local-operator',{text:'First request',clientMessageId:messageId,timeZone:'Pacific/Auckland',locale:'en-GB'});f.send('Second request')
 await f.h.close();hosts.splice(hosts.indexOf(f.h),1)
 let now=Date.parse('2026-01-01T10:59:59Z')
 const h=new Runtime(f.config,{model:f.model,clock:()=>{const at=now;now+=2000;return at}});hosts.push(h)
 expect(h.chat.send(f.c.id,'local-operator',{text:'First request',clientMessageId:messageId})).toEqual({runId:sent.runId,duplicate:true})
 await settle(h,()=>!h.chat.view(f.c.id,'local-operator').reply)
 expect(f.calls).toHaveLength(2)
 const first=JSON.parse(f.calls[0]!.input).runtimeContext,second=JSON.parse(f.calls[1]!.input).runtimeContext
 expect(first).toMatchObject({role:'router',localTime:expect.stringContaining('+13:00'),timeZone:'Pacific/Auckland',timeZoneSource:'browser',channel:'chat',locale:'en-GB',eventAt:h.store.triggers.get(sent.runId)!.at})
 expect(second).toMatchObject({timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,timeZoneSource:'host'})
 expect(Date.parse(second.localTime)).toBeGreaterThan(Date.parse(first.localTime))
 expect(h.chat.view(f.c.id,'local-operator').messages.map(m=>m.text)).toEqual(['First request','Second request','Reply to First request','Reply to Second request'])
})

it('reads retained Router results within the same conversation, including a later turn, and rejects other readers',async()=>{
 let resource='',original=''
 const f=fixture(async r=>{
  if(!resource){
   const result=await r.onTool!('worker_manage',{action:'list'},'catalog')
   original=JSON.stringify(result);resource='model-tool-receipt/'+await r.retainToolResult!('catalog',result)
  }
  const page=await r.onTool!('router_read',{resource,limit:8000},'read')
  expect(page.success).toBe(true);expect(JSON.parse(page.contentItems[0]!.text!).text).toBe(original)
  return {reply:'Read the catalog'}
 },true)
 const first=f.send('List the team');await settle(f.h,()=>!f.view().reply)
 const second=f.send('Read the earlier result');await settle(f.h,()=>!f.view().reply)
 const other=f.h.chat.create('different-owner'),foreign=f.h.chat.send(other.id,'different-owner',{text:'Read something',clientMessageId:randomUUID()})
 await expect(f.h.resources.read({resource},{routerTriggerId:foreign.runId})).rejects.toThrow()
 await expect(f.h.resources.read({resource:'settings'},{routerTriggerId:second.runId})).rejects.toThrow('uploaded file')
 f.h.store.put('model-tool-receipt','worker-only',{triggerId:first.runId,ticketId:'task',result:{success:true,contentItems:[]}})
 await expect(f.h.resources.read({resource:'model-tool-receipt/worker-only'},{routerTriggerId:first.runId})).rejects.toThrow('outside')
 await f.h.chat.cancel(f.c.id,'local-operator',first.runId)
 await expect(f.h.resources.read({resource},{routerTriggerId:second.runId})).rejects.toThrow()
})

it('projects background tasks using their current discussion instead of their original assignment',async()=>{
 const f=fixture(async()=>({reply:'OK'})),initial=f.send('Start work'),trigger=f.h.store.triggers.get(initial.runId)!,discussion='local:chat:'+f.c.id
 const task=await f.h.manager.call({action:'assign',id:'research',revision:0,requestId:'move',text:'Move this task'}, {trigger,discussion})
 expect(f.view().workers[0]!.tasks).toHaveLength(1)
 const other=f.h.chat.create('other-owner'),next=f.h.chat.send(other.id,'other-owner',{clientMessageId:randomUUID(),text:'Continue work'})
 f.h.store.put('task-routing',task.ticketId,{discussion:'local:chat:'+other.id,parentTrigger:next.runId})
 expect(f.view().workers[0]!.tasks).toEqual([])
 expect(f.h.chat.view(other.id,'other-owner').workers[0]!.tasks).toMatchObject([{id:task.ticketId}])
})

it('uses the Chat zone for a new daily schedule and replays the same occurrence settings after edits',()=>{
 const f=fixture(async()=>({reply:''}),true)
 const sent=f.h.chat.send(f.c.id,'local-operator',{text:'Remind me every morning at nine.',clientMessageId:randomUUID(),locale:'en-GB',timeZone:'Pacific/Auckland'})
 const trigger=f.h.store.triggers.get(sent.runId)!,context=f.h.scopes.context(trigger,f.h.routerIngress.get(trigger.id)!.discussion)!
 const command={action:'schedule.put',operationId:'morning',expectedRevision:0,scopeId:context.route.scopeId,
   schedule:{id:'morning',name:'Daily reminder',triggerId:trigger.id,prompt:'Good morning',mode:'standalone',timing:{kind:'daily',time:'09:00',startAt:'2099-01-01T00:00:00Z'}}}
 const create=(input:unknown)=>f.h.proactive.command(input,context)
 const saved=create(command)
 expect(saved).toMatchObject({timing:{timezone:'Pacific/Auckland'}})
 const change={...command,schedule:{...command.schedule,timing:{...command.schedule.timing,timezone:'Asia/Shanghai'}}}
 expect(()=>create(change)).toThrow('operationId reused')
 expect(create({...change,operationId:'change-zone',expectedRevision:1})).toMatchObject({timing:{timezone:'Asia/Shanghai'}})
 expect(create(command)).toEqual(saved)
})
