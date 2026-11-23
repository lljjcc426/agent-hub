import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {afterEach,expect,it,vi} from 'vitest'
import {Runtime} from '../src/runtime.ts'
import {configSchema} from '../src/config.ts'
import {ChatDeliveries} from '../src/chat-deliveries.ts'
import {restoreRetainedFiles} from '../src/chat-file-handoff.ts'
import {goalHandoffEvidence} from '../src/goal-handoff-evidence.ts'
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

async function fixture(missing=false,nameSource=false){
 let originalQuestion=question
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
   {state:'blocked',summary,reply:'',question:originalQuestion,handbacks:[]}
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
 if(nameSource)originalQuestion=question.replace('旧任务留存的','旧任务 `'+sourceId+'` 留存的')
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

it.each([false,true])('keeps the approval and resumes the same held task with exact read-only copies (upgrade=%s)',async upgrade=>{
 const f=await fixture(),{host,chat,owner,decision,sourceId,ticketId}=f
 expect(decision.target.label).toBe('验收原有文件')
 const assignment=host.store.tickets.get(ticketId)!.assignments.at(-1)!.id
 let current=host
 if(upgrade){
  const state=()=>[current.store.get('router-goal',f.goal.id),current.store.get('ticket',ticketId),
   current.store.get('run',ticketId),current.store.get('business-decision',decision.id)]
  const checkpoint=state(),operationId=randomUUID()
  const maintenance={action:'prepare',operationId,expectedRevision:host.settings.current().revision}
  host.store.put('chat-permission','unfinished',{actor:{ticketId},phase:'uncertain'})
  await expect(deploymentMaintenance(host,maintenance)).rejects.toMatchObject({code:'deployment_busy'})
  host.store.db.prepare("DELETE FROM records WHERE kind='chat-permission' AND id='unfinished'").run()
  await expect(deploymentMaintenance(host,maintenance)).resolves.toMatchObject({state:'prepared'})
  await host.close();hosts.delete(host)
  current=f.open()
  expect(state()).toEqual(checkpoint)
  await expect(deploymentMaintenance(current,{action:'finish',operationId})).resolves.toMatchObject({resumed:true})
  await current.tick()
  expect(state()).toEqual(checkpoint)
  expect(f.reviews).toHaveLength(1)
  expect(current.chat.businessDecisions(chat.id,owner)).toEqual([expect.objectContaining({id:decision.id,status:'pending'})])
 }
 expect(current.chat.decide(chat.id,owner,f.input).decision.status).toBe('answered')
 expect(current.chat.decide(chat.id,owner,f.input).duplicate).toBe(true)
 await f.until(current,()=>f.reviews.length===2&&!current.executionActive(ticketId))
 const continued=f.reviews[1]!,{chatFiles}=JSON.parse(continued.input)
 expect(continued.activity?.ticketId).toBe(ticketId)
 expect(current.chat.permissionActor(continued.activity!.triggerId!,ticketId)?.mode).toBe('full')
 expect(continued.instructions).not.toMatch(/permission mode|native_permission_decision/)
 expect(continued.tools!.find(tool=>tool.name==='superagent_tool')?.inputSchema.properties).not.toHaveProperty('pendingNotice')
 expect(continued.threadId).toBeDefined()
 expect(current.store.tickets.get(ticketId)!.assignments.map(item=>item.id)).toEqual([assignment])
 expect(chatFiles.map((item:{relativePath:string})=>item.relativePath)).toEqual([patch,report,installer])
 expect(chatFiles.map((item:{path:string})=>item.path)).toEqual(continued.attachments)
 for(const file of chatFiles)expect(statSync(file.path).mode&0o777).toBe(0o400)
 expect(readFileSync(chatFiles[0].path)).toEqual(patchBytes)
 expect(readFileSync(chatFiles[2].path)).toEqual(packageBytes)
 expect(current.store.tickets.get(sourceId)?.ended?.by).toBe('human')
 expect(current.chat.businessDecisions(chat.id,owner)).toEqual([expect.objectContaining({id:decision.id,status:'answered',fileHandoff:{state:'ready',missing:[]}})])
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

it('binds acceptance to the original delivered question, human reply and task handoff, while retaining older rounds',async()=>{
 const f=await fixture(),{host,owner,chat,sourceId,ticketId,decision}=f
 host.chat.decide(chat.id,owner,f.input)
 await f.until(host,()=>f.reviews.length===2&&!host.executionActive(ticketId))
 const goal=host.goals.get(f.goal.id)!,node=goal.nodes!.find(n=>n.ticketId===ticketId)!
 const receipt=host.store.get<object>('chat-file-handoff',decision.id)!
 const remove=(kind:string,id:string)=>host.store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id)
 remove('chat-file-handoff',decision.id)
 expect(host.verification.capture(ticketId,{state:'ready',summary:'Inspection finished',question:null})).toBe(true)
 const initial=host.verification.ensure(goal,node)
 const {handoffEvidence,...old}=initial
 expect(handoffEvidence).toBe(true)
 expect(old.snapshot.evidence.some(e=>e.key==='chat-file-handoff')).toBe(false)
 host.store.put('chat-file-handoff',decision.id,receipt)
 expect(host.verification.current(old,goal,{readOnly:true})).toBe(true)
 expect(host.verification.current(initial,goal,{readOnly:true})).toBe(false)
 const round=host.verification.ensure(goal,node)
 const evidence=round.snapshot.evidence.find(e=>e.key==='chat-file-handoff')!
 expect(evidence?.ticketId).toBe(ticketId)
 const proof=JSON.parse(evidence.content).handoffs[0]
 expect(proof).toMatchObject({receiptId:decision.id,ticketId,sourceTicketId:sourceId,conversationId:chat.id,
  exchanges:[{decisionId:decision.id,question:{text:question,role:'assistant',workerId:'reviewer',status:'complete'},answer:{role:'user',text:'可以'}}]})
 expect(proof.files.map((file:{relativePath:string})=>file.relativePath).sort()).toEqual([patch,report,installer].sort())
 expect(host.verification.current(round,goal,{readOnly:true})).toBe(true)
 const ask=proof.exchanges[0].question.messageId,answer=proof.exchanges[0].answer.messageId
 const original=host.store.get<object>('chat-message',ask)!,reply=host.store.get<object>('chat-message',answer)!
 host.store.put('chat-message',ask,{...original,status:'interrupted'})
 expect(host.verification.current(round,goal,{readOnly:true})).toBe(false)
 const read=()=>JSON.parse(host.verification.ensure(goal,node).snapshot.evidence.find(e=>e.key==='chat-file-handoff')!.content).handoffs[0]
 expect(read().exchanges).toEqual([])
 host.store.put('chat-message',ask,original)
 host.store.put('chat-message',answer,{...reply,conversationId:'other-private-chat'})
 expect(read().exchanges).toEqual([])
 host.store.put('chat-message',answer,reply)
 const saved=host.store.get<object>('question-answer',proof.exchanges[0].answerReceiptId)!
 host.store.put('question-answer',proof.exchanges[0].answerReceiptId,{...saved,answerDigest:'unrelated'})
 expect(read().exchanges).toEqual([])
 host.store.put('question-answer',proof.exchanges[0].answerReceiptId,saved)
 expect(host.verification.current(round,goal,{readOnly:true})).toBe(true)
})

it.each([true,false])('includes only explicitly linked questions for a restored manifest (named source=%s)',async named=>{
 const f=await fixture(false,named),{host,ticketId,sourceId,chat,owner}=f
 const files=[patch,report,installer].map(path=>{
  const binary=readFileSync(join(f.cwd,path))
  return {path,bytes:binary.length,sha256:createHash('sha256').update(binary).digest('hex')}
 })
 const hold=vi.spyOn(host.goals,'resumeAnsweredQuestion').mockReturnValue(false)
 const text='你自己找，就在本机'
 host.chat.decide(chat.id,owner,{...f.input,text})
 hold.mockRestore()
 const restored=await restoreRetainedFiles(host,{ticketId,sourceTicketId:sourceId,files},()=>{},new AbortController().signal)
 const goal=host.goals.get(f.goal.id)!,context=host.goals.context(goal),read=()=>goalHandoffEvidence(host,goal,ticketId,context)
 const [proof]=read()
 expect(proof).toMatchObject({receiptId:restored.id,sourceTicketId:sourceId})
 expect(proof!.files.map(f=>[f.relativePath,f.sha256]).sort()).toEqual(files.map(f=>[f.path,f.sha256]).sort())
 expect(proof!.exchanges.map(e=>e.answer.text)).toEqual(named?[text]:[])
 const asset=restored.files[0]!.id,saved=host.store.get<object>('asset',asset)!
 host.store.put('asset',asset,{...saved,sha256:'0'.repeat(64)})
 expect(read()).toEqual([])
 host.store.put('asset',asset,saved)
 const cleanup=host.memory.cleanup.blocked.bind(host.memory.cleanup)
 vi.spyOn(host.memory.cleanup,'blocked').mockImplementation((kind,id,value)=>kind==='asset'&&id===asset||cleanup(kind,id,value))
 expect(read()).toEqual([])
})
