import {GithubError} from './github-errors.ts'

export interface GithubReadOptions {
 signal?:AbortSignal
 check?:()=>void
 fresh?:boolean
}

export interface GithubReadResponse<T> {
 data:T
 bytes:number
 freshnessMs:number
 etag?:string
}

interface CacheEntry extends GithubReadResponse<unknown> {
 freshUntil:number
 expiresAt:number
}

interface InFlight {
 controller:AbortController
 waiters:Set<()=>void>
 result:Promise<unknown>
}

/** Process-local response caching and request deduplication, under the caller's current authority. */
export class GithubReadCache {
 private readonly entries=new Map<string,CacheEntry>()
 private readonly inFlight=new Map<string,InFlight>()
 private bytes=0
 constructor(private readonly maxEntries=128,private readonly maxBytes=16*1024*1024){}

 clear(){
  this.entries.clear()
  this.inFlight.clear()
  this.bytes=0
 }

 async read<T>(key:string,{signal,check,fresh}:GithubReadOptions,load:(
  signal:AbortSignal,authorize:()=>void,previous:GithubReadResponse<T>|undefined
 )=>Promise<GithubReadResponse<T>>):Promise<T>{
  const authorize=()=>{check?.();signal?.throwIfAborted()}
  authorize()
  const previous=this.cached(key)
  if(previous&&!fresh&&previous.freshUntil>Date.now())return previous.data as T
  const flight=this.inFlight.get(key)??this.start(key,load,previous as GithubReadResponse<T>|undefined)
  flight.waiters.add(authorize)
  let onAbort:(()=>void)|undefined
  try{
   const data=await new Promise<unknown>((resolve,reject)=>{
    onAbort=()=>reject(signal?.reason)
    signal?.addEventListener('abort',onAbort,{once:true})
    flight.result.then(resolve,reject)
   })
   authorize()
   return data as T
  }finally{
   if(onAbort)signal?.removeEventListener('abort',onAbort)
   flight.waiters.delete(authorize)
   if(flight.waiters.size===0){
    if(this.inFlight.get(key)===flight)this.inFlight.delete(key)
    flight.controller.abort()
   }
  }
 }

 private start<T>(key:string,load:(signal:AbortSignal,authorize:()=>void,previous:GithubReadResponse<T>|undefined)=>Promise<GithubReadResponse<T>>,
  previous:GithubReadResponse<T>|undefined){
  const controller=new AbortController(),waiters=new Set<()=>void>()
  const authorize=()=>{
   controller.signal.throwIfAborted()
   let failure:unknown
   for(const check of waiters){
    try{check();return}catch(error){failure=error}
   }
   throw failure??Error('GitHub request no longer has an authorized caller')
  }
  const result=Promise.resolve().then(async()=>{
   authorize()
   const response=await load(controller.signal,authorize,previous)
   authorize()
   if(this.inFlight.get(key)===flight)this.save(key,response)
   return response.data
  }).catch(error=>{
   if(this.inFlight.get(key)===flight&&error instanceof GithubError&&
    ['auth_required','access_denied','not_found'].includes(error.code))this.remove(key)
   throw error
  }).finally(()=>{
   if(this.inFlight.get(key)===flight)this.inFlight.delete(key)
  })
  const flight={controller,waiters,result}
  this.inFlight.set(key,flight)
  return flight
 }

 private cached(key:string){
  const entry=this.entries.get(key)
  if(!entry)return
  if(entry.expiresAt<=Date.now()){this.remove(key);return}
  this.entries.delete(key)
  this.entries.set(key,entry)
  return entry
 }

 private remove(key:string){
  const entry=this.entries.get(key)
  if(entry){this.bytes-=entry.bytes;this.entries.delete(key)}
 }

 private save(key:string,response:GithubReadResponse<unknown>){
  this.remove(key)
  if(response.bytes>this.maxBytes||response.freshnessMs<=0&&!response.etag)return
  while(this.entries.size>=this.maxEntries||this.bytes+response.bytes>this.maxBytes)
   this.remove(this.entries.keys().next().value!)
  const freshUntil=Date.now()+response.freshnessMs
  const expiresAt=freshUntil+(response.etag?5*60_000:0)
  this.entries.set(key,{...response,freshUntil,expiresAt})
  this.bytes+=response.bytes
 }
}

export function githubResponseCachePolicy(headers:Headers,previousEtag?:string){
 const policy=headers.get('cache-control')??''
 const directives=policy.toLowerCase().split(',').map(value=>value.trim())
 if(directives.includes('no-store')||headers.get('vary')?.trim()==='*')return {freshnessMs:0,etag:undefined}
 const etag=headers.get('etag')??previousEtag
 const maxAge=directives.find(value=>/^max-age=\d+$/.test(value))
 const age=Math.max(0,Number(headers.get('age'))||0)
 const freshnessMs=directives.includes('no-cache')?0:Math.min(60_000,maxAge?Math.max(0,Number(maxAge.slice(8))-age)*1000:30_000)
 return {freshnessMs,etag}
}
