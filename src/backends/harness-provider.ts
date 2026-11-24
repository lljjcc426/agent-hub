import {createServer} from 'node:http'
import {randomBytes} from 'node:crypto'
import {Readable,Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {setTimeout as delay} from 'node:timers/promises'
import type {ApiDefinition} from '../backend-config.ts'
import type {ModelRequest} from '../model.ts'
import {checkBudget,ContextBudgetExceeded} from '../context-budget.ts'
import {apiHeaders,apiOutputFormat} from './api-request.ts'
import {apiCheckFailure,apiResponseError,retryableInferenceStatus,type ApiResponseError} from './api-errors.ts'

const rejectedImageCodes=new Set([
 'unsupported_image','unsupported_image_format','unsupported_image_type',
 'invalid_image','invalid_image_format','invalid_image_url','invalid_image_mode','image_too_large',
])
function hasToolImage(item:any){
 return item?.type==='function_call_output'&&typeof item.call_id==='string'&&Array.isArray(item.output)&&
  item.output.some((part:any)=>part?.type==='input_image')
}

function rejectedToolImages(error:ApiResponseError|undefined,input:any[]):'all'|string[]|undefined{
 if(!error)return
 const parameter=/^input(?:\[(\d+)\]|\.(\d+))\.output(?:\[(\d+)\]|\.(\d+))\.(?:image_url|image|type)$/.exec(error.parameter??'')
 if(parameter){
  const item=input[Number(parameter[1]??parameter[2])]
  if(!hasToolImage(item)||item.output[Number(parameter[3]??parameter[4])]?.type!=='input_image')return
  if(error.code!=='image_not_supported')return [item.call_id]
 }
 if(error.code==='image_not_supported')return 'all'
 if(rejectedImageCodes.has(error.code??''))return input.filter(hasToolImage).map(item=>item.call_id)
}

function textOnlyToolOutputs(input:unknown,rejectAll:boolean,rejected:ReadonlySet<string>){
 if(!Array.isArray(input)||!rejectAll&&!rejected.size)return input
 return input.map(item=>{
  if(!hasToolImage(item)||!rejectAll&&!rejected.has(item.call_id))return item
  return {...item,output:[
   ...item.output.filter((part:any)=>part?.type!=='input_image'),
   {type:'input_text',text:JSON.stringify({
    code:'tool_image_rejected',message:'This model connection rejected the image returned by this tool. Continue using the available text and report which image could not be inspected.'
   })},
  ]}
 })
}

/** One private loopback endpoint per activation. Only the host authenticates upstream. */
export async function openHarnessProvider(d:ApiDefinition,model:string,r:ModelRequest,credential?:()=>Promise<string>,checkpointAt?:number){
 const prefix='/'+randomBytes(32).toString('hex')
 const path={'openai-chat':'/chat/completions','openai-responses':'/responses',anthropic:'/messages'}[d.kind]
 const upstream=d.baseUrl.replace(/\/+$/,'')+path
 const lifetime=new AbortController()
 let port=0,steps=0,failure:unknown,rejectAllToolImages=false,checkpointed=false
 const rejectedImageCalls=new Set<string>()
 const server=createServer(async(req,res)=>{
  if(req.method!=='POST'||req.headers.host!=='127.0.0.1:'+port||req.headers.origin||req.url?.split('?')[0]!==prefix+path){
   res.writeHead(403).end()
   return
  }
  const disconnected=new AbortController()
  res.once('close',()=>{if(!res.writableEnded)disconnected.abort()})
  const deadline=Date.now()+d.requestTimeoutMs
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
   if(taskStep&&steps>0&&steps<d.maxSteps&&checkpointAt!==undefined&&Date.now()>=checkpointAt&&(checkpointed||r.workerCheckpointReady?.())){
    checkpointed=true;res.writeHead(409).end();return
   }
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
   if(d.kind==='openai-responses')body.input=textOnlyToolOutputs(body.input,rejectAllToolImages,rejectedImageCalls)
   const encode=()=>{
    const wire=JSON.stringify(body)
    if(Buffer.byteLength(wire)>d.maxContextBytes)return
    checkBudget(body,r.contextBudget,'api-wire','harness-provider',r.onBudget,true)
    return wire
   }
   let wire=encode()
   if(!wire){res.writeHead(413).end();return}

   let headers:Record<string,string>
   try{headers=apiHeaders(d,await credential?.())}
   catch{res.writeHead(401).end();return}
   // Retry only the inference POST, before any response stream reaches the CLI.
   // A tool result in this payload is evidence, never a new tool invocation.
   let retries=0
   const send=async()=>{
    for(;;){
     let result:Response|undefined
     try{result=await fetch(upstream,{method:'POST',headers,body:wire,redirect:'error',signal})}
     catch(error){
      const cause=(error as Error)?.cause as NodeJS.ErrnoException|undefined
      if(retries||!taskStep||signal.aborted||!['ECONNRESET','UND_ERR_SOCKET'].includes(cause?.code??''))throw error
     }
     if(result&&(!retryableInferenceStatus(result.status)||retries>=2))return result
     const header=result?.headers.get('retry-after')??''
     const requested=/^\d+$/.test(header)?Number(header)*1000:Date.parse(header)-Date.now()
     const wait=Math.max(Number.isNaN(requested)?0:requested,500*2**retries)
     if(result&&(wait>10_000||Date.now()+wait>=deadline))return result
     await result?.body?.cancel()
     r.onBackendIssue?.({code:'transient',willRetry:true,...(result?{httpStatus:result.status}:{})})
     retries++
     await delay(wait,undefined,{signal})
    }
   }
   let response=await send()
   // The provider explicitly rejected this model request before returning a
   // completion. Retry the same step with the affected tool results expressed as text.
   if(d.kind==='openai-responses'&&[400,415,422].includes(response.status)&&Array.isArray(body.input)&&body.input.some(hasToolImage)){
    const parsed=await apiResponseError(response,[],AbortSignal.any([signal,AbortSignal.timeout(2000)])).catch(()=>undefined)
    const rejected=rejectedToolImages(parsed,body.input)
    if(rejected){
     if(rejected==='all')rejectAllToolImages=true
     else for(const id of rejected)rejectedImageCalls.add(id)
     body.input=textOnlyToolOutputs(body.input,rejectAllToolImages,rejectedImageCalls)
     wire=encode()
     if(!wire){res.writeHead(413).end();return}
     r.onBackendIssue?.({code:'unsupported',willRetry:true,httpStatus:response.status})
     response=await send()
    }
   }
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
 return {url:'http://127.0.0.1:'+port+prefix,failure:()=>failure,checkpointed:()=>checkpointed,async close(){
  lifetime.abort()
  server.closeAllConnections()
  await new Promise<void>(ok=>server.close(()=>ok()))
 }}
}
