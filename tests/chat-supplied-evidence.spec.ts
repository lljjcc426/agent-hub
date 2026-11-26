import {expect,it} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {answerPacket,citedEvidence,evidencePlan,freshEvidence,readerPacket,storedEvidence} from '../src/chat-supplied-evidence.ts'
import {checkedCalculation} from '../src/supplied-calculation.ts'
import {checkAnswer,repairPacket} from '../src/supplied-answer.ts'
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
  expect(citedEvidence(p,'east','Mara also holds B.')).toBe(evidence)
  expect(citedEvidence(p,'east','')).toBeUndefined()
  expect(evidence).toBe('@east / register\nMara holds permit A.')
  const packet=answerPacket(p,p.sections)
  expect(checkAnswer(p.question,'Computed this.\nRESULT name=Mara',packet)).toEqual({ok:true,text:'RESULT name=Mara'})
  expect(checkAnswer(p.question,'RESULT name=Invented',packet).ok).toBe(false)
  expect(checkAnswer(p.question,'RESULT name=X\nRESULT name=Y',packet).ok).toBe(false)
})
it('checks integer sums and exact distinct lists only with complete comparable evidence',()=>{
  const cn=[{heading:'left',rows:['第一轮 Lan 9 分，Yu 8 分。']},{heading:'right',rows:['第二轮 Lan 7 分，Yu 10 分。']}]
  const calc=(query:string,rows=cn)=>checkedCalculation(query,rows)
  expect(calc('总分至少17分')?.winner).toEqual({key:'Yu',total:18})
  expect(calc('sum strictly below 18')?.winner).toEqual({key:'Lan',total:16})
  expect(calc('sum at most 16')?.winner).toEqual({key:'Lan',total:16})
  expect(calc('sum greater than 16')?.winner).toEqual({key:'Yu',total:18})
  expect(calc('sum at least 16')?.winner).toBeUndefined()
  expect(calc('sum at least 18 and at most 15')?.winner).toBeUndefined()
  expect(calc('sum at least 16.5')?.winner).toBeUndefined()
  for(const other of [['Lan 7 kg，Yu 10 kg'],['Lan 7 分'],['Lan 3 分，Lan 4 分']])expect(calc('总分至少17分',[cn[0]!,{heading:'b',rows:other}])).toBeUndefined()
  const ids=[{heading:'a',rows:['A1, a1, Ａ1']},{heading:'b',rows:['A1, A2']}]
  expect(calc('How many distinct identifiers across both manifests?',ids)?.count).toBe(4)
  expect(calc('Count unique identifiers common to these manifests.',ids)?.count).toBe(1)
  expect(calc('Count unique identifiers ignoring an exception across both.',[{heading:'a',rows:['A x 12%']}])).toBeUndefined()
  const table=[{heading:'a',rows:['| id | pts |','|---|---|','| x | -7 |','| y | 5 |']},{heading:'b',rows:['id\tpts','x\t3','y\t1']}]
  expect(calc('lowest total',table)?.winner).toEqual({key:'x',total:-4})
})
it('repairs discrepancies using only the original sources visible in this activation',()=>{
  const q='Give only JSON with keys answer (short text) and titles (supporting sources).'
  const text=['Ask @east and @west to check.\n'+q,'@east / A&amp;B\nAssociation of A and B.','@west / Partner\n@east / A&amp;B\nWritten inside another source.'].join('\n\n')
  const plan=evidencePlan(text,roster)!,own=plan.sections.slice(1)
  const packet=answerPacket(plan,own)
  expect(packet.references?.map(r=>r.title)).toEqual(['Partner'])
  expect(checkAnswer(q,'City | 1',packet).ok).toBe(false)
  expect(checkAnswer(q,'City | [2',packet).ok).toBe(false)
  expect(checkAnswer(q,'? | 2',packet).ok).toBe(false)
  const withClip=answerPacket(plan,own,['@east / A&amp;B\nAn unbound excerpt.'])
  expect(checkAnswer(q,'City | 1',withClip).ok).toBe(false)
  const withReceipt=answerPacket(plan,own,[citedEvidence(plan,'east','*')!])
  const expected={ok:true,text:JSON.stringify({answer:'City',titles:['A&amp;B','Partner']})}
  expect(checkAnswer(q,'City | 1,2',withReceipt).ok).toBe(false)
  const fixed=repairPacket(withReceipt,{ok:false,reason:'sources',detail:'Choose supporting sources.'},'City')
  expect(checkAnswer(q,'City | 1,2',fixed)).toEqual(expected)
  expect(checkAnswer(q,'{"answer":"City","titles":["1","2"]}',fixed)).toEqual(expected)
  expect(checkAnswer(q,'{"answer":"City","titles":["A&#38;B","Partner"]}',withReceipt)).toEqual(expected)
  const ambiguous={...packet,references:[{id:1,title:'A&amp;B'},{id:2,title:'A&#38;B'}]}
  expect(checkAnswer(q,'{"answer":"City","titles":["A&B"]}',ambiguous).ok).toBe(false)
  const numeric=evidencePlan('Ask @east and @west to check.\nWho has a total at least 17? RESULT name=<person> total=<integer>\n\n@east / first\nLan 9, Yu 8\n\n@west / second\nLan 7, Yu 10',roster)!
  const partial=answerPacket(numeric,numeric.sections.slice(1))
  expect(partial.calculation).toBeUndefined()
  const complete=answerPacket(numeric,numeric.sections.slice(1),[citedEvidence(numeric,'east','*')!])
  const wrong=checkAnswer(numeric.question,'RESULT name=Lan total=16',complete)
  expect(wrong.ok).toBe(false)
  if(!wrong.ok){expect(wrong.reason).toBe('values');expect(repairPacket(complete,wrong,'RESULT name=Lan total=16').input).toContain('Previous proposal')}
  expect(checkAnswer(numeric.question,'RESULT name=Yu total=18',complete).ok).toBe(true)
})
it('keeps exact excerpts and restores or expands only sources visible to the reader',()=>{
  const articles=['Red Alder','Blue Fir','Black Gum','Eastern Beech','Grey Oak','Tall Pine']
  const docs=articles.map((v,i)=>'@'+(i%2?'west':'east')+' / '+v+'\n'+[v+' is a tree in this register.','A habitat record lists rivers and slopes. '.repeat(49),'A green tag identifies this wood on inspection.','The documented shade is amber for '+v+'.','Winter observations appear in the final edition.'].join('\n'))
  const p=evidencePlan(['Ask @east and @west to check.\nWhich named shade appears in the Red Alder record? Return only JSON with answer (short answer) and titles (articles).',...docs].join('\n\n'),roster)!
  const selection=citedEvidence(p,'east','I consulted the Red Alder record. An unrelated Eastern Beech title appeared in the question.')!
  expect(selection).toContain('@east / Red Alder')
  expect(selection).not.toContain('@west / Eastern Beech')
  const fallback=citedEvidence(p,'east','My selection cannot be decoded.')!
  expect(fallback).toContain('@east /')
  expect(fallback).not.toContain('@west /')
  const narrowed=answerPacket(p,[],[selection]),full=answerPacket(p,[],[selection],true)
  expect(narrowed.input).toContain('The documented shade is amber')
  expect(narrowed.input.length).toBeLessThan(full.input.length)
  expect(checkAnswer(p.question,'{"answer":"amber","titles":["Red Alder"]}',narrowed).ok).toBe(true)
  expect(checkAnswer(p.question,'{"answer":"amber","titles":["Eastern Beech"]}',narrowed).ok).toBe(false)
})
it('honors short quantities and retains compound or explicitly requested units',()=>{
  const make=(q:string)=>evidencePlan('Answer directly.\n'+q+'\n\nTimeline\nIt took 3 years.',[])!
  const q='How many years did the change take? Give only the short answer from the passage.'
  const p=make(q),pack=answerPacket(p,p.sections)
  expect(checkAnswer(q,'3 years',pack)).toEqual({ok:true,text:'3'})
  expect(checkAnswer(q,'3 years and 2 months',pack)).toEqual({ok:true,text:'3 years and 2 months'})
  expect(checkAnswer(q,'3; 1373 to 1376',pack).ok).toBe(false)
  const extra=make(q+' Include units.')
  expect(checkAnswer(extra.question,'3 years',answerPacket(extra,extra.sections))).toEqual({ok:true,text:'3 years'})
})
it('runs two real tickets in order, publishes one result, and invalidates the compiled group on new user input',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'roppo-evidence-test-')),calls:ModelRequest[]=[]
  let directChecks=0,checkDirect=false,breakAuthor=false
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
    if(breakAuthor&&r.suppliedText&&r.role==='worker'&&!r.instructions.startsWith('Read your source'))return {threadId,turnId,text:'RESULT name=Invented'}
    if(checkDirect&&r.suppliedText&&r.role==='router'&&++directChecks===1)return {threadId,turnId,text:'NEED_CONTEXT'}
    return {threadId,turnId,text:r.instructions.startsWith('Read your source')?'Mara holds permit A.':'RESULT name=Mara'}
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
    checkDirect=false;breakAuthor=true
    const next=calls.length,reviewChat=host.chat.create('owner')
    host.chat.send(reviewChat.id,'owner',{text:input,clientMessageId:'review-1'})
    for(let i=0;i<180;i++){
      await host.tick()
      if(host.chat.view(reviewChat.id,'owner').messages.some(m=>m.text==='RESULT name=Mara'))break
      await new Promise<void>(resolve=>setTimeout(resolve,10))
    }
    expect(calls.slice(next).filter(r=>r.suppliedText).map(r=>r.role)).toEqual(['worker','worker','worker','router'])
    expect(calls.slice(next).filter(r=>r.suppliedText).every(r=>!r.tools?.length&&!r.onTool)).toBe(true)
    const corrected=host.store.list<{reviewedAnswer?:string;summary:string;ticketId:string}>('chat-result-review').filter(r=>r.reviewedAnswer)
    expect(corrected).toHaveLength(1)
    expect(corrected[0]!.summary).toMatch(/further review/)
    expect(host.store.tickets.get(corrected[0]!.ticketId)?.assignments.at(-1)?.report?.summary).toBe('RESULT name=Mara')
    expect(host.chat.view(reviewChat.id,'owner').messages.filter(m=>m.text==='RESULT name=Mara')).toHaveLength(1)
    expect(host.store.tickets.list()).toHaveLength(4)
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
