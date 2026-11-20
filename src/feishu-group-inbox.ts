import type {Runtime} from './runtime.ts'
import {bodyDigest,type Source} from './sources.ts'
import type {Trigger} from './vendor/dsh-core/index.ts'

const kind = 'feishu-group-inbox'
const maxMessages = 5
const waitMs = 120_000

interface GroupBatch {
  id: string
  createdAt: number
  messages: Trigger[]
}

function isGroupMessage(source:Source|undefined, trigger:Trigger):boolean {
  const {chat,chatType,messageId,root}=trigger.meta
  // Direct requests and replies in an existing topic use their normal intake.
  return !!source?.config.enabled && source.config.capabilities.events && source.config.kind==='feishu' &&
    !trigger.addressed && chatType!=='p2p' && typeof chat==='string' && typeof messageId==='string' &&
    (root===undefined || root===messageId) && source.config.feishu?.chats.includes(chat)===true
}

function receivedId(host:Runtime,source:Source,trigger:Trigger):string|undefined {
  if (host.store.triggers.get(trigger.id)) return trigger.id
  const key=source.idempotencyKey?.(trigger)
  return key?host.store.get<string>('source-event-key',key):undefined
}

function currentMessage(host:Runtime, trigger:Trigger):boolean {
  const {source,meta:{chat,messageId}}=trigger
  const adapter=host.sources.get(source)
  if (!adapter || !isGroupMessage(adapter,trigger)) return false
  if (receivedId(host,adapter,trigger) || host.memory.cleanup.blocked('trigger',trigger.id,trigger)) return false
  if (host.store.get('source-message-state',bodyDigest([source,chat,messageId]))) return false
  const observed=host.store.get<{hash:string;deleted:boolean}>('source-message-observation',source+':'+messageId)
  return !observed || (!observed.deleted && observed.hash===bodyDigest(trigger.text))
}

function submit(host:Runtime, batch:GroupBatch, now:number) {
  const messages=batch.messages.filter(trigger=>currentMessage(host,trigger))
  for (const trigger of messages) host.ingest(trigger)
  host.store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,batch.id)
  if (messages.length) host.store.audit({type:'feishu.group-batch',source:messages[0]!.source,
    chat:messages[0]!.meta.chat,count:messages.length,waitedMs:now-batch.createdAt})
}

/** Both live events and REST replay pass through the same durable inbox. */
export function collectFeishuGroupMessage(host:Runtime, source:Source, trigger:Trigger, now:number) {
  if (!isGroupMessage(source,trigger)) return
  if (receivedId(host,source,trigger)) return
  if (!currentMessage(host,trigger)) return {disposition:'ignored',triggerId:trigger.id}

  return host.store.atomic(()=>{
    const id=bodyDigest([trigger.source,trigger.meta.chat])
    let pending=host.store.get<GroupBatch>(kind,id)
    if (pending && pending.createdAt+waitMs<=now) {
      submit(host,pending,now)
      pending=undefined
      const received=receivedId(host,source,trigger)
      if (received) return {disposition:'duplicate',triggerId:received}
    }
    const messages=pending?.messages.filter(message=>currentMessage(host,message))??[]
    const duplicate=messages.find(message=>message.meta.messageId===trigger.meta.messageId)
    if (duplicate) return {disposition:'duplicate',triggerId:duplicate.id}

    const batch:GroupBatch={id,createdAt:messages.length?pending!.createdAt:now,messages:[...messages,trigger]}
    if (batch.messages.length>=maxMessages) {
      submit(host,batch,now)
      return {disposition:'stored',triggerId:trigger.id}
    }
    host.store.put(kind,id,batch)
    return {disposition:'buffered',triggerId:trigger.id}
  })
}

export function flushDueFeishuGroupMessages(host:Runtime,now:number) {
  for (const batch of host.store.list<GroupBatch>(kind)) {
    if (batch.createdAt+waitMs<=now) host.store.atomic(()=>submit(host,batch,now))
  }
}
