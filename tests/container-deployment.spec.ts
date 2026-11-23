import {afterEach,expect,it} from 'vitest'
import {request as httpRequest} from 'node:http'
import {mkdtempSync,mkdirSync,rmSync,readFileSync,realpathSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {Runtime} from '../src/runtime.ts'
import {Store,MAX_DB_SCHEMA,type Run} from '../src/store.ts'
import {configSchema} from '../src/config.ts'
import {serve} from '../src/server.ts'
import {deploymentBlockers,deploymentMaintenance,inspectDeployment,pauseControl} from '../src/deployment-maintenance.ts'
import {heldArtifactReads} from '../src/artifact-read-recovery.ts'
import {artifactReadAssetId} from '../src/goal-artifacts.ts'
import {bundledEngineId} from '../src/backends/bundled-opencode.ts'
import type {PluginThread,PluginToolEffect} from '../src/backends/plugin-process.ts'
import {stableDigest} from '../src/sources.ts'
import {initContainer,inspectContainer} from '../src/container-cli.ts'
import {publicOriginSchema,requestHostOrigin} from '../src/http-deployment.ts'
const roots:string[]=[],hosts:Runtime[]=[],closers:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const c of closers.splice(0))await c();for(const h of hosts.splice(0))if(!h.shuttingDown)await h.close();for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true})})
function root(){const p=mkdtempSync(join(tmpdir(),'roppo-container-'));roots.push(p);return p}
function host(path=root()){
 const config=configSchema.parse({stateDir:join(path,'state'),port:0,work:{sandboxDriver:'disabled'},execution:{router:{mode:'host'},management:{enabled:true},workers:[{id:'one',backend:'codex'}]},sources:[{id:'local',kind:'local',cwd:path,allowedActors:['operator']}]})
 const h=new Runtime(config,{model:{async run(){throw Error('No model invocation in deployment unit checks')}}});hosts.push(h);return h
}
async function mappedRequest(url:string,headers:Record<string,string>,body?:string){
 return new Promise<{status:number;json:()=>any}>((resolve,reject)=>{
  const req=httpRequest(url,{method:body?'POST':'GET',headers},res=>{let data='';res.setEncoding('utf8');res.on('data',s=>data+=s);res.on('end',()=>resolve({status:res.statusCode!,json:()=>JSON.parse(data)}))})
  req.on('error',reject);req.end(body)
 })
}
const prepare=(h:Runtime,id=randomUUID())=>deploymentMaintenance(h,{action:'prepare',operationId:id,expectedRevision:h.settings.current().revision})

function stoppedCallback(h:Runtime,name:string,args:object,role:'router'|'subagent'){
 const {store}=h,{stateDir}=h.config
 const cwd=realpathSync(h.config.sources[0]!.cwd),id='plugin:'+randomUUID(),turnId=randomUUID()
 const identity=stableDigest('account'),digest=stableDigest('engine'),nativeId=randomUUID(),folder=randomUUID()
 const call={id:'number:1',name,args}
 const receiptId=stableDigest([id,turnId,call.id]),failureAt=Date.now()
 const thread:PluginThread={id,turnId,backendId:'codex',pluginId:'opencode-cli',digest,stateVersion:1,
  cwd,identity,nativeId,state:'failed',effectIds:[receiptId],lastFailure:{code:'outcome_unknown',at:failureAt}}
 const receipt:PluginToolEffect={state:'running',fingerprint:stableDigest([name,args]),failure:{operation:'tool',reason:'exception'}}
 const activity=randomUUID(),triggerId=randomUUID(),sourceId='local'
 const owner=role==='subagent'?{ticketId:randomUUID(),agentId:randomUUID()}:{}
 store.put('backend-plugin-thread',id,thread)
 store.put('backend-plugin-tool',receiptId,receipt)
 store.put('backend-binding',id,{id:'codex',harness:bundledEngineId,harnessDigest:digest})
 store.put('model-session',id,{threadId:id,cwd,activity,triggerId,sourceId,ephemeral:false,...owner})
 store.put('model-usage',activity,{id:activity,role,purpose:role,triggerId,sourceId,state:'failed',at:failureAt,endedAt:failureAt+1,steps:{},...owner})
 if(owner.agentId)store.put('work',owner.agentId,{...owner,id:owner.agentId,threadId:id,cwd,
  kind:'agent',state:'failed',endedAt:failureAt+2,createdAt:failureAt,notify:'collected'})
 else store.put('router-session',triggerId,{threadId:id,triggerId,source:sourceId})
 const data=join(stateDir,'backend-plugin-data','codex',identity,'threads',stableDigest(id))
 const journal=join(data,'sessions',folder),session=join(journal,'session.json')
 mkdirSync(journal,{recursive:true});mkdirSync(join(data,'index'))
 writeFileSync(join(data,'index',createHash('sha256').update(nativeId).digest('hex')+'.json'),JSON.stringify({id:nativeId,folder}))
 const native={format:1,folder,nativeId,cwd,turns:[{id:turnId,state:'interrupted',tools:[call]}]}
 writeFileSync(session,JSON.stringify(native))
 return {thread,receiptId,receipt,journal,session,native,activity}
}

function interruptedArtifact(h:Runtime,followingTool='superagent_read'){
 const {store}=h,{stateDir}=h.config,cwd=realpathSync(h.config.sources[0]!.cwd)
 const {triggerId}=h.receive('local','operator',{id:'artifact',thread:'artifact',text:'Open the original artifact',addressed:true}) as {triggerId:string}
 const decision=h.engine.decide(triggerId,{kind:'accept',title:'Open the original artifact',scope:'Check artifact',reason:'Requested',rules:[]})
 const ticket=store.tickets.get(decision.ticketId!)!,assignment=ticket.assignments.at(-1)!
 h.engine.assignmentStarted(ticket.id,assignment.id)
 h.engine.report(ticket.id,{state:'blocked',summary:'Interrupted artifact open',question:null})
 const saved=store.tickets.get(ticket.id)!
 store.put('ticket',ticket.id,{...saved,undelivered:[]})
 store.db.exec("UPDATE jobs SET state='done'")
 const threadId='plugin:'+randomUUID(),turnId=randomUUID(),folder=randomUUID()
 const nativeId='native-artifact',identity=stableDigest('account'),digest=stableDigest('engine'),artifactId='unavailable-artifact'
 const run:Run={ticketId:ticket.id,assignmentId:assignment.id,cwd,phase:'uncertain',prepared:true,threadId,turnId,backendId:'codex',error:'outcome_unknown'}
 store.put('run',ticket.id,run)
 store.put('model-session',threadId,{threadId,cwd,ticketId:ticket.id,ephemeral:false})
 store.put('backend-binding',threadId,{id:'codex',harness:bundledEngineId,harnessDigest:digest})
 const result={success:true,contentItems:[]}
 const calls=[
  {id:'number:2',name:'superagent_status',args:{label:'Checking an artifact'},result},
  {id:'number:3',name:'superagent_artifact_read',args:{id:artifactId}},
  {id:'number:4',name:followingTool,args:{resource:'catalog'}},
 ]
 const effectIds=calls.slice(0,2).map(call=>{
  const id=stableDigest([threadId,turnId,call.id]),fingerprint=stableDigest([call.name,call.args])
  const receipt:PluginToolEffect=call.result?{fingerprint,state:'complete',result}:
   {fingerprint,state:'running',failure:{operation:'tool',reason:'exception'}}
  store.put('backend-plugin-tool',id,receipt)
  return id
 })
 const thread:PluginThread={id:threadId,turnId,backendId:'codex',pluginId:'opencode-cli',digest,stateVersion:1,
  cwd,identity,nativeId,state:'failed',effectIds,lastFailure:{code:'outcome_unknown',at:Date.now()}}
 store.put('backend-plugin-thread',threadId,thread)
 const data=join(stateDir,'backend-plugin-data','codex',identity,'threads',stableDigest(threadId))
 const journal=join(data,'sessions',folder),session=join(journal,'session.json')
 mkdirSync(journal,{recursive:true})
 mkdirSync(join(data,'index'))
 writeFileSync(join(data,'index',createHash('sha256').update(nativeId).digest('hex')+'.json'),JSON.stringify({id:nativeId,folder}))
 writeFileSync(session,JSON.stringify({format:1,folder,nativeId,cwd,turns:[{id:turnId,state:'interrupted',tools:calls}]}))
 writeFileSync(join(journal,turnId+'.ready'),'ready')
 const original=join(cwd,'retained-package.zip')
 writeFileSync(original,'original file bytes')
 return {ticketId:ticket.id,run,thread,receiptId:effectIds[1]!,asset:join(stateDir,'assets',artifactReadAssetId(ticket.id,artifactId)),session,original}
}
it('initializes once and changes only deployment-owned origin when reopening a container volume',async()=>{
 const p=root();await initContainer(p,'http://127.0.0.1:55001',false)
 const file=join(p,'state/config.json'),config=JSON.parse(readFileSync(file,'utf8'));config.prompts.router='Retain my prompt';config.work.network=true;writeFileSync(file,JSON.stringify(config))
 expect(await initContainer(p,'http://127.0.0.1:55002',false)).toMatchObject({created:false})
 const after=JSON.parse(readFileSync(file,'utf8'));expect(after.prompts.router).toBe('Retain my prompt');expect(after.work.network).toBe(true);expect(after.http.publicOrigin).toBe('http://127.0.0.1:55002')
 expect(after.sources[0].cwd).toBe(join(p,'state/workspace'))
})
it('rejects a newer DB before modifying the saved container config',async()=>{
 const p=root();await initContainer(p,'http://localhost:55001',false);const file=join(p,'state/config.json'),before=readFileSync(file,'utf8'),db=new Store(join(p,'state/state.sqlite'))
 db.db.exec('PRAGMA user_version='+(MAX_DB_SCHEMA+1));db.close()
 expect(()=>inspectContainer(p)).toThrow('newer than this image')
 await expect(initContainer(p,'http://localhost:55002',false)).rejects.toThrow('newer than this image')
 expect(readFileSync(file,'utf8')).toBe(before)
})
it.each(['https://127.0.0.1:4337','http://example.com:4337','http://user@localhost:4337','http://localhost:4337/path','http://localhost:4337/','http://localhost:4337?x=1'])('rejects unsupported public origin %s',value=>{expect(publicOriginSchema.safeParse(value).success).toBe(false)})
it('retains native defaults and enforces mapped Host and browser Origin independently',async()=>{
 const h=host();expect(h.config.http).toBeUndefined();h.config.http={listenHost:'127.0.0.1',publicOrigin:'http://127.0.0.1:55009'}
 const s=await serve(h);closers.push(async()=>{s.server.closeAllConnections();await new Promise<void>(r=>s.server.close(()=>r()));await s.closeRuntime()})
 const token=readFileSync(s.tokenPath,'utf8').trim(),headers={authorization:'Bearer '+token,'content-type':'application/json',host:'127.0.0.1:55009',origin:'http://127.0.0.1:55009'}
 expect(s.operatorUrl).toMatch(/^http:\/\/127\.0\.0\.1:55009\/configure#pair=/)
 expect(JSON.parse(readFileSync(s.connectionFile,'utf8')).url).toBe(s.url)
 const response=await mappedRequest(s.url+'/operator-link',headers,'{}');expect(response.status).toBe(200);expect(response.json().url).toMatch(/^http:\/\/127\.0\.0\.1:55009\//)
 expect((await mappedRequest(s.url+'/operator-link',{...headers,origin:'http://127.0.0.1:55008'},'{}')).status).toBe(403)
 expect((await mappedRequest(s.url+'/health',{host:'untrusted.invalid:55009'})).status).toBe(403)
 expect((await mappedRequest(s.url+'/health',{host:'127.0.0.1:55008','x-forwarded-host':'127.0.0.1:55009'})).status).toBe(403)
 expect(requestHostOrigin('localhost:'+new URL(s.url).port,s.url,h.config.http.publicOrigin)).toBe('http://localhost:'+new URL(s.url).port)
})
it('prepares idempotently, blocks another operation, and restores only its own maintenance pause',async()=>{
 const h=host(),id=randomUUID();await prepare(h,id);expect(h.schedulingPaused).toBe(true)
 expect(await prepare(h,id)).toMatchObject({state:'prepared'})
 await expect(prepare(h)).rejects.toThrow('existing maintenance')
 expect(await deploymentMaintenance(h,{action:'finish',operationId:id})).toMatchObject({resumed:true})
 expect(h.schedulingPaused).toBe(false)
 const count=()=>h.store.db.prepare("SELECT COUNT(*) n FROM audit WHERE json_extract(body,'$.type')='pause'").get()!.n,before=count()
 expect(await deploymentMaintenance(h,{action:'finish',operationId:id})).toMatchObject({state:'finished',resumed:true})
 expect(count()).toBe(before)
})
it('keeps a later human pause even when its boolean value did not change',async()=>{
 const h=host(),id=randomUUID();await prepare(h,id);h.pause(true)
 expect(await deploymentMaintenance(h,{action:'finish',operationId:id})).toMatchObject({resumed:false,reason:'pause_control_changed'})
 expect(h.schedulingPaused).toBe(true)
})
it('adopts the precise pause from a legacy cutover and rejects a newer operator pause',async()=>{
 const h=host(),operationId=randomUUID()
 h.pause(true)
 const legacyPauseSeq=pauseControl(h).seq
 h.pause(true)
 const input={action:'prepare',operationId,expectedRevision:h.settings.current().revision,legacyPauseSeq}
 await expect(deploymentMaintenance(h,input)).rejects.toMatchObject({code:'maintenance_pause_changed'})
 expect(h.schedulingPaused).toBe(true)
 await expect(deploymentMaintenance(h,{...input,legacyPauseSeq:pauseControl(h).seq})).resolves.toMatchObject({state:'prepared',wasPaused:false})
 await expect(deploymentMaintenance(h,{action:'finish',operationId})).resolves.toMatchObject({resumed:true})
 expect(h.schedulingPaused).toBe(false)
})
it('preserves an originally paused instance and a prepared receipt across restart',async()=>{
 const h=host();h.pause(true);const id=randomUUID();await prepare(h,id);const config=h.config;await h.close()
 const next=new Runtime(config,{model:{async run(){throw Error('No model')}}});hosts.push(next)
 expect(await deploymentMaintenance(next,{action:'finish',operationId:id})).toMatchObject({resumed:false})
 expect(next.schedulingPaused).toBe(true)
})
it('rejects unfinished work without pausing or inventing a completed maintenance',async()=>{
 const h=host();h.receive('local','operator',{id:'work',thread:'work',text:'Do a bounded task',addressed:true})
 await expect(prepare(h)).rejects.toThrow('Unsettled work')
 expect(h.schedulingPaused).toBe(false)
})

it('recovers only supported stopped callbacks and leaves the original command fenced after upgrade',async()=>{
 const dir=root(),h=host(dir),plan={title:'Original plan',steps:[{id:'one',title:'Read retained data',state:'running'}]}
 const published=stoppedCallback(h,'superagent_plan',plan,'router')
 const unpublished=stoppedCallback(h,'superagent_plan',plan,'router')
 const snapshot=stoppedCallback(h,'superagent_browser',{action:'snapshot',requestId:'snapshot'},'subagent')
 const shell=stoppedCallback(h,'superagent_shell',{command:'example command',requestId:'shell'},'subagent')
 h.store.put('chat-plan','plan',{...plan,id:'plan',activityId:published.activity})
 const original=[published,unpublished,snapshot,shell],journals=original.map(f=>readFileSync(f.session))
 const jobs=h.store.db.prepare('SELECT * FROM jobs ORDER BY id').all()
 const operationId=randomUUID()
 expect(inspectDeployment(h.store,0,h.config.stateDir)).toMatchObject({
  blockers:[],backendReceipts:expect.arrayContaining([
   expect.objectContaining({id:published.receiptId,recovery:'interrupted_chat_plan'}),
   expect.objectContaining({id:snapshot.receiptId,recovery:'interrupted_browser_snapshot'}),
   expect.objectContaining({id:shell.receiptId,tool:'superagent_shell'}),
  ]),
 })
 await expect(prepare(h,operationId)).resolves.toMatchObject({state:'prepared'})
 await h.close()
 const next=host(dir),saved=(id:string)=>next.store.get('backend-plugin-tool',id)
 for(const f of original)expect(saved(f.receiptId)).toEqual(f.receipt)
 await expect(deploymentMaintenance(next,{action:'finish',operationId})).resolves.toMatchObject({resumed:true})
 expect(saved(published.receiptId)).toMatchObject({state:'complete',result:{success:true}})
 for(const f of [unpublished,snapshot])expect(saved(f.receiptId)).toMatchObject({state:'complete',result:{success:false}})
 expect(saved(shell.receiptId)).toEqual(shell.receipt)
 expect(next.store.get('chat-plan','plan')).toEqual({...plan,id:'plan',activityId:published.activity})
 for(const [index,f] of original.entries()){
  expect(next.store.get('backend-plugin-thread',f.thread.id)).toEqual(f.thread)
  expect(readFileSync(f.session)).toEqual(journals[index])
 }
 expect(next.store.db.prepare('SELECT * FROM jobs ORDER BY id').all()).toEqual(jobs)
 next.pause(false)
 expect(next.store.db.prepare("SELECT 1 FROM audit WHERE json_extract(body,'$.type')='backend.tool.reconciled'").all()).toHaveLength(3)
 expect(deploymentBlockers(next.store,0,next.config.stateDir)).toEqual([])
})

it.each(['live writer','ambiguous thread','mismatched fingerprint','active terminal owner'])(
 'blocks upgrade when receipt evidence has a %s',async reason=>{
  const h=host(),f=stoppedCallback(h,'superagent_browser',{action:'snapshot',requestId:'snapshot'},'subagent')
  if(reason==='live writer')writeFileSync(join(f.journal,'writer.lock'),String(process.pid))
  if(reason==='ambiguous thread'){
   const id='plugin:'+randomUUID()
   h.store.put('backend-plugin-thread',id,{...f.thread,id})
  }
  if(reason==='mismatched fingerprint')h.store.put('backend-plugin-tool',f.receiptId,{...f.receipt,fingerprint:stableDigest('different call')})
  if(reason==='active terminal owner'){
   const usage=h.store.get<object>('model-usage',f.activity)
   h.store.put('model-usage',f.activity,{...usage,state:'running'})
  }
  await expect(prepare(h)).rejects.toMatchObject({code:'deployment_busy'})
  expect(h.schedulingPaused).toBe(false)
  expect(h.store.get<PluginToolEffect>('backend-plugin-tool',f.receiptId)?.state).toBe('running')
 },
)

it('preserves a held artifact task through deployment and reconciles its failed read on resume without replay',async()=>{
 const home=root(),h=host(home),f=interruptedArtifact(h),operationId=randomUUID()
 const original=h.store.get('ticket',f.ticketId)
 const previousJobs=h.store.db.prepare('SELECT * FROM jobs ORDER BY id').all()
 const journal=readFileSync(f.session)
 expect(deploymentBlockers(h.store)).toEqual([{kind:'backend-effects',count:1},{kind:'tasks',count:1}])
 expect(heldArtifactReads(h.store,h.config.stateDir)).toHaveLength(1)
 h.pause(true)
 await expect(deploymentMaintenance(h,{action:'prepare',operationId,expectedRevision:h.settings.current().revision,
  legacyPauseSeq:pauseControl(h).seq})).resolves.toMatchObject({state:'prepared',wasPaused:false})
 await h.close()
 const next=host(home)
 expect(next.store.get('ticket',f.ticketId)).toEqual(original)
 expect(next.store.get('run',f.ticketId)).toEqual(f.run)
 expect(next.store.get('backend-plugin-tool',f.receiptId)).toMatchObject({state:'running'})
 expect(await deploymentMaintenance(next,{action:'finish',operationId})).toMatchObject({state:'finished',resumed:true})
 expect(next.store.get('backend-plugin-tool',f.receiptId)).toMatchObject({
  state:'complete',result:{success:false},
  reconciliation:{reason:'interrupted_artifact_read',ticketId:f.ticketId,assignmentId:f.run.assignmentId,threadId:f.run.threadId,turnId:f.run.turnId},
 })
 expect(next.store.get('run',f.ticketId)).toMatchObject({phase:'idle',threadId:f.run.threadId,assignmentId:f.run.assignmentId})
 expect(next.store.get('ticket',f.ticketId)).toEqual(original)
 expect(next.store.get('backend-plugin-thread',f.run.threadId!)).toEqual(f.thread)
 expect(next.store.db.prepare('SELECT * FROM jobs ORDER BY id').all()).toEqual(previousJobs)
 expect(readFileSync(f.session)).toEqual(journal)
 expect(readFileSync(f.original,'utf8')).toBe('original file bytes')
 expect(deploymentBlockers(next.store,0,next.config.stateDir)).toEqual([])
 next.pause(false)
 expect(next.store.db.prepare("SELECT 1 FROM audit WHERE json_extract(body,'$.type')='artifact.read.reconciled'").all()).toHaveLength(1)
})

it.each(['wrong fingerprint','unknown callback','materialized asset','pending work','other unknown effect'])(
 'keeps deployment blocked when artifact recovery also finds %s',async reason=>{
  const h=host(),f=interruptedArtifact(h,reason==='unknown callback'?'github_write':undefined)
  if(reason==='wrong fingerprint'){
   const receipt=h.store.get<PluginToolEffect>('backend-plugin-tool',f.receiptId)!
   h.store.put('backend-plugin-tool',f.receiptId,{...receipt,fingerprint:'mismatched'})
  }
  if(reason==='materialized asset'){mkdirSync(f.asset,{recursive:true});writeFileSync(join(f.asset,'package.zip'),'keep this')}
  if(reason==='pending work')h.store.enqueue('pending-artifact-work','execute',{ticketId:f.ticketId,assignmentId:f.run.assignmentId})
  if(reason==='other unknown effect')h.store.put('backend-plugin-tool','unrelated',{state:'running',fingerprint:'unrelated'})
  await expect(prepare(h)).rejects.toMatchObject({code:'deployment_busy'})
  expect(h.schedulingPaused).toBe(false)
  expect(h.store.get('backend-plugin-tool',f.receiptId)).toMatchObject({state:'running'})
 },
)

it('preserves the terminal state of an explicitly stopped task',()=>{
 const h=host(),f=interruptedArtifact(h)
 h.engine.stopTicket(f.ticketId,'Stopped by operator')
 const stopped=h.store.get('ticket',f.ticketId)
 const receipt=h.store.get('backend-plugin-tool',f.receiptId)
 h.pause(false)
 expect(h.store.get('ticket',f.ticketId)).toEqual(stopped)
 expect(h.store.get('backend-plugin-tool',f.receiptId)).toEqual(receipt)
 expect(readFileSync(f.original,'utf8')).toBe('original file bytes')
})
it('a human override while quiescing cannot be undone by the installer',async()=>{
 const h=host();let release!:()=>void;(h as any).tickIdle=new Promise<void>(r=>release=r)
 const pending=prepare(h);h.pause(true);release()
 await expect(pending).rejects.toThrow('Pause control changed')
 expect(h.schedulingPaused).toBe(true)
})
it('aborts interrupted preparation after restart without leaving an unrecoverable maintenance lock',async()=>{
 const h=host(),id=randomUUID();h.store.put('deployment-maintenance',id,{id,state:'preparing',wasPaused:false,at:Date.now()});h.pause(true,id)
 const config=h.config;await h.close();const next=new Runtime(config,{model:{async run(){throw Error('No model')}}});hosts.push(next)
 expect(await deploymentMaintenance(next,{action:'abort',operationId:id})).toMatchObject({state:'aborted',resumed:true})
 expect(next.schedulingPaused).toBe(false)
 await expect(prepare(next)).resolves.toMatchObject({state:'prepared'})
})
it('fences a delayed prepare request after concurrent abort',async()=>{
 const h=host(),id=randomUUID();let release!:()=>void;(h as any).tickIdle=new Promise<void>(r=>release=r)
 const pending=prepare(h,id)
 expect(await deploymentMaintenance(h,{action:'abort',operationId:id})).toMatchObject({state:'aborted',resumed:true})
 release();await expect(pending).rejects.toThrow('cancelled')
 expect(h.schedulingPaused).toBe(false)
 expect(h.store.get<any>('deployment-maintenance',id).state).toBe('aborted')
})
it('requires a current revision and safely aborts a request that never prepared',async()=>{
 const h=host(),id=randomUUID()
 await expect(deploymentMaintenance(h,{action:'prepare',operationId:id,expectedRevision:99})).rejects.toThrow('current settings revision')
 expect(await deploymentMaintenance(h,{action:'abort',operationId:id})).toMatchObject({state:'not_found',resumed:false})
 expect(h.schedulingPaused).toBe(false)
})

it('normalizes an explicitly published HTTP default port',()=>{expect(publicOriginSchema.parse('http://127.0.0.1:80')).toBe('http://127.0.0.1');expect(requestHostOrigin('127.0.0.1','http://127.0.0.1:4337','http://127.0.0.1')).toBe('http://127.0.0.1')})
