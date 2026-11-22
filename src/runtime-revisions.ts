import type {DatabaseSync} from 'node:sqlite'

const memoryRecords=[
  'settings','management-scope','tenant-epoch','entry-binding','scope-migration','history-plan',
  'source-entry-state','source-member-state','source-identity','source-native-proof','source-invalid-trigger','identity-link',
  'trigger','router-route','router-admission','router-cancelled','router-input-set','router-duty',
  'router-schedule','router-schedule-run','router-goal','goal-wake','delegation-inbound','delegation-peer','delegation-connection',
  'memory-generation','memory-policy','memory-personal','memory-evidence','memory-observation',
  'memory-fact','memory-vector','memory-suppression','memory-topic','memory-reflection','memory-reflection-history',
]
const scheduleRecords=[
  'router-schedule-run','router-goal','worker-assignment','task-routing','ticket','router-reply-owner','router-inbox','router-read',
]
const conversationRecords=['chat-call','chat-delivery','chat-message','chat-plan','chat-run','chat-pending-reactions']
const localChatRecords=['chat-conversation',...conversationRecords]
const chatExcluded=['health','clock','chat-revision','execution-call','model-usage',...localChatRecords]
const sqlList=(values:readonly string[])=>values.map(value=>"'"+value+"'").join(',')
type Row='OLD'|'NEW'

function conversationId(row:Row){
  return `CASE
    WHEN ${row}.kind='chat-conversation' THEN ${row}.id
    WHEN ${row}.kind IN (${sqlList(conversationRecords)}) AND json_valid(${row}.body)
      THEN json_extract(${row}.body,'$.conversationId')
  END`
}

function recordTrigger(event:'insert'|'update'|'delete',rows:Row[],when=''){
  const changed=(test:(row:Row)=>string)=>rows.map(test).join(' OR ')
  const includes=(values:readonly string[])=>changed(row=>`${row}.kind IN (${sqlList(values)})`)
  const conversations=rows.map(row=>'SELECT '+conversationId(row)+' AS conversation').join(' UNION ')
  return `CREATE TRIGGER IF NOT EXISTS runtime_revision_records_${event} AFTER ${event} ON records ${when} BEGIN
    UPDATE runtime_revision SET version=version+1 WHERE scope='memory' AND (${includes(memoryRecords)});
    UPDATE runtime_revision SET version=version+1 WHERE scope='schedule' AND (${includes(scheduleRecords)});
    UPDATE runtime_revision SET version=version+1 WHERE scope='chat' AND (
      ${changed(row=>`${row}.kind NOT IN (${sqlList(chatExcluded)})`)}
      ${rows.includes('OLD')?"OR (OLD.kind='chat-conversation' AND NOT EXISTS (SELECT 1 FROM records WHERE kind='chat-conversation' AND id=OLD.id))":''}
    );
    INSERT INTO runtime_revision(scope,version)
      SELECT 'chat:'||conversation,1 FROM (${conversations})
      WHERE typeof(conversation)='text' AND EXISTS(SELECT 1 FROM records r WHERE r.kind='chat-conversation' AND r.id=conversation)
      ON CONFLICT(scope) DO UPDATE SET version=version+1;
    ${rows.includes('OLD')?`DELETE FROM runtime_revision WHERE scope='chat:'||OLD.id AND OLD.kind='chat-conversation'
      AND NOT EXISTS(SELECT 1 FROM records WHERE kind='chat-conversation' AND id=OLD.id);`:''}
  END;`
}

/** Derived stamps advance in the transaction that changes the input, including raw SQL and restores. */
export class RuntimeRevisions {
  private readonly read
  private readonly readChat

  constructor(db:DatabaseSync){
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_revision(scope TEXT PRIMARY KEY,version INTEGER NOT NULL) WITHOUT ROWID;
      INSERT OR IGNORE INTO runtime_revision VALUES ('memory',0),('schedule',0),('chat',0);
      ${recordTrigger('insert',['NEW'])}
      ${recordTrigger('update',['OLD','NEW'],'WHEN NEW.kind IS NOT OLD.kind OR NEW.id IS NOT OLD.id OR NEW.body IS NOT OLD.body')}
      ${recordTrigger('delete',['OLD'])}
      ${(['jobs','outbox'] as const).map(table=>{
        const changed=table==='jobs'?'NEW.state IS NOT OLD.state OR NEW.payload IS NOT OLD.payload OR NEW.error IS NOT OLD.error OR NEW.kind IS NOT OLD.kind'
          :'NEW.status IS NOT OLD.status OR NEW.body IS NOT OLD.body OR NEW.error IS NOT OLD.error'
        return (['INSERT','UPDATE','DELETE'] as const).map(event=>`
          CREATE TRIGGER IF NOT EXISTS runtime_revision_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
          ${event==='UPDATE'?'WHEN NEW.id IS NOT OLD.id OR '+changed:''}
          BEGIN UPDATE runtime_revision SET version=version+1 WHERE scope IN ('schedule','chat'); END;
        `).join('\n')
      }).join('\n')}
    `)
    this.read=db.prepare('SELECT version FROM runtime_revision WHERE scope=?')
    this.readChat=db.prepare("SELECT version AS shared, coalesce((SELECT version FROM runtime_revision WHERE scope=?),0) AS local FROM runtime_revision WHERE scope='chat'")
  }

  version(scope:'memory'|'schedule'):number {
    return Number(this.read.get(scope)!.version)
  }

  chat(conversationId:string):string {
    const row=this.readChat.get('chat:'+conversationId)!
    return row.shared+':'+row.local
  }
}
