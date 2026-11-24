import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {it,expect,vi} from 'vitest'
import {bundledCLI} from '../src/backends/bundled-opencode.ts'
import {configSchema} from '../src/config.ts'
import type {PluginToolEffect} from '../src/backends/plugin-process.ts'
import type {ModelRequest} from '../src/model.ts'
import {Runtime} from '../src/runtime.ts'

it.skipIf(!bundledCLI)('keeps status nudges on the live worker and hands a substantive follow-up to a fresh native turn once',async()=>{
 const root=mkdtempSync(join(tmpdir(),'chat-inflight-input-'))
 let allowResponse!:()=>void
 const responseGate=new Promise<void>(resolve=>{allowResponse=resolve})
 const initial='Check the application window',change='Use the second window instead'
 const prompts:string[]=[]
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[]
  for await(const chunk of req)chunks.push(chunk)
  const wire=Buffer.concat(chunks).toString(),input=JSON.parse(wire)
  const task=input.tools?.some((t:{function:{name:string}})=>t.function.name==='roppo_superagent_desktop')
  if(task){prompts.push(wire);if(prompts.length===1)await responseGate}
  res.writeHead(200,{'content-type':'text/event-stream'})
  const emit=(delta:unknown,reason:string|null)=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',
   created:1,model:'sample',choices:[{index:0,delta,finish_reason:reason}]})+'\n\n')
  const call=task&&prompts.length===1
  const result={state:'ready',summary:'Window checked',reply:'Window checked',question:null,askedBy:null,handbacks:[],files:[]}
  emit(call?{role:'assistant',tool_calls:[{index:0,id:'window',type:'function',function:{name:'roppo_superagent_desktop',
   arguments:JSON.stringify({action:'get_window_state',arguments:{pid:123,window_id:123,include_screenshot:false},requestId:'window'})}}]}:
   {role:'assistant',content:JSON.stringify(result)},null)
  emit({},call?'tool_calls':'stop');res.end('data: [DONE]\n\n')
 })
 await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok))
 const baseUrl='http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1'
 let host:Runtime|undefined
 try{
  const h=host=await Runtime.create(configSchema.parse({stateDir:join(root,'state'),turnTimeoutMs:30000,
   watchdog:{enabled:false},work:{network:false,sandboxDriver:process.platform==='darwin'?'seatbelt':'bubblewrap'},
   backends:{api:{kind:'openai-chat',model:'sample',baseUrl}},execution:{backend:'api',router:{mode:'host',backend:'api'},management:{enabled:true},
    workers:[{id:'builder',backend:'api'}]},sources:[{id:'local',kind:'local',cwd:root,workspace:{mode:'directory'},allowedActors:['owner']}]}))
  h.scopes.command({action:'scope.put',operationId:'scope',expectedRevision:0,scope:{id:'team',tenantId:'org',name:'Team',
   managers:[JSON.stringify(['local','owner'])],workerIds:['builder'],sourceIds:['local'],backendIds:['api']}})
  const chat=h.chat.create('owner'),send=(text:string,id=randomUUID())=>h.chat.send(chat.id,'owner',{text,clientMessageId:id,locale:'en'})
  const desktop=vi.spyOn(h.desktop,'call').mockImplementation(async()=>{throw Error('Obsolete desktop request reached its handler')})
  const rerouted:string[]=[],threads:string[]=[]
  const native=h.model.run.bind(h.model)
  vi.spyOn(h.model,'run').mockImplementation(async(r:ModelRequest)=>{
   if(r.role==='worker'){
    const result=await native({...r,onThread:id=>{threads.push(id);r.onThread?.(id)}})
    return result
   }
   const threadId=r.threadId??randomUUID(),turnId=randomUUID()
   r.onThread?.(threadId);r.onTurn?.(turnId)
   const input=JSON.parse(r.input),text=input.trigger?.text
   if(input.kind==='user_message'){
    rerouted.push(text)
    const command=text===initial?{action:'start',operationId:'initial-goal',expectedRevision:0,title:initial,objective:initial,authorizationQuote:initial,
     criteria:[{id:'window',description:'Confirm the window'}],nodes:[{id:'check',title:'Inspect the window',instruction:initial,workerId:'builder',criterionIds:['window']}]}:
     {action:'send',ticketId:h.store.tickets.list()[0]!.id,requestId:'follow-'+input.trigger.id,revision:h.settings.current().revision,text}
    const receipt=await r.onTool!(text===initial?'router_goal':'worker_manage',command,randomUUID())
    if(!receipt.success)throw Error(JSON.stringify(receipt.contentItems))
   }
   return {threadId,turnId,text:JSON.stringify({reply:'Received.'})}
  })
  const until=(check:()=>void)=>vi.waitFor(async()=>{await h.tick();check()},{timeout:25000,interval:30})
  send(initial)
  await until(()=>expect(prompts).toHaveLength(1))
  const original=h.store.tickets.list()[0]!,assignment=original.assignments.at(-1)!.id
  const revision=()=>h.scopes.ownership(original.id)!.dataRevision
  const before=revision()
  for(const nudge of ['继续','please continue','接着做']){
   const msg=send(nudge)
   await until(()=>expect(h.store.get('router-result','router:'+msg.runId)).toBeDefined())
   expect(h.chat.view(chat.id,'owner').run?.state).toBe('running')
  }
  expect(rerouted).toEqual([initial]);expect(revision()).toBe(before)
  const key=randomUUID(),sent=send(change,key)
  expect(send(change,key).runId).toBe(sent.runId)
  await until(()=>expect(revision()).toBe((before??1)+1))
  const extra=['Keep the title', 'Keep the original size']
  for(const [i,detail] of extra.entries()){
   send(detail)
   await until(()=>expect(revision()).toBe((before??1)+2+i))
  }
  allowResponse()
  await until(()=>{
   const ticket=h.store.tickets.get(original.id)!
   expect(ticket.assignments.at(-1)?.id).toBe(assignment)
   expect(ticket.inputs.some(i=>i.kind==='trigger'&&h.store.triggers.get(i.triggerId)?.text===change&&i.readAt)).toBe(true)
  })
  expect(prompts).toHaveLength(2);expect(prompts[1]).toContain(change)
  for(const detail of extra)expect(prompts[1]).toContain(detail)
  expect(new Set(threads).size).toBe(2)
  expect(h.store.db.prepare("SELECT count(*) AS n FROM audit WHERE json_extract(body,'$.type')='worker.provider_recovered' AND json_extract(body,'$.cause')='input_superseded'").get()?.n).toBe(1)
  expect(desktop).not.toHaveBeenCalled()
  const denied=h.store.list<PluginToolEffect>('backend-plugin-tool').filter(r=>r.admission?.stage==='not_dispatched')
  expect(denied).toHaveLength(1);expect(denied[0]).toMatchObject({state:'complete',result:{success:false}})
  expect(h.store.tickets.get(original.id)!.inputs.filter(i=>i.kind==='trigger'&&h.store.triggers.get(i.triggerId)?.text===change)).toHaveLength(1)
 }finally{allowResponse();await host?.close();server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));rmSync(root,{recursive:true,force:true})}
},65000)
