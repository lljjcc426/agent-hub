import type {ModelRequest} from './model.ts'

export interface ChatInputSize {
  system: number
  tools: number
  attachments: number
  conversation: number
  memory: number
  files: {id:string;name:string;bytes:number}[]
}

interface FileRef {id:string;name?:string}
interface InputEnvelope {
  trigger?: {meta?: {attachments?: FileRef[]}}
  messages?: {meta?: {attachments?: FileRef[]}}[]
  conversation?: {history?: {attachments?: FileRef[]}[]}
  memory?: object
  retry?: number
  previousInput?: string
}

// Measure the logical values handed to the backend. Native history, tool results
// and provider framing added after this boundary are outside this measurement.
export function measureChatInput({instructions, schema, tools, input}: Pick<ModelRequest,'instructions'|'schema'|'tools'|'input'>): ChatInputSize {
  const bytes = (text:string) => Buffer.byteLength(text, 'utf8')
  const size: ChatInputSize = {
    system: bytes(instructions) + bytes(JSON.stringify(schema)),
    tools: tools?.length ? bytes(JSON.stringify(tools)) : 0,
    attachments: 0, conversation: bytes(input), memory: 0, files: [],
  }
  let envelope: InputEnvelope
  let embedded = false
  try {
    envelope = JSON.parse(input)
    if (envelope?.retry && typeof envelope.previousInput === 'string') {
      envelope = JSON.parse(envelope.previousInput)
      embedded = true
    }
  } catch { return size }
  if (!envelope || typeof envelope !== 'object') return size
  const valueBytes = (value:object) => {
    const json = JSON.stringify(value)
    return bytes(embedded ? JSON.stringify(json).slice(1,-1) : json)
  }
  if (envelope.memory) size.memory = valueBytes(envelope.memory)
  const files = new Map<string,ChatInputSize['files'][number]>()
  const add = (ref:FileRef) => {
    const length = valueBytes(ref)
    const id = ref.id.replace(/^asset\//,'')
    const file = files.get(id) ?? {id,name:ref.name ?? id,bytes:0}
    file.bytes += length
    files.set(id,file)
    size.attachments += length
  }
  envelope.trigger?.meta?.attachments?.forEach(add)
  envelope.messages?.forEach(message => message.meta?.attachments?.forEach(add))
  envelope.conversation?.history?.forEach(message => message.attachments?.forEach(add))
  size.files = [...files.values()]
  size.conversation -= size.memory + size.attachments
  return size
}
