import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {afterEach,expect,it} from 'vitest'
import {Runtime} from '../src/runtime.ts'
import {configSchema} from '../src/config.ts'
import {serve} from '../src/server.ts'
import {ChatDeliveries} from '../src/chat-deliveries.ts'
import {legacyExecutionQuestion} from '../src/business-decisions.ts'
import {managedWorkspacePath} from '../src/workspace.ts'
import {stableDigest} from '../src/sources.ts'
import type {ModelRequest} from '../src/model.ts'

const roots:string[]=[],hosts:Runtime[]=[],listeners:Awaited<ReturnType<typeof serve>>[]=[]
afterEach(async()=>{
 for(const h of listeners.splice(0)){h.server.closeAllConnections();await new Promise<void>(ok=>h.server.close(()=>ok()))}
 for(const host of hosts.splice(0))await host.close()
 for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})
})

function fixture(run:(request:ModelRequest)=>Promise<unknown>){
 const root=mkdtempSync(join(tmpdir(),'roppo-retained-'));roots.push(root)
 const config=configSchema.parse({stateDir:join(root,'state'),port:0,work:{sandboxDriver:'disabled',network:false,autoRecover:false},
  execution:{router:{mode:'host'},management:{enabled:true},workers:[{id:'build',backend:'codex'},{id:'review',backend:'codex'}]},
  sources:[{id:'local',kind:'local',cwd:root,sandbox:'workspace-write',workspace:{mode:'directory'},allowedActors:['operator']}]})
 const h=new Runtime(config,{model:{async run(r){
  const threadId=r.threadId??randomUUID(),turnId=randomUUID()
  r.onThread?.(threadId);r.onTurn?.(turnId)
  return {threadId,turnId,text:JSON.stringify(await run(r))}
 }}})
 hosts.push(h)
 h.scopes.command({action:'scope.put',operationId:'scope',expectedRevision:0,scope:{id:'team',tenantId:'local',name:'Team',
  managers:[JSON.stringify(['local','operator'])],sourceIds:['local'],workerIds:['build','review'],backendIds:['codex']}})
 const owner='local-operator',chat=h.chat.create(owner)
 h.chat.setApprovalMode(owner,'full')
 const discussion='local:chat:'+chat.id
 const send=(text:string)=>h.chat.send(chat.id,owner,{text,clientMessageId:randomUUID(),locale:'zh-CN'})
 const context=(id:string)=>h.scopes.context(h.store.triggers.get(id)!,discussion)!
 const assign=async(runId:string,workerId:string,text:string)=>{
  const c=context(runId)
  return await h.manager.call({action:'assign',id:workerId,requestId:randomUUID(),text,revision:h.settings.current().revision},
   {discussion,trigger:c.trigger,scoped:c})
 }
 return {h,owner,chat,send,context,assign}
}

async function settle(host:Runtime,done:()=>boolean){
 for(let i=0;i<500;i++){await host.tick();if(done())return;await new Promise(ok=>setTimeout(ok,5))}
 throw Error('Chat did not settle')
}

const name='Setup 0.3.1.exe',expected=Buffer.from('exact original package')
const sha=createHash('sha256').update(expected).digest('hex')

async function publishManifest(f:ReturnType<typeof fixture>){
 const {h,chat}=f
 const old=f.send('Build the original package'),orig=await f.assign(old.runId,'build','Build')
 const cwd=managedWorkspacePath(h.config.stateDir,orig.ticketId),relative='release/'+name
 mkdirSync(dirname(join(cwd,relative)),{recursive:true})
 writeFileSync(join(cwd,relative),expected)
 const a=h.store.tickets.get(orig.ticketId)!.assignments.at(-1)!
 h.store.put('run',orig.ticketId,{ticketId:orig.ticketId,assignmentId:a.id,cwd,phase:'idle',workerId:'build',prepared:true})
 h.engine.stopTicket(orig.ticketId,'Original task was stopped')
 const verified=f.send('Verify the retained package'),report=await f.assign(verified.runId,'review','Verification')
 const reportCwd=managedWorkspacePath(h.config.stateDir,report.ticketId)
 mkdirSync(reportCwd,{recursive:true})
 writeFileSync(join(reportCwd,'verified.json'),JSON.stringify({
  sourceTicketId:orig.ticketId,artifacts:[{kind:'Windows-x64',originalRelativePath:relative,bytes:expected.length,sha256:sha}],
 }))
 const deliveries=new ChatDeliveries(h),files=deliveries.capture(chat.id,verified.runId,report.ticketId,'review',reportCwd,['verified.json'])
 h.chat.publishFiles(report.ticketId,files.map(file=>file.id))
 h.engine.stopTicket(report.ticketId,'Verification workspace retained after the report')
 for(const runId of [old.runId,verified.runId])h.store.jobState('router:'+runId,'done')
 return {...orig,cwd,relative}
}

it('reuses an authorized package from a stopped task, supports resumed downloads and fences revoked file links',async()=>{
 let selected:string
 const f=fixture(async r=>{
  if(r.role==='router'&&JSON.parse(r.input).trigger?.text==='给我'){
   const listing=await r.onTool!('chat_artifact_find',{query:'Windows x64'},'find')
   const found=JSON.parse(listing.contentItems[0]!.text!).items
   expect(found).toEqual([expect.objectContaining({name,sha256:sha})])
   selected=found[0].id
   const assignment=await r.onTool!('worker_manage',{action:'assign',id:'review',revision:0,requestId:'attach-package',text:'Deliver retained artifact '+selected},'assign')
   expect(assignment.success).toBe(true)
   return {reply:'已安排交付原包。'}
  }
  if(r.role==='worker'){
   expect(r.input).toContain(selected)
   const invalid=await r.onTool!('chat_artifact_deliver',{id:'invalid'},'invalid')
   expect(invalid.success).toBe(false)
   expect(invalid.contentItems[0]!.text).toContain('Invalid arguments')
   const delivered=await r.onTool!('chat_artifact_deliver',{id:selected},'attach')
   expect(await r.onTool!('chat_artifact_deliver',{id:selected},'attach-again')).toEqual(delivered)
   expect(delivered.success).toBe(true)
   return {state:'ready',summary:'原包已就绪。',reply:'',question:null,handbacks:[]}
  }
  return r.role==='router'?{reply:''}:{state:'ready',summary:'Done',reply:'',question:null,handbacks:[]}
 })
 const original=await publishManifest(f),{h,chat,owner}=f
 const target=f.send('给我')
 expect(h.chat.permissionActor(target.runId)?.mode).toBe('full')
 const view=()=>h.chat.view(chat.id,owner,undefined,undefined,undefined,target.runId,undefined,true)
 await settle(h,()=>view().run?.state==='completed')
 const cards=view().messages.flatMap(m=>m.deliveries??[])
 expect(cards).toEqual([expect.objectContaining({name,sha256:sha,localFile:true,retained:true})])
 expect(view().pendingCards).toEqual([])
 const file=cards[0]!
 expect(h.store.db.prepare('SELECT id FROM chat_delivery_bytes WHERE id=?').get(file.id)).toBeUndefined()
 await expect(h.chat.retainedDelivery(chat.id,'other-owner',file.id)).rejects.toThrow('Conversation not found')
 const other=h.chat.create(owner)
 const otherTurn=h.chat.send(other.id,owner,{text:'Windows',clientMessageId:randomUUID()})
 expect(await h.chat.artifactTool(otherTurn.runId,'chat_artifact_find',{query:'Windows'},()=>{})).toMatchObject({
  contentItems:[{text:'{"items":[],"more":false}'}],
 })
 h.store.jobState('router:'+otherTurn.runId,'done')
 const host=await serve(h);listeners.push(host)
 const token=readFileSync(host.tokenPath,'utf8').trim()
 const read=(range?:string)=>fetch(host.url+'/api/chat/conversations/'+chat.id+'/deliveries/'+file.id,
  {headers:{authorization:'Bearer '+token,...(range?{range}:{})}})
 const prefix=await read('bytes=0-4'),suffix=await read('bytes=5-')
 expect(prefix.status).toBe(206);expect(suffix.status).toBe(206)
 expect(prefix.headers.get('content-range')).toBe('bytes 0-4/'+expected.length)
 expect(prefix.headers.get('etag')).toBe('"'+sha+'"')
 expect(Buffer.concat([Buffer.from(await prefix.arrayBuffer()),Buffer.from(await suffix.arrayBuffer())])).toEqual(expected)
 expect((await read('bytes=999-')).status).toBe(416)
 const ctx=f.context(target.runId),entryId=ctx.route.entryId
 const grant=h.store.get<{revision:number}>('task-channel',stableDigest([original.ticketId,entryId]))!
 h.scopes.command({action:'task.channel',operationId:'withdraw',expectedRevision:grant.revision,ticketId:original.ticketId,
  entryId,context:true,request:true,result:false})
 expect((await read('bytes=5-')).status).toBe(404)
 expect(await h.chat.artifactTool(target.runId,'chat_artifact_find',{query:'Windows'},()=>{})).toMatchObject({
  contentItems:[{text:'{"items":[],"more":false}'}],
 })
})

it('settles a prerequisite rejection as an individual tool result without a confirmation',async()=>{
 const f=fixture(async r=>{
  if(r.role==='worker'){
   const failed=await r.onTool!('superagent_artifact_read',{id:'evidence-from-another-task'},'denied')
   expect(failed.success).toBe(false)
   expect(JSON.parse(failed.contentItems[0]!.text!).code).toBe('artifact_dependency_required')
   return {state:'ready',summary:'Continued after rejected read',reply:'完成',question:null,handbacks:[]}
  }
  return {reply:''}
 })
 const {h,chat,owner}=f
 const target=f.send('Read artifact')
 const current=await f.assign(target.runId,'review','Current task can continue')
 await settle(h,()=>!!h.store.tickets.get(current.ticketId)?.ended)
 expect(h.store.tickets.get(current.ticketId)?.assignments.at(-1)?.report?.summary).toBe('Continued after rejected read')
 const view=h.chat.view(chat.id,owner,undefined,undefined,undefined,undefined,undefined,true)
 expect(view.pendingCards).toEqual([])
 expect(view.messages.every(m=>m.text!==legacyExecutionQuestion)).toBe(true)
})

it('keeps an interrupted Chat Worker visible without requesting confirmation after restart',async()=>{
 const f=fixture(async r=>{
  if(r.role==='worker')throw Error('Worker connection interrupted')
  return {reply:''}
 })
 const {h,owner,chat}=f,target=f.send('Look up the original file')
 const {ticketId}=await f.assign(target.runId,'review','Find the original file')
 await settle(h,()=>h.store.tickets.get(ticketId)?.assignments.at(-1)?.report?.state==='blocked')
 expect(h.store.tickets.get(ticketId)?.attention).toBeUndefined()
 await h.close()
 hosts.splice(hosts.indexOf(h),1)
 const restored=new Runtime(h.config);hosts.push(restored)
 const view=restored.chat.view(chat.id,owner,undefined,undefined,undefined,target.runId,undefined,true)
 expect(view.pendingCards).toEqual([])
 expect(restored.store.tickets.get(ticketId)?.attention).toBeUndefined()
 expect(restored.store.tickets.get(ticketId)?.assignments.at(-1)?.report?.summary).toBe('Error: Worker connection interrupted')
})
