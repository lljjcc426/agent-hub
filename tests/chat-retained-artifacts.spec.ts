import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,mkdtempSync,readFileSync,rmSync,truncateSync,writeFileSync} from 'node:fs'
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

async function publishManifest(f:ReturnType<typeof fixture>,version={bytes:expected.length,sha256:sha}){
 const {h,chat}=f
 const old=f.send('Build the original package'),orig=await f.assign(old.runId,'build','Build')
 const cwd=managedWorkspacePath(h.config.stateDir,orig.ticketId),relative='release/'+name
 mkdirSync(dirname(join(cwd,relative)),{recursive:true})
 writeFileSync(join(cwd,relative),version.bytes===expected.length?expected:Buffer.alloc(0))
 truncateSync(join(cwd,relative),version.bytes)
 const a=h.store.tickets.get(orig.ticketId)!.assignments.at(-1)!
 h.store.put('run',orig.ticketId,{ticketId:orig.ticketId,assignmentId:a.id,cwd,phase:'idle',workerId:'build',prepared:true})
 h.engine.stopTicket(orig.ticketId,'Original task was stopped')
 const verified=f.send('Verify the retained package'),report=await f.assign(verified.runId,'review','Verification')
 const reportCwd=managedWorkspacePath(h.config.stateDir,report.ticketId)
 mkdirSync(reportCwd,{recursive:true})
 writeFileSync(join(reportCwd,'verified.json'),JSON.stringify({
  sourceTicketId:orig.ticketId,artifacts:[{kind:'Windows-x64',originalRelativePath:relative,...version}],
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

it('opens just the selected original for the assigned Worker and revokes further access with the source grant',async()=>{
 let input:any,opened:any,second:any
 const f=fixture(async r=>{
  if(r.role!=='worker')return {reply:'Received'}
  const result=await r.onTool!('chat_artifact_open',{id:input.id},'open')
  expect(result.success).toBe(true)
  opened=JSON.parse(result.contentItems[0]!.text!)
  expect(readFileSync(opened.path)).toEqual(expected)
  const replay=await r.onTool!('superagent_artifact_read',{id:input.id},'again')
  second=JSON.parse(replay.contentItems[0]!.text!)
  return {state:'ready',summary:'Inspected package bytes',reply:'Verified',question:null,handbacks:[]}
 })
 const source=await publishManifest(f),old=f.h.store.tickets.get(source.ticketId)!
 const turn=f.send('Inspect the original installer'),target=await f.assign(turn.runId,'review','Inspect its version')
 const listed=await f.h.chat.artifactTool(turn.runId,'chat_artifact_find',{query:'Windows'},()=>{})
 input=JSON.parse(listed.contentItems[0]!.text!).items[0]
 await settle(f.h,()=>!!second)
 expect(second).toEqual(opened)
 expect(opened).toMatchObject({name,sha256:sha,bytes:expected.length})
 expect(opened.path).not.toContain(source.ticketId)
 expect(f.h.store.tickets.get(source.ticketId)).toEqual(old)
 const asset=f.h.store.get<any>('asset',opened.resource.slice(6))!
 const current={ticketId:target.ticketId,assignmentId:f.h.store.tickets.get(target.ticketId)!.assignments.at(-1)!.id}
 expect(f.h.chat.retained.canReadInput(asset,current)).toBe(true)
 expect(f.h.chat.retained.canReadInput(asset,{...current,ticketId:source.ticketId})).toBe(false)
 const entryId=f.context(turn.runId).route.entryId,grant=f.h.store.get<{revision:number}>('task-channel',stableDigest([source.ticketId,entryId]))!
 f.h.scopes.command({action:'task.channel',operationId:'withdraw-source',expectedRevision:grant.revision,ticketId:source.ticketId,entryId,context:true,request:true,result:false})
 expect(f.h.chat.retained.canReadInput(asset,current)).toBe(false)
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

it('fulfills a private pickup without a model turn, a new assignment or a goal wake',async()=>{
 let turns=0
 const f=fixture(async()=>{turns++;throw Error('pickup must not dispatch')})
 await publishManifest(f)
 const {h,chat,owner}=f
 const target=f.send('把安装包给我')
 const before=h.store.tickets.list(),wakes=h.store.list('goal-wake')
 await settle(h,()=>!!h.store.get('router-result','router:'+target.runId))
 const view=h.chat.view(chat.id,owner,undefined,undefined,undefined,target.runId,undefined,true)
 expect(view.messages.flatMap(m=>m.deliveries??[])).toMatchObject([{name,localFile:true,sha256:sha}])
 expect(h.store.tickets.list()).toEqual(before)
 expect(h.store.list('goal-wake')).toEqual(wakes)
 expect(turns).toBe(0)
})

it('reads an applied, previously oversized Worker handback without changing the original ticket',async()=>{
 const {h,chat,owner,assign,send}=fixture(async()=>{throw Error('must not call model')})
 const build=send('build package'),work=await assign(build.runId,'build','produce the test installer')
 const ticket=h.store.tickets.get(work.ticketId)!,assignment=ticket.assignments.at(-1)!,cwd=managedWorkspacePath(h.config.stateDir,ticket.id)
 const path='candidate/setup-mac.zip',turnId=randomUUID()
 mkdirSync(dirname(join(cwd,path)),{recursive:true});writeFileSync(join(cwd,path),expected)
 h.store.put('run',ticket.id,{ticketId:ticket.id,assignmentId:assignment.id,cwd,phase:'idle',workerId:'build',prepared:true})
 const {begin,observe}=await import('../src/async-worker-inbox.ts')
 h.engine.assignmentStarted(ticket.id,assignment.id)
 const attempt=begin(h,ticket.id,assignment.id)
 const text=JSON.stringify({state:'ready',files:[path,'unrelated.txt'],reply:'文件名：`setup-mac.zip`（'+expected.length+' 字节）。\nSHA-256：`'+sha+'`'})
 h.store.put('transcript',turnId,{turnId,ticketId:ticket.id,text,at:Date.now()})
 observe(h,attempt,{kind:'result',nativeTurnId:turnId,payload:text},()=>{
  h.store.put('chat-file-correction',ticket.id+':'+assignment.id,{ticketId:ticket.id,assignmentId:assignment.id})
  h.engine.note(ticket.id,'File delivery failed: Evidence must be a regular file no larger than 102400 KiB.')
 })
 h.store.jobState('router:'+build.runId,'done')
 const request=send('把安装包给我')
 const before=h.store.tickets.list()
 expect(await h.chat.pickup(request.runId,'把安装包给我',new AbortController().signal)).toContain('候选')
 const cards=h.chat.view(chat.id,owner,undefined,undefined,undefined,request.runId,undefined,true).messages.flatMap(m=>m.deliveries??[])
 expect(cards).toMatchObject([{name:'setup-mac.zip',size:expected.length,sha256:sha,localFile:true}])
 await h.chat.pickup(request.runId,'把安装包给我',new AbortController().signal)
 expect(new ChatDeliveries(h).list(chat.id)).toHaveLength(1)
 expect(h.store.tickets.list()).toEqual(before)
 writeFileSync(join(cwd,path),Buffer.alloc(expected.length))
 await expect(h.chat.retainedDelivery(chat.id,owner,cards[0]!.id)).rejects.toThrow()
 h.store.put('async-worker-revoked',attempt.id,{ticketId:ticket.id})
 expect(JSON.stringify(await h.chat.artifactTool(request.runId,'chat_artifact_find',{ticketId:ticket.id},()=>{}))).not.toContain('setup-mac.zip')
})

it('keeps pickup separate from new work and binds legacy digests to the named file',async()=>{
 const {existingFileRequest,reportedFileVersions,choosePickup}=await import('../src/chat-file-pickup.ts')
 for(const request of ['把安装包给我','你把mac安装包本地链接给我','Send me the installer','Where is the report?'])expect(existingFileRequest(request)).toBe(true)
 for(const request of ['帮我生成一份报告给我','重新构建安装包发给我','别把安装包给我','Build and send me the new installer','把安装包发给团队','给我解释这个安装包怎么使用'])expect(existingFileRequest(request)).toBe(false)
 const items=[{id:'a',ticketId:'first-ticket',name:'setup-mac.zip'},{id:'b',ticketId:'review-ticket',name:'review-mac.zip'}]
 expect(choosePickup(items,'把安装包给我','from first-ticket')).toEqual(items.slice(0,1))
 expect(choosePickup(items,'把安装包给我','')).toEqual(items)
 expect(choosePickup(items,'send missing.exe','from first-ticket')).toEqual([])
 expect(choosePickup(items.slice(1),'把安装包给我','原任务 '+'a'.repeat(32)+' 的安装包')).toEqual([])
 expect(choosePickup(items,'把 v1.2.3 安装包给我','')).toEqual([])
 expect(reportedFileVersions(JSON.stringify({state:'ready',files:['a.zip','b.zip'],reply:'`a.zip` 23 bytes. Other file: `b.zip` (44 bytes). SHA256: '+sha}))).toEqual([{name:'b.zip',path:'b.zip',bytes:44,sha256:sha}])
})


it('streams the inclusive 512 MiB download boundary and excludes larger files while uploads retain their own limit',async()=>{
 const {chatDownloadMaxBytes,chatUploadLimits}=await import('../src/execution-limits.ts')
 expect(chatDownloadMaxBytes).toBe(512*1024*1024)
 expect(chatUploadLimits.maxBytes).toBe(100*1024*1024)
 const digest=createHash('sha256'),zero=Buffer.alloc(1024*1024)
 for(let i=0;i<512;i++)digest.update(zero)
 const f=fixture(async()=>{throw Error('Unexpected dispatch')}),{h,send,owner,chat}=f
 const version={bytes:chatDownloadMaxBytes,sha256:digest.digest('hex')}
 const original=await publishManifest(f,version),request=send('把安装包给我')
 const cards=()=>new ChatDeliveries(h).list(chat.id).filter(f=>f.runId===request.runId)
 await h.chat.pickup(request.runId,'把安装包给我',new AbortController().signal)
 expect(cards()).toMatchObject([{size:chatDownloadMaxBytes,sha256:version.sha256,localFile:true}])
 const entry=await h.chat.retainedDelivery(chat.id,owner,cards()[0]!.id)
 expect(entry&&'file' in entry&&entry.file).toBeTruthy()
 if(entry&&'file' in entry&&entry.file)await entry.file.handle.close()
 truncateSync(join(original.cwd,original.relative),chatDownloadMaxBytes+1)
 await expect(h.chat.retainedDelivery(chat.id,owner,cards()[0]!.id)).rejects.toThrow()
 expect(()=>new ChatDeliveries(h).capture(chat.id,request.runId,original.ticketId,'build',original.cwd,[original.relative])).toThrow('524288 KiB')
 const larger=fixture(async()=>{throw Error('Unexpected dispatch')})
 await publishManifest(larger,{...version,bytes:chatDownloadMaxBytes+1})
 const get=larger.send('把安装包给我')
 await larger.h.chat.pickup(get.runId,'把安装包给我',new AbortController().signal)
 expect(new ChatDeliveries(larger.h).list(larger.chat.id).filter(f=>f.runId===get.runId)).toHaveLength(0)
},20000)

it('lets the Router return an existing published file in a contextual reply without a Worker',async()=>{
 const f=fixture(async r=>{
  if(r.role!=='router')throw Error('File pickup dispatched work')
  const listed=await r.onTool!('chat_artifact_find',{query:'Windows x64'},'list')
  const [item]=JSON.parse(listed.contentItems[0]!.text!).items
  const delivered=await r.onTool!('chat_artifact_deliver',{id:item.id},'attach')
  expect(delivered.success).toBe(true)
  return {reply:'Here is the file.'}
 })
 await publishManifest(f)
 const {h,chat,owner}=f,request=f.send('That one, please.')
 const before=h.store.tickets.list()
 await settle(h,()=>!!h.store.get('router-result','router:'+request.runId))
 const view=h.chat.view(chat.id,owner,undefined,undefined,undefined,request.runId,undefined,true)
 expect(view.messages.flatMap(m=>m.deliveries??[])).toMatchObject([{name,sha256:sha,localFile:true}])
 expect(h.store.tickets.list()).toEqual(before)
})

it('prefers the captured original and preserves the published download if that original is replaced',async()=>{
 const {h,chat,owner,send,assign}=fixture(async()=>{throw Error('Unexpected dispatch')})
 const build=send('Build original'),{ticketId}=await assign(build.runId,'build','Build the release')
 const cwd=managedWorkspacePath(h.config.stateDir,ticketId),file='my-installer.dmg',dir=new ChatDeliveries(h)
 mkdirSync(cwd,{recursive:true});writeFileSync(join(cwd,file),expected)
 h.store.put('run',ticketId,{ticketId,assignmentId:h.store.tickets.get(ticketId)!.assignments.at(-1)!.id,cwd,phase:'idle',workerId:'build'})
 const staged=dir.capture(chat.id,build.runId,ticketId,'build',cwd,[file])
 h.chat.publishFiles(ticketId,staged.map(f=>f.id))
 const pickup=async()=>{
  const r=send('把安装包给我')
  await h.chat.pickup(r.runId,'把安装包给我',new AbortController().signal)
  return dir.list(chat.id).find(f=>f.runId===r.runId)!
 }
 const first=await pickup();expect(first).toMatchObject({name:file,localFile:true,sha256:sha})
 writeFileSync(join(cwd,file),Buffer.alloc(expected.length))
 await expect(h.chat.retainedDelivery(chat.id,owner,first.id)).rejects.toThrow()
 const next=await pickup();expect(next.sha256).toBe(sha);expect(next.localFile).toBeUndefined()
 const entry=await h.chat.retainedDelivery(chat.id,owner,next.id)
 expect(entry&&'bytes' in entry&&Buffer.from(entry.bytes!)).toEqual(expected)
})

it('captures Worker downloads beyond the upload limit with their exact version',async()=>{
 const {h,chat,assign,send}=fixture(async()=>{throw Error('Unexpected dispatch')})
 const r=send('Build'),{ticketId}=await assign(r.runId,'build','Build')
 const cwd=managedWorkspacePath(h.config.stateDir,ticketId),path=join(cwd,'large.zip')
 mkdirSync(cwd,{recursive:true});writeFileSync(path,'');truncateSync(path,100*1024*1024+1)
 const [file]=new ChatDeliveries(h).capture(chat.id,r.runId,ticketId,'build',cwd,['large.zip'])
 expect(h.store.get('chat-delivery',file!.id)).toMatchObject({originalPath:'large.zip',size:100*1024*1024+1,sha256:expect.stringMatching(/^[a-f0-9]{64}$/)})
 expect(h.store.db.prepare('SELECT length(bytes) n FROM chat_delivery_bytes WHERE id=?').get(file!.id)?.n).toBe(100*1024*1024+1)
})

it('previews the verified original of a retained raster image and keeps the separate download',async()=>{
 const {h,chat,owner,send,assign}=fixture(async()=>({reply:'Done'}))
 const build=send('Prepare the panel'),{ticketId}=await assign(build.runId,'build','Prepare the panel')
 const cwd=managedWorkspacePath(h.config.stateDir,ticketId),name='panel.png'
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII=','base64')
 mkdirSync(cwd,{recursive:true});writeFileSync(join(cwd,name),image)
 h.store.put('run',ticketId,{ticketId,assignmentId:h.store.tickets.get(ticketId)!.assignments.at(-1)!.id,cwd,phase:'idle',workerId:'build'})
 const deliveries=new ChatDeliveries(h),[source]=deliveries.capture(chat.id,build.runId,ticketId,'build',cwd,[name])
 h.chat.publishFiles(ticketId,[source!.id])
 h.engine.stopTicket(ticketId,'Image already delivered')
 h.store.jobState('router:'+build.runId,'done')
 const request=send('Inspect the composition')
 const lookup=h.chat.retained.find(request.runId,{query:name}).items.find(item=>item.name===name)!
 expect((await h.chat.artifactTool(request.runId,'chat_artifact_deliver',{id:lookup.id},()=>{})).success).toBe(true)
 const file=deliveries.list(chat.id).find(item=>item.runId===request.runId&&item.retained)!
 const host=await serve(h);listeners.push(host)
 const headers={authorization:'Bearer '+readFileSync(join(h.config.stateDir,'access-token'),'utf8').trim()}
 const url=host.url+'/api/chat/conversations/'+chat.id+'/deliveries/'+file.id
 const preview=await fetch(url+'?preview=1',{headers})
 expect(preview.headers.get('content-type')).toBe('image/png')
 expect(preview.headers.get('content-disposition')).toMatch(/^inline;/)
 expect(Buffer.from(await preview.arrayBuffer())).toEqual(image)
 const download=await fetch(url,{headers})
 expect(download.headers.get('content-disposition')).toMatch(/^attachment;/)
 expect(Buffer.from(await download.arrayBuffer())).toEqual(image)
 expect(h.chat.view(chat.id,owner).messages.some(message=>message.deliveries?.some(item=>item.id===file.id))).toBe(true)
})
