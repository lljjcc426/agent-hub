import {it,expect} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Store} from '../src/store.ts'
import {HistoryCleanup,planChatHistory,type HistoryPlan} from '../src/history-cleanup.ts'
import {externalCandidateKind} from '../src/external-memory-candidates.ts'

it('preserves record, nested resource and scope boundaries across rollback, replacement and another connection',()=>{
 const dir=mkdtempSync(join(tmpdir(),'roppo-fence-')),file=join(dir,'state.sqlite')
 const store=new Store(file),other=new DatabaseSync(file),cleanup=new HistoryCleanup(store,dir)
 const plan=(key:string):HistoryPlan=>({id:'plan',at:1,scopeId:'account',roots:[key+'/inner'],records:[['settings',key]],tickets:[key],triggers:[key+'-request'],sessions:[],files:[]})
 const check=(key:string,hit:boolean)=>{
  expect(cleanup.blocked('settings',key)).toBe(hit)
  expect(cleanup.blocked('custom',key,{resource:JSON.stringify(['ticket/'+key+'/inner/file'])})).toBe(hit)
  expect(cleanup.blocked('custom',key,{resource:'ticket/'+key+'/innerest/file'})).toBe(false)
  expect(cleanup.blocked('memory-fact','unrelated',{root:key+'/inner'})).toBe(false)
  expect(store.historyFence.current().tickets.has(key)).toBe(hit)
  expect(store.historyFence.current().triggers.has(key+'-request')).toBe(hit)
 }
 try{
  const initial=store.historyFence.current();store.put('health','host',{at:1});expect(store.historyFence.current()).toBe(initial)
  expect(()=>store.atomic(()=>{
   store.put('history-plan','plan',plan('A'));check('A',true)
   expect(()=>store.atomic(()=>{store.put('history-plan','plan',plan('B'));check('B',true);throw Error('inner rollback')})).toThrow()
   check('A',true);check('B',false)
   throw Error('outer rollback')
  })).toThrow()
  store.put('history-plan','plan',plan('C'));check('A',false);check('B',false);check('C',true)
  other.prepare("UPDATE records SET body=? WHERE kind='history-plan' AND id='plan'").run(JSON.stringify(plan('D')))
  check('C',false);check('D',true)
  other.prepare("DELETE FROM records WHERE kind='history-plan'").run();check('D',false)
 }finally{other.close();store.db.close();rmSync(dir,{recursive:true,force:true})}
})

it('reclaims restored bodies on the final pass and leaves already redacted records untouched',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'roppo-cleanup-pass-'))
 const store=new Store(join(dir,'state.sqlite')),cleanup=new HistoryCleanup(store,dir)
 try{
  for(const id of ['clean','restored','outside'])store.put('sample',id,{id,text:'original'})
  const plan:HistoryPlan={id:'wipe',at:1,scopeId:'scope',roots:['clean','restored'],records:[['sample','clean'],['sample','restored']],tickets:[],triggers:[],sessions:[],files:[]}
  cleanup.apply(plan)
  store.db.prepare("UPDATE records SET body=? WHERE kind='sample' AND id='restored'").run(JSON.stringify({id:'restored',text:'late restore'}))
  const writes:string[]=[]
  store.recordObservers.set('sample',id=>writes.push(id))
  let ioRan=false
  setImmediate(()=>{ioRan=true})
  await cleanup.process({async run(){throw Error('no model needed')}},async()=>true)
  expect(ioRan).toBe(true)
  expect(writes).toEqual(['restored'])
  expect(store.get('sample','restored')).toEqual({id:'restored',text:''})
  expect(store.get('sample','outside')).toEqual({id:'outside',text:'original'})
  expect(cleanup.receipts()[0]).toMatchObject({status:'completed',phase:'verified',local:'verified'})
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})

it('erases only the external memory candidates owned by the cleared conversation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'roppo-candidate-cleanup-')),store=new Store(join(dir,'state.sqlite'))
 const cleanup=new HistoryCleanup(store,dir)
 const owned={conversationId:'own-chat',text:'private note'}
 const foreign={conversationId:'other-chat',text:'own-chat'}
 try{
  store.put(externalCandidateKind,'own-note',owned)
  store.put(externalCandidateKind,'other-note',foreign)
  const plan=planChatHistory(store,dir,'account','reset',1,['own-chat'])
  expect(plan.records).toEqual([[externalCandidateKind,'own-note']])
  expect(plan.roots).toEqual(['own-chat'])
  const writes:string[]=[]
  store.recordObservers.set(externalCandidateKind,id=>writes.push(id))
  cleanup.apply(plan)
  await cleanup.process({async run(){throw Error('unexpected model call')}},async()=>true)
  expect(cleanup.receipts()[0]?.status).toBe('completed')
  expect(writes).toEqual(['own-note'])
  expect(store.get(externalCandidateKind,'own-note')).toEqual({deleted:true})
  expect(store.get(externalCandidateKind,'other-note')).toEqual(foreign)
  const reopened=new HistoryCleanup(store,dir)
  expect(reopened.blocked(externalCandidateKind,'other-note',foreign)).toBe(false)
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})

it('keeps empty native identifiers out of scope and stops legacy plans before further erasure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'roppo-empty-history-')),store=new Store(join(dir,'state.sqlite'))
 try{
  store.put('chat-run','own-request',{conversationId:'own-chat',triggerId:'own-request'})
  store.put('work','own-job',{triggerId:'own-request',threadId:'',cwd:dir})
  store.put('work','foreign-job',{description:'',threadId:'',cwd:dir,text:'keep'})
  const plan=planChatHistory(store,dir,'account','reset',1,['own-chat'])
  expect(plan.roots).not.toContain('')
  expect(plan.sessions).toEqual([])
  expect(plan.records).toContainEqual(['work','own-job'])
  expect(plan.records).not.toContainEqual(['work','foreign-job'])
  const corrupt={...plan,roots:[...plan.roots,''],sessions:[{threadId:'',cwd:dir}]}
  store.put('history-plan',plan.id,corrupt)
  store.put('history-cleanup',plan.id,{id:plan.id,status:'processing',phase:'native_history',nativeDone:['saved']})
  const cleanup=new HistoryCleanup(store,dir)
  await cleanup.process({run:async()=>{throw Error('unreachable')}},async()=>{throw Error('must not quiesce')})
  expect(cleanup.receipts()[0]).toMatchObject({phase:'scope_review',nativeDone:['saved']})
  expect(cleanup.blocked('work','foreign-job',{threadId:'',ref:'ticket//x'})).toBe(false)
  expect(store.get('work','foreign-job')).toMatchObject({text:'keep'})
  expect(()=>cleanup.apply(corrupt)).toThrow('invalid identity')
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})
