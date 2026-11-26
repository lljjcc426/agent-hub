import {it,expect} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Store} from '../src/store.ts'
import {HistoryCleanup,type HistoryPlan} from '../src/history-cleanup.ts'

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
