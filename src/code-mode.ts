import { Ajv } from 'ajv'
import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten'
import { protocolBytes, receiptReference } from './context-budget.ts'
import { modelToolCalls } from './execution-limits.ts'
import type { ModelRequest, ToolSpec } from './model.ts'
import { isParallelRead, ToolDispatch } from './tool-dispatch.ts'

const maxSource = 16_000
const maxOutput = 128 * 1024
const maxCellCalls = 128
const maxWallMs = 60_000
const maxComputeMs = 1_000
const ajv = new Ajv({strict:false})
type Invoke = NonNullable<ModelRequest['onTool']>
type ToolResult = Awaited<ReturnType<Invoke>>
const message = (text: string, success: boolean): ToolResult => ({success,contentItems:[{type:'inputText',text}]})

export const codeModeTool = {
  type:'function',
  name:'code_mode',
  description:'Run bounded async JavaScript to combine already authorized host tools. Call tools.<name>(args) with the active names and JSON arguments. OpenCode roppo_ names also work. Each call returns {success, contentItems}. Use Promise.all for independent reads and return only the needed data. Mutating tools keep their normal approvals and receipts. The script has no filesystem, network, Node, or shell APIs of its own.',
  inputSchema:{type:'object',additionalProperties:false,required:['source'],properties:{source:{type:'string',minLength:1,maxLength:maxSource}}},
} satisfies ToolSpec

/** Each cell receives only this activation's authorized tool descriptors and dispatcher. */
export function withCodeMode(request: ModelRequest, maxToolCalls = request.options?.maxToolCalls ?? modelToolCalls.default): ModelRequest {
  if(!request.managed || !(request.coordinationTurn || request.allowNativeTools) || request.ephemeral || request.role==='subagent' ||
    !request.onTool || !request.tools?.length || request.options?.tools && !request.options.tools.includes(codeModeTool.name))return request
  const tools=request.tools.filter(t=>t.name!==codeModeTool.name&&t.name!=='chat_opening')
  const original=request.onTool
  let calls=0
  const invoke:Invoke=async(name,args,id)=>{
    if(++calls>maxToolCalls)return message('Tool-call budget exhausted',false)
    return original(name,args,id)
  }
  return {...request,tools:[...request.tools,codeModeTool],onTool:async(name,args,id)=>{
    if(name!==codeModeTool.name)return invoke(name,args,id)
    if(++calls>maxToolCalls)return message('Tool-call budget exhausted',false)
    const source=(args as {source?:unknown}|null)?.source
    if(typeof source!=='string'||!source.trim()||source.length>maxSource)return message('Provide a bounded JavaScript source string',false)
    return runCell(source,tools,invoke,id,request)
  }}
}

async function runCell(source:string, tools:ToolSpec[], invoke:Invoke, parent:string, request:ModelRequest):Promise<ToolResult> {
  const allowed=new Map(tools.map(tool=>[tool.name,ajv.compile(tool.inputSchema)]))
  const wasm=await getQuickJS()
  request.signal?.throwIfAborted()
  const runtime=wasm.newRuntime()
  runtime.setMemoryLimit(32*1024*1024)
  runtime.setMaxStackSize(512*1024)
  const vm=runtime.newContext(),dispatch=new ToolDispatch()
  const promises:QuickJSDeferredPromise[]=[]
  const running:Promise<void>[]=[]
  const outputLimit=Math.min(maxOutput,request.contextBudget?.toolReserveBytes??maxOutput)
  const deadline=performance.now()+maxWallMs
  let until=deadline,open=true,count=0,outstanding=0
  let wake:(()=>void)|undefined
  const notify=()=>{wake?.();wake=undefined}
  const stop=()=>{open=false;notify()}
  const timer=setTimeout(stop,maxWallMs)
  request.signal?.addEventListener('abort',stop,{once:true})
  runtime.setInterruptHandler(()=>!open||performance.now()>=until)
  const wrap=(value:ToolResult)=>vm.newString(JSON.stringify(value))
  const call=vm.newFunction('invokeTool',(nameHandle:QuickJSHandle,argsHandle:QuickJSHandle)=>{
    if(!open||request.signal?.aborted||count>=maxCellCalls)return wrap(message('Code Mode tool-call limit reached',false))
    if(vm.typeof(nameHandle)!=='string'||vm.typeof(argsHandle)!=='string')return wrap(message('Tool name and JSON arguments required',false))
    const name=vm.getString(nameHandle),encoded=vm.getString(argsHandle)
    const validate=allowed.get(name)
    if(!validate||Buffer.byteLength(encoded)>outputLimit)return wrap(message('Tool or arguments outside this activation',false))
    let args:unknown
    try{args=JSON.parse(encoded)}catch{return wrap(message('Invalid JSON tool arguments',false))}
    if(!validate(args))return wrap(message('Tool arguments do not match the supplied schema',false))
    const id=parent+':code:'+ ++count
    const promise=vm.newPromise()
    promises.push(promise)
    outstanding++
    running.push(dispatch.run(isParallelRead(name),async()=>{
      if(!open||request.signal?.aborted)return message('Code Mode stopped before the queued tool ran',false)
      try{
        const value=await invoke(name,args,id)
        if(protocolBytes(value)<=outputLimit)return value
        if(request.retainToolResult)return receiptReference(value,await request.retainToolResult(id,value),request.role==='router'?'router_read':'superagent_read')
        return message('Tool result exceeds the Code Mode output budget',false)
      }catch{
        stop()
        return message('Tool failed. Check its receipt and outcome before retrying',false)
      }
    }).then(value=>{
      if(!open)return
      const handle=wrap(value)
      try{promise.resolve(handle)}finally{handle.dispose()}
    }).catch(stop).finally(()=>{outstanding--;notify()}))
    return promise.handle
  })
  vm.setProp(vm.global,'__roppoInvoke',call)
  call.dispose()
  const program=[
    '(async(invoke)=>{',
    'delete globalThis.__roppoInvoke;',
    'const tools=Object.create(null);',
    'const names='+JSON.stringify([...allowed.keys()])+';',
    'for(const name of names) tools[name]=async(args={})=>JSON.parse(await invoke(name,JSON.stringify(args)));',
    'for(const name of names) if(!Object.hasOwn(tools,"roppo_"+name)) Object.defineProperty(tools,"roppo_"+name,{value:tools[name]});',
    'Object.freeze(tools);',
    'const result=await (async()=>{',source,'})();',
    'return JSON.stringify(result ?? null);',
    '})(globalThis.__roppoInvoke)',
  ].join('\n')
  try{
    until=Math.min(deadline,performance.now()+maxComputeMs)
    const value=vm.evalCode(program,'roppo-code-mode.js')
    if(value.error){value.error.dispose();return message('Invalid JavaScript or Code Mode compute limit reached',false)}
    try{
      while(open){
        until=Math.min(deadline,performance.now()+maxComputeMs)
        const jobs=runtime.executePendingJobs()
        if(jobs.error){jobs.error.dispose();break}
        const outcome=vm.getPromiseState(value.value)
        if(outcome.type==='rejected'){
          outcome.error.dispose()
          return message('Code Mode failed. Check any tool receipts before retrying',false)
        }
        if(outcome.type==='fulfilled'){
          try{
            if(outstanding)return message('Await all submitted tools in Code Mode. Check any tool receipts before retrying',false)
            if(vm.typeof(outcome.value)!=='string')return message('Return a JSON-serializable result',false)
            const output=vm.getString(outcome.value)
            return Buffer.byteLength(output)<=outputLimit?message(output,true):message('Code Mode output exceeds its budget. Use a smaller return value',false)
          }finally{outcome.value.dispose()}
        }
        if(!outstanding)return message('Code Mode is waiting on a promise with no pending tools',false)
        await new Promise<void>(resolve=>{wake=resolve})
      }
    }finally{value.value.dispose()}
    request.signal?.throwIfAborted()
    return message('Code Mode stopped at its execution limit. Check any tool receipts before retrying',false)
  } finally {
    stop()
    clearTimeout(timer)
    request.signal?.removeEventListener('abort',stop)
    // An admitted tool may already have committed an effect. Let its host receipt
    // settle, and fence calls still waiting behind an exclusive operation.
    await Promise.allSettled(running)
    for(const promise of promises)promise.dispose()
    vm.dispose()
    runtime.dispose()
  }
}
