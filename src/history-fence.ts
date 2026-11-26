import type {DatabaseSync} from 'node:sqlite'
import type {HistoryPlan} from './history-cleanup.ts'

interface HistoryIndex {
 readonly version:string
 readonly planIds:readonly string[]
 readonly records:ReadonlyMap<string,ReadonlySet<string>>
 readonly roots:ReadonlySet<string>
 readonly tickets:ReadonlySet<string>
 readonly triggers:ReadonlySet<string>
}

/** The version changes inside the same SQLite transaction as the deletion plan.
 * A version observed in a rolled-back transaction cannot later match a different plan. */
export class HistoryFence {
 private cached?:HistoryIndex
 private readonly stamp
 private readonly plans
 constructor(db:DatabaseSync){
  db.exec(`
   CREATE TABLE IF NOT EXISTS history_fence_version(id INTEGER PRIMARY KEY CHECK(id=1),stamp TEXT NOT NULL);
   INSERT OR IGNORE INTO history_fence_version VALUES(1,lower(hex(randomblob(32))));
   CREATE TRIGGER IF NOT EXISTS history_fence_insert AFTER INSERT ON records WHEN NEW.kind='history-plan'
    BEGIN UPDATE history_fence_version SET stamp=lower(hex(randomblob(32))) WHERE id=1; END;
   CREATE TRIGGER IF NOT EXISTS history_fence_delete AFTER DELETE ON records WHEN OLD.kind='history-plan'
    BEGIN UPDATE history_fence_version SET stamp=lower(hex(randomblob(32))) WHERE id=1; END;
   CREATE TRIGGER IF NOT EXISTS history_fence_update AFTER UPDATE ON records
    WHEN (OLD.kind='history-plan' OR NEW.kind='history-plan') AND (NEW.kind IS NOT OLD.kind OR NEW.id IS NOT OLD.id OR NEW.body IS NOT OLD.body)
    BEGIN UPDATE history_fence_version SET stamp=lower(hex(randomblob(32))) WHERE id=1; END;
  `)
  this.stamp=db.prepare('SELECT stamp FROM history_fence_version WHERE id=1')
  this.plans=db.prepare("SELECT id,body,rowid FROM records WHERE kind='history-plan'")
 }
 current():HistoryIndex{
  const version=String(this.stamp.get()!.stamp)
  if(this.cached?.version===version)return this.cached
  const planIds:string[]=[]
  const records=new Map<string,Set<string>>()
  const roots=new Set<string>(),tickets=new Set<string>(),triggers=new Set<string>()
  for(const row of this.plans.all().sort((a,b)=>Number(a.rowid)-Number(b.rowid))){
   const plan=JSON.parse(String(row.body)) as HistoryPlan
   planIds.push(String(row.id))
   for(const [kind,id] of plan.records??[]){
    let ids=records.get(kind)
    if(!ids){ids=new Set();records.set(kind,ids)}
    ids.add(id)
   }
   for(const id of plan.roots??[])roots.add(id)
   for(const id of plan.tickets??[])tickets.add(id)
   for(const id of plan.triggers??[])triggers.add(id)
  }
  this.cached={version,planIds,records,roots,tickets,triggers}
  return this.cached
 }
}
