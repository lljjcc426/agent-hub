import {randomUUID} from 'node:crypto'
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it,vi} from 'vitest'
import {configSchema} from '../src/config.ts'
import type {Model,ModelRequest} from '../src/model.ts'
import type {RouterGoal} from '../src/router-goals.ts'
import {Runtime} from '../src/runtime.ts'
import {serve} from '../src/server.ts'
import {bodyDigest,stableDigest} from '../src/sources.ts'

const owner='local-operator'
const roots:string[]=[],hosts=new Set<Runtime>(),servers:Awaited<ReturnType<typeof serve>>[]=[]
afterEach(async()=>{
 for(const server of servers.splice(0)) {
  server.server.closeAllConnections()
  await new Promise<void>(resolve=>server.server.close(()=>resolve()))
 }
 for(const host of hosts)await host.close()
 hosts.clear()
 for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})
})

function fixture(run?:(request:ModelRequest)=>Promise<unknown>){
 const root=mkdtempSync(join(tmpdir(),'chat-delegated-goal-'));roots.push(root)
 const config=configSchema.parse({stateDir:join(root,'state'),port:0,watchdog:{enabled:false},work:{network:false,sandboxDriver:'disabled',autoRecover:false},
  execution:{router:{mode:'host'},management:{enabled:true},workers:[{id:'research',backend:'codex'},{id:'review',backend:'codex'}]},
  sources:[{id:'local',kind:'local',cwd:root,allowedActors:['operator']}]})
 const model:Model={async run(r){
  const threadId=r.threadId??randomUUID(),turnId=randomUUID()
  r.onThread?.(threadId);r.onTurn?.(turnId)
  return {threadId,turnId,text:JSON.stringify(run?await run(r):{reply:''})}
 }}
 const host=new Runtime(config,{model});hosts.add(host)
 host.scopes.command({action:'scope.put',operationId:'enable-scopes',expectedRevision:0,
  scope:{id:'local-team',tenantId:'local',name:'Team',managers:[JSON.stringify(['local','operator'])],
   workerIds:['research','review'],sourceIds:['local'],backendIds:['codex']}})
 const chat=host.chat.create(owner)
 function send(text:string,conversationId=chat.id,account=owner){
  const {runId}=host.chat.send(conversationId,account,{clientMessageId:randomUUID(),text,locale:'zh-CN',openingLocale:'zh-CN'})
  const trigger=host.store.triggers.get(runId)!,discussion='local:chat:'+conversationId
  return {discussion,trigger,scoped:host.scopes.context(trigger,discussion)!}
 }
 return {host,config,model,chat,send}
}
type Fixture=ReturnType<typeof fixture>

async function assignment(f:Fixture,ctx:ReturnType<Fixture['send']>,requestId:string,id='research'){
 const receipt=await f.host.manager.call({action:'assign',id,revision:0,requestId,text:'Read the local acceptance evidence'},ctx)
 return receipt.ticketId as string
}

async function delegatedGoal(f:Fixture,nodes=[{id:'review',title:'Verify local evidence',instruction:'Verify local evidence',workerId:'review',criterionIds:['evidence']}]) {
 const {host,send}=f,initial=send('Prepare for local acceptance'),originalTask=await assignment(f,initial,'intake')
 const answer=send('Verify the desktop with the local evidence')
 const requestId='intake-answer'
 await host.manager.call({action:'send',revision:0,ticketId:originalTask,requestId,text:answer.trigger.text},answer)
 // Reproduce the saved internal turn from the incident using the real Worker send receipt and admission.
 const trigger=host.store.triggers.get('router-followup:'+bodyDigest([answer.discussion,requestId]))!
 const admission=host.routerIngress.admit(trigger,false)
 expect(admission.state).toBe('accepted')
 expect(admission.discussion).not.toBe(answer.discussion)
 const scoped=host.scopes.context(trigger,admission.discussion)!
 const goal=host.goals.command({action:'start',operationId:'desktop-acceptance',expectedRevision:0,
  title:'Desktop acceptance',objective:answer.trigger.text,authorizationQuote:trigger.text,
  criteria:[{id:'evidence',description:'Verify the local fixture',files:['evidence.txt']}],nodes},scoped) as RouterGoal
 return {goal,answer,originalTask,child:{trigger,scoped,discussion:admission.discussion}}
}

const cancel=(goal:RouterGoal,operationId='cancel-desktop')=>({action:'cancel',id:goal.id,operationId,expectedRevision:goal.revision})
const settle=async(host:Runtime,done:()=>boolean)=>{
 for(let i=0;i<240;i++){
  await host.tick()
  if(done())return
  await new Promise<void>(resolve=>setTimeout(resolve,5))
 }
 const jobs=host.store.db.prepare("SELECT id,state,error FROM jobs WHERE state IN ('failed','uncertain','blocked','running')").all()
 const goals=host.store.list<RouterGoal>('router-goal').map(({state,reason,nodes})=>({state,reason,nodes}))
 throw Error('The Chat or Worker did not settle '+JSON.stringify({jobs,goals}))
}

it('reads the original Chat goal and its Worker result through the model tools and HTTP task details',async()=>{
 let targetId:string,observed=false
 const f=fixture(async r=>{
  const input=JSON.parse(r.input)
  if(input.kind==='goal_verification'){
   for(const e of input.evidence)await r.onTool!('goal_evidence',{id:e.id},'read-'+e.id)
   return {checks:input.criteria.map((criterion:{id:string})=>({criterionId:criterion.id,verdict:'passed',
    explanation:'Inspected the retained local fixture',
    evidenceIds:input.evidence.filter((e:{criterionIds:string[]})=>criterion.id==='__goal__'||e.criterionIds.includes(criterion.id)).map((e:{id:string})=>e.id)}))}
  }
  if(r.role==='worker'){
   if(r.activity?.workerId!=='review')return {state:'waiting',summary:'Waiting for the next input',reply:'',question:null,handbacks:[]}
   writeFileSync(join(r.cwd,'evidence.txt'),'Original retained evidence')
   return {state:'ready',summary:'Desktop fixture verified by Review',reply:'The local evidence is ready.',files:['evidence.txt'],question:null,handbacks:[]}
  }
  if(!input.trigger?.text.startsWith('Read the progress'))return {reply:''}
  const tool=async(name:string,args:unknown)=>{
   const r2=await r.onTool!(name,args,randomUUID())
   expect(r2.success,name+' '+JSON.stringify(r2.contentItems)).toBe(true)
   return JSON.parse(r2.contentItems[0]!.text!)
  }
  expect((await r.onTool!('chat_opening',{text:'我先查已记录的桌面验收。'},'opening')).success).toBe(true)
  const list=await tool('router_goal',{action:'list'})
  expect(list.items.map((g:RouterGoal)=>g.id)).toContain(targetId)
  const {goal}=await tool('router_goal',{action:'inspect',id:targetId})
  const worker=await tool('worker_manage',{action:'result',ticketId:goal.taskIds[0]})
  expect(worker.report.summary).toContain('Desktop fixture verified by Review')
  expect(worker.assignment.workerId).toBe('review')
  observed=true
  return {reply:'已查到桌面验收结果。'}
 })
 const {host,chat}=f,{goal,answer}=await delegatedGoal(f)
 targetId=goal.id
 await host.goals.advance()
 const ticketId=host.goals.get(goal.id)!.taskIds[0]!
 await settle(host,()=>!!host.store.get<{report?:{summary?:string}}>('goal-delivery',ticketId))
 const saved=host.store.get<{files:string[]}>('goal-delivery',ticketId)!
 expect(saved.files).toHaveLength(1)
 const file=host.store.get<any>('chat-delivery',saved.files[0]!)
 expect(file).toMatchObject({conversationId:chat.id,runId:answer.trigger.id,ticketId})
 await settle(host,()=>host.goals.get(goal.id)?.state==='completed')
 const server=await serve(host);servers.push(server)
 const headers={authorization:'Bearer '+readFileSync(server.tokenPath,'utf8').trim(),'content-type':'application/json'}
 const url=server.url+'/api/chat/conversations/'+chat.id
 const q='/task-detail?task='+encodeURIComponent('goal:'+goal.id)
 const response=await fetch(url+q,{headers})
 expect(response.status).toBe(200)
 expect(await response.json()).toMatchObject({activity:{id:'goal:'+goal.id,tickets:[{id:ticketId,workerId:'review'}]}})
 const download=await fetch(url+'/deliveries/'+file.id,{headers})
 expect(download.status).toBe(200)
 expect(await download.text()).toBe('Original retained evidence')
 const unrelated=host.chat.create(owner)
 expect((await fetch(server.url+'/api/chat/conversations/'+unrelated.id+q,{headers})).status).toBe(404)
 expect((await fetch(url+q)).status).toBe(401)
 const request=await fetch(url+'/messages',{method:'POST',headers,body:JSON.stringify({clientMessageId:randomUUID(),openingLocale:'zh-CN',text:'Read the progress and existing result for Desktop acceptance'})})
 expect(request.status).toBe(202)
 await settle(host,()=>host.chat.view(chat.id,owner).messages.some(m=>m.text==='已查到桌面验收结果。'))
 expect(observed).toBe(true)
})

it('cancels a complete held goal from the original Chat, including both Workers and queued acceptance',async()=>{
 let targetId:string,replyCount=0
 const f=fixture(async r=>{
  if(r.role==='worker')return {state:'waiting',summary:'Wait for input',reply:'',question:null,handbacks:[]}
  if(!JSON.parse(r.input).trigger?.text.startsWith('Cancel Desktop acceptance'))return {reply:''}
  expect((await r.onTool!('chat_opening',{text:'我先核对要取消的验收任务。'},'opening')).success).toBe(true)
  const get=await r.onTool!('router_goal',{action:'inspect',id:targetId},'inspect')
  expect(get.success,JSON.stringify(get.contentItems)).toBe(true)
  const {goal}=JSON.parse(get.contentItems[0]!.text!)
  const result=await r.onTool!('router_goal',cancel(goal),'cancel')
  expect(result.success,JSON.stringify(result.contentItems)).toBe(true)
  expect(JSON.parse(result.contentItems[0]!.text!)).toMatchObject({id:targetId,state:'cancelled'})
  replyCount++
  return {reply:'桌面验收已取消。'}
 })
 const {host,chat,send}=f,{goal,child,originalTask}=await delegatedGoal(f,[
  {id:'read',title:'Read local evidence',instruction:'Read local evidence',workerId:'research',criterionIds:['evidence']},
  {id:'review',title:'Verify local evidence',instruction:'Verify local evidence',workerId:'review',criterionIds:['evidence']},
 ])
 const first=await assignment(f,child,'first-candidate')
 const second=await assignment(f,child,'goal-node:'+goal.id+':review','review')
 const held={...goal,state:'held' as const,taskIds:[first]}
 host.store.put('router-goal',goal.id,held)
 targetId=goal.id
 const queue={goalId:goal.id,discussion:goal.discussion,triggerId:goal.triggerId}
 host.store.put('goal-wake','old-wake',{id:'old-wake',goalId:goal.id,state:'queued'})
 host.store.put('goal-verification','old-verification',{id:'old-verification',goalId:goal.id,state:'pending',snapshot:{evidence:[]}})
 host.store.put('goal-replan','old-replan',{id:'old-replan',goalId:goal.id,state:'pending',snapshot:{planRevision:0,contract:goal.contract,failureNodeIds:[]}})
 host.store.enqueue('goal-verify:old-verification','goal-verify',{...queue,roundId:'old-verification'})
 host.store.enqueue('goal-replan:old-replan','goal-replan',{...queue,roundId:'old-replan'})
 // Keep the test rounds in the queue until the cancellation turn has run.
 host.store.db.prepare("UPDATE jobs SET next_at=? WHERE id IN ('goal-verify:old-verification','goal-replan:old-replan')").run(Date.now()+60000)
 const pending=host.approvals.request(first,{id:'native-permission',method:'item/commandExecution/requestApproval',params:{}}).catch(e=>e.message)
 const otherChat=host.chat.create(owner),otherAccount=host.chat.create('someone-else')
 for(const ctx of [send('Cancel another task',otherChat.id),send('Cancel another task',otherAccount.id,'someone-else')]){
  expect(host.goals.command({action:'list'},ctx.scoped).items).toEqual([])
  expect(()=>host.goals.command(cancel(held),ctx.scoped)).toThrow('Goal unavailable')
 }
 const owned=send('Check Desktop acceptance')
 expect(()=>host.goals.command({...cancel(held),expectedRevision:0},owned.scoped)).toThrow('revision conflict')
 expect(()=>host.goals.command({action:'resume',id:goal.id,operationId:'resume',expectedRevision:held.revision},owned.scoped)).toThrow('Goal unavailable')
 const ownerKey=stableDigest([second,child.scoped.route.entryId])
 const channel=host.store.get<any>('task-channel',ownerKey)!
 host.store.put('task-channel',ownerKey,{...channel,request:false})
 expect(()=>host.goals.command(cancel(held),owned.scoped)).toThrow('outside this entry')
 expect(host.store.tickets.get(first)?.ended).toBeUndefined()
 expect(host.goals.get(goal.id)?.state).toBe('held')
 host.store.put('task-channel',ownerKey,channel)
 host.chat.setApprovalMode(owner,'full')
 const actual=send('Cancel Desktop acceptance and all its work')
 await settle(host,()=>replyCount===1&&host.chat.view(chat.id,owner).messages.some(m=>m.text==='桌面验收已取消。'))
 expect(await pending).toBe('Approval expired')
 expect(host.goals.get(goal.id)).toMatchObject({state:'cancelled',taskIds:[first,second]})
 for(const id of [first,second])expect(host.store.tickets.get(id)?.ended).toMatchObject({by:'human',outcome:'stopped'})
 expect(host.store.tickets.get(originalTask)?.ended).toBeUndefined()
 expect(host.store.get<any>('goal-wake','old-wake').state).toBe('failed')
 expect(host.store.get<any>('goal-verification','old-verification').state).toBe('stale')
 expect(host.store.get<any>('goal-replan','old-replan').state).toBe('stale')
 expect(host.store.db.prepare("SELECT state FROM jobs WHERE id='goal-verify:old-verification'").get()?.state).toBe('cancelled')
 const cancelled=host.goals.get(goal.id)!
 expect(host.goals.command(cancel(held),actual.scoped)).toEqual(cancelled)
 expect(host.chat.view(chat.id,owner).plans).toContainEqual(expect.objectContaining({id:goal.id,state:'cancelled'}))
})

it('requires a real Worker command and finishes a committed cancellation after restart',async()=>{
 const f=fixture(),{host,send,config,model}=f,{goal,child}=await delegatedGoal(f)
 const ticketId=await assignment(f,child,'goal-node:'+goal.id+':review','review')
 const command=cancel(goal),current=send('Cancel Desktop acceptance')
 const delivery={ticketId,kind:'reply' as const,channel:child.trigger.channel!,text:'Earlier Worker message'}
 host.store.outbox.send({id:'unsent-worker-result',...delivery})
 host.store.outbox.send({id:'uncertain-worker-result',...delivery})
 host.store.deliveryFailed('uncertain-worker-result',1,'The remote outcome is unknown',true)
 const receiptKey=child.trigger.id.slice('router-followup:'.length),receipt=host.store.get('worker-command',receiptKey)
 host.store.db.prepare("DELETE FROM records WHERE kind='worker-command' AND id=?").run(receiptKey)
 expect(()=>host.goals.command({action:'inspect',id:goal.id},current.scoped)).toThrow('Goal unavailable')
 expect(()=>host.goals.command(command,current.scoped)).toThrow('Goal unavailable')
 host.store.put('worker-command',receiptKey,receipt)
 const interrupted=vi.spyOn(host,'interruptForAutomation').mockImplementationOnce(()=>{throw Error('interrupted after commit')})
 expect(()=>host.goals.command(command,current.scoped)).toThrow('interrupted after commit')
 expect(host.goals.get(goal.id)?.state).toBe('cancelled')
 expect(host.store.tickets.get(ticketId)?.ended).toBeUndefined()
 expect(host.store.deliveries().filter(d=>d.ticketId===ticketId).map(d=>d.status)).toEqual(['dropped','uncertain'])
 interrupted.mockRestore()
 await host.close();hosts.delete(host)
 const restarted=new Runtime(config,{model});hosts.add(restarted)
 expect(restarted.store.tickets.get(ticketId)?.ended).toMatchObject({by:'human',outcome:'stopped'})
 expect(restarted.goals.command({action:'inspect',id:goal.id},current.scoped).goal.state).toBe('cancelled')
 expect(restarted.goals.command(command,current.scoped).state).toBe('cancelled')
 expect(()=>restarted.goals.beforeTurn(child.trigger.id)).toThrow('cancelled')
})
