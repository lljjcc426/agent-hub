import {afterEach,expect,it} from 'vitest'
import {randomUUID} from 'node:crypto'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {configSchema} from '../src/config.ts'
import type {Model,ModelRequest} from '../src/model.ts'
import {Runtime} from '../src/runtime.ts'
import {serve} from '../src/server.ts'

const roots:string[]=[], servers:Awaited<ReturnType<typeof serve>>[]=[]

async function close(host:Awaited<ReturnType<typeof serve>>){
  servers.splice(servers.indexOf(host),1)
  host.server.closeAllConnections()
  await new Promise<void>(resolve=>host.server.close(()=>resolve()))
  await host.closeRuntime()
}

afterEach(async()=>{
  while(servers.length)await close(servers.at(-1)!)
  for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})
})

function fixture(run?:(request:ModelRequest)=>unknown|Promise<unknown>){
  const root=mkdtempSync(join(tmpdir(),'roppo-runtime-perf-test-'))
  roots.push(root)
  let now=Date.now()
  const calls:ModelRequest[]=[]
  const config=()=>configSchema.parse({stateDir:join(root,'state'),port:0,acceptMode:'auto',
    work:{sandboxDriver:'disabled',autoRecover:false},
    execution:{router:{mode:'host'},workers:[{id:'one',backend:'codex'}],management:{enabled:true}},
    sources:[{id:'local',kind:'local',cwd:root,allowedActors:['alice']}]})
  const model:Model={async run(request){
    calls.push(request)
    const threadId=request.threadId??randomUUID(),turnId=randomUUID()
    request.onThread?.(threadId)
    request.onTurn?.(turnId)
    return {threadId,turnId,text:JSON.stringify(await run?.(request)??{reply:''})}
  }}
  return {calls,now:()=>now,advance:(ms:number)=>{now+=ms},async open(){
    const host=await serve(new Runtime(config(),{model,clock:()=>now}))
    servers.push(host)
    const headers={authorization:'Bearer '+readFileSync(host.tokenPath,'utf8').trim(),'content-type':'application/json'}
    const api=async(path:string,data?:unknown,method='POST')=>{
      const response=await fetch(host.url+path,{headers,...(data===undefined?{}:{method,body:JSON.stringify(data)}),signal:AbortSignal.timeout(4000)})
      const value=await response.json()
      if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`)
      return value
    }
    return {host,headers,api}
  }}
}

type Client=Awaited<ReturnType<ReturnType<typeof fixture>['open']>>
type Frame={event:string;id?:string}

async function events(client:Client,id:string,last?:string){
  const controller=new AbortController()
  const headers={...client.headers,...(last?{'last-event-id':last}:{})}
  try{
    const response=await fetch(client.host.url+'/api/chat/conversations/'+id+'/events',{headers,signal:controller.signal})
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader=response.body!.getReader(),decoder=new TextDecoder(),frames:Frame[]=[]
    const done=(async()=>{
      let buffer=''
      try{
        for(;;){
          const {value,done}=await reader.read()
          if(done)return
          buffer+=decoder.decode(value,{stream:true})
          let boundary:number
          while((boundary=buffer.indexOf('\n\n'))!==-1){
            const block=buffer.slice(0,boundary)
            buffer=buffer.slice(boundary+2)
            const event=block.match(/^event: (.*)$/m)?.[1]
            if(event)frames.push({event,id:block.match(/^id: (.*)$/m)?.[1]})
          }
        }
      }catch(error){if(!controller.signal.aborted)throw error}
    })()
    // Awaited on explicit close. A server-side reset may finish the stream first.
    void done.catch(()=>{})
    return {frames,async close(){controller.abort();await done}}
  }catch(error){controller.abort();throw error}
}

const chat='/api/chat/conversations'

it('sends one revision to both subscribers, isolates unrelated conversation changes and resumes from Last-Event-ID',async()=>{
  const f=fixture(),client=await f.open(),{api}=client
  const conversation=await api(chat,{}),other=await api(chat,{})
  const a=await events(client,conversation.id),b=await events(client,conversation.id)
  try{
    await expect.poll(()=>a.frames.length).toBe(1)
    await expect.poll(()=>b.frames).toEqual(a.frames)
    const original=a.frames[0]!.id!
    await api(chat+'/'+other.id,{title:'Independent conversation'},'PATCH')
    await delay(850)
    expect(a.frames).toHaveLength(1)
    expect(b.frames).toHaveLength(1)
    await api(chat+'/'+conversation.id,{title:'New shared title'},'PATCH')
    await expect.poll(()=>a.frames.length).toBe(2)
    await expect.poll(()=>b.frames).toEqual(a.frames)
    const latest=a.frames[1]!.id!
    expect(Number(latest)).toBeGreaterThan(Number(original))
    expect((await api(chat+'/'+conversation.id)).conversation.title).toBe('New shared title')
    await a.close()
    const resumed=await events(client,conversation.id,original)
    try{
      await expect.poll(()=>resumed.frames).toEqual([{event:'change',id:latest}])
    }finally{await resumed.close()}
  }finally{await Promise.all([a.close(),b.close()])}
})

it('keeps a durable chat revision across service restart and delivers a change that happened while disconnected',async()=>{
  const f=fixture(),first=await f.open(),conversation=await first.api(chat,{})
  const stream=await events(first,conversation.id)
  await expect.poll(()=>stream.frames.length).toBe(1)
  const last=stream.frames[0]!.id!
  await stream.close()
  await close(first.host)
  const second=await f.open(),unchanged=await events(second,conversation.id,last)
  try{
    await delay(850)
    expect(unchanged.frames).toEqual([])
  }finally{await unchanged.close()}
  await second.api(chat+'/'+conversation.id,{title:'Changed while disconnected'},'PATCH')
  const resumed=await events(second,conversation.id,last)
  try{
    await expect.poll(()=>resumed.frames.length).toBe(1)
    expect(Number(resumed.frames[0]!.id)).toBeGreaterThan(Number(last))
    expect((await second.api(chat+'/'+conversation.id)).conversation.title).toBe('Changed while disconnected')
  }finally{await resumed.close()}
})

it('fences an open cached stream after chat reset and denies an old Last-Event-ID on reconnection',async()=>{
  const client=await fixture().open(),conversation=await client.api(chat,{}),stream=await events(client,conversation.id)
  try{
    await expect.poll(()=>stream.frames.length).toBe(1)
    const last=stream.frames[0]!.id!
    await client.api('/api/chat/reset',{operationId:randomUUID()})
    await expect.poll(()=>stream.frames.map(frame=>frame.event)).toEqual(['change','reset'])
    const old=await fetch(client.host.url+chat+'/'+conversation.id+'/events',{
      headers:{...client.headers,'last-event-id':last},signal:AbortSignal.timeout(4000)})
    expect(old.status).not.toBe(200)
    expect(await old.json()).toMatchObject({code:'conversation_reset'})
  }finally{await stream.close()}
})

const scopeId='team',entry='workroom'
const binding=(active:boolean,expectedRevision:number)=>({action:'entry.bind',operationId:randomUUID(),expectedRevision,scopeId,sourceId:'local',accountNamespace:'local-test',nativeId:entry,history:'group',active})

async function scope(client:Client){
  await client.api('/router-scopes',{action:'scope.put',operationId:randomUUID(),expectedRevision:0,
    scope:{id:scopeId,tenantId:'tenant',name:'Test team',managers:[JSON.stringify(['local','alice'])],workerIds:['one'],sourceIds:['local'],backendIds:['codex']}})
  return client.api('/router-scopes',binding(true,0))
}

async function send(client:Client,text:string,room=entry){
  return client.api('/send',{source:'local',event:{id:randomUUID(),scope:room,thread:room+'-topic',addressed:true,text}})
}

async function plan(client:Client,anchor:string,now:number){
  return client.api('/router-proactive',{action:'schedule.put',scopeId,operationId:randomUUID(),expectedRevision:0,
    schedule:{id:'recurring',name:'Plan test',triggerId:anchor,prompt:'Check a local fixture',mode:'standalone',notification:'always',active:true,
      timing:{kind:'interval',startAt:new Date(now+1000).toISOString(),intervalSeconds:3600}}})
}

const scheduleState='/router-proactive/state?scopeId='+scopeId
const scheduledCalls=(calls:ModelRequest[])=>calls.filter(request=>!!JSON.parse(request.input).schedule)

it.each(['entry','source actor'] as const)('skips a due scheduled run after %s authority is revoked',async kind=>{
  const f=fixture(),client=await f.open(),bound=await scope(client)
  const anchor=await send(client,'Authorize a local schedule')
  await plan(client,anchor.triggerId,f.now())
  if(kind==='entry')await client.api('/router-scopes',binding(false,bound.revision))
  else{
    const {current}=await client.api('/settings')
    await client.api('/settings',{revision:current.revision,patch:{sources:current.config.sources.map((source:{id:string})=>({...source,allowedActors:['bob']}))}})
  }
  f.advance(1100)
  await expect.poll(async()=>(await client.api(scheduleState)).runs.at(0)?.state).toBe('skipped')
  expect(scheduledCalls(f.calls)).toHaveLength(0)
})

it('settles a queued scheduled run once after restarting the HTTP service',async()=>{
  const f=fixture(r=>({reply:JSON.parse(r.input).schedule?'Verified schedule reply':''})),first=await f.open()
  await scope(first)
  const anchor=await send(first,'Authorize a local schedule')
  const saved=await plan(first,anchor.triggerId,f.now())
  await first.api('/action',{action:'pause'})
  const queued=await first.api('/router-proactive',{action:'schedule.run',scopeId,operationId:randomUUID(),expectedRevision:saved.revision,id:saved.id})
  expect(queued.state).toBe('queued')
  await close(first.host)
  const second=await f.open()
  expect((await second.api(scheduleState)).runs).toEqual([expect.objectContaining({id:queued.id,state:'queued'})])
  expect(scheduledCalls(f.calls)).toHaveLength(0)
  await second.api('/action',{action:'resume'})
  await expect.poll(async()=>(await second.api(scheduleState)).runs).toEqual([
    expect.objectContaining({id:queued.id,state:'completed',delivery:'sent'}),
  ])
  expect(scheduledCalls(f.calls)).toHaveLength(1)
  await close(second.host)
  const third=await f.open()
  expect((await third.api(scheduleState)).runs).toEqual([expect.objectContaining({id:queued.id,state:'completed',delivery:'sent'})])
  expect(scheduledCalls(f.calls)).toHaveLength(1)
})

it('discards late extraction output after an entry change and keeps it discarded across restart',async()=>{
  const marker='Keep this temporary preference in the original room only'
  let release:()=>void=()=>{}
  let seen=0
  const f=fixture(request=>{
    const input=JSON.parse(request.input)
    if(!Array.isArray(input.messages))return {reply:''}
    const source=input.messages.findIndex((message:{text:string})=>message.text===marker)
    if(source<0)return {memories:[],topics:[]}
    seen++
    return new Promise(resolve=>{release=()=>resolve({topics:[],memories:[
      {action:'add',target:null,kind:'preference',topic:'fixture',content:marker,importance:4,source,quote:marker,expiresAt:null,inferred:false},
    ]})})
  })
  const first=await f.open(),bound=await scope(first)
  await first.api('/router-scopes',{...binding(true,0),nativeId:'other-room'})
  const anchor=await send(first,'Configure automatic memory')
  await first.api('/agent-memory',{triggerId:anchor.triggerId,command:{action:'configure',expectedRevision:0,
    policy:{writeMode:'auto',delayMs:0,minIntervalMs:0}}})
  await send(first,marker)
  let revoked
  try{
    await expect.poll(()=>seen).toBe(1)
    revoked=await first.api('/router-scopes',binding(false,bound.revision))
  }finally{release()}
  const other=await send(first,'Check local memory from a current context','other-room')
  const check=(c:Client)=>c.api('/router-memory',{triggerId:other.triggerId,query:{}})
  expect((await check(first)).items).toEqual([])
  await close(first.host)
  const second=await f.open()
  expect((await check(second)).items).toEqual([])
  await second.api('/router-scopes',binding(true,revoked.revision))
  const restored=await send(second,'Check memory after granting fresh room access')
  const memory=await second.api('/router-memory',{triggerId:restored.triggerId,query:{}})
  expect(memory.items).toEqual([])
  await delay(450)
  expect(seen).toBe(1)
})
