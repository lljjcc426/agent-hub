import { basename, extname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ToolSpec } from './model.ts'
import type { Runtime } from './runtime.ts'
import { evidenceBytes, workbookObservation } from './goal-artifacts.ts'
import type {RetainedChatFile} from './chat-retained-artifacts.ts'
import { chatDownloadMaxBytes } from './execution-limits.ts'
import { pendingNoticeSchema, pendingNoticeProperty } from './chat-pending-notice.ts'
import { ChatError } from './chat-errors.ts'

export interface ChatDelivery {
  id: string
  conversationId: string
  runId?: string
  ticketId?: string
  workerId?: string
  name: string
  size: number
  preview: 'text' | 'image' | null
  excerpt?: string
  mime: string
  createdAt: number
  retained?: true
  localFile?: true
  sha256?: string
}
type DeliveryRow=ChatDelivery&{published:boolean;reference?:RetainedChatFile;originalPath?:string}
const images: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
const textFiles = new Set([
  '.md',
  '.txt',
  '.csv',
  '.json',
  '.tsv',
  '.yaml',
  '.yml',
  '.log',
  '.js',
  '.ts',
  '.py',
  '.css',
  '.xml',
  '.html',
])


const routerFileCharacters=1024*1024
export const routerFileInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[^/\\\x00-\x1f\x7f]+$/)
      .refine((n) => textFiles.has(extname(n).toLowerCase()), 'Choose a text file format'),
    content: z.string().max(routerFileCharacters),
    requireApproval: z.boolean().optional(),
    pendingNotice: pendingNoticeSchema,
  })
  .strict()
export const routerFileTool: ToolSpec = {
  type: 'function',
  name: 'chat_deliver_file',
  description:
    'Deliver a finished text file you authored for this Chat task. Supply its filename and actual UTF-8 contents. When the user asks to review or approve before delivery, set requireApproval to true: the host holds those exact contents for their decision. End the turn after staging it. Otherwise deliver directly. For a binary file or work requiring execution, assign a Worker.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { name: { type: 'string' }, content: { type: 'string', maxLength: routerFileCharacters }, requireApproval: { type: 'boolean' }, pendingNotice:pendingNoticeProperty },
    required: ['name', 'content'],
  },
}

/** Files explicitly handed back by a Worker remain available after its workspace changes. */
export class ChatDeliveries {
  constructor(private host: Runtime) {
    host.store.db
      .exec(`CREATE TABLE IF NOT EXISTS chat_delivery_bytes(id TEXT PRIMARY KEY,bytes BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_delivery_conversation ON records(json_extract(body,'$.conversationId')) WHERE kind='chat-delivery';
      CREATE TRIGGER IF NOT EXISTS erase_chat_delivery AFTER UPDATE OF body ON records
      WHEN NEW.kind='chat-delivery' AND json_extract(NEW.body,'$.mime') IS NULL BEGIN DELETE FROM chat_delivery_bytes WHERE id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS delete_chat_delivery AFTER DELETE ON records WHEN OLD.kind='chat-delivery'
      BEGIN DELETE FROM chat_delivery_bytes WHERE id=OLD.id; DELETE FROM records WHERE kind='chat-file-inspection' AND id=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS discard_candidate_chat_files AFTER DELETE ON records WHEN OLD.kind='goal-delivery'
      BEGIN DELETE FROM records WHERE kind='chat-delivery' AND json_extract(body,'$.published')=0
        AND id IN (SELECT value FROM json_each(OLD.body,'$.files')); END;`)
  }
  private save(
    conversationId: string,
    name: string,
    bytes: Buffer,
    published: boolean,
    origin: { runId: string; ticketId?: string; workerId?: string },
    originalPath?: string,
    imageMime?: string,
  ) {
    const ext = extname(name).toLowerCase(),
      mime = imageMime ?? images[ext],
      preview = mime ? 'image' : textFiles.has(ext) ? 'text' : null
    const item: ChatDelivery = {
      id: randomUUID(),
      conversationId,
      ...origin,
      name,
      size: bytes.length,
      preview,
      ...(preview === 'text' ? { excerpt: bytes.subarray(0, 800).toString('utf8').slice(0, 240) } : {}),
      mime: mime ?? (preview === 'text' ? 'text/plain' : 'application/octet-stream'),
      createdAt: Date.now(),
    }
    this.host.store.put('chat-delivery', item.id, { ...item, published, ...(originalPath ? {originalPath, sha256:createHash('sha256').update(bytes).digest('hex')} : {}) })
    this.host.store.db.prepare('INSERT INTO chat_delivery_bytes VALUES(?,?)').run(item.id, bytes)
    return item
  }
  text(conversationId: string, runId: string, name: string, content: string, published = true) {
    return this.save(conversationId, name, Buffer.from(content), published, { runId })
  }
  image(conversationId:string,origin:{runId:string;ticketId?:string;workerId?:string},name:string,bytes:Buffer,mime:string) {
    return this.save(conversationId,name,bytes,true,origin,undefined,mime)
  }
  retain(conversationId:string,runId:string,source:{name:string;size:number},reference:RetainedChatFile,local:boolean){
    const item:ChatDelivery={id:randomUUID(),conversationId,runId,name:source.name,size:source.size,preview:null,retained:true,
      ...(local?{localFile:true}:{}),sha256:reference.sha256,mime:'application/octet-stream',createdAt:Date.now()}
    this.host.store.put('chat-delivery',item.id,{...item,published:true,reference} satisfies DeliveryRow)
    return item
  }
  capture(
    conversationId: string,
    runId: string,
    ticketId: string,
    workerId: string,
    cwd: string,
    paths: string[],
  ) {
    const files: ChatDelivery[] = []
    try {
      for (const path of new Set(paths)) {
        this.host.resources.workspacePath(cwd, path)
        const bytes = evidenceBytes(cwd, path, chatDownloadMaxBytes)
        if (!bytes) throw Error('Delivery file is missing: ' + path)
        files.push(this.save(conversationId, basename(path), bytes, false, { runId, ticketId, workerId }, path))
      }
      return files
    } catch (error) {
      this.discard(files.map((f) => f.id))
      throw error
    }
  }
  publish(conversationId: string, origin: {ticketId: string} | {runId: string}, ids: string[]) {
    return ids.map((id) => {
      const row = this.host.store.get<DeliveryRow>('chat-delivery', id)
      if (!row?.mime || row.conversationId !== conversationId ||
          ('ticketId' in origin ? row.ticketId !== origin.ticketId : !!row.ticketId || row.runId !== origin.runId))
        throw new ChatError('delivery_missing', 'Delivery unavailable.', 404)
      const { published, originalPath, reference, ...item } = row
      this.host.store.put('chat-delivery', id, { ...row, published: true })
      return item
    })
  }
  discard(ids: string[]) {
    for (const id of ids)
      this.host.store.db
        .prepare(
          "DELETE FROM records WHERE kind='chat-delivery' AND id=? AND json_extract(body,'$.published')=0",
        )
        .run(id)
  }
  evidence(ticketId: string, id: string) {
    const file = this.host.store.get<ChatDelivery>('chat-delivery', id)
    if (!file?.mime || file.ticketId !== ticketId) throw Error('Chat delivery evidence is unavailable')
    const cached = this.host.store.get<{ content: string }>('chat-file-inspection', id)
    if (cached) return { key: 'chat-file/' + file.name, content: cached.content }
    const row = this.host.store.db.prepare('SELECT bytes FROM chat_delivery_bytes WHERE id=?').get(id)
    if (!row) throw Error('Chat delivery bytes are unavailable')
    const data = Buffer.from(row.bytes as Uint8Array)
    let observation: unknown
    if (file.preview === 'text')
      observation = { text: data.subarray(0, 24000).toString('utf8'), complete: data.length <= 24000 }
    if (extname(file.name).toLowerCase() === '.xlsx') {
      try {
        observation = workbookObservation(data, null)
      } catch {
        observation = { error: 'Workbook contents could not be read' }
      }
    }
    const content = JSON.stringify({
      name: file.name,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      observation,
      release:
        'The host retained these exact bytes for download in the originating Chat. Passing final acceptance publishes the file card in the same transaction. The public card is intentionally pending this review.',
    })
    this.host.store.put('chat-file-inspection', id, { ticketId, fileId: id, content })
    return { key: 'chat-file/' + file.name, content }
  }
  list(conversationId: string) {
    return this.host.store.db
      .prepare(
        "SELECT body FROM records WHERE kind='chat-delivery' AND json_extract(body,'$.conversationId')=? AND json_extract(body,'$.published')=1 AND json_extract(body,'$.mime') IS NOT NULL ORDER BY rowid DESC",
      )
      .all(conversationId)
      .map((row) => {
        const {reference,originalPath,...item}=JSON.parse(String(row.body)) as DeliveryRow
        return item
      })
  }
  private allowed(conversationId:string,id:string,draft?:{runId:string}|{ticketId:string}){
    const item = this.host.store.get<DeliveryRow>('chat-delivery', id)
    if (
      !item ||
      !item.mime || item.size > chatDownloadMaxBytes ||
      item.conversationId !== conversationId ||
      (!draft ? !item.published :
        'runId' in draft ? item.published || !!item.ticketId || item.runId !== draft.runId :
        item.ticketId !== draft.ticketId) ||
      this.host.memory.cleanup.blocked('chat-delivery', id, item)
    )
      throw new ChatError('delivery_missing', 'Delivery unavailable.', 404)
    return item
  }
  reference(conversationId:string,id:string){
    const {reference,originalPath,...item}=this.allowed(conversationId,id)
    if(item.retained&&!reference)throw new ChatError('delivery_missing','Delivery unavailable.',404)
    return reference?{item,reference}:undefined
  }
  read(conversationId: string, id: string, draft?: { runId: string } | { ticketId: string }) {
    const {reference,originalPath,...item}=this.allowed(conversationId,id,draft)
    const data = this.host.store.db.prepare('SELECT bytes FROM chat_delivery_bytes WHERE id=?').get(id)
    if (!data) throw new ChatError('delivery_missing', 'Delivery unavailable.', 404)
    return { item, bytes: data.bytes as Uint8Array }
  }
}
