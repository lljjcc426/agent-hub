import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {z} from 'zod'
import {toolParallelism} from '../execution-limits.ts'

export const maxWebPageCheckpointBytes=32*1024
export const webPageCheckpointSchema=z.object({
 url:z.string().max(6100),startedAt:z.number().int().nonnegative(),endedAt:z.number().int().nonnegative(),
 sourceBytes:z.number().int().nonnegative(),excerpts:z.array(z.string().max(1800)).max(4),
}).strict()
export type WebPageCheckpoint=z.infer<typeof webPageCheckpointSchema>
export interface WebBatchReplay {threadId:string;turnId:string;callId:string}

export function webBatchUrls(value:unknown){
 if(!Array.isArray(value)||!value.length||value.length>toolParallelism)return
 try{
  const urls=value.map(input=>{
   if(typeof input!=='string'||Buffer.byteLength(input)>2000)throw Error('Invalid batch URL')
   const url=new URL(input)
   if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid batch URL')
   return url.href
  })
  return [...new Set(urls)]
 }catch{return}
}
export const webPageDirectory=(root:string,turnId:string)=>join(root,turnId+'.web-pages')
export const webPageFile=(directory:string,url:string)=>join(directory,createHash('sha256').update(url).digest('hex')+'.json')
