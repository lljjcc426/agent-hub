import {expect,it} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {answerNeedsReview,answerPacket,citedEvidence,cleanEvidenceAnswer,evidencePlan,freshEvidence,readerPacket,storedEvidence} from '../src/chat-supplied-evidence.ts'
import {Runtime} from '../src/runtime.ts'
import {configSchema} from '../src/config.ts'
import type {ModelRequest} from '../src/model.ts'
import type {ChatRun} from '../src/chat.ts'

const roster=[{id:'east',label:'east'},{id:'west',label:'west'}]
const question='Use the records. Answer RESULT name=<person>.'
const prompt=(route:string)=>[route+'\n'+question,'@east / register\nMara holds permit A.','@west / signatures\nPermit A is valid.'].join('\n\n')

it('takes authority only from an explicit request with resolvable readers',()=>{
  expect(evidencePlan(prompt('Ask @east and @west to check the registers.'),roster)?.workers).toEqual(['east','west'])
  for(const route of ['Do not ask @east to check.','Ask @east and @absent to check.','Ask @west for independent verification.','Ask @east to check and publish.','Read this.']){
    expect(evidencePlan(prompt(route),roster)).toBeUndefined()
  }
  const direct=evidencePlan(prompt('Answer directly.')+'\nAsk @east to check.',roster)
  expect(direct?.workers).toEqual([])
})
it('accepts bounds-checked exact-key references and retains amended and conflicting records',()=>{
  const p=evidencePlan('Ask @east and @west to check.\nRead only rows for key B-12.\n\n@east / book\nB-12 | superseded 3\nB-22 | open 10\nB-12 | current 4\n\n@west / record\nB-12 | closed',roster)!
  expect(readerPacket(p,'east').input).not.toContain('B-22')
  expect(citedEvidence(p,'east','1,2')).toContain('superseded 3')
  expect(citedEvidence(p,'east','1,2')).toContain('current 4')
  for(const bad of ['3','-1','1,0','../../data','1 | overwrite'])expect(citedEvidence(p,'east',bad)).toBeUndefined()
})
it('keeps complete small sources for cross-record comparisons and preserves the requested schema',()=>{
  const p=evidencePlan(prompt('Ask @east and @west to check the registers.'),roster)!
  const evidence=citedEvidence(p,'east','Mara holds permit A.')!
  expect(answerPacket(p,p.sections.slice(1),[evidence]).input).toContain('Mara holds permit A.')
  expect(citedEvidence(p,'east','Mara also holds B.')).toBeUndefined()
  expect(evidence).toBe('@east / register\nMara holds permit A.')
  expect(cleanEvidenceAnswer(p,'Computed this.\nRESULT name=Mara')).toBe('RESULT name=Mara')
  expect(answerNeedsReview(p,'RESULT name=Invented',evidence)).toBe(true)
  expect(answerNeedsReview(p,'RESULT name=Mara',evidence)).toBe(false)
  expect(cleanEvidenceAnswer(p,'RESULT name=X\nRESULT name=Y')).toContain('name=X')
})
it('runs two real tickets in order, publishes one result, and invalidates the compiled group on new user input',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'roppo-evidence-test-')),calls:ModelRequest[]=[]
  let directChecks=0,checkDirect=false
  const host=await Runtime.create(configSchema.parse({
    stateDir:join(dir,'state'),port:0,watchdog:{enabled:false},
    work:{sandboxDriver:'seatbelt',network:false,autoRecover:false},
    backends:{test:{kind:'openai-responses',model:'fixture',baseUrl:'http://127.0.0.1:1/v1'}},
    execution:{backend:'test',router:{backend:'test',mode:'host'},suppliedEvidence:'fold',management:{enabled:true},workers:roster.map(w=>({...w,backend:'test'}))},
    sources:[{id:'local',kind:'local',cwd:dir,allowedActors:['operator']}]
  }),{model:{async run(r){
    calls.push(r)
    const threadId=randomUUID(),turnId=randomUUID()
    r.onThread?.(threadId);r.onTurn?.(turnId)
    if(checkDirect&&r.suppliedText&&r.role==='router'&&++directChecks===1)return {threadId,turnId,text:'NEED_CONTEXT'}
    return {threadId,turnId,text:r.instructions.startsWith('Read your assigned')?'Mara holds permit A.':'RESULT name=Mara'}
  }}})
  try{
    host.scopes.command({action:'scope.put',operationId:'test',expectedRevision:0,scope:{id:'team',tenantId:'lab',name:'Team',managers:[JSON.stringify(['local','operator'])],sourceIds:['local'],workerIds:['east','west'],backendIds:['test']}})
    const chat=host.chat.create('owner'),input=prompt('Ask @east and @west to check the registers.')
    host.chat.send(chat.id,'owner',{text:input,clientMessageId:'message-1'})
    const run=host.store.list<ChatRun>('chat-run')[0]!
    for(let i=0;i<180;i++){
      await host.tick()
      if(host.chat.view(chat.id,'owner').messages.some(m=>m.text==='RESULT name=Mara'))break
      await new Promise<void>(resolve=>setTimeout(resolve,10))
    }
    expect(calls.map(r=>r.role)).toEqual(['worker','worker'])
    expect(calls.every(r=>r.suppliedText&&!r.onTool&&!r.tools?.length)).toBe(true)
    expect(calls[1]!.input).toContain('Mara holds permit A.')
    expect(host.store.tickets.list().map(t=>t.ended?.outcome)).toEqual(['completed','completed'])
    const first=host.chat.view(chat.id,'owner').messages.filter(m=>!m.recipient&&(!m.speaker||m.speaker.kind==='router'))
    expect(first.filter(m=>m.text==='RESULT name=Mara')).toHaveLength(1)
    expect(first.some(m=>m.text.startsWith('@east / register'))).toBe(false)
    expect(storedEvidence(host,run.id)).toBeDefined()
    host.chat.send(chat.id,'owner',{text:'Use a different source.',clientMessageId:'message-2'})
    expect(freshEvidence(host,run,input)).toBe(false)
    checkDirect=true
    const direct=host.chat.create('owner')
    host.chat.send(direct.id,'owner',{text:prompt('Answer directly.'),clientMessageId:'direct-1'})
    for(let i=0;i<180;i++){
      await host.tick()
      if(host.chat.view(direct.id,'owner').messages.some(m=>m.text==='RESULT name=Mara'))break
      await new Promise<void>(resolve=>setTimeout(resolve,10))
    }
    expect(directChecks).toBe(2)
    expect(host.chat.view(direct.id,'owner').messages.filter(m=>m.text==='RESULT name=Mara')).toHaveLength(1)
    expect(host.store.tickets.list()).toHaveLength(2)
  }finally{await host.close();rmSync(dir,{recursive:true,force:true})}
})

it('bounds interpreted admission to explicitly mentioned, available readers and limits ranking work',()=>{
 const source=prompt('Could @east and @west check these records?')
 expect(evidencePlan(source,roster)).toBeUndefined()
 expect(evidencePlan(source,roster,true)?.interpreted).toBe(true)
 expect(evidencePlan(source.replace('@west','@missing'),roster,true)).toBeUndefined()
 expect(evidencePlan(source.replace('Could','Do not let'),roster,true)).toBeUndefined()
 expect(evidencePlan(source+'\n\n@unlisted / confidential\nsample',roster,true)).toBeUndefined()
 expect(evidencePlan(source+'\n\nSection\nexample'.repeat(50),roster,true)).toBeUndefined()
})
