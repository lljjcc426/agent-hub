import {StringDecoder} from 'node:string_decoder'
import {z} from 'zod'
import {textPage} from './context-budget.ts'
import {resourcePage,maxJobWaitMs} from './execution-limits.ts'
import {execFileSync, type ChildProcess} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {openSync,readSync,closeSync,fstatSync,mkdirSync,readFileSync,writeFileSync,existsSync,lstatSync,realpathSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {startSandboxRunner} from './sandbox.ts'
import type {Store} from './store.ts'
import type {Config} from './config.ts'
import {projectWorkspace} from './project-code.ts'
import {hostPrivateFiles} from './private-files.ts'

export const jobInput=z.object({
 id:z.string(),action:z.enum(['read','wait','stop']),yieldMs:z.number().int().min(0).max(maxJobWaitMs).default(5000),
 offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(resourcePage.maxCharacters).default(resourcePage.defaultCharacters),
}).strict()
export class WorkItemUnavailable extends Error {constructor(){super('Work item is outside this worker')}}

export interface WorkOwner {ticketId:string;assignmentId:string;cwd:string;sandbox:'read-only'|'workspace-write';agentId?:string;depth:number;network?:boolean}
export interface WorkItem extends WorkOwner {
 id:string;kind:'shell'|'agent';state:'starting'|'running'|'completed'|'failed'|'cancelled'|'interrupted';
 createdAt:number;endedAt?:number;pid?:number;command?:string;prompt?:string;threadId?:string;
 notify:'auto'|'held'|'sent'|'collected'|'dropped';deadline?:number;result?:unknown;exitCode?:number|null;error?:string
}
export interface WorkHooks {
 valid(owner:WorkOwner):boolean
 canReadInput?(input:import('./chat-retained-artifacts.ts').OpenedChatArtifact,owner:WorkOwner):boolean
 wake(item:WorkItem):void
 expired?(owner:WorkOwner,killed:string[],remaining:string[]):void
 agent(item:WorkItem,signal:AbortSignal):Promise<{threadId:string;result:unknown}>
}
/** A linked checkout is registered by both the worktree and the common repo. A gitfile alone grants nothing. */
function linkedGitDirectory(cwd:string){
 try{
  if(lstatSync(cwd).isSymbolicLink()||!lstatSync(join(cwd,'.git')).isFile())return
  const options={cwd,encoding:'utf8' as const,timeout:2000,stdio:['ignore','pipe','ignore'] as ['ignore','pipe','ignore']}
  const locations=execFileSync('git',['rev-parse','--path-format=absolute','--git-dir','--git-common-dir'],options).trimEnd().split('\n')
  if(locations.length!==2)return
  const [worktree,common]=locations.map(location=>realpathSync(location))
  if(dirname(worktree!)!==join(common!,'worktrees'))return
  const registered=execFileSync('git',['--git-dir='+common,'worktree','list','--porcelain','-z'],options).split('\0')
  if(registered.includes('worktree '+realpathSync(cwd)))return common
 }catch{return undefined}
}
const terminal=(item:WorkItem)=>!['starting','running'].includes(item.state)
const liveWork="json_extract(body,'$.state') IN ('starting','running')"
const autoWork="json_extract(body,'$.notify')='auto'"
const workTicket="json_extract(body,'$.ticketId')"
const workAssignment="json_extract(body,'$.assignmentId')"
/** Work survives a model turn. A process restart interrupts work rather than silently replaying it. */
export class WorkManager {
 private agents=new Map<string,{controller:AbortController;promise:Promise<void>}>()
 private waits=new Map<string,number>()
 private runners=new Map<string,ChildProcess>()
 private stopping=false
  readonly recovered:Promise<void>
 private readonly pollItems
 private readonly liveItems
 private readonly byTicket
 private readonly byAssignment
 private readonly autoByAssignment
 readonly directory:string
 constructor(readonly store:Store,readonly config:Config,private hooks:WorkHooks){
  const db=store.db
  db.exec(`
   CREATE INDEX IF NOT EXISTS work_ticket ON records(${workTicket}) WHERE kind='work';
   CREATE INDEX IF NOT EXISTS work_live_assignment ON records(${workTicket},${workAssignment})
     WHERE kind='work' AND ${liveWork};
   CREATE INDEX IF NOT EXISTS work_needs_poll ON records(json_extract(body,'$.state'))
     WHERE kind='work' AND (${liveWork} OR ${autoWork});
  `)
  this.pollItems=db.prepare(`SELECT id FROM records WHERE kind='work' AND (${liveWork} OR ${autoWork}) ORDER BY rowid`)
  this.liveItems=db.prepare(`SELECT body FROM records WHERE kind='work' AND ${liveWork} ORDER BY rowid`)
  this.byTicket=db.prepare(`SELECT body FROM records WHERE kind='work' AND ${workTicket}=? ORDER BY rowid`)
  this.byAssignment=db.prepare(`SELECT body FROM records WHERE kind='work' AND ${liveWork} AND ${workTicket}=? AND ${workAssignment}=? ORDER BY rowid`)
  this.autoByAssignment=db.prepare(`SELECT body FROM records WHERE kind='work' AND ${liveWork} AND ${autoWork} AND ${workTicket}=? AND ${workAssignment}=? ORDER BY rowid`)
  this.directory=join(config.stateDir,'jobs');mkdirSync(this.directory,{recursive:true,mode:0o700})
  const interrupted=this.live()
  for(const item of interrupted){
   // The runner's parent/lock monitor kills its own process group. Never signal a stale PID here.
   this.put({...item,state:'interrupted',endedAt:Date.now(),error:'Host restarted; inspect the retained output before repeating work'})
  }
  this.recovered=(async()=>{
   const shells=interrupted.filter(w=>w.kind==='shell');if(!shells.length)return
   for(let n=0;n<35;n++){
    const waiting=shells.filter(w=>{if(existsSync(join(this.directory,w.id+'.result.json')))return false;if(!w.pid)return true;try{process.kill(w.pid,0);return true}catch{return false}})
    if(!waiting.length)return
    await new Promise(r=>setTimeout(r,100))
   }
   throw Error('Previous managed command shutdown is not confirmed; inspect retained jobs before resuming')
  })()
  void this.recovered.catch(()=>{})
 }
 private decode(rows:Record<string,unknown>[]){return rows.map(row=>JSON.parse(String(row.body)) as WorkItem)}
 private live(){return this.decode(this.liveItems.all())}
 private assigned(ticketId:string,assignmentId:string){return this.decode(this.byAssignment.all(ticketId,assignmentId))}
 list(ticketId?:string){return ticketId?this.decode(this.byTicket.all(ticketId)):this.store.list<WorkItem>('work')}
 private put(item:WorkItem){this.store.put('work',item.id,item);return item}
 private assert(owner:WorkOwner){if(this.stopping||!this.hooks.valid(owner))throw Error('This assignment no longer owns work tools')}
 private matching(owner:WorkOwner,item:WorkItem){return item.ticketId===owner.ticketId&&item.assignmentId===owner.assignmentId&&item.agentId===owner.agentId}
 private own(owner:WorkOwner,id:string){this.assert(owner);const item=this.store.get<WorkItem>('work',id);if(!item||!this.matching(owner,item))throw new WorkItemUnavailable();return item}
 private key(owner:WorkOwner,requestId:string){return owner.ticketId+':'+owner.assignmentId+':'+(owner.agentId??'root')+':'+requestId}
 private create(owner:WorkOwner,kind:WorkItem['kind'],requestId:string,body:{command?:string;prompt?:string}){
  this.assert(owner)
  const key=this.key(owner,requestId),previous=this.store.get<string>('work-request',key)
  if(previous){const item=this.own(owner,previous);if(item.kind!==kind||item.command!==body.command||item.prompt!==body.prompt)throw Error('Work request id reused with different content');return {item,fresh:false}}
  return this.store.atomic(()=>{
   const item:WorkItem={...owner,...body,id:randomUUID(),kind,state:'starting',createdAt:Date.now(),notify:'auto'}
   this.put(item);this.store.put('work-request',key,item.id);return {item,fresh:true}
  })
 }
 async shell(owner:WorkOwner,command:string,requestId:string,yieldMs=5000,writablePaths?:string[]){
  if(this.config.work.sandboxDriver==='disabled')throw Error('Managed shell is disabled; configure a sandbox driver before requesting commands')
  if(this.config.work.sandboxDriver==='seatbelt'&&process.platform!=='darwin')throw Error('Seatbelt sandbox requires macOS')
  if(this.config.work.sandboxDriver==='bubblewrap'&&process.platform!=='linux')throw Error('Bubblewrap sandbox requires Linux')
  const {item,fresh}=this.create(owner,'shell',requestId,{command})
  if(fresh){
   const spec=join(this.directory,item.id+'.spec.json')
   const gitDirectory=owner.cwd===projectWorkspace(this.config.stateDir,owner.ticketId)?undefined:linkedGitDirectory(owner.cwd)
   const attachments=this.store.list<any>('asset').filter(a=>a.ticketId===owner.ticketId&&(a.kind!=='chat-artifact-input'||this.hooks.canReadInput?.(a,owner))).map(a=>a.path)
   writeFileSync(spec,JSON.stringify({id:item.id,command,cwd:owner.cwd,sandbox:owner.sandbox,codex:this.config.codex,sandboxDriver:this.config.work.sandboxDriver,network:this.config.work.network&&(owner.network??true),privateState:this.config.stateDir,privatePaths:hostPrivateFiles(),gitDirectory,attachments,writablePaths,hostPid:process.pid,hostLock:join(this.config.stateDir,'host.lock'),directory:this.directory,maxOutputBytes:this.config.work.maxOutputBytes}),{mode:0o600,flag:'wx'})
   try{
    const child=startSandboxRunner(spec)
    this.runners.set(item.id,child)
    child.once('error',()=>{this.put({...this.store.get<WorkItem>('work',item.id)!,state:'failed',endedAt:Date.now(),error:'Unable to start managed command'})})
    child.once('exit',()=>{this.runners.delete(item.id);const current=this.store.get<WorkItem>('work',item.id);if(current&&['starting','running'].includes(current.state)&&!existsSync(join(this.directory,item.id+'.result.json')))this.put({...current,state:'interrupted',endedAt:Date.now(),error:'Managed runner exited without a durable receipt; inspect retained output before retrying'})})
    await new Promise<void>((resolve,reject)=>{child.once('spawn',()=>resolve());child.once('error',reject)})
    this.put({...item,state:'running',pid:child.pid})
   }catch(error){this.put({...item,state:'failed',endedAt:Date.now(),error:String(error)})}
  }
  return this.wait(owner,item.id,yieldMs)
 }
 async agent(owner:WorkOwner,prompt:string,requestId:string){
  this.assert(owner)
  const previous=this.store.get<string>('work-request',this.key(owner,requestId))
  if(previous){const {item}=this.create(owner,'agent',requestId,{prompt});return this.view(item)}
  if(owner.depth>=this.config.work.maxDepth)throw Error('Subagent depth limit reached')
  if(this.list(owner.ticketId).filter(w=>w.kind==='agent'&&!terminal(w)).length>=this.config.work.maxAgents)throw Error('Subagent concurrency limit reached')
  const {item,fresh}=this.create(owner,'agent',requestId,{prompt})
  if(fresh){
   const controller=new AbortController()
   const current=this.put({...item,state:'running'})
   const promise=this.hooks.agent(current,controller.signal).then(result=>{
    const latest=this.store.get<WorkItem>('work',item.id)!
    if(terminal(latest)||this.stopping)return
    this.put({...latest,state:'completed',endedAt:Date.now(),threadId:result.threadId,result:result.result})
   }).catch(error=>{
    const latest=this.store.get<WorkItem>('work',item.id)!
    if(!terminal(latest))this.put({...latest,state:controller.signal.aborted?'cancelled':'failed',endedAt:Date.now(),error:String(error).slice(0,1000)})
   }).finally(async()=>{
    await this.cancelOwned(item.ticketId,item.assignmentId,item.id,'Subagent ended')
    this.agents.delete(item.id)
   })
   this.agents.set(item.id,{controller,promise})
  }
  return this.view(this.store.get<WorkItem>('work',item.id)!)
 }
 async wait(owner:WorkOwner,id:string,yieldMs=0){
  this.own(owner,id)
  const until=Date.now()+Math.min(maxJobWaitMs,Math.max(0,yieldMs))
  this.waits.set(id,(this.waits.get(id)??0)+1)
  try{do{
   await this.tick()
   let item=this.own(owner,id)
   if(terminal(item)||Date.now()>=until){
    if(terminal(item)&&item.notify==='auto')item=this.put({...item,notify:'collected'})
    return this.view(item)
   }
   await new Promise(resolve=>setTimeout(resolve,30))
  }while(true)}finally{const n=(this.waits.get(id)??1)-1;if(n)this.waits.set(id,n);else this.waits.delete(id)}
 }
 view(item:WorkItem,offset=0,limit=resourcePage.defaultCharacters){
  const path=join(this.directory,item.id+'.output')
  let characters=0,window=''
  if(existsSync(path)){
   const fd=openSync(path,'r'),decoder=new StringDecoder('utf8'),buffer=Buffer.allocUnsafe(64*1024)
   const collect=(chunk:string)=>{
    const start=Math.max(0,offset-characters),end=Math.min(chunk.length,offset+limit+1-characters)
    if(start<end)window+=chunk.slice(start,end)
    characters+=chunk.length
   }
   try{
    let length
    while((length=readSync(fd,buffer,0,buffer.length,null))>0)collect(decoder.write(buffer.subarray(0,length)))
    collect(decoder.end())
   }finally{closeSync(fd)}
  }
  const output=textPage(window,0,limit).text,next=offset+output.length
  return {...item,output,outputOffset:offset,nextOffset:next<characters?next:null,outputCharacters:characters,resource:'job/'+item.id}
 }
 read(owner:WorkOwner,id:string,offset=0,limit=resourcePage.defaultCharacters){return this.view(this.own(owner,id),offset,limit)}
 // Terminal shell receipts already know their character length. Read a bounded UTF-8 suffix
 // instead of scanning a large completed log from the start a second time.
 outputTail(owner:WorkOwner,id:string,characters:number){
  this.own(owner,id)
  const fd=openSync(join(this.directory,id+'.output'),'r')
  try{
   const size=fstatSync(fd).size,buffer=Buffer.alloc(Math.min(size,characters*4+4)),start=size-buffer.length
   let read=0
   while(read<buffer.length){
    const count=readSync(fd,buffer,read,buffer.length-read,start+read)
    if(!count)break
    read+=count
   }
   return buffer.toString('utf8',0,read).slice(-characters)
  }finally{closeSync(fd)}
 }
 active(ticketId:string,assignmentId:string){return this.decode(this.autoByAssignment.all(ticketId,assignmentId))}
 ownsRunningShell(item:WorkItem){
  const child=this.runners.get(item.id)
  return item.kind==='shell'&&item.state==='running'&&this.store.get<WorkItem>('work',item.id)?.state==='running'&&!!child?.pid&&child.pid===item.pid&&
   child.exitCode===null&&child.signalCode===null&&!child.killed
 }
 async tick(){
  if(this.hooks.expired){
   const due=this.live().filter(w=>w.deadline&&Date.now()>=w.deadline&&!w.agentId)
   for(const expired of new Map(due.map(w=>[w.ticketId+':'+w.assignmentId,w])).values()){
    const owned=this.active(expired.ticketId,expired.assignmentId).filter(w=>!w.agentId),killed:string[]=[]
    for(const w of owned){
     this.put({...w,deadline:undefined,notify:w.kind==='shell'?'held':w.notify})
     if(w.kind==='shell'){await this.cancel(this.store.get<WorkItem>('work',w.id)!,'Background turn deadline reached',false);killed.push(w.id)}
    }
    this.hooks.expired(expired,killed,owned.filter(w=>w.kind==='agent').map(w=>w.id))
   }
  }
  for(const row of this.pollItems.all()){
   let item=this.store.get<WorkItem>('work',String(row.id))
   if(!item)continue
   if(item.kind==='shell'&&!terminal(item)){
    const path=join(this.directory,item.id+'.result.json')
    if(existsSync(path)){
     try{const result=JSON.parse(readFileSync(path,'utf8'));if(result.id!==item.id)throw Error('Runner identity mismatch');item=this.put({...item,state:result.error?'failed':result.exitCode===0?'completed':'failed',endedAt:result.endedAt,exitCode:result.exitCode,result,error:result.error})}
     catch{item=this.put({...item,state:'failed',endedAt:Date.now(),error:'Invalid managed-command result'})}
    }
   }
   if(!terminal(item)&&!this.hooks.valid(item)){await this.cancel(item,'Assignment ended',true);continue}
   if(!terminal(item)&&item.deadline&&Date.now()>=item.deadline&&item.kind==='shell'){
    await this.cancel(item,'Background turn deadline reached',false)
    item=this.store.get<WorkItem>('work',item.id)
    if(!item)continue
   }
   if(terminal(item)&&item.notify==='auto'&&!this.waits.has(item.id)&&!this.stopping&&this.hooks.valid(item)){
    // Queue the wake and record notification in the same transaction.
    this.store.atomic(()=>{const current=this.store.get<WorkItem>('work',item.id)!;if(current.notify==='auto'){this.hooks.wake(current);this.put({...current,notify:'sent'})}})
   }
  }
 }
 turnStarted(ticketId:string,assignmentId:string){for(const w of this.active(ticketId,assignmentId).filter(w=>!w.agentId))this.put({...w,deadline:undefined})}
 turnEnded(ticketId:string,assignmentId:string){
  const deadline=Date.now()+this.config.work.backgroundTimeoutMs
  for(const item of this.active(ticketId,assignmentId).filter(w=>!w.agentId))this.put({...item,deadline})
 }
 async handoff(ticketId:string,assignmentId:string){
  for(const item of this.assigned(ticketId,assignmentId)){
   if(item.kind==='agent')await this.cancel(item,'Human handoff',true)
   else if(!item.agentId){const current=this.store.get<WorkItem>('work',item.id)!;if(!terminal(current))this.put({...current,notify:'held',deadline:undefined})}
  }
 }
 private async cancel(item:WorkItem,reason:string,drop:boolean){
  if(terminal(this.store.get<WorkItem>('work',item.id)!))return
  this.put({...item,state:'cancelled',endedAt:Date.now(),error:reason,notify:drop?'dropped':item.notify})
  if(item.kind==='agent'){
   const active=this.agents.get(item.id);active?.controller.abort();await active?.promise
  }else{
   const child=this.runners.get(item.id)
   if(child?.pid){
    try{process.platform==='win32'?child.kill('SIGTERM'):process.kill(-child.pid,'SIGTERM')}catch{}
    await new Promise<void>(resolve=>{
     if(child.exitCode!==null)return resolve()
     const timer=setTimeout(()=>{try{if(child.pid)process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL')}catch{}resolve()},2500)
     child.once('close',()=>{clearTimeout(timer);resolve()})
    })
   }
  }
 }
 async stop(owner:WorkOwner,id:string){await this.cancel(this.own(owner,id),'Cancelled by worker',false);return this.view(this.store.get<WorkItem>('work',id)!)}
 async cancelOwned(ticketId:string,assignmentId:string,agentId:string|undefined,reason:string){
  for(const item of this.assigned(ticketId,assignmentId).filter(w=>w.agentId===agentId))await this.cancel(item,reason,true)
 }
 async endAssignment(ticketId:string,assignmentId:string){await this.cancelOwned(ticketId,assignmentId,undefined,'Assignment ended')}
 async close(){
  this.stopping=true
  for(const item of this.live())await this.cancel(item,'Host stopped',true)
  await Promise.allSettled([...this.agents.values()].map(a=>a.promise))
  await Promise.allSettled([...this.runners.values()].map(child=>new Promise<void>(resolve=>{
   if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL')}catch{}resolve()},3000)
   child.once('close',()=>{clearTimeout(timer);resolve()})
  })))
 }
}
