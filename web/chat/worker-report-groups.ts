import type {ChatMessage,WorkerFilePatch} from '../../src/chat.ts'

export type ChangedFile={path:string;versions:WorkerFilePatch[]}
export type WorkerReport={conversationId:string;messageId:string;workerId:string;label:string;files:ChangedFile[]}
export type WorkerReports=WorkerReport[]
export type DiffTarget={group:string;path:string}

export function reportsForTranscript(messages:ChatMessage[], visible:ChatMessage[]){
  const visibleIds=new Set(visible.map(m=>m.id))
  const receipts=new Map<string,{message:ChatMessage;group:string}>()
  let last:{worker:string;run:string;conversation:string;group:string}|undefined
  for(const m of messages){
    if(m.role==='user'||(last&&(last.run!==m.runId||last.conversation!==m.conversationId)))last=undefined
    if(m.speaker?.kind!=='worker'||!m.fileChanges?.length)continue
    if(!last||last.worker!==m.speaker.id)last={worker:m.speaker.id,run:m.runId,conversation:m.conversationId,group:m.id}
    receipts.set(m.id,{message:m,group:last.group})
  }

  const byMessage=new Map<string,WorkerReports>()
  const groups=new Map<string,WorkerReport>()
  const indexed=new Map<string,Map<string,ChangedFile>>()
  const included=new Set<string>()
  for(const anchor of visible){
    const ids=receipts.has(anchor.id)?[anchor.id]:anchor.speaker?.kind==='router'?
      (anchor.fileChangeSources??[]).filter(id=>!visibleIds.has(id)):[]
    for(const id of ids){
      const source=receipts.get(id)
      if(!source||included.has(id)||source.message.runId!==anchor.runId)continue
      included.add(id)
      const {message,group}=source
      let report=groups.get(group)
      if(!report){
        report={conversationId:message.conversationId,messageId:group,workerId:message.speaker!.id,label:message.speaker!.label,files:[]}
        groups.set(group,report)
        indexed.set(group,new Map())
        byMessage.set(anchor.id,[...(byMessage.get(anchor.id)??[]),report])
      }
      const paths=indexed.get(group)!
      for(const patch of message.fileChanges!){
        let row=paths.get(patch.path)
        if(!row){row={path:patch.path,versions:[]};paths.set(patch.path,row);report.files.push(row)}
        row.versions.push(patch)
      }
    }
  }
  return {byMessage,groups:[...groups.values()]}
}
