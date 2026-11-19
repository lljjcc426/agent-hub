import {z} from 'zod'
import {toolParallelism} from '../execution-limits.ts'

const time=z.number().int().min(0).max(8_640_000_000_000_000)
export const nativeToolBatchSchema=z.object({
 callId:z.string().min(1).max(1000),
 items:z.array(z.object({
  target:z.string().regex(/^[a-f0-9]{16}$/),
  status:z.enum(['completed','failed','skipped']),
  queuedAt:time,startedAt:time,endedAt:time,
  reused:z.literal(true).optional(),
  failure:z.enum(['http','content','transport','timeout','cancelled','repeated_failure','retry_wait']).optional(),
  httpStatus:z.number().int().min(100).max(599).optional(),
 }).strict().refine(item=>item.queuedAt<=item.startedAt&&item.startedAt<=item.endedAt)).min(1).max(toolParallelism),
}).strict()
export type NativeToolBatch=z.infer<typeof nativeToolBatchSchema>
