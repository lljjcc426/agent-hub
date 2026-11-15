import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {afterEach,it,expect} from 'vitest'
import {configSchema} from '../src/config.ts'
import {Runtime} from '../src/runtime.ts'
import {serve} from '../src/server.ts'
import {operatorWorkspace,operatorTask} from '../src/operator-workspace.ts'
import {MessageSource} from '../src/sources.ts'
import {planHistory} from '../src/history-cleanup.ts'

const roots:string[]=[],hosts:Runtime[]=[],servers:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const close of servers.splice(0))await close();for(const host of hosts.splice(0))await host.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})})
function fixture(question=false){
 const root=mkdtempSync(join(tmpdir(),'agenthub-workspace-'));roots.push(root)
 const config=configSchema.parse({stateDir:join(root,'state'),port:0,work:{sandboxDriver:'disabled'},sources:[{id:'local',kind:'local',cwd:root,allowedActors:['operator']}]})
 const host=new Runtime(config,{model:{async run(r){const output=r.ephemeral?{action:'accept',title:'Workspace test',scope:'Reply to this request',reason:'Explicit request',rules:[],ruleAssessments:[],targetTicketId:null}:{state:question?'blocked':'ready',summary:'Actual task summary',reply:question?'':'Actual task reply',question:question?'Which document?':null,handbacks:[]};return {threadId:r.threadId??randomUUID(),turnId:randomUUID(),text:JSON.stringify(output)}}}});hosts.push(host);return host
}
async function work(host:Runtime,text='Synthetic request',id='request'){
 const {triggerId}=host.receive('local','operator',{id,thread:id,text,addressed:true}) as {triggerId:string}
 host.store.put('entry-client-event',triggerId,{client:'codex',bridge:'synthetic-bridge'})
 for(let n=0;n<100;n++){await host.tick();await new Promise(r=>setTimeout(r,2));const ticket=host.store.tickets.list().find(t=>t.origin.triggerId===triggerId);if(ticket&&host.store.deliveries().some(d=>d.ticketId===ticket.id&&d.kind==='reply'&&d.status==='sent'))return ticket}
 throw Error('Fixture did not settle')
}
it('projects completed work and origin receipts without copying configuration or protocol history',async()=>{
 const host=fixture(),ticket=await work(host,'Synthetic request '+('long '.repeat(3000)))
 const list=operatorWorkspace(host);expect(list.tasks[0]).toMatchObject({id:ticket.id,entryId:'codex',state:'ready',replySent:true,replyRead:false});expect(JSON.stringify(list).length).toBeLessThan(5000);expect(list).not.toHaveProperty('events');expect(list).not.toHaveProperty('backends')
 host.store.put('entry-client-receipt',ticket.id,{client:'codex'});expect(operatorTask(host,ticket.id)).toMatchObject({state:'replied',replyRead:true,result:'Actual task reply'});expect(operatorTask(host,ticket.id)!.message.length).toBe(8000)
 expect(operatorWorkspace(host,1,1)).toMatchObject({total:1,tasks:[],more:false});expect(operatorTask(host,'missing')).toBeUndefined()
})
it('shows the title, summary, request and result of retained local assistant work',async()=>{
 const host=fixture(),ticket=await work(host,'Summarize the local project')
 host.store.put('entry-client-event',ticket.origin.triggerId,{client:'local'})
 host.store.put('entry-client-receipt',ticket.id,{client:'local'})
 expect(operatorWorkspace(host).tasks).toEqual([expect.objectContaining({id:ticket.id,entryId:'local',title:'Workspace test',summary:'Actual task summary',state:'replied'})])
 expect(operatorTask(host,ticket.id)).toMatchObject({message:'Summarize the local project',result:'Actual task reply'})
})
it('omits cleaned history from lists, counts, activity and direct task access while retaining other work',async()=>{
 const host=fixture(),deleted=await work(host,'Delete this history','deleted'),retained=await work(host,'Keep this history','retained')
 for(const ticket of [deleted,retained])host.store.put('entry-client-receipt',ticket.id,{client:'codex'})
 const callId=host.activity.begin('worker','Deleted worker',{ticketId:deleted.id,workerId:'worker-1'})
 host.store.put('memory-evidence','cleanup-evidence',{id:'cleanup-evidence',scopeId:'cleanup-scope',locator:'trigger:'+deleted.origin.triggerId})
 host.memory.cleanup.apply(planHistory(host.store,host.config.stateDir,'cleanup-scope','cleanup-test',Date.now(),'cleanup-evidence'))
 // Cleanup retains receipt envelopes. Even a late execution update must stay hidden.
 host.store.put('run',deleted.id,{...host.store.get<any>('run',deleted.id),phase:'running',workerId:'worker-1'})
 expect(host.store.tickets.get(deleted.id)?.title).toBe('')
 const list=operatorWorkspace(host,0,1)
 expect(list).toMatchObject({total:1,more:false,activeTotal:0,attentionTotal:0,counts:{running:0,replied:1,attention:0}})
 expect(list.tasks.map(t=>t.id)).toEqual([retained.id])
 expect(list.architecture.workers.flatMap(w=>w.active)).toEqual([])
 expect(list.architecture.activity.some(c=>c.id===callId||c.ticketId===deleted.id)).toBe(false)
 expect(operatorWorkspace(host,1,1).tasks).toEqual([])
 expect(operatorWorkspace(host,0,25,{search:'Workspace test'}).total).toBe(1)
 expect(operatorTask(host,deleted.id)).toBeUndefined()
 expect(operatorTask(host,retained.id)).toMatchObject({message:'Keep this history',result:'Actual task reply'})
 const server=await serve(host);servers.push(()=>new Promise<void>(r=>server.server.close(()=>r())))
 const headers={authorization:'Bearer '+readFileSync(server.tokenPath,'utf8').trim()}
 expect((await fetch(server.url+'/entry-workspace/task/'+deleted.id,{headers})).status).toBe(404)
})
it('keeps clarification and uncertain delivery in attention without counting them as a completed reply',async()=>{
 const host=fixture(true),ticket=await work(host)
 expect(operatorWorkspace(host)).toMatchObject({attentionTotal:1,attention:[{id:ticket.id,state:'attention',question:'Which document?'}]})
 const delivery=host.store.deliveries().find(d=>d.ticketId===ticket.id)!;host.store.deliveryFailed(delivery.id,1,'Synthetic delivery response lost',true)
 expect(operatorTask(host,ticket.id)).toMatchObject({state:'attention',deliveryUncertain:true})
})
it('only exposes a source link for that configured GitHub repository and preserves real pending approvals',async()=>{
 const host=fixture(),ticket=await work(host),trigger=host.store.triggers.get(ticket.origin.triggerId)!
 host.config.sources[0]!.kind='github';host.config.sources[0]!.repository='example/project'
 for(const url of ['javascript:alert(1)','https://github.com/other/project/issues/1','https://example.com/example/project/issues/1']){host.store.put('trigger',trigger.id,{...trigger,meta:{url}});expect(operatorTask(host,ticket.id)).not.toHaveProperty('sourceUrl')}
 host.store.put('trigger',trigger.id,{...trigger,meta:{url:'https://github.com/example/project/issues/1'}});expect(operatorTask(host,ticket.id)!.sourceUrl).toBe('https://github.com/example/project/issues/1')
 const pending=host.approvals.request(ticket.id,{id:'synthetic-approval',method:'item/permissions/requestApproval',params:{permissions:{network:{enabled:true}}}});const approval=operatorTask(host,ticket.id)!.approvals[0]!
 expect(operatorWorkspace(host).attentionTotal).toBe(1);host.approvals.answer(approval.id,'decline');expect(await pending).toMatchObject({permissions:{}});expect(operatorTask(host,ticket.id)!.approvals).toEqual([])
})
it('requires operator access, validates pagination and returns a missing-work response',async()=>{
 const host=fixture(),server=await serve(host);servers.push(()=>new Promise<void>(r=>server.server.close(()=>r())))
 const headers={authorization:'Bearer '+readFileSync(server.tokenPath,'utf8').trim()}
 expect((await fetch(server.url+'/entry-workspace')).status).toBe(401);expect((await fetch(server.url+'/entry-workspace/task/unknown')).status).toBe(401)
 expect((await fetch(server.url+'/entry-workspace?limit=999',{headers})).status).toBe(400);expect((await fetch(server.url+'/entry-workspace/task/unknown',{headers})).status).toBe(404)
 expect(await(await fetch(server.url+'/entry-workspace',{headers})).json()).toMatchObject({total:0,tasks:[],attentionTotal:0})
})
