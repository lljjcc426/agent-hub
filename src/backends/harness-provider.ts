import {createServer} from 'node:http'
import {randomBytes} from 'node:crypto'
import {Readable,Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import type {ApiDefinition} from '../backend-config.ts'
import type {ModelRequest} from '../model.ts'
import {checkBudget,ContextBudgetExceeded} from '../context-budget.ts'
import {apiHeaders,apiOutputFormat} from './api-request.ts'
import {apiCheckFailure,apiResponseError} from './api-errors.ts'

/** One private loopback endpoint per activation. Only the host authenticates upstream. */
export async function openHarnessProvider(d:ApiDefinition,model:string,r:ModelRequest,credential?:()=>Promise<string>){
 const prefix='/'+randomBytes(32).toString('hex')
 const path={'openai-chat':'/chat/completions','openai-responses':'/responses',anthropic:'/messages'}[d.kind]
 const upstream=d.baseUrl.replace(/\/+$/,'')+path
 const lifetime=new AbortController()
 let port=0,steps=0,failure:unknown
 const server=createServer(async(req,res)=>{
  if(req.method!=='POST'||req.headers.host!=='127.0.0.1:'+port||req.headers.origin||req.url?.split('?')[0]!==prefix+path){
   res.writeHead(403).end()
   return
  }
  const disconnected=new AbortController()
  res.once('close',()=>{if(!res.writableEnded)disconnected.abort()})
  const signal=AbortSignal.any([lifetime.signal,disconnected.signal,AbortSignal.timeout(d.requestTimeoutMs),...(r.signal?[r.signal]:[])])
  try{
   const chunks:Buffer[]=[]
   let bytes=0
   for await(const chunk of req){
    bytes+=chunk.length
    if(bytes>d.maxContextBytes){res.writeHead(413).end();return}
    chunks.push(chunk)
   }
   const input=JSON.parse(Buffer.concat(chunks).toString('utf8'))
   if(input?.model!==model||input.previous_response_id||input.conversation||input.stream!==true){res.writeHead(400).end();return}
   // OpenCode can make auxiliary title requests without the task schema or tools.
   const taskStep=Array.isArray(input.tools)&&input.tools.length>0
   if(taskStep&&++steps>d.maxSteps){failure=Error('Model step limit reached');res.writeHead(400).end();return}
   const body={...input,...d.parameters,...(taskStep?apiOutputFormat(d,r.schema):{})}
   if(d.kind==='openai-chat'){
    delete body.max_tokens
    delete body.max_completion_tokens
    body[d.chatTokenField]=d.maxOutputTokens
   }else if(d.kind==='openai-responses'){
    body.store=false
    body.max_output_tokens=d.maxOutputTokens
    if(d.subscription)body.include=['reasoning.encrypted_content']
   }else body.max_tokens=d.maxOutputTokens
   const wire=JSON.stringify(body)
   if(Buffer.byteLength(wire)>d.maxContextBytes){res.writeHead(413).end();return}
   checkBudget(body,r.contextBudget,'api-wire','harness-provider',r.onBudget,true)

   let headers:Record<string,string>
   try{headers=apiHeaders(d,await credential?.())}
   catch{res.writeHead(401).end();return}
   const send=()=>fetch(upstream,{method:'POST',headers,body:wire,redirect:'error',signal})
   const response=await send().catch(error=>{
    // A reset before the response arrives cannot have executed a host tool.
    // Keep the same model step and deadline without resuming a native tool turn.
    if(!taskStep||signal.aborted||!['ECONNRESET','UND_ERR_SOCKET'].includes(error?.cause?.code))throw error
    return send()
   })
   if(!response.ok||!response.body){
    const retryAfter=response.headers.get('retry-after')
    const parsed=response.status===429?await apiResponseError(response,[],AbortSignal.any([signal,AbortSignal.timeout(2000)])).catch(()=>undefined):undefined
    res.writeHead(response.ok?502:response.status,{
     ...(retryAfter&&retryAfter.length<=100?{'retry-after':retryAfter}:{}),
     ...(parsed&&apiCheckFailure(parsed).code==='api_quota_exhausted'?{'x-roppo-provider-code':'quota_exhausted'}:{}),
    }).end()
    if(!response.bodyUsed)await response.body?.cancel()
    return
   }
   if(!response.headers.get('content-type')?.includes('text/event-stream')){
    await response.body.cancel()
    res.writeHead(502).end()
    return
   }
   let received=0
   const limit=new Transform({transform(chunk,_encoding,next){
    received+=chunk.length
    if(received>d.maxContextBytes){const error=Error('Provider response exceeds connection size limit');failure=error;next(error)}
    else next(null,chunk)
   }})
   res.writeHead(200,{'content-type':'text/event-stream'})
   await pipeline(Readable.fromWeb(response.body as any),limit,res,{signal})
  }catch(error){
   if(error instanceof ContextBudgetExceeded)failure=error
   if(!res.headersSent)res.writeHead(error instanceof ContextBudgetExceeded?413:502).end()
   else res.destroy()
  }
 })
 await new Promise<void>((ok,fail)=>{
  server.once('error',fail)
  server.listen(0,'127.0.0.1',()=>{port=(server.address() as {port:number}).port;ok()})
 })
 return {url:'http://127.0.0.1:'+port+prefix,failure:()=>failure,async close(){
  lifetime.abort()
  server.closeAllConnections()
  await new Promise<void>(ok=>server.close(()=>ok()))
 }}
}
