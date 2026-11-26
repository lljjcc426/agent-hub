import type {Store} from './store.ts'
import type {HistoryPlan} from './history-cleanup.ts'
import type {EntryBinding,ManagementScope,RouterRoute,TaskOwnership} from './router-scope.ts'
import {stableDigest} from './sources.ts'
import {defaultMemoryWriteMode,memoryPolicySchema,type MemoryPolicy} from './memory-policy.ts'

export interface PersonalReset {defaultWriteMode?:MemoryPolicy['writeMode'];settingsKey:string;scopeId:string;entries:string[];spaces:string[];factIds:string[]}
export function hasForeignHistoryOwner(store:Store,plan:HistoryPlan){
 if(!plan.personalReset)return false
 // A personal conversation can be bound to a team. Check the exact entry and
 // its current owner so a different entry in that team cannot join the reset.
 const bindings=new Map(plan.personalReset.entries.map(id=>[id,store.get<EntryBinding>('entry-binding',id)]))
 const belongs=(entry:string,owner:{tenantId:string;scopeId:string})=>{
  const binding=bindings.get(entry)
  return !!binding&&binding.scopeId===owner.scopeId&&binding.tenantId===owner.tenantId
 }
 return plan.tickets.some(id=>{
  const owner=store.get<TaskOwnership>('task-ownership',id)
  return owner&&!belongs(owner.originEntry,owner)
 })||plan.triggers.some(id=>{
  const route=store.get<RouterRoute>('router-route',id)
  return route&&!belongs(route.entryId,route)
 })
}
const bySpace=new Set(['memory-personal','memory-last-extract','memory-maintenance','memory-consolidation','memory-sequence','memory-reflection','memory-reflection-run','memory-reflection-revision'])
const learning=new Set(['memory-observation','memory-extraction-session','memory-document-use','memory-use','memory-topic','memory-vector','memory-reflection-history'])
export function addPersonalReset(store:Store,plan:HistoryPlan,owner:string,conversationIds:string[]):HistoryPlan{
 const conversations=conversationIds.flatMap(id=>{const c=store.get<{sourceId:string;actor:string;nativeId?:string}>('chat-conversation',id);return c?[{...c,id}]:[]})
 const bindings=store.list<EntryBinding>('entry-binding').filter(b=>conversations.some(c=>c.sourceId===b.sourceId&&(c.nativeId??'chat:'+c.id)===b.nativeId))
 const entries=bindings.map(b=>b.id),spaces=[...new Set(bindings.flatMap(b=>conversations.filter(c=>c.sourceId===b.sourceId&&(c.nativeId??'chat:'+c.id)===b.nativeId).map(c=>stableDigest([b.tenantId,b.scopeId,b.id,JSON.stringify([c.sourceId,c.actor])]))))]
 const factIds=store.list<{id:string;entryId:string}>('memory-fact').filter(f=>entries.includes(f.entryId)).map(f=>f.id)
 const selected=new Map(plan.records.map(ref=>[JSON.stringify(ref),ref]))
 for(const row of store.db.prepare('SELECT kind,id,body FROM records').all()){
  const kind=String(row.kind),id=String(row.id),body=JSON.parse(String(row.body))
  if(bySpace.has(kind)&&spaces.includes(id)||learning.has(kind)&&(spaces.includes(body.space)||entries.includes(body.entryId)||factIds.includes(body.factId))){
   const ref:[string,string]=[kind,id];selected.set(JSON.stringify(ref),ref)
  }
 }
 return {...plan,records:[...selected.values()],personalReset:{defaultWriteMode:defaultMemoryWriteMode,settingsKey:'chat-space:'+owner,scopeId:plan.scopeId,entries,spaces,factIds}}
}
/** Once per durable reset operation, including replay over an older backup.
 * A later user policy update must not be erased by cleanup retries or restarts. */
export function applyPersonalReset(store:Store,plan:HistoryPlan){
 const reset=plan.personalReset;if(!reset||store.get('history-personal-reset',plan.id))return
 const saved=store.get<{display?:string}>('settings',reset.settingsKey)
 // Rotate the entry/native conversation identity as well as the Chat ID.
 store.put('settings',reset.settingsKey,{display:saved?.display??'group'})
 const scope=store.get<ManagementScope>('management-scope',reset.scopeId)
 const old=store.get<{revision:number}>('memory-policy',reset.scopeId)
 if(scope?.tenantId===reset.scopeId||!scope&&old){
  store.put('memory-policy',reset.scopeId,{revision:(old?.revision??0)+1,value:memoryPolicySchema.parse({
   // Receipts created before adaptive learning was the default must replay the original reset.
   writeMode:reset.defaultWriteMode??'explicit_only',
  })})
  if(scope && !scope.memoryEnabled)store.put('management-scope',scope.id,{...scope,memoryEnabled:true,revision:scope.revision+1})
 }
 for(const row of store.db.prepare("SELECT id,body FROM records WHERE kind='memory-suppression'").all()){
  const value=JSON.parse(String(row.body))
  if(scope?.tenantId===reset.scopeId&&value.scopeId===reset.scopeId||reset.factIds.includes(value.factId??value.id))store.db.prepare("DELETE FROM records WHERE kind='memory-suppression' AND id=?").run(row.id!)
 }
 store.put('history-personal-reset',plan.id,{id:plan.id,scopeId:reset.scopeId,at:plan.at})
}
