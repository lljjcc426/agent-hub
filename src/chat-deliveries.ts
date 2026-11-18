import { basename, extname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ToolSpec } from './model.ts'
import type { Runtime } from './runtime.ts'
import { evidenceBytes, workbookObservation } from './goal-artifacts.ts'
import { chatUploadLimits } from './chat-attachments.ts'
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
}
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

export const routerFileInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[^/\\\x00-\x1f\x7f]+$/)
      .refine((n) => textFiles.has(extname(n).toLowerCase()), 'Choose a text file format'),
    content: z.string().max(128 * 1024),
  })
  .strict()
export const routerFileTool: ToolSpec = {
  type: 'function',
  name: 'chat_deliver_file',
  description:
    'Publish a finished text file you authored directly to this Chat. Supply the filename and its actual UTF-8 contents. The user receives a downloadable file card. For a binary file or work requiring execution, assign a Worker and let it return its final files.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { name: { type: 'string' }, content: { type: 'string' } },
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
  ) {
    const ext = extname(name).toLowerCase(),
      preview = images[ext] ? 'image' : textFiles.has(ext) ? 'text' : null
    const item: ChatDelivery = {
      id: randomUUID(),
      conversationId,
      ...origin,
      name,
      size: bytes.length,
      preview,
      ...(preview === 'text' ? { excerpt: bytes.subarray(0, 800).toString('utf8').slice(0, 240) } : {}),
      mime: images[ext] ?? (preview === 'text' ? 'text/plain' : 'application/octet-stream'),
      createdAt: Date.now(),
    }
    this.host.store.put('chat-delivery', item.id, { ...item, published })
    this.host.store.db.prepare('INSERT INTO chat_delivery_bytes VALUES(?,?)').run(item.id, bytes)
    return item
  }
  text(conversationId: string, runId: string, name: string, content: string) {
    return this.save(conversationId, name, Buffer.from(content), true, { runId })
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
        const bytes = evidenceBytes(cwd, path, chatUploadLimits.maxBytes)
        if (!bytes) throw Error('Delivery file is missing: ' + path)
        files.push(this.save(conversationId, basename(path), bytes, false, { runId, ticketId, workerId }))
      }
      return files
    } catch (error) {
      this.discard(files.map((f) => f.id))
      throw error
    }
  }
  publish(conversationId: string, ticketId: string, ids: string[]) {
    return ids.map((id) => {
      const row = this.host.store.get<ChatDelivery & { published: boolean }>('chat-delivery', id)
      if (!row?.mime || row.ticketId !== ticketId || row.conversationId !== conversationId)
        throw new ChatError('delivery_missing', 'Delivery unavailable.', 404)
      const { published, ...item } = row
      this.host.store.put('chat-delivery', id, { ...item, published: true })
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
      .map((row) => JSON.parse(String(row.body)) as ChatDelivery)
  }
  read(conversationId: string, id: string) {
    const item = this.host.store.get<ChatDelivery & { published: boolean }>('chat-delivery', id)
    if (
      !item?.published ||
      !item.mime ||
      item.conversationId !== conversationId ||
      this.host.memory.cleanup.blocked('chat-delivery', id, item)
    )
      throw new ChatError('delivery_missing', 'Delivery unavailable.', 404)
    const data = this.host.store.db.prepare('SELECT bytes FROM chat_delivery_bytes WHERE id=?').get(id)
    if (!data) throw new ChatError('delivery_missing', 'Delivery unavailable.', 404)
    return { item, bytes: data.bytes as Uint8Array }
  }
}
