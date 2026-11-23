import {execFileSync} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {constants,copyFileSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {afterEach,expect,it} from 'vitest'
import {configSchema} from '../src/config.ts'
import type {Model,ModelRequest} from '../src/model.ts'
import type {RouterGoal} from '../src/router-goals.ts'
import {Runtime} from '../src/runtime.ts'
import type {Run} from '../src/store.ts'
import {managedWorkspacePath} from '../src/workspace.ts'
import {deploymentMaintenance,deploymentBlockers} from '../src/deployment-maintenance.ts'
import {handedOffFiles} from '../src/chat-file-handoff.ts'

const roots:string[]=[],hosts=new Set<Runtime>()
const owner='owner'
const continueRequest='对了，你三端的搞好了没，没搞好就继续'
const manifest='deliverables/local-deploy-artifacts.json'
const installer='packages/macos-local/Roppo-Local-Deploy-0.10.0-macos-arm64.zip'
const installerFiles=[manifest,'deliverables/roppo-local-deploy.patch','deliverables/local-deploy-verification.md',
 'deliverables/local-deploy-compatibility.md',installer]

afterEach(async()=>{
 for(const host of hosts)await host.close()
 hosts.clear()
 for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})
})

const ready=(summary='Done')=>({state:'ready',summary,reply:'',question:null,askedBy:null,handbacks:[],files:[]})

async function tool<T=unknown>(r:ModelRequest,name:string,args:unknown):Promise<T>{
 const result=await r.onTool!(name,args,randomUUID())
 const text=result.contentItems.map(item=>item.text??'').join('\n')
 if(!result.success)throw Error(name+': '+text)
 return JSON.parse(text) as T
}

function fixture(handler:(r:ModelRequest)=>Promise<unknown>,options:{git?:boolean;shell?:boolean}={}){
 const root=mkdtempSync(join(tmpdir(),'roppo-goal-workspace-'));roots.push(root)
 const source=join(root,'source');mkdirSync(source)
 if(options.git){
  const git=(...args:string[])=>execFileSync('git',args,{cwd:source,stdio:'pipe'})
  git('init','-b','main')
  writeFileSync(join(source,'source.txt'),'original')
  git('add','source.txt')
  git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','Original')
 }
 const ids=['builder','reviewer','parallel']
 const config=configSchema.parse({
  stateDir:join(root,'state'),watchdog:{enabled:false},work:{network:false,sandboxDriver:options.shell?'seatbelt':'disabled'},
  execution:{router:{mode:'host'},management:{enabled:true,maxWorkers:ids.length},workers:ids.map(id=>({id,backend:'codex'}))},
  sources:[{id:'local',kind:'local',cwd:source,sandbox:'workspace-write',workspace:{mode:options.git?'git-worktree':'directory'},allowedActors:['operator']}],
 })
 const model:Model={async run(r){
  const threadId=r.threadId??randomUUID(),turnId=randomUUID()
  r.onThread?.(threadId);r.onTurn?.(turnId)
  const input=JSON.parse(r.input)
  let output:unknown
  if(input.kind==='goal_verification'){
   for(const e of input.evidence){
    let offset:number|null=0
    do{offset=(await tool<{nextOffset:number|null}>(r,'goal_evidence',{id:e.id,offset})).nextOffset}while(offset!==null)
   }
   output={checks:input.criteria.map((criterion:{id:string})=>({criterionId:criterion.id,verdict:'passed',
    explanation:'Inspected the evidence',evidenceIds:input.evidence.filter((e:{criterionIds:string[]})=>criterion.id==='__goal__'||e.criterionIds.includes(criterion.id)).map((e:{id:string})=>e.id)}))}
  }else output=await handler(r)
  return {threadId,turnId,text:JSON.stringify(output)}
 }}
 const open=()=>{const host=new Runtime(config,{model});hosts.add(host);return host}
 let host=open()
 host.scopes.command({action:'scope.put',operationId:'enable-scopes',expectedRevision:0,
  scope:{id:'team',tenantId:'local',name:'Team',managers:[JSON.stringify(['local','operator'])],
   workerIds:ids,sourceIds:['local'],backendIds:['codex']}})
 const chat=host.chat.create(owner)
 host.chat.setApprovalMode(owner,'full')
 const send=(text:string,conversation=chat.id,account=owner)=>host.chat.send(conversation,account,{text,clientMessageId:randomUUID(),locale:'zh-CN'}).runId
 const context=(runId:string,conversation=chat.id)=>host.scopes.context(host.store.triggers.get(runId)!,'local:chat:'+conversation)!
 const start=(text:string,fields:Record<string,unknown>={})=>host.goals.command(startCommand(text,fields),context(send(text))) as RouterGoal
 const until=async(done:()=>boolean)=>{
  for(let i=0;i<1800;i++){
   await host.tick()
   if(done())return
   await new Promise(resolve=>setTimeout(resolve,5))
  }
  throw Error(JSON.stringify({goals:host.store.list<RouterGoal>('router-goal').map(g=>({title:g.title,state:g.state,reason:g.reason,nodes:g.nodes})),
   errors:host.store.db.prepare("SELECT kind,error FROM jobs WHERE state='failed'").all()}))
 }
 return {get host(){return host},config,source,chat,send,context,start,until,async restart(){
  await host.close();hosts.delete(host);host=open()
 }}
}

function startCommand(text:string,fields:Record<string,unknown>={}){
 return {action:'start',operationId:randomUUID(),expectedRevision:0,title:text,objective:text,authorizationQuote:text,
  criteria:[{id:'verification',description:'Verify the retained work'}],
  nodes:[{id:'continue',title:'Check existing work',instruction:'Inspect the existing files',workerId:'builder',criterionIds:['verification']}],
  ...fields}
}

function stageInstaller(cwd:string,archiveRoot:string|undefined){
 const sample=Buffer.from('macOS arm64 candidate fixture')
 const hash=createHash('sha256').update(sample).digest('hex')
 for(const name of installerFiles){
  const destination=join(cwd,name)
  mkdirSync(dirname(destination),{recursive:true})
  if(archiveRoot){copyFileSync(join(archiveRoot,name),destination,constants.COPYFILE_FICLONE);continue}
  writeFileSync(destination,name===installer?sample:name===manifest?JSON.stringify({source:{sha:'a460ccb'},platforms:{macos:{packagePath:installer,sha256:hash}}}):'Retained build evidence')
 }
 return JSON.parse(readFileSync(join(cwd,manifest),'utf8')) as {source:{sha:string};platforms:{macos:{sha256:string}}}
}

it('restores exact installer inputs across an upgrade without reopening the original task',async()=>{
 let workerRuns=0
 const shell=process.platform==='darwin'
 const f=fixture(async r=>{
  if(r.role==='router')return {reply:'The installer work is retained.'}
  workerRuns++
  const files=JSON.parse(r.input).chatFiles as {relativePath:string;path:string;resource:string;sha256:string}[]|undefined
  if(!files)return {...ready('Waiting for the original installer inputs'),state:'blocked'}
  expect(files.map(file=>file.relativePath)).toEqual(installerFiles)
  for(const file of files){
   expect(r.attachments).toContain(file.path)
   expect(createHash('sha256').update(readFileSync(file.path)).digest('hex')).toBe(file.sha256)
   if(file.relativePath.endsWith('.md'))expect(await tool(r,'superagent_read',{resource:file.resource})).toBeTruthy()
   if(shell&&file.relativePath===installer){
    const result=await tool(r,'superagent_shell',{command:"/usr/bin/shasum -a 256 '"+file.path+"'",requestId:'read-restored-original'})
    expect(JSON.stringify(result)).toContain(file.sha256)
   }
  }
  return ready('The original files are available')
 },{shell})
 const old=f.start('Original installer build')
 f.host.store.put('router-goal',old.id,{...old,workspace:undefined})
 await f.host.goals.advance()
 const oldTicket=f.host.goals.get(old.id)!.taskIds[0]!
 const cwd=managedWorkspacePath(f.config.stateDir,oldTicket)
 stageInstaller(cwd,undefined)
 const assignmentId=f.host.store.tickets.get(oldTicket)!.assignments.at(-1)!.id
 f.host.store.put('run',oldTicket,{ticketId:oldTicket,assignmentId,cwd,phase:'idle',prepared:true} satisfies Run)
 const stopped=f.host.goals.command({action:'cancel',id:old.id,expectedRevision:old.revision,operationId:'retain-build'},
  f.context(f.send('Stop the original build and keep its files'))) as RouterGoal
 const next=f.start('Continue the verification',{maxReplans:0})
 f.host.store.put('router-goal',next.id,{...next,workspace:undefined})
 await f.until(()=>f.host.goals.get(next.id)?.state==='held'&&!f.host.activeExecutions&&
  !f.host.store.db.prepare("SELECT 1 FROM jobs WHERE state IN ('pending','running') LIMIT 1").get())
 expect(deploymentBlockers(f.host.store,0,f.config.stateDir)).toEqual([])
 const held=f.host.goals.get(next.id)!,ticketId=held.taskIds[0]!
 const checkpoint=f.host.store.get<Run>('run',ticketId)!
 const files=installerFiles.map(path=>{
  const bytes=readFileSync(join(cwd,path))
  return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
 })
 const operationId=randomUUID(),handoff={ticketId,sourceTicketId:oldTicket,files}
 const recover={action:'restore-files',operationId,handoff}
 await expect(deploymentMaintenance(f.host,recover)).rejects.toMatchObject({code:'maintenance_not_prepared'})
 await deploymentMaintenance(f.host,{action:'prepare',operationId,expectedRevision:f.host.settings.current().revision})
 const wrong=[...files.slice(0,-1),{...files.at(-1)!,sha256:'0'.repeat(64)}]
 await expect(deploymentMaintenance(f.host,{...recover,handoff:{...handoff,files:wrong}})).rejects.toThrow('Original file changed')
 expect(handedOffFiles(f.host,ticketId)).toEqual([])
 const receipt=await deploymentMaintenance(f.host,recover)
 expect(receipt).toMatchObject({ticketId,sourceTicketId:oldTicket,files})
 expect(await deploymentMaintenance(f.host,recover)).toEqual(receipt)
 expect(f.host.store.get('run',ticketId)).toEqual(checkpoint)
 expect(f.host.goals.get(next.id)).toEqual(held)
 expect(f.host.goals.get(old.id)).toEqual(stopped)
 expect(workerRuns).toBe(1)
 await f.restart()
 expect(handedOffFiles(f.host,ticketId)).toHaveLength(5)
 await deploymentMaintenance(f.host,{action:'finish',operationId})
 f.host.goals.command({action:'resume',id:held.id,expectedRevision:held.revision,operationId:'verify-old-files'},
  f.context(f.send('Continue the original verification')))
 await f.until(()=>workerRuns===2&&f.host.goals.get(next.id)?.state==='completed')
 expect(f.host.goals.get(next.id)?.taskIds).toEqual([ticketId])
 expect(f.host.store.get<Run>('run',ticketId)?.cwd).toBe(checkpoint.cwd)
 expect(f.host.chat.businessDecisions(f.chat.id,owner)).toHaveLength(0)
 expect(f.host.goals.get(old.id)?.state).toBe('cancelled')
},30000)

it('continues the stopped installer goal in its legacy workspace without a file confirmation',async()=>{
 const replay=process.env.ROPPO_INSTALLER_REPLAY_ROOT
 let oldGoal!:RouterGoal
 let oldTicket='',cwd='',checked='',continued!:RouterGoal
 const shell=process.platform==='darwin'
 const f=fixture(async r=>{
  if(r.role==='router'){
   if(JSON.parse(r.input).trigger?.text!==continueRequest)return {reply:''}
   const {items}=await tool<{items:RouterGoal[]}>(r,'router_goal',{action:'list'})
   const retained=items.find(g=>g.id===oldGoal.id)!
   expect(retained.state).toBe('cancelled')
   expect(retained.taskIds).toEqual([oldTicket])
   continued=await tool<RouterGoal>(r,'router_goal',startCommand(continueRequest,{
    continueFrom:{goalId:retained.id,ticketId:retained.taskIds[0]!,expectedRevision:retained.revision},
   }))
   return {reply:''}
  }
  expect(r.cwd).toBe(cwd)
  expect(r.instructions).toContain('previous task’s retained workspace')
  for(const name of installerFiles.slice(0,-1)){
   const file=await tool(r,'superagent_read',{resource:'files/'+name})
   expect(JSON.stringify(file).length).toBeGreaterThan(20)
  }
  if(shell){
   const receipt=await tool(r,'superagent_shell',{command:"/usr/bin/shasum -a 256 '"+installer+"'",requestId:'verify-original'})
   expect(JSON.stringify(receipt)).toContain(checked)
  }else{
   expect(createHash('sha256').update(readFileSync(join(r.cwd,installer))).digest('hex')).toBe(checked)
  }
  return ready('Read the original installer and verified its checksum')
 },{shell})
 oldGoal=f.start('三端同机宿主安装包')
 // The deployed predecessor derived its directory from the task rather than the goal.
 f.host.store.put('router-goal',oldGoal.id,{...oldGoal,workspace:undefined})
 await f.host.goals.advance()
 oldGoal=f.host.goals.get(oldGoal.id)!
 oldTicket=oldGoal.nodes![0]!.ticketId!
 cwd=managedWorkspacePath(f.config.stateDir,oldTicket)
 const retained=stageInstaller(cwd,replay)
 checked=retained.platforms.macos.sha256
 const assignment=f.host.store.tickets.get(oldTicket)!.assignments.at(-1)!.id
 f.host.store.put('run',oldTicket,{ticketId:oldTicket,assignmentId:assignment,cwd,phase:'idle',prepared:true} satisfies Run)
 const stopped=f.host.goals.command({action:'cancel',id:oldGoal.id,expectedRevision:oldGoal.revision,operationId:'stop-old'},
  f.context(f.send('停止任务并保留已有文件'))) as RouterGoal
 expect(stopped.state).toBe('cancelled')
 expect(f.host.store.list('chat-delivery')).toEqual([])
 const other=f.host.chat.create('other-owner')
 const unauthorized=f.context(f.send(continueRequest,other.id,'other-owner'),other.id)
 expect(()=>f.host.goals.command(startCommand(continueRequest,{
  continueFrom:{goalId:stopped.id,ticketId:oldTicket,expectedRevision:stopped.revision},
 }),unauthorized)).toThrow('Retained goal or task is unavailable')
 // Run only the authorized continuation below.
 f.host.store.jobState('router:'+unauthorized.trigger.id,'done')
 await f.restart()
 const continuation=f.send(continueRequest)
 await f.until(()=>!!continued&&f.host.goals.get(continued.id)?.state==='completed')
 const current=f.host.goals.get(continued.id)!
 expect(current.taskIds).toHaveLength(1)
 expect(f.host.store.get<Run>('run',current.taskIds[0]!)?.cwd).toBe(cwd)
 expect(f.host.goals.get(oldGoal.id)?.state).toBe('cancelled')
 expect(f.host.chat.businessDecisions(f.chat.id,owner)).toEqual([])
 expect(f.host.chat.view(f.chat.id,owner,undefined,undefined,undefined,continuation,undefined,true).pendingCards).toEqual([])
 expect(f.host.store.list('goal-replan')).toEqual([])
 if(replay)console.info('Installer replay:',{files:installerFiles.length,source:retained.source.sha,sha256:checked,continuationTasks:1,cards:0})
},30000)

it('serializes writers sharing the goal workspace and forks independent Git edits',async()=>{
 let release!:()=>void
 const blocked=new Promise<void>(resolve=>{release=resolve})
 const seen=new Map<string,string>()
 const f=fixture(async r=>{
  if(r.role==='router')return {reply:''}
  const task=r.activity!.ticketId!
  const node=f.host.goals.forTask(task)!.nodes!.find(n=>n.ticketId===task)!
  seen.set(node.id,r.cwd)
  if(node.id==='first'){
   writeFileSync(join(r.cwd,'source.txt'),'first writer')
   await blocked
  }else if(node.id==='second'){
   expect(readFileSync(join(r.cwd,'source.txt'),'utf8')).toBe('first writer')
  }else{
   expect(readFileSync(join(r.cwd,'source.txt'),'utf8')).toBe('original')
   writeFileSync(join(r.cwd,'source.txt'),'different worktree')
  }
  return ready()
 },{git:true})
 const goal=f.start('Implement two changes and an independent branch',{
  maxParallel:3,nodes:[
   {id:'first',title:'First writer',instruction:'Edit the shared workspace',workerId:'builder',criterionIds:['verification']},
   {id:'second',title:'Second writer',instruction:'Continue the shared edit',workerId:'reviewer',criterionIds:['verification']},
   {id:'fork',title:'Independent edit',instruction:'Edit independently',workerId:'parallel',criterionIds:['verification'],workspace:'worktree'},
  ],
 })
 try{
  await f.until(()=>seen.has('first')&&seen.has('fork'))
  expect(seen.has('second')).toBe(false)
  expect(seen.get('fork')).not.toBe(seen.get('first'))
  expect(execFileSync('git',['rev-parse','--git-common-dir'],{cwd:seen.get('fork')!,encoding:'utf8'}).trim()).toBe(join(realpathSync(f.source),'.git'))
 }finally{release()}
 await f.until(()=>f.host.goals.get(goal.id)?.state==='completed')
 expect(seen.get('second')).toBe(seen.get('first'))
 expect(readFileSync(join(f.source,'source.txt'),'utf8')).toBe('original')
},30000)

it('keeps a genuine missing-input question on one task across scheduler ticks and restart',async()=>{
 let attempts=0
 const f=fixture(async r=>{
  if(r.role==='router')return {reply:''}
  attempts++
  return attempts===1?{...ready('The exact input is missing'),state:'blocked',
   question:'这两份版本中要使用哪一个？'}:ready('Used the supplied version')
 })
 const goal=f.start('确认版本后交付',{maxReplans:2})
 await f.until(()=>f.host.goals.get(goal.id)?.state==='held')
 const task=f.host.goals.get(goal.id)!.taskIds[0]!
 const before=f.host.chat.businessDecisions(f.chat.id,owner)
 expect(before).toEqual([expect.objectContaining({status:'pending',ticketId:task})])
 await f.restart()
 for(let i=0;i<12;i++)await f.host.tick()
 expect(f.host.store.list('goal-replan')).toEqual([])
 expect(f.host.goals.get(goal.id)?.taskIds).toEqual([task])
 expect(f.host.chat.businessDecisions(f.chat.id,owner)).toEqual(before)
 expect(f.host.chat.view(f.chat.id,owner,undefined,undefined,undefined,undefined,undefined,true).pendingCards).toHaveLength(1)
 const answer={action:'answer' as const,id:before[0]!.id,version:before[0]!.version,requestId:randomUUID(),text:'用第二份'}
 expect(f.host.chat.decide(f.chat.id,owner,answer).decision.status).toBe('answered')
 await f.until(()=>f.host.goals.get(goal.id)?.state==='completed')
 expect(attempts).toBe(2)
 expect(f.host.goals.get(goal.id)?.taskIds).toEqual([task])
 expect(f.host.chat.businessDecisions(f.chat.id,owner)).toEqual([expect.objectContaining({id:answer.id,status:'answered'})])
},30000)
