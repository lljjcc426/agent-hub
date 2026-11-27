import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it} from 'vitest'
import {configSchema} from '../src/config.ts'
import {Runtime} from '../src/runtime.ts'
import {SourceIdentities} from '../src/source-identity.ts'
import type {EntryBinding} from '../src/router-scope.ts'
import {peopleIndex} from '../src/people-index.ts'

it('shows a recent native observation only under the verified account and exact bound group',async()=>{
 const root=mkdtempSync(join(tmpdir(),'roppo-people-'))
 const h=new Runtime(configSchema.parse({stateDir:root,port:0,sources:[{id:'local',kind:'local',cwd:root,allowedActors:['reviewer']}] }))
 try{
  h.scopes.command({action:'scope.put',operationId:'scope',expectedRevision:0,scope:{id:'team',tenantId:'test',name:'Demo',managers:[JSON.stringify(['local','reviewer'])],sourceIds:['local'],workerIds:[],backendIds:['codex']}})
  const entry=h.scopes.command({action:'entry.bind',operationId:'one',expectedRevision:0,scopeId:'team',sourceId:'local',accountNamespace:'local',nativeId:'group-a',history:'group'}) as EntryBinding
  const other=h.scopes.command({action:'entry.bind',operationId:'two',expectedRevision:0,scopeId:'team',sourceId:'local',accountNamespace:'local',nativeId:'group-b',history:'group'}) as EntryBinding
  const identity={sourceId:'local',provider:'local',namespace:'local',verifiedAt:Date.now()}
  h.store.put('source-identity','local',identity)
  const received=h.receive('local','reviewer',{id:'native-group-message',scope:'group-a',thread:'group-a',text:'本地群观察',addressed:true}) as {triggerId:string}
  const trigger=h.store.triggers.get(received.triggerId)!
  h.scopes.context(trigger,'local:group-a')
  new SourceIdentities(h.store,h.scopes,h.sources).recordNative(trigger)
  h.store.put('source-health','local',{status:'ok',at:Date.now()})
  const before=h.store.db.prepare('SELECT total_changes() AS n').get()!.n
  expect(peopleIndex(h,entry.id)).toMatchObject({availability:'partial',people:[{actorId:'reviewer',sourceId:'local',role:'scope-manager'}]})
  expect(peopleIndex(h,other.id)).toMatchObject({availability:'partial',people:[]})
  expect(h.store.db.prepare('SELECT total_changes() AS n').get()!.n).toBe(before)
  h.store.put('source-identity','local',{...identity,namespace:'replacement'})
  expect(peopleIndex(h,entry.id)).toMatchObject({availability:'unavailable',people:[]})
 }finally{await h.close();rmSync(root,{recursive:true,force:true})}
})
