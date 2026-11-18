import {mkdtempSync,rmSync,mkdirSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,it,expect} from 'vitest'
import {Store} from '../src/store.ts'
import {Settings} from '../src/settings.ts'
import {configSchema} from '../src/config.ts'
import {Approvals,withinNativeTask} from '../src/approvals.ts'
const roots:string[]=[],stores:Store[]=[]
function store(){const r=mkdtempSync(join(tmpdir(),'agent-setting-'));roots.push(r);const s=new Store(join(r,'state.db'));stores.push(s);return s}
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true})})
it('preserves prompt versions and refuses stale writes',()=>{
 const s=store(),config=configSchema.parse({sources:[{id:'local',kind:'local',allowedActors:['operator'],cwd:'.'}]})
 const settings=new Settings(s,config)
 settings.save(0,{prompts:{shared:'Use Chinese',router:'',worker:'',delivery:''}})
 expect(settings.history()).toHaveLength(2)
 expect(()=>settings.save(0,{concurrency:3})).toThrow('conflict')
 const restored=new Settings(s,configSchema.parse({sources:[{id:'local',kind:'local',allowedActors:['operator'],cwd:'.'}]}))
 expect(restored.config.prompts.shared).toBe('Use Chinese')
})
it('binds approvals to a live native request and refuses replay',async()=>{
 const s=store(),approvals=new Approvals(s)
 const pending=approvals.request('work',{id:'native-1',method:'item/commandExecution/requestApproval',params:{threadId:'t',turnId:'u',command:'test'}})
 const record=s.list<any>('approval')[0]
 approvals.answer(record.id,'accept')
 await expect(pending).resolves.toEqual({decision:'accept'})
 expect(()=>approvals.answer(record.id,'accept')).toThrow('expired')
 approvals.close()
})
it('expires persisted requests after host restart',async()=>{
 const s=store(),first=new Approvals(s)
 const pending=first.request('work',{id:'n',method:'item/fileChange/requestApproval',params:{}})
 const rejected=pending.catch(e=>e.message)
 first.close()
 expect(await rejected).toBe('Approval expired')
 const second=new Approvals(s)
 expect(s.list<any>('approval')[0].status).toBe('expired')
 second.close()
})

it('rejects prompt overrides that drop environment or policy placeholders',()=>{
 const c={sources:[{id:'local',kind:'local',allowedActors:['operator'],cwd:'.'}]}
 expect(()=>configSchema.parse({...c,prompts:{overrides:{environment:{text:'No variables',base:'a'.repeat(64)}}}})).toThrow('placeholders')
 expect(()=>configSchema.parse({...c,prompts:{overrides:{unknown:{text:'Unknown',base:'a'.repeat(64)}}}})).toThrow()
})
it('reports an upgraded default without discarding the team override',async()=>{
 const {promptStatus,compose}=await import('../src/prompts.ts')
 const config=configSchema.parse({sources:[{id:'local',kind:'local',allowedActors:['operator'],cwd:'.'}],prompts:{overrides:{worker:{text:'Team work instructions',base:'a'.repeat(64)}}}})
 expect(promptStatus(config).find(p=>p.id==='worker')!.defaultChanged).toBe(true)
 expect(compose(config,'worker',{cwd:'.'},'v')).toContain('Team work instructions')
})

it('keeps in-memory settings unchanged when the database commit fails',()=>{
 const s=store(),config=configSchema.parse({sources:[{id:'local',kind:'local',allowedActors:['operator'],cwd:'.'}]}),settings=new Settings(s,config)
 const original=s.db.exec.bind(s.db)
 s.db.exec=(sql:string)=>{if(sql==='COMMIT')throw Error('Injected commit failure');return original(sql)}
 try{
  expect(()=>settings.save(0,{concurrency:4})).toThrow('commit failure')
  expect(config.concurrency).toBe(2)
  expect(settings.current().revision).toBe(0)
 }finally{s.db.exec=original}
})
it('retains transaction rollback after a failed transaction start',()=>{
 const s=store(),original=s.db.exec.bind(s.db)
 s.db.exec=(sql:string)=>{if(sql==='BEGIN IMMEDIATE')throw Error('Injected busy');return original(sql)}
 expect(()=>s.atomic(()=>s.put('test','x',1))).toThrow('busy')
 s.db.exec=original
 expect(()=>s.atomic(()=>{s.put('test','x',1);throw Error('rollback')})).toThrow('rollback')
 expect(s.get('test','x')).toBeUndefined()
})

it('reopens an unconsumed private answer after restart and returns it only over the live protocol',async()=>{
 const s=store(),chat={conversationId:'chat',runId:'run',workerId:'worker'},request={id:'question',method:'item/tool/requestUserInput',params:{questions:[{id:'code',isSecret:true,question:'Access code?'}]}}
 const first=new Approvals(s)
 expect(await first.request('work',request,chat,true)).toEqual({answers:{}})
 const id=s.list<any>('approval')[0].id
 const answers={code:{answers:['test-secret']}}
 first.answer(id,answers);first.close()
 expect(JSON.stringify(s.list('approval'))).not.toContain('test-secret')
 const second=new Approvals(s)
 expect(s.get<any>('approval',id).status).toBe('pending')
 second.answer(id,answers);second.answer(id,answers)
 expect(await second.request('work',request,chat)).toEqual({answers})
 expect(await second.request('work',request,chat)).toEqual({answers:{}})
 expect(JSON.stringify(s.list('approval'))).not.toContain('test-secret')
 second.close()
})

it('never transfers opaque file consent to a different native item',async()=>{
 const s=store(),approvals=new Approvals(s),chat={conversationId:'chat',runId:'run',workerId:'worker'}
 const req=(itemId:string)=>approvals.request('work',{id:itemId,method:'item/fileChange/requestApproval',params:{threadId:'t',itemId}},chat)
 await req('first');approvals.answer(s.list<any>('approval')[0].id,'accept')
 expect(await req('second')).toEqual({decision:'decline'})
 expect(await req('first')).toEqual({decision:'accept'})
 expect(await req('first')).toEqual({decision:'decline'})
 approvals.close()
})

it('keeps native permission expansion inside the configured task, including symlink targets',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-grants-'));roots.push(root)
 const work=join(root,'project'),privateDir=join(work,'state'),allowed=join(work,'output')
 for(const p of [work,privateDir,allowed])mkdirSync(p)
 symlinkSync(privateDir,join(work,'alias'))
 const can=(permissions:unknown,writable=true)=>withinNativeTask({id:'p',method:'item/permissions/requestApproval',params:{permissions}},work,writable,false,privateDir)
 expect(can({fileSystem:{write:[allowed]}})).toBe(true)
 expect(can({fileSystem:{write:[allowed]}},false)).toBe(false)
 expect(can({fileSystem:{write:[work]}})).toBe(false)
 expect(can({fileSystem:{read:[join(work,'alias')]}})).toBe(false)
 expect(can({network:{enabled:true}})).toBe(false)
})
