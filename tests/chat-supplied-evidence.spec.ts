import {expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {answerPacket,citedEvidence,evidencePlan,freshEvidence,namedEvidenceGroup,policyEvidenceGroup,readerPacket,storedEvidence} from '../src/chat-supplied-evidence.ts'
import {checkedCalculation} from '../src/supplied-calculation.ts'
import {checkAnswer,repairPacket} from '../src/supplied-answer.ts'
import {Runtime} from '../src/runtime.ts'
import {configSchema} from '../src/config.ts'
import type {ModelRequest} from '../src/model.ts'
import {TransientModelError} from '../src/model.ts'
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
it('admits a shared passage only within the authority of the full message',()=>{
  const user='Could @east and @west review this? Zeta is listed in aisle A. An amendment moves Zeta to B. Which aisle holds Zeta? Reply only with the letter.'
  expect(evidencePlan(user,roster)).toBeUndefined()
  const p=evidencePlan(user,roster,true)!
  expect(p.workers).toEqual(['east','west'])
  expect(p.direction).toBe(user)
  const result=citedEvidence(p,'east','{"lines":[2]}')!,packet=answerPacket(p,p.sections,[result])
  expect(result).toMatch(/amendment/)
  expect(packet.input.match(/amendment/g)).toHaveLength(1)
  expect(packet.input).toContain('1 Zeta is listed in aisle A.')
  expect(packet.input).not.toContain('Reader-selected')
  expect(citedEvidence(p,'east','{"lines":[3]}')).toBeUndefined()
  expect(citedEvidence(p,'east','B')).toBeUndefined()
  expect(checkAnswer(p.question,'B',packet).ok).toBe(false)
  expect(checkAnswer(p.question,'{"rows":["old","use"],"value":"B"}',packet).ok).toBe(true)
  for(const value of ['A','Unlisted Person'])expect(checkAnswer(p.question,JSON.stringify({rows:['old','use'],value}),packet).ok).toBe(false)
  expect(evidencePlan('Ink costs 45. Pens cost 30. Please answer directly with the cheaper item.',roster)?.workers).toEqual([])
  for(const invalid of [user.replace('this','confidential files'),user.replace('@west','@absent'),user.replace('amendment','@west amendment'),user.replace('Could @east','Suppose @east'),user.replace('review','publish')]){
    expect(evidencePlan(invalid,roster,true)).toBeUndefined()
  }
  expect(evidencePlan('Ink costs 45. Pens cost 30. Do not answer directly; ask for help.',roster)).toBeUndefined()
})
it('binds ordinary briefs to the original participants and never redistributes the message after a negative intake',async()=>{
  const text='Could @east and @west review these records? One schedule uses A. Another uses B. Which applies?'
  const answers=['{"route":"PLAN"}','{"access":"individual","briefs":{"east":"Verify your assigned entry.","west":"Review your own addendum."}}']
  const read=async()=>({text:answers.shift()!,threadId:'t',turnId:'r'})
  const first=await namedEvidenceGroup(text,roster,true,read)
  expect(first.group).toMatchObject({workers:['east','west'],ordinary:true,briefs:{east:'Verify your assigned entry.'}})
  expect(first.plan).toBeUndefined()
  const replay=await namedEvidenceGroup(text,roster,true,async()=>{throw Error('unexpected replay')},first.group)
  expect(replay.group).toEqual(first.group)
  const plainLayout='Could @east and @west review the files?\nDifferent layout\nWhat applies?'
  const decisions=['{"route":"READ"}','{"access":"shared","briefs":{"east":"","west":""}}']
  const ordinary=await namedEvidenceGroup(plainLayout,roster,true,async()=>({text:decisions.shift()!,threadId:'x',turnId:'y'}))
  expect(ordinary.group).toMatchObject({ordinary:true,workers:['east','west']})
  expect(ordinary.plan).toBeUndefined()
  const quoted='Yesterday I wrote “please have @east and @west review these records”. What does that sentence mean?'
  expect(await namedEvidenceGroup(quoted,roster,true,async()=>{throw Error('no activation expected')})).toEqual({})
})
it('requires the original link from the requested key to the cited answer',()=>{
  const p=evidencePlan('请 @east 和 @west 一起核对。旧编号 K1 对应账册 J7。J7 归 Uma，J8 归 Neri。请只回 K1 当前的保管人姓名。',roster,true)!
  const packet=answerPacket(p,p.sections)
  expect(checkAnswer(p.question,JSON.stringify({rows:['other','use'],value:'Uma'}),packet)).toMatchObject({ok:true,rows:['use','use']})
  expect(checkAnswer(p.question,JSON.stringify({rows:['old','use'],value:'Uma'}),packet).ok).toBe(false)
  expect(checkAnswer(p.question,JSON.stringify({rows:['use','use'],value:'Neri'}),packet).ok).toBe(false)
  expect(checkAnswer(p.question,JSON.stringify({rows:['use','use'],value:'Uma'}),packet).ok).toBe(true)
  const partial=answerPacket(p,[],[citedEvidence(p,'east','{"lines":[2]}')!])
  expect(partial.input).not.toContain('旧编号')
  expect(checkAnswer(p.question,'{"r1":"U","value":"Uma"}',partial).ok).toBe(false)
})
it('computes a complement only for one complete rounded age distribution',()=>{
  const q='How many percent were not from 18 to 59? Give only the short answer.'
  const rows=['16.2% under 18, 61.5% from 18 to 59, and 22.2% aged 60 or older.']
  expect(checkedCalculation(q,[{heading:'A',rows}])?.complement).toBe(38.5)
  const p=evidencePlan('Answer directly.\n'+q+'\n\nA\n'+rows[0],[])!
  expect(checkAnswer(q,'16.2;22.2',answerPacket(p,p.sections))).toMatchObject({ok:true,text:'38.5',arithmetic:expect.any(String)})
  const multipart=q+' Also describe the median.'
  expect(answerPacket({...p,question:multipart},p.sections).calculation).toBeUndefined()
  for(const text of [rows[0]!.replace('under 18','under 20'),rows[0]!.replace('22.2%','12.2%')])
    expect(checkedCalculation(q,[{heading:'A',rows:[text]}])).toBeUndefined()
  expect(checkedCalculation(q,[{heading:'A',rows},{heading:'B',rows}])).toBeUndefined()
})
it('checks explicit net counts across alternatives and leaves mixed-unit comparisons to the reader',()=>{
  const q='Which location has more unreserved stock? Give only the name.'
  const message='Could @east and @west review these records? Cedar has 9 units, of which 5 are reserved. Maple has 7 units. '+q
  const plan=evidencePlan(message,roster,true)!,packet=answerPacket(plan,plan.sections)
  expect(packet.passage?.winningRow).toBe(1)
  expect(checkAnswer(q,'{"r1":"U","r2":"U","value":"Cedar"}',packet)).toMatchObject({ok:true,text:'Maple',arithmetic:expect.stringContaining('9 - 5 = 4')})
  expect(checkAnswer(q,'{"r1":"U","r2":"U","value":"Unlisted"}',packet).ok).toBe(false)
  expect(checkAnswer(q,'{"r1":"U","r2":"U","value":"Maple"}',packet).ok).toBe(true)
  const mixed=evidencePlan(message.replace('7 units','7 boxes'),roster,true)!
  expect(answerPacket(mixed,mixed.sections).passage?.winningRow).toBeUndefined()
  for(const altered of [message.replace('are reserved','are not reserved'),message.replace('9 units,','9 units available,')]){
    const variant=evidencePlan(altered,roster,true)!
    expect(answerPacket(variant,variant.sections).passage?.winningRow).toBeUndefined()
  }
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

it('reconciles a partial ordinary dispatch on the original Chat without creating a shared grant or duplicate ticket',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'roppo-participants-')),calls:ModelRequest[]=[]
 let transient=true,stopGate=false,release=()=>{},entered=false
 const host=await Runtime.create(configSchema.parse({
  stateDir:join(dir,'state'),port:0,watchdog:{enabled:false},work:{sandboxDriver:'seatbelt',network:false,autoRecover:false},
  backends:{test:{kind:'openai-responses',model:'fixture',baseUrl:'http://127.0.0.1:1/v1'}},
  execution:{backend:'test',router:{backend:'test',mode:'host'},suppliedEvidence:'fold',management:{enabled:true},workers:roster.map(w=>({...w,backend:'test'}))},
  sources:[{id:'local',kind:'local',cwd:dir,allowedActors:['operator']}]
 }),{model:{async run(r){
   calls.push(r)
   const threadId=randomUUID(),turnId=randomUUID()
   r.onThread?.(threadId);r.onTurn?.(turnId)
   if(r.suppliedText&&transient){transient=false;throw new TransientModelError('Transient before any tools')}
   if(r.suppliedText&&stopGate){entered=true;await new Promise<void>(resolve=>{release=resolve})}
   let text
   if(r.suppliedText)text=r.schema.properties&&'route' in (r.schema.properties as object)?'{"route":"PLAN"}':'{"access":"individual","briefs":{"east":"Review receipt Alpha.","west":"Review receipt Beta."}}'
   else if(r.role==='worker')text=JSON.stringify({state:'ready',summary:'Checked my receipt.',reply:'Checked my receipt.',question:null,askedBy:null,files:[],handbacks:[]})
   else text=JSON.stringify({reply:'The two receipts agree.',decision:'answer',nextStep:''})
   return {text,threadId,turnId}
 }}})
 try{
   host.scopes.command({action:'scope.put',operationId:'test',expectedRevision:0,scope:{id:'team',tenantId:'lab',name:'Team',managers:[JSON.stringify(['local','operator'])],sourceIds:['local'],workerIds:['east','west'],backendIds:['test']}})
   const assign=host.manager.call.bind(host.manager),westKeys:string[]=[]
   vi.spyOn(host.manager,'call').mockImplementation(async(args,...rest)=>{
     const x=args as {action:string;id:string;requestId:string}
     if(x.action==='assign'&&x.id==='west'){westKeys.push(x.requestId);if(westKeys.length===1)throw Error('Temporary failure before assignment')}
     return assign(args,...rest)
   })
   const chat=host.chat.create('owner'),input={text:'Could @east and @west review separate records? East may see Alpha. West may see Beta. Give both findings.',clientMessageId:'one'}
   host.chat.send(chat.id,'owner',input)
   host.chat.send(chat.id,'owner',input)
   for(let i=0;i<300;i++){
     await host.tick()
     if(host.store.tickets.list().length===2&&host.store.tickets.list().every(t=>t.ended))break
     await new Promise<void>(ok=>setTimeout(ok,10))
   }
   const run=host.store.list<ChatRun>('chat-run')[0]!
   expect(westKeys).toHaveLength(2)
   expect(calls[1]!.input).toBe(calls[0]!.input)
   expect(calls[1]!.threadId).toBeUndefined()
   expect(new Set(westKeys).size).toBe(1)
   expect(run.suppliedEvidence).toBeUndefined()
   expect(Object.keys(run.namedParticipants!.tickets).sort()).toEqual(['east','west'])
   expect(host.store.tickets.list().map(t=>t.ended?.outcome)).toEqual(['completed','completed'])
   expect(calls.filter(r=>r.role==='worker'&&r.suppliedText)).toHaveLength(0)
   const messages=host.chat.view(chat.id,'owner').messages.filter(m=>m.text==='The two receipts agree.'&&!m.recipient)
   expect(messages).toHaveLength(1)
   stopGate=true
   const next=host.chat.create('owner'),accepted=host.chat.send(next.id,'owner',{...input,clientMessageId:'stop'})
   for(let i=0;i<100&&!entered;i++){await host.tick();await new Promise<void>(ok=>setTimeout(ok,5))}
   expect(entered).toBe(true)
   const stopped=host.chat.cancel(next.id,'owner',accepted.runId!)
   release();await stopped
   for(let i=0;i<10;i++)await host.tick()
   expect(host.store.tickets.list()).toHaveLength(2)
   expect(host.store.get<ChatRun>('chat-run',accepted.runId!)?.cancelled).toBe(true)
 }finally{await host.close();rmSync(dir,{recursive:true,force:true})}
})

it('keeps the configured Router in control of an ongoing Chat and gives each profiled reader its own original records',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'roppo-policy-source-')),calls:ModelRequest[]=[]
  const routerPolicy='Follow the original user agreement.',routerIdentity='Router role marker.'
  const people=[{id:'east',label:'程序员1',prompt:'East role marker.'},{id:'west',label:'程序员2',prompt:'West role marker.'}]
  let allow=true,neededScope=false
  const host=await Runtime.create(configSchema.parse({
    stateDir:join(dir,'state'),port:0,watchdog:{enabled:false},prompts:{router:routerPolicy},work:{sandboxDriver:'seatbelt',network:false,autoRecover:false},
    backends:{test:{kind:'openai-responses',model:'fixture',baseUrl:'http://127.0.0.1:1/v1'}},
    execution:{backend:'test',router:{backend:'test',mode:'host',prompt:routerIdentity},suppliedEvidence:'fold',management:{enabled:true},workers:people.map(w=>({...w,backend:'test'}))},
    sources:[{id:'local',kind:'local',cwd:dir,allowedActors:['operator']}]
  }),{model:{async run(r){
    calls.push(r)
    const threadId=randomUUID(),turnId=randomUUID();r.onThread?.(threadId);r.onTurn?.(turnId)
    let text=JSON.stringify({reply:'Understood.',decision:'answer'})
    if(r.instructions.includes('Decide as the configured Router'))text=JSON.stringify({route:allow?'READ':'OTHER',worker:''})
    else if(r.suppliedText&&r.instructions.includes('Read your source')){
      if(!neededScope){neededScope=true;text='NEED_CONTEXT'}
      else text=r.instructions.includes('Only that scoped check is due.')?'*':'NEED_CONTEXT'
    }else if(r.suppliedText)text='RESULT name=Mara'
    return {text,turnId,threadId}
  }}})
  try{
    host.scopes.command({action:'scope.put',operationId:'test',expectedRevision:0,scope:{id:'team',tenantId:'lab',name:'Team',managers:[JSON.stringify(['local','operator'])],sourceIds:['local'],workerIds:['east','west'],backendIds:['test']}})
    const until=async(ready:()=>boolean)=>{for(let n=0;n<230&&!ready();n++){await host.tick();await new Promise<void>(done=>setTimeout(done,8))}expect(ready()).toBe(true)}
    const chat=host.chat.create('owner')
    const seed='When I give a new register, keep the answer concise.'
    const input='Ask @程序员1 and @程序员2 to check the registers.\n'+question+'\n\n@程序员1 / register for 程序员2\nMara holds permit A.\n\n@程序员2 / signatures\nPermit A is valid.'
    host.chat.send(chat.id,'owner',{text:seed,clientMessageId:'seed'})
    await until(()=>host.chat.view(chat.id,'owner').messages.some(m=>m.text==='Understood.'))
    host.chat.send(chat.id,'owner',{text:input,clientMessageId:'read',locale:'zh-CN'})
    await until(()=>host.chat.view(chat.id,'owner').messages.some(m=>m.text==='RESULT name=Mara'))
    const slim=calls.filter(c=>c.suppliedText)
    expect(slim.map(c=>c.role)).toEqual(['router','worker','worker','worker','router'])
    expect(slim.every(c=>!c.tools?.length&&!c.onTool&&c.allowNativeTools===false)).toBe(true)
    for(const read of slim.filter(c=>c.role==='router')){
      expect(read.instructions.split(routerPolicy)).toHaveLength(2)
      expect(read.instructions.split(routerIdentity)).toHaveLength(2)
      expect(read.input).toContain(seed);expect(read.input).toContain('zh-CN')
    }
    expect(slim.at(-1)!.input).toContain('workerReports')
    expect(slim[1]!.instructions).toContain(people[0]!.prompt)
    expect(slim[1]!.input).toContain('Mara holds permit A.');expect(slim[1]!.input).not.toContain('Permit A is valid.')
    expect(slim[3]!.instructions).toContain(people[1]!.prompt)
    expect(slim[3]!.input).toContain('Permit A is valid.')
    for(const read of slim.filter(c=>c.role==='worker'))expect(read.input).not.toContain(seed)
    const assignments=host.store.list<{ticketId:string;workerId:string}>('worker-assignment')
    expect(assignments).toHaveLength(2)
    for(const a of assignments){
      const ticket=host.store.tickets.get(a.ticketId)!
      expect(ticket.ended?.outcome).toBe('completed')
      const original=host.store.triggers.get(ticket.origin.triggerId)!.text
      expect(original).toContain(a.workerId==='east'?'Your deliverable is the evidence in this section':'other readers’ verified findings')
      expect(original).not.toContain(a.workerId==='east'?'Permit A is valid.':'Mara holds permit A.')
    }
    allow=false
    const other=host.chat.create('owner')
    host.chat.send(other.id,'owner',{text:input,clientMessageId:'decline'})
    await until(()=>host.chat.view(other.id,'owner').messages.some(m=>m.text==='Understood.'))
    expect(host.store.tickets.list()).toHaveLength(2)
    expect(calls.at(-1)!.suppliedText).toBeFalsy()
  }finally{await host.close();rmSync(dir,{recursive:true,force:true})}
})

it('lets the ordinary Router attach only its chosen reader’s source, retaining the original policy and dispatch identity',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'roppo-ordinary-source-')),workers:ModelRequest[]=[]
  const input=prompt('Ask @east and @west to check the registers.')
  let dispatched=false,valid=false,replay=false,workerSource=''
  const host=await Runtime.create(configSchema.parse({
    stateDir:join(dir,'state'),port:0,watchdog:{enabled:false},prompts:{shared:'Keep the established team rules.'},work:{sandboxDriver:'seatbelt',network:false,autoRecover:false},
    backends:{test:{kind:'openai-responses',model:'fixture',baseUrl:'http://127.0.0.1:1/v1'}},
    execution:{backend:'test',router:{backend:'test',mode:'host'},suppliedEvidence:'fold',management:{enabled:true},workers:roster.map(w=>({...w,backend:'test'}))},
    sources:[{id:'local',kind:'local',cwd:dir,allowedActors:['operator']}]
  }),{model:{async run(r){
    const threadId=randomUUID(),turnId=randomUUID();r.onThread?.(threadId);r.onTurn?.(turnId)
    let text=JSON.stringify({reply:'The register was checked.',decision:'answer'})
    if(r.role==='worker'){
      workers.push(r);workerSource=r.input
      text=JSON.stringify({state:'ready',summary:'Mara',reply:'Mara',question:null,askedBy:null,files:[],handbacks:[]})
    }else if(!dispatched&&r.instructions.includes('includeSuppliedSource')){
      dispatched=true
      expect(r.instructions).toContain('Keep the established team rules.')
      expect(r.tools?.find(t=>t.name==='worker_manage')?.inputSchema.properties).toHaveProperty('includeSuppliedSource')
      const args={action:'assign',id:'east',revision:0,requestId:'read-the-register',text:'Check the current permit.',includeSuppliedSource:true}
      valid=(await r.onTool!('worker_manage',args,'first')).success
      replay=(await r.onTool!('worker_manage',args,'retry')).success
    }
    return {text,turnId,threadId}
  }}})
  try{
    host.scopes.command({action:'scope.put',operationId:'test',expectedRevision:0,scope:{id:'team',tenantId:'lab',name:'Team',managers:[JSON.stringify(['local','operator'])],sourceIds:['local'],workerIds:['east','west'],backendIds:['test']}})
    const chat=host.chat.create('owner');host.chat.send(chat.id,'owner',{text:input,clientMessageId:'ordinary'})
    for(let n=0;n<180&&!workers.length;n++){await host.tick();await new Promise<void>(done=>setTimeout(done,8))}
    expect([dispatched,valid,replay]).toEqual([true,true,true])
    expect(host.store.tickets.list()).toHaveLength(1)
    expect(host.store.list('worker-assignment')[0]).toMatchObject({sourceFromChat:true,workerId:'east'})
    expect(workers[0]?.suppliedText).toBeFalsy()
    expect(workerSource).toContain('Mara holds permit A.')
    expect(workerSource).not.toContain('Permit A is valid.')
    const withoutContext=host.manager.call({action:'assign',id:'east',revision:0,requestId:'unbound',includeSuppliedSource:true,text:'Check'})
    await expect(withoutContext).rejects.toThrow(/current authorized private Chat/)
  }finally{await host.close();rmSync(dir,{recursive:true,force:true})}
})


it('resolves daily Chinese mentions and requires a real permitted choice for an unnamed reader',async()=>{
  const people=[{id:'east',label:'程序员1'},{id:'west',label:'程序员2'}]
  const source='请核对下面的记录。归档号 C31 换成 R47。R47 存在西楼，R49 存在东楼。请只给 C31 所在的楼名。'
  const vote=(id:string)=>async()=>({threadId:'r',turnId:'v',text:JSON.stringify({route:'READ',worker:id})})
  const {plan,group}=await policyEvidenceGroup(source,people,true,vote('east'),5)
  expect(plan?.workers).toEqual(['east']);expect(group?.selectedWorker).toBe('east')
  expect(plan?.sections[0]?.rows).toHaveLength(2)
  expect(await policyEvidenceGroup(source,people,true,vote('unknown'),5)).toEqual({})
  expect(await policyEvidenceGroup(source,people,true,vote('east'),6,group)).toEqual({})
  const addressed=source.replace('请核对','请@程序员1和@程序员2核对')
  expect((await policyEvidenceGroup(addressed,people,true,vote(''),5)).plan?.workers).toEqual(['east','west'])
  expect((await policyEvidenceGroup(addressed.replace('程序员2','程序员20'),people,true,vote(''),5)).group).toBeUndefined()
  expect((await policyEvidenceGroup(source.replace('请核对','请直接回答并核对'),people,true,vote('east'),5)).group).toBeUndefined()
})
