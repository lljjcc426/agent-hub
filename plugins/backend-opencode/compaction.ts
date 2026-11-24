import {DatabaseSync} from 'node:sqlite'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {privateFile} from '../cli-shared/files.ts'

/** Executed by the pinned Bun CLI after it commits a summary. The preceding
 * message can also be a new user request or a tool step that still needs inference. */
export function compactionPlugin(root:string){
 const path=join(root,'compaction.mjs')
 const database=JSON.stringify(join(root,'data','opencode','opencode.db'))
 privateFile(path,`import {Database} from 'bun:sqlite'
export default async () => ({
 'experimental.session.compacting': async (_, output) => {
  output.context.push('Preserve the most recent user corrections, their scope, unfinished jobs and operation receipt resources verbatim. Distinguish completed, pending and unknown outcomes. Re-open original sources when exact details matter. The host reader can list model-tool-receipts to locate earlier results.')
 },
 'experimental.compaction.autocontinue': async ({sessionID,message,overflow}, output) => {
  if (overflow) return
  const db = new Database(${database}, {readonly:true})
  try {
   const row = db.query("SELECT id,data FROM message WHERE session_id=? AND id<? ORDER BY id DESC LIMIT 1").get(sessionID,message.id)
   if (!row) return
   const previous = JSON.parse(row.data)
   if (previous.role !== 'assistant' || previous.agent !== 'roppo' || previous.finish !== 'stop' || previous.error || previous.summary) return
   const answer = db.query("SELECT 1 FROM part WHERE session_id=? AND message_id=? AND json_extract(data,'$.type')='text' AND COALESCE(json_extract(data,'$.synthetic'),0)=0 AND length(trim(json_extract(data,'$.text')))>0 LIMIT 1").get(sessionID,row.id)
   if (answer) output.enabled = false
  } finally { db.close() }
 }
})`)
 return pathToFileURL(path).href
}

/** Use only messages observed in the current CLI invocation. An internal
 * summary can itself be a valid JSON reply, so content cannot identify it. */
export function completedAnswer(root:string,session:string,stops:Iterable<string>,failedSummary=false){
 const db=new DatabaseSync(join(root,'data','opencode','opencode.db'),{readOnly:true})
 try{
  const info=db.prepare("SELECT data FROM message WHERE session_id=? AND id=?")
  const parts=db.prepare("SELECT json_extract(data,'$.text') AS text FROM part WHERE session_id=? AND message_id=? AND json_extract(data,'$.type')='text' AND COALESCE(json_extract(data,'$.synthetic'),0)=0 ORDER BY id")
  for(const id of [...stops].reverse()){
   const row=info.get(session,id)
   if(!row)continue
   const message=JSON.parse(String(row.data))
   if(message.role!=='assistant'||message.agent!=='roppo'||message.summary||message.error||message.finish!=='stop')continue
   if(failedSummary){
    const later=db.prepare("SELECT id,data FROM message WHERE session_id=? AND id>? ORDER BY id").all(session,id)
    const marker=db.prepare("SELECT 1 FROM part WHERE session_id=? AND message_id=? AND json_extract(data,'$.type')='compaction'")
    if(!later.length||!later.every(row=>{
     const next=JSON.parse(String(row.data))
     return next.role==='assistant'?next.summary===true:next.role==='user'&&typeof row.id==='string'&&!!marker.get(session,row.id)
    }))return
   }
   return parts.all(session,id).map(part=>String(part.text)).join('')
  }
 }finally{db.close()}
}
