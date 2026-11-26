import {planChatHistory,type CleanupReceipt,type HistoryPlan} from './history-cleanup.ts'
import {needsHistoryScopeReview} from './history-fence.ts'
import {addPersonalReset,hasForeignHistoryOwner} from './personal-memory-reset.ts'
import {stableDigest} from './sources.ts'
import type {Store} from './store.ts'

/** Rebuild from the original account's conversations. The old expanded graph is
 * an upper bound, never evidence that a file, worker or native session was owned. */
export function rebuildPersonalResetScope(store:Store,stateDir:string,origin:HistoryPlan,held:HistoryPlan,receipt:CleanupReceipt){
 const personal=origin.personalReset
 if(!personal?.settingsKey.startsWith('chat-space:')||origin.id!==held.id||receipt.id!==origin.id||
    receipt.phase!=='scope_review'||!needsHistoryScopeReview(held))throw Error('Expected a held personal Chat reset')
 const owner=personal.settingsKey.slice('chat-space:'.length)
 if(!owner||origin.scopeId!=='@chat:'+stableDigest(owner)||held.scopeId!==origin.scopeId||personal.scopeId!==origin.scopeId)throw Error('Cannot establish the original Chat account')
 const seeds=origin.records.filter(([kind])=>kind==='chat-conversation').map(([,id])=>id)
 const ids=seeds.filter(id=>{
  const chat=store.get<{owner:string;createdAt:number}>('chat-conversation',id)
  return chat?.owner===owner&&chat.createdAt<=origin.at
 })
 if(!ids.length)throw Error('Cannot establish original Chat conversations')
 const draft=addPersonalReset(store,planChatHistory(store,stateDir,origin.scopeId,origin.id,origin.at,ids),owner,ids)
 const entries=new Set(personal.entries)
 if(draft.personalReset!.entries.some(entry=>!entries.has(entry)))throw Error('A Chat entry has changed ownership since the reset')
 const paths=new Set(held.files),tickets=new Set(held.tickets),triggers=new Set(held.triggers),roots=new Set(held.roots)
 const records=new Set(held.records.map(ref=>JSON.stringify(ref)))
 const sessions=new Map(held.sessions.map(s=>[s.threadId,s.cwd]))
 const owned=draft.sessions.filter(s=>sessions.get(s.threadId)===s.cwd)
 const proven=new Set(owned.map(s=>s.threadId)),done=new Set(receipt.nativeDone)
 if(held.sessions.some(s=>s.threadId&&!done.has(s.threadId)&&!proven.has(s.threadId))||draft.unresolvedSessions?.length)
  throw Error('Unprocessed native sessions still require an ownership or directory check')
 const plan:HistoryPlan={...draft,roots:draft.roots.filter(id=>roots.has(id)),records:draft.records.filter(ref=>records.has(JSON.stringify(ref))),
  tickets:draft.tickets.filter(id=>tickets.has(id)),triggers:draft.triggers.filter(id=>triggers.has(id)),
  sessions:owned,files:draft.files.filter(file=>paths.has(file)),personalReset:personal}
 if(needsHistoryScopeReview(plan))throw Error('Rebuilt account scope still contains an invalid identifier')
 if(hasForeignHistoryOwner(store,plan))throw Error('Another workspace owns a task or route in the rebuilt account scope')
 return plan
}
