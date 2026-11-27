import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {pipeline} from 'node:stream/promises'
import type {FileHandle} from 'node:fs/promises'
import type {IncomingMessage,ServerResponse} from 'node:http'
import type {ChatSessions} from './chat.ts'
import {basename} from 'node:path'
import {ChatError} from './chat-errors.ts'
import {imagePreviewMime} from './chat-images.ts'

type RetainedDelivery=NonNullable<Awaited<ReturnType<ChatSessions['retainedDelivery']>>>
const run=promisify(execFile)

function byteRange(header:string,size:number){
 const match=/^bytes=(\d*)-(\d*)$/i.exec(header)
 if(!match||!size)return
 const offset=match[1]?Number(match[1]):undefined,limit=match[2]?Number(match[2]):undefined
 if(offset!==undefined&&(!Number.isSafeInteger(offset)||offset>=size)||
  limit!==undefined&&!Number.isSafeInteger(limit))return
 if(offset===undefined){
  if(!limit)return
  return {start:Math.max(0,size-limit),end:size-1}
 }
 const end=Math.min(size-1,limit??size-1)
 if(end<offset)return
 return {start:offset,end}
}

export async function sendRetainedDelivery(req:IncomingMessage,res:ServerResponse,entry:RetainedDelivery,preview=false){
 const file='file' in entry?entry.file:undefined
 const size=entry.item.size,etag='"'+entry.reference.sha256+'"'
 try{
  const requested=req.headers.range&&(!req.headers['if-range']||req.headers['if-range']===etag)
  const range=requested?byteRange(req.headers.range!,size):undefined
  const headers={
   'accept-ranges':'bytes','etag':etag,'cache-control':'private, no-store','x-content-type-options':'nosniff',
   'content-security-policy':"default-src 'none'; sandbox",
  }
  if(requested&&!range){res.writeHead(416,{...headers,'content-range':'bytes */'+size}).end();return}
  let mime:string|undefined
  if(preview){
   if('bytes' in entry&&entry.bytes)mime=imagePreviewMime(entry.bytes)
   else if(file){
    const header=Buffer.alloc(12),{bytesRead}=await file.handle.read(header,0,header.length,0)
    await file.verify()
    mime=imagePreviewMime(header.subarray(0,bytesRead))
   }
  }
  const start=range?.start??0,end=range?.end??size-1
  res.writeHead(range?206:200,{
   ...headers,'content-length':end-start+1,'content-type':mime??'application/octet-stream',
   'content-disposition':(mime?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(entry.item.name),
   ...(range?{'content-range':`bytes ${start}-${end}/${size}`}:{}),
  })
  if(req.method==='HEAD'||size===0){res.end();return}
  if('bytes' in entry&&entry.bytes){res.end(entry.bytes.subarray(start,end+1));return}
  if(!file)throw Error('Missing retained file')
  await pipeline(file.handle.createReadStream({start,end,autoClose:false}),async function*(chunks){
   // Hold the last chunk until the opened version has been checked again.
   let finalChunk:Buffer|undefined
   for await(const chunk of chunks){if(finalChunk)yield finalChunk;finalChunk=chunk}
   await file.verify()
   if(finalChunk)yield finalChunk
  },res)
 }finally{await file?.handle.close().catch(()=>{})}
}

export async function revealRetainedDelivery(entry:RetainedDelivery|undefined){
 if(!entry||!('file' in entry)||!entry.file)throw new ChatError('delivery_missing','Local file unavailable.',404)
 return revealLocalFile(entry.file)
}

export async function revealLocalFile(file:{path:string;handle:FileHandle;verify:()=>Promise<void>}){
 try{
  await file.verify()
  try{await run('/usr/bin/open',['-R',file.path],{timeout:5000})}
  catch{throw new ChatError('file_reveal_failed','Finder could not show this file.',500)}
 } finally {await file.handle.close().catch(()=>{})}
}

export function sendWorkerPatch(req:IncomingMessage,res:ServerResponse,patch:{path:string;text:string},download:boolean){
 const name=encodeURIComponent(basename(patch.path)+'.patch').replace(/'/g,'%27')
 res.writeHead(200,{'content-type':'text/plain; charset=utf-8','content-length':Buffer.byteLength(patch.text),
  'content-disposition':(download?'attachment':'inline')+"; filename*=UTF-8''"+name,'cache-control':'private, no-store',
  'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"})
 res.end(req.method==='HEAD'?undefined:patch.text)
}

export async function openWorkerPatch(text:string){
 await new Promise<void>((resolve,reject)=>{
  const child=spawn('/usr/bin/open',['-f','-a','TextEdit'],{stdio:['pipe','ignore','ignore'],timeout:8000})
  const failed=()=>reject(new ChatError('patch_open_failed','TextEdit could not open the diff.',500))
  child.once('error',failed)
  child.stdin.once('error',failed)
  child.once('close',code=>code===0?resolve():failed())
  child.stdin.end(text)
 })
}
