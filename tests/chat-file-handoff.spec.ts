import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {afterEach,expect,it,vi} from 'vitest'
import {Runtime} from '../src/runtime.ts'
import {configSchema} from '../src/config.ts'
import {ChatDeliveries} from '../src/chat-deliveries.ts'
import {legacyExecutionQuestion} from '../src/business-decisions.ts'
import {deploymentBlockers,deploymentMaintenance,pauseControl} from '../src/deployment-maintenance.ts'
import {managedWorkspacePath} from '../src/workspace.ts'
import type {Model,ModelRequest} from '../src/model.ts'
import type {RouterGoal} from '../src/router-goals.ts'
import type {Run} from '../src/store.ts'

const roots:string[]=[],hosts=new Set<Runtime>()
afterEach(async()=>{
 vi.restoreAllMocks()
 for(const host of hosts)await host.close()
 hosts.clear()
 for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})
})

const patch='deliverables/change.patch',report='deliverables/verification.md',installer='repo/.local/Roppo Setup.exe'
const packageBytes=Buffer.from([0,1,2,3,4])
const patchBytes=Buffer.from('original patch\n')
const question='能否将旧任务留存的 `'+patch+'`、`'+report+'` 和报告所列的原始安装包，只读交接到本验收任务？'
const summary='缺少旧任务保留的验收原件'

async function fixture(missing=false){
 const root=mkdtempSync(join(tmpdir(),'roppo-handoff-test-'));roots.push(root)
 const config=configSchema.parse({stateDir:join(root,'state'),work:{sandboxDriver:'disabled',network:false,autoRecover:false},
  execution:{router:{mode:'host'},management:{enabled:true},workers:[{id:'builder',backend:'codex'},{id:'reviewer',backend:'codex'}]},
  sources:[{id:'local',kind:'local',cwd:root,sandbox:'workspace-write',workspace:{mode:'directory'},allowedActors:['operator']}]})
 const reviews:ModelRequest[]=[]
 const model:Model={async run(request){
  const threadId=request.threadId??randomUUID(),turnId=randomUUID()
  request.onThread?.(threadId);request.onTurn?.(turnId)
  if(request.role!=='worker')return {threadId,turnId,text:'{"reply":""}'}
  reviews.push(request)
  const answered=JSON.parse(request.input).inputs?.some((item:{event?:{text:string}})=>item.event?.text==='可以')
  const value=answered?{state:'waiting',summary:'原件已齐，继续验收。',reply:'',question:null,handbacks:[]}:
   {state:'blocked',summary,reply:'',question,handbacks:[]}
  return {threadId,turnId,text:JSON.stringify(value)}
 }}
 const open=()=>{const host=new Runtime(config,{model});hosts.add(host);return host}
 const host=open(),owner='owner'
 host.scopes.command({action:'scope.put',operationId:'scope',expectedRevision:0,
  scope:{id:'team',tenantId:'org',name:'Handoff fixture',contextBytes:128000,managers:[JSON.stringify(['local','operator'])],
   workerIds:['builder','reviewer'],sourceIds:['local'],backendIds:['codex']}})
 const chat=host.chat.create(owner)
 host.chat.setApprovalMode(owner,'full')
 const discussion='local:chat:'+chat.id
 const send=(text:string)=>host.chat.send(chat.id,owner,{clientMessageId:randomUUID(),text,locale:'zh-CN'})
 const context=(id:string)=>host.scopes.context(host.store.triggers.get(id)!,discussion)!
 const old=send('保留首版文件'),oldContext=context(old.runId)
 const {ticketId:sourceId}=await host.manager.call({action:'assign',id:'builder',text:'首版文件',requestId:'old-task',revision:0},{discussion,trigger:oldContext.trigger,scoped:oldContext})
 const cwd=managedWorkspacePath(config.stateDir,sourceId)
 const reportText='| Package | Bytes | SHA-256 |\n| `'+installer+'` | '+packageBytes.length+' | `'+createHash('sha256').update(packageBytes).digest('hex')+'` |\n'
 for(const [path,bytes] of [[patch,patchBytes],[report,Buffer.from(reportText)]] as const){
  mkdirSync(dirname(join(cwd,path)),{recursive:true});writeFileSync(join(cwd,path),bytes)
 }
 if(!missing){mkdirSync(dirname(join(cwd,installer)),{recursive:true});writeFileSync(join(cwd,installer),packageBytes)}
 host.store.atomic(()=>new ChatDeliveries(host).capture(chat.id,old.runId,sourceId,'builder',cwd,[patch,report]))
 const oldTicket=host.store.tickets.get(sourceId)!
 host.store.put('run',sourceId,{ticketId:sourceId,assignmentId:oldTicket.assignments.at(-1)!.id,cwd,phase:'idle',workerId:'builder',prepared:true} satisfies Run)
 host.engine.stopTicket(sourceId,'User stopped the prior build')
 const work=send('独立验收原有安装包')
 const goal=host.goals.command({action:'start',operationId:'handoff-goal',expectedRevision:0,title:'验收安装包',objective:'独立验收原有安装包',
  authorizationQuote:'独立验收原有安装包',maxReplans:0,
  criteria:[{id:'inspect',description:'Check the original packages'}],
  nodes:[{id:'review',title:'验收原有文件',instruction:'Inspect the original files',workerId:'reviewer',criterionIds:['inspect']}]},context(work.runId)) as RouterGoal
 const until=async(h:Runtime,done:()=>boolean)=>{
  for(let i=0;i<400;i++){await h.tick();if(done())return;await new Promise(resolve=>setTimeout(resolve,5))}
  throw Error('Handoff did not settle: '+JSON.stringify({goal:h.goals.get(goal.id)?.state,jobs:h.store.db.prepare("SELECT kind,state,error FROM jobs WHERE state='failed'").all()}))
 }
 await until(host,()=>host.goals.get(goal.id)?.state==='held'&&host.chat.businessDecisions(chat.id,owner)[0]?.status==='pending')
 const decision=host.chat.businessDecisions(chat.id,owner)[0]!
 const input={action:'answer' as const,id:decision.id,version:decision.version,requestId:randomUUID(),text:'可以'}
 return {host,owner,chat,sourceId,cwd,reviews,decision,input,open,until,goal,ticketId:decision.ticketId}
}

it('keeps the approval and resumes the same held task with exact read-only copies',async()=>{
 const f=await fixture(),{host,chat,owner,decision,sourceId,ticketId}=f
 expect(decision.target.label).toBe('验收原有文件')
 const assignment=host.store.tickets.get(ticketId)!.assignments.at(-1)!.id
 expect(host.chat.decide(chat.id,owner,f.input).decision.status).toBe('answered')
 expect(host.chat.decide(chat.id,owner,f.input).duplicate).toBe(true)
 await f.until(host,()=>f.reviews.length===2&&!host.executionActive(ticketId))
 const continued=f.reviews[1]!,{chatFiles}=JSON.parse(continued.input)
 expect(continued.activity?.ticketId).toBe(ticketId)
 expect(host.chat.permissionActor(continued.activity!.triggerId!,ticketId)?.mode).toBe('full')
 expect(continued.instructions).not.toMatch(/permission mode|native_permission_decision/)
 expect(continued.tools!.find(tool=>tool.name==='superagent_tool')?.inputSchema.properties).not.toHaveProperty('pendingNotice')
 expect(continued.threadId).toBeDefined()
 expect(host.store.tickets.get(ticketId)!.assignments.map(item=>item.id)).toEqual([assignment])
 expect(chatFiles.map((item:{relativePath:string})=>item.relativePath)).toEqual([patch,report,installer])
 expect(chatFiles.map((item:{path:string})=>item.path)).toEqual(continued.attachments)
 for(const file of chatFiles)expect(statSync(file.path).mode&0o777).toBe(0o400)
 expect(readFileSync(chatFiles[0].path)).toEqual(patchBytes)
 expect(readFileSync(chatFiles[2].path)).toEqual(packageBytes)
 expect(host.store.tickets.get(sourceId)?.ended?.by).toBe('human')
 expect(host.chat.businessDecisions(chat.id,owner)).toEqual([expect.objectContaining({id:decision.id,status:'answered',fileHandoff:{state:'ready',missing:[]}})])
})

it.each(['absent','changed'] as const)('reports the %s package on the answered record without another model call',async state=>{
 const f=await fixture(state==='absent'),{host,chat,owner,ticketId,decision}=f
 if(state==='changed')writeFileSync(join(f.cwd,installer),Buffer.from([0,1,2,3,5]))
 host.chat.decide(chat.id,owner,f.input)
 await f.until(host,()=>host.chat.businessDecisions(chat.id,owner)[0]?.fileHandoff?.state==='missing'&&!host.executionActive(ticketId))
 expect(f.reviews).toHaveLength(1)
 expect(host.chat.businessDecisions(chat.id,owner)).toEqual([expect.objectContaining({id:decision.id,status:'answered',fileHandoff:{state:'missing',missing:[installer]}})])
 expect(host.store.tickets.get(ticketId)?.attention).toBeUndefined()
 expect(host.store.tickets.get(ticketId)?.assignments.at(-1)?.report?.summary).toBe('缺少原始文件：'+installer)
 expect(host.store.list('asset')).toHaveLength(0)
})

it.each([false,true])('recovers the approved handoff after a legacy startup failure (maintenance: %s)',async maintenance=>{
 const f=await fixture(),{host,chat,owner,ticketId,decision}=f
 const defer=vi.spyOn(host.goals,'resumeAnsweredQuestion').mockReturnValue(false)
 host.chat.decide(chat.id,owner,f.input)
 defer.mockRestore()
 const task=host.store.tickets.get(ticketId)!
 const followup=task.inputs.find(item=>item.kind==='trigger'&&item.triggerId.startsWith('router-followup:'))!
 expect(followup.kind).toBe('trigger')
 if(followup.kind!=='trigger')throw Error('Missing answered input')
 const original=host.store.triggers.get(followup.triggerId)!
 const run=host.store.get<Run>('run',ticketId)!
 host.store.atomic(()=>{
  host.store.db.prepare("DELETE FROM records WHERE kind='chat-file-handoff' AND id=?").run(decision.id)
  host.store.db.prepare("UPDATE jobs SET state='done' WHERE kind='execute' AND json_extract(payload,'$.ticketId')=?").run(ticketId)
  host.store.put('run',ticketId,{...run,phase:'uncertain',error:'Error: async_worker_goal_unavailable'})
  const update=host as unknown as {reportWork:(id:string,value:{state:'blocked';summary:string;question:string;askedBy:string})=>void}
  update.reportWork(ticketId,{state:'blocked',summary:'Error: async_worker_goal_unavailable',question:legacyExecutionQuestion,askedBy:followup.triggerId})
  // The user can also have replied to the obsolete card on the older host.
  const prior=host.store.triggers.get(String(original.meta.parentTrigger))!
  const duplicateReply={...prior,id:prior.id+':legacy-card-reply',text:'？'}
  expect(host.routerIngress.admitDecision(duplicateReply).state).toBe('accepted')
  const context=host.scopes.context(duplicateReply,prior.source+':chat:'+chat.id)!
  host.scopes.noteInput(ticketId,context)
  host.memory.moveTaskContext(ticketId,context)
  host.store.put('chat-run',duplicateReply.id,{id:duplicateReply.id,triggerId:duplicateReply.id,conversationId:chat.id,decisionTicketId:ticketId})
  host.store.put('chat-permission','legacy-clone',{id:'legacy-clone',tool:'github_git',phase:'complete',automatic:false,
    createdAt:Date.now(),args:{},facts:{tool:'github_git'},actor:{triggerId:duplicateReply.id,runId:duplicateReply.id,
      conversationId:chat.id,workerId:'reviewer',ticketId,mode:'ask'}})
  const obsoleteId=host.store.tickets.get(ticketId)!.attention!.id
  const obsolete=host.store.get<object>('business-decision',obsoleteId)!
  host.store.put('business-decision',obsoleteId,{...obsolete,status:'answered',answer:{text:'？',at:Date.now()}})
 })
 await f.until(host,()=>deploymentBlockers(host.store).length===0)
 host.store.put('chat-permission','legacy-unconfirmed',{actor:{ticketId},phase:'uncertain'})
 expect(deploymentBlockers(host.store)).toContainEqual({kind:'tasks',count:1})
 host.store.db.prepare("DELETE FROM records WHERE kind='chat-permission' AND id='legacy-unconfirmed'").run()
 if(maintenance)host.pause(true)
 await host.close();hosts.delete(host)
 const reopened=f.open()
 if(maintenance){
  expect(reopened.store.get<Run>('run',ticketId)).toEqual({...run,phase:'uncertain',error:'Error: async_worker_goal_unavailable'})
  expect(reopened.store.tickets.get(ticketId)?.attention?.question).toBe(legacyExecutionQuestion)
  const operationId=randomUUID()
  await expect(deploymentMaintenance(reopened,{action:'prepare',operationId,
    expectedRevision:reopened.settings.current().revision,legacyPauseSeq:pauseControl(reopened).seq})).resolves.toMatchObject({state:'prepared'})
  await reopened.tick()
  expect(f.reviews).toHaveLength(1)
  await expect(deploymentMaintenance(reopened,{action:'finish',operationId})).resolves.toMatchObject({state:'finished',resumed:true})
 }
 await f.until(reopened,()=>f.reviews.length===2&&!reopened.executionActive(ticketId))
 expect(reopened.chat.businessDecisions(chat.id,owner)).toEqual([expect.objectContaining({id:decision.id,status:'answered',fileHandoff:{state:'ready',missing:[]}})])
 expect(reopened.store.tickets.get(ticketId)?.attention).toBeUndefined()
 expect(reopened.chat.permissionActor(original.id,ticketId)?.mode).toBe('full')
 expect(reopened.chat.view(chat.id,owner).approvals).toEqual([])
 expect(reopened.chat.approvalHistory(chat.id,owner).items.map(item=>item.id)).toContain('legacy-clone')
 reopened.chat.setApprovalMode(owner,'ask')
 reopened.chat.setApprovalMode(owner,'full')
 expect(reopened.chat.permissionActor(original.id,ticketId)?.mode).toBe('ask')
})

it('keeps an uncertain execution after the saved answer as a blocked status across restart',async()=>{
 const f=await fixture(),{host,chat,owner,ticketId,decision}=f
 host.chat.decide(chat.id,owner,f.input)
 const run=host.store.get<Run>('run',ticketId)!
 host.store.put('run',ticketId,{...run,phase:'uncertain',error:'Execution outcome requires reconciliation'})
 await host.close();hosts.delete(host)
 const reopened=f.open()
 await reopened.tick()
 expect(reopened.chat.businessDecisions(chat.id,owner)).toEqual([expect.objectContaining({id:decision.id,status:'answered'})])
 expect(reopened.store.tickets.get(ticketId)?.attention).toBeUndefined()
 expect(reopened.store.get<Run>('run',ticketId)?.phase).toBe('uncertain')
 expect(f.reviews).toHaveLength(1)
})
