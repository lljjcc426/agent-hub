import {randomUUID} from 'node:crypto'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {afterEach,expect,it,vi} from 'vitest'
import {Runtime} from '../src/runtime.ts'
import {configSchema} from '../src/config.ts'
import {GithubReader} from '../src/github-read.ts'
import {githubRateLimitDelay} from '../src/github-errors.ts'
import {loadManagedConfig,managedConnections,managedSecrets,prepareManagedConfig,recoverManagedFiles} from '../src/managed-config.ts'
import {serve} from '../src/server.ts'
import * as githubCli from '../src/github-cli.ts'
import type {Tool} from '@modelcontextprotocol/sdk/types.js'
import type {Model} from '../src/model.ts'

const repository='fixture/project',token='ghp_TEST_FIXTURE'
const sha='a'.repeat(40),mergeSha='b'.repeat(40)
const cleanups:(()=>Promise<void>)[]=[]
afterEach(async()=>{
 for(const clean of cleanups.splice(0).reverse())await clean()
 vi.unstubAllGlobals()
})
const json=(value:unknown,status=200)=>Response.json(value,{status})
const hostFor=(model:Model,withWorker=false)=>{
 const root=mkdtempSync(join(tmpdir(),'roppo-github-test-'))
 const host=new Runtime(configSchema.parse({stateDir:join(root,'state'),port:0,work:{sandboxDriver:'disabled',autoRecover:false},
  execution:{router:{mode:'host'},...(withWorker?{management:{enabled:true},workers:[{id:'research',backend:'codex'}]}:{})},
  sources:[{id:'local',kind:'local',cwd:root,allowedActors:['operator']}]}),{model})
 cleanups.push(async()=>{await host.close();rmSync(root,{recursive:true,force:true})})
 return host
}
const output=(result:{contentItems:{type:string;text?:string}[]})=>JSON.parse(result.contentItems[0]!.text!)
const compare={repository,action:'compare',base:sha,head:mergeSha}
const patch='@@ -1 +1 @@\n-old line\n+new line'
const comparedFile={filename:'src/main.ts',status:'modified',additions:1,deletions:1,patch}
const comparison=(files:unknown[])=>({status:'ahead',ahead_by:1,behind_by:0,total_commits:1,files})
function legacyConnection(host:Runtime){
 const id=randomUUID(),state=host.config.stateDir
 const key='AGENTHUB_SETUP_GITHUB_ACCESS_'+id.replaceAll('-','').toUpperCase()
 const files=prepareManagedConfig(state,id,managedConnections(state),{[key]:token},true)
 host.store.put('github-access','current',{id,account:'fixture-user',repositories:[repository],tools:[],checkedAt:Date.now()})
 host.store.put('github-connection-change',id,{action:'connect',at:Date.now()})
 files.finish()
}

it('returns exact unified diffs and pages the files and large patches in an authorized comparison',async()=>{
 const largePatch=patch+'\n'+' '.repeat(7970)+'🙂\n+last line\n'
 let requests=0
 const reader=new GithubReader(async(input,init)=>{
  requests++
  const url=new URL(String(input))
  expect(url.origin).toBe('https://api.github.com')
  expect(url.pathname).toBe('/repos/'+repository+'/compare/'+sha+'...feature%2Fchange')
  expect(url.searchParams.get('page')).toBe('1')
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+token)
  return json(comparison([
   {...comparedFile,status:'renamed',previous_filename:'src/old.ts',patch:largePatch},
   ...Array.from({length:8},(_,i)=>({...comparedFile,filename:'module-'+i+'.ts'})),
   {filename:'logo.png',status:'modified',additions:0,deletions:0},
  ]))
 })
 const read=async(args:object)=>{const result=await reader.read({...compare,head:'feature/change',...args},()=>token);expect(result.success).toBe(true);return output(result)}
 const first=await read({})
 expect(first).toMatchObject({reportedFiles:10,matchingFiles:10,nextFileOffset:8,totalCommits:1})
 expect(first.files[0]).toMatchObject({path:'src/main.ts',previousPath:'src/old.ts',patchAvailable:true})
 expect(first.files[0].patch).toContain(patch)
 const second=await read({fileOffset:first.nextFileOffset})
 expect(second.nextFileOffset).toBeNull()
 expect(second.files.map((file:{path:string})=>file.path)).toEqual(['module-7.ts','logo.png'])
 expect(second.files[1]).toMatchObject({path:'logo.png',patchAvailable:false})
 const focused=await read({paths:['src/old.ts']})
 const next=await read({paths:['src/old.ts'],patchOffset:focused.files[0].nextPatchOffset})
 expect(focused.files[0].nextPatchOffset).toBeGreaterThan(0)
 expect(next.files[0].nextPatchOffset).toBeNull()
 expect(focused.files[0].patch+next.files[0].patch).toBe(largePatch)
 expect(requests).toBe(1)
})

it('shares authenticated REST and native MCP reads and serves subsequent pages from the same response',async()=>{
 const diff='@@ -1 +1 @@\n'+'+evidence content\n'.repeat(2600)
 const fetcher=vi.fn<typeof fetch>().mockImplementation(async(input,init)=>{
  expect(new URL(String(input)).pathname).toBe('/repos/'+repository+'/pulls/1')
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+token)
  expect(new Headers(init?.headers).get('accept')).toBe('application/vnd.github.diff')
  return new Response(diff,{headers:{'cache-control':'private, max-age=30'}})
 })
 vi.stubGlobal('fetch',fetcher)
 const host=hostFor({async run(){throw Error('Unexpected turn')}})
 legacyConnection(host)
 const inspect=vi.spyOn(host.toolConnections,'inspectManaged').mockResolvedValue([{
  name:'pull_request_read',annotations:{readOnlyHint:true},
  inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'}}},
 }])
 const invoke=vi.spyOn(host.toolConnections,'invokeManaged').mockImplementation(async(_id,_config,_headers,_tool,_input,authorize)=>{
  authorize()
  return {result:{content:[{type:'text',text:diff}]}}
 })
 const api={action:'api',apiPath:'repos/'+repository+'/pulls/1',format:'diff'}
 const mcp={action:'tool',tool:'pull_request_read',arguments:{method:'get_diff',pullNumber:1}}
 for(const request of [api,mcp]){
  const read=(offset=0)=>host.github.read({repository,...request,offset},true,()=>{}).then(output)
  const first=await Promise.all(Array.from({length:16},()=>read()))
  expect(first.every(page=>page.text===first[0].text)).toBe(true)
  let text=first[0].text, offset=first[0].nextOffset
  while(offset!==null){
   const page=await read(offset)
   text+=page.text
   offset=page.nextOffset
  }
  expect(text).toBe(diff)
 }
 expect(fetcher).toHaveBeenCalledTimes(1)
 expect(inspect).toHaveBeenCalledTimes(1)
 expect(invoke).toHaveBeenCalledTimes(1)
 expect(output(await host.github.read({repository,...mcp},false,()=>{}))).toMatchObject({status:'access_denied'})
 expect(invoke).toHaveBeenCalledTimes(1)
})

it('partitions snapshots by credential and response format and revalidates expired data with ETag',async()=>{
 const epoch=Date.now()
 let now=epoch
 const time=vi.spyOn(Date,'now').mockImplementation(()=>now)
 cleanups.push(async()=>{time.mockRestore()})
 const requests:{auth:string|null;accept:string|null;etag:string|null}[]=[]
 let denied=false
 const reader=new GithubReader(async(_input,init)=>{
  const h=new Headers(init?.headers),etag=h.get('if-none-match'),auth=h.get('authorization'),accept=h.get('accept')
  requests.push({auth,accept,etag})
  if(denied)return new Response(null,{status:403})
  if(etag)return new Response(null,{status:304,headers:{'cache-control':'private, max-age=1'}})
  if(accept==='application/vnd.github.diff')return new Response(patch,{headers:{'cache-control':'no-store'}})
  return Response.json({visibility:auth===null?'public':auth.endsWith('_other')?'other':'owner'},
   {headers:{etag:'"fixture"','cache-control':'private, max-age=1'}})
 })
 const path='repos/'+repository+'/pulls?state=open&per_page=20'
 expect(await reader.readRest(path,token)).toEqual({visibility:'owner'})
 expect(await reader.readRest('repos/'+repository+'/pulls?per_page=20&state=open',token)).toEqual({visibility:'owner'})
 expect(await reader.readRest(path,token+'_other')).toEqual({visibility:'other'})
 expect(await reader.readRest(path,undefined)).toEqual({visibility:'public'})
 expect(await reader.readRest(path,token,{format:'diff'})).toBe(patch)
 expect(await reader.readRest(path,token,{format:'diff'})).toBe(patch)
 expect(requests).toHaveLength(5)
 now+=1100
 expect(await reader.readRest(path,token)).toEqual({visibility:'owner'})
 expect(requests.at(-1)).toMatchObject({auth:'Bearer '+token,etag:'"fixture"'})
 expect(await reader.readRest(path,token,{fresh:true})).toEqual({visibility:'owner'})
 expect(requests).toHaveLength(7)
 denied=true
 await expect(reader.readRest(path,token,{fresh:true})).rejects.toMatchObject({code:'access_denied'})
 await expect(reader.readRest(path,token)).rejects.toMatchObject({code:'access_denied'})
 expect(requests).toHaveLength(9)
})

it('cancels individual coalesced callers promptly and checks authority before returning shared data',async()=>{
 let release!:()=>void
 const ready=new Promise<void>(r=>{release=r}),controller=new AbortController()
 const fetcher=vi.fn<typeof fetch>().mockImplementation(async(_input,init)=>{
  await ready
  expect(init?.signal?.aborted).toBe(false)
  return json({value:'authorized evidence'})
 })
 const reader=new GithubReader(fetcher),path='repos/'+repository+'/pulls/1'
 let permitted=true
 const check=()=>{if(!permitted)throw Error('scope revoked')}
 const primary=reader.readRest(path,token,{signal:controller.signal})
 const revoked=reader.readRest(path,token,{check})
 const retained=reader.readRest(path,token)
 const primaryError=expect(primary).rejects.toThrow('cancelled by caller')
 const revokedError=expect(revoked).rejects.toThrow('scope revoked')
 controller.abort(Error('cancelled by caller'))
 await primaryError
 permitted=false
 release()
 await revokedError
 expect(await retained).toEqual({value:'authorized evidence'})
 await expect(reader.readRest(path,token,{check})).rejects.toThrow('scope revoked')
 expect(fetcher).toHaveBeenCalledTimes(1)
})

it('caps combined GitHub requests and prevents queued reads from sending during Retry-After',async()=>{
 let active=0,peak=0,calls=0
 const reader=new GithubReader(async(input)=>{
  calls++
  peak=Math.max(peak,++active)
  const limited=String(input).endsWith('/0')
  await delay(limited?1:20)
  active--
  return limited?new Response('limit',{status:429,headers:{'retry-after':'60'}}):json({id:String(input).split('/').at(-1)})
 })
 const selection=Array.from({length:32},(_,i)=>reader.readRest('repos/'+repository+'/issues/'+i,token))
 const results=await Promise.allSettled(selection)
 expect(peak).toBe(10)
 expect(calls).toBe(10)
 expect(results.filter(r=>r.status==='rejected')).toHaveLength(23)
 await expect(reader.readRest('repos/'+repository+'/pulls/5',token)).rejects.toMatchObject({code:'rate_limited',retryAfterSeconds:60})
 expect(calls).toBe(10)
 expect(await reader.readRest('repos/'+repository+'/pulls/5',undefined)).toEqual({id:'5'})
})

it('shares cooldown between MCP and REST and advertises only usable GitHub actions to subagents',async()=>{
 const fetcher=vi.fn<typeof fetch>()
 vi.stubGlobal('fetch',fetcher)
 const host=hostFor({async run(){throw Error('Unexpected turn')}})
 legacyConnection(host)
 vi.spyOn(host.toolConnections,'inspectManaged').mockResolvedValue([{
  name:'pull_request_read',annotations:{readOnlyHint:true},inputSchema:{type:'object'},
 }])
 const invoke=vi.spyOn(host.toolConnections,'invokeManaged').mockResolvedValue({
  result:{isError:true,content:[{type:'text',text:'HTTP 429: rate limit'}]},
 })
 const githubTools=host.availableWorkerSpecs({githubConnector:false}).filter(s=>s.name.startsWith('github_'))
 expect(githubTools.map(t=>t.name)).toEqual(['github_read'])
 expect(githubTools[0]?.inputSchema).toMatchObject({properties:{action:{
  enum:['overview','files','pull','pulls','issue','checks','branch'],
 }}})
 expect(host.availableWorkerSpecs({githubConnector:false,network:false}).some(s=>s.name.startsWith('github_'))).toBe(false)
 const read=(input:object)=>host.github.read({repository,...input},true,()=>{}).then(output)
 const mcp={action:'tool',tool:'pull_request_read',arguments:{method:'get_diff',pullNumber:1}}
 expect(await read(mcp)).toMatchObject({status:'rate_limited',retryAfterSeconds:60})
 expect(await read(mcp)).toMatchObject({status:'rate_limited',retryAfterSeconds:60})
 expect(await read({action:'api',apiPath:'repos/'+repository+'/pulls/1'})).toMatchObject({status:'rate_limited',retryAfterSeconds:60})
 expect(invoke).toHaveBeenCalledTimes(1)
 expect(fetcher).not.toHaveBeenCalled()
})

it('reuses CLI credentials for concurrent reads and fetches current data after a connector write',async()=>{
 let title='Before',gets=0,writes=0
 const credential=vi.spyOn(githubCli,'githubCliToken').mockResolvedValue(token)
 cleanups.push(async()=>{credential.mockRestore()})
 vi.stubGlobal('fetch',async(_input:RequestInfo|URL,init?:RequestInit)=>{
  if(init?.method==='PATCH'){
   writes++
   title=JSON.parse(String(init.body)).title
  }else gets++
  return json({number:1,title})
 })
 const host=hostFor({async run(){throw Error('Unexpected turn')}})
 legacyConnection(host)
 host.store.put('github-access','current',{...host.store.get<object>('github-access','current'),source:'cli'})
 const check=()=>{}
 const get=(fresh=false)=>host.github.read({repository,action:'api',apiPath:'repos/'+repository+'/pulls/1',fresh},true,check).then(output)
 expect(await Promise.all(Array.from({length:20},()=>get()))).toEqual(Array(20).fill(expect.objectContaining({data:{number:1,title:'Before'}})))
 expect(credential).toHaveBeenCalledTimes(1)
 expect(gets).toBe(1)
 const plan=await host.github.prepare('github_write',{repository,action:'api',apiPath:'pulls/1',verb:'PATCH',arguments:{title:'After'}})
 expect(output(await host.github.execute(plan,check))).toMatchObject({status:'complete'})
 expect(await get()).toMatchObject({data:{title:'After'}})
 expect(gets).toBe(2)
 expect(writes).toBe(1)
 const n=credential.mock.calls.length
 await get(true)
 expect(credential.mock.calls.length).toBe(n+1)
 expect(gets).toBe(3)
 host.github.disconnect(check)
 expect(await get()).toMatchObject({status:'unconfigured'})
 expect(gets).toBe(3)
})

it('rejects invalid comparisons and refuses to send a comparison without a connector credential',async()=>{
 const fetcher=vi.fn<typeof fetch>()
 const reader=new GithubReader(fetcher)
 expect(output(await reader.read({...compare,head:undefined},()=>token)).status).toBe('invalid_request')
 expect(output(await reader.read({...compare,patchOffset:1},()=>token)).status).toBe('invalid_request')
 expect(output(await reader.read(compare,()=>undefined)).status).toBe('auth_required')
 expect(fetcher).not.toHaveBeenCalled()
})

it('isolates anonymous quota from connector quota and stops retrying within the cooldown',async()=>{
 const requests:string[]=[]
 const reader=new GithubReader(async(input,init)=>{
  const authorization=new Headers(init?.headers).get('authorization')
  const path=new URL(String(input)).pathname
  requests.push(authorization??'anonymous')
  if(!authorization)return new Response('limit',{status:403,headers:{'x-ratelimit-remaining':'0','retry-after':'60'}})
  if(path.includes('/compare/'))return json(comparison([comparedFile]))
  if(path.endsWith('/pulls'))return json({message:'You have exceeded a secondary rate limit.'},403)
  return json({name:'main',commit:{sha}})
 })
 const branch={repository,action:'branch',ref:'main'}
 const pulls={repository,action:'pulls'}
 const limited=await reader.read(pulls,()=>undefined)
 expect(output(limited)).toMatchObject({status:'rate_limited',authentication:'anonymous',retryAfterSeconds:60})
 expect(output(await reader.read(branch,()=>undefined))).toMatchObject({status:'rate_limited',authentication:'anonymous'})
 expect(output(await reader.read(compare,()=>token)).files[0].patch).toBe(patch)
 expect(output(await reader.read(pulls,()=>token))).toMatchObject({status:'rate_limited',authentication:'connector',retryAfterSeconds:60})
 expect(output(await reader.read(branch,()=>token))).toMatchObject({status:'rate_limited',authentication:'connector'})
 expect((await reader.read(branch,()=>token+'_other')).success).toBe(true)
 expect(requests).toEqual(['anonymous','Bearer '+token,'Bearer '+token,'Bearer '+token+'_other'])
})

it('honors the later exhausted-quota reset and accepts an HTTP-date Retry-After',()=>{
 const now=Date.UTC(2026,10,22,9,0)
 const retry=new Date(now+30_000).toUTCString()
 const reset=String(now/1000+90)
 expect(githubRateLimitDelay(new Headers({'retry-after':retry,'x-ratelimit-remaining':'0','x-ratelimit-reset':reset}),now)).toBe(90)
 expect(githubRateLimitDelay(new Headers({'retry-after':retry,'x-ratelimit-remaining':'5','x-ratelimit-reset':reset}),now)).toBe(30)
})

it('delegates comparisons with the saved token and answers a new Chat message while the Worker runs',async()=>{
 const outbound:string[]=[]
 vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(String(input))
  outbound.push(url.pathname)
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+token)
  if(url.pathname.startsWith('/repos/fixture/inaccessible/'))return json({},404)
  return json(comparison([comparedFile]))
 })
 const receipts:unknown[]=[]
 let releaseWorker!:()=>void
 const workerGate=new Promise<void>(resolve=>{releaseWorker=resolve})
 let workerStarted=false
 const host=hostFor({async run(request){
  const threadId=request.threadId??randomUUID(),turnId=randomUUID()
  request.onThread?.(threadId);request.onTurn?.(turnId)
  const call=(name:string,args:unknown)=>request.onTool!(name,args,randomUUID())
  if(request.role==='worker'){
   workerStarted=true
   await workerGate
   receipts.push(output(await call('github_read',compare)))
   receipts.push(output(await call('github_read',{...compare,repository:'fixture/other'})))
   receipts.push(output(await call('github_read',{...compare,repository:'fixture/inaccessible'})))
   return {threadId,turnId,text:JSON.stringify({state:'ready',summary:'Compared commits',reply:'Compared.',question:null,askedBy:null,handbacks:[]})}
  }
  const input=JSON.parse(request.input)
  if(input.kind!=='user_message')return {threadId,turnId,text:'{"reply":""}'}
  if(input.trigger.text==='你有在看吗')return {threadId,turnId,text:'{"reply":"在，Worker 正在比较提交。"}'}
  expect(request.coordinationTurn).toBe(true)
  expect(request.allowNativeTools).toBeUndefined()
  await call('chat_opening',{text:'I will ask the Worker to compare the two commits.'})
  expect(output(await call('github_read',compare))).toMatchObject({repository,files:[{patch}]})
  const assignment=await call('worker_manage',{action:'assign',id:'research',revision:0,requestId:'comparison',text:'Compare the two fixture commits'})
  expect(output(assignment)).toHaveProperty('ticketId')
  return {threadId,turnId,text:'{"reply":"Assigned the comparison."}'}
 }},true)
 legacyConnection(host)
 const outside=await host.github.read(compare,false,()=>{})
 expect(output(outside).status).toBe('access_denied')
 const chat=host.chat.create('owner')
 const view=()=>host.chat.view(chat.id,'owner')
 const waitUntil=async(done:()=>boolean)=>{
  for(let i=0;i<150;i++){await host.tick();if(done())return;await delay(5)}
  throw Error('Chat did not settle')
 }
 try{
  host.chat.send(chat.id,'owner',{clientMessageId:randomUUID(),text:'Compare the commits.',openingLocale:'en'})
  await waitUntil(()=>workerStarted&&view().messages.some(message=>message.text==='Assigned the comparison.'))
  host.chat.send(chat.id,'owner',{clientMessageId:randomUUID(),text:'你有在看吗',openingLocale:'zh-CN'})
  await waitUntil(()=>view().messages.some(message=>message.text==='在，Worker 正在比较提交。'))
  expect(view().workers[0]?.tasks[0]?.state).toBe('running')
  expect(outbound).toEqual(['/repos/'+repository+'/compare/'+sha+'...'+mergeSha])
 }finally{releaseWorker()}
 await waitUntil(()=>receipts.length===3)
 expect(receipts).toEqual([
  expect.objectContaining({repository,files:[expect.objectContaining({patch})]}),
  expect.objectContaining({repository:'fixture/other',files:[expect.objectContaining({patch})]}),
  expect.objectContaining({status:'not_found'}),
 ])
 expect(outbound).toEqual([repository,'fixture/other','fixture/inaccessible'].map(repo=>'/repos/'+repo+'/compare/'+sha+'...'+mergeSha))
})

it('uses GitHub repository discovery for commit history and accepts a repository outside the picker',async()=>{
 const paths:string[]=[]
 vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname
  paths.push(path)
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+token)
  if(path==='/user/repos')return json([{full_name:repository}])
  if(path==='/repos/fixture/other')return json({default_branch:'main'})
  if(path==='/repos/fixture/other/branches')return json([{name:'main',commit:{sha}}])
  if(path==='/repos/fixture/other/commits')return json([])
  throw Error('Unexpected repository request '+path)
 })
 const host=hostFor({async run(){throw Error('Model unused')}})
 legacyConnection(host)
 const signal=new AbortController().signal
 const result=await host.chat.commitHistory('owner',{repository:'github:fixture/other'},()=>{},signal)
 expect(result).toMatchObject({repository:'github:fixture/other',branch:'main',repositories:[
  {id:'github:'+repository,label:repository},{id:'github:fixture/other',label:'fixture/other'},
 ]})
 expect(await host.github.visibleRepositories(()=>{},signal)).toEqual([repository])
 expect(paths).toEqual(['/user/repos','/repos/fixture/other','/repos/fixture/other/branches','/repos/fixture/other/commits'])
})

it('starts all repository reads together and returns a cited excerpt plus a normal missing-path result',async()=>{
 let release!:()=>void
 const barrier=new Promise<void>(resolve=>{release=resolve})
 const started:string[]=[]
 const reader=new GithubReader(async (input,options)=>{
  const path=new URL(String(input)).pathname
  started.push(path)
  expect(new Headers(options?.headers).has('authorization')).toBe(false)
  await barrier
  if(path.endsWith('/missing'))return json({},404)
  if(path.endsWith('/contents'))return json([{path:'src',type:'dir'}])
  if(path.endsWith('/readme'))return json({path:'README.md',type:'file',encoding:'base64',content:Buffer.from('Title\n\nImport integration to read a repository').toString('base64'),html_url:'https://github.com/'+repository+'/blob/main/README.md'})
  return json({default_branch:'main',description:'Integration fixture'})
 })
 const pending=reader.read({repository,paths:['missing'],query:'integration'},()=>undefined)
 try{
  for(let i=0;i<10&&started.length<4;i++)await delay(1)
  expect(started).toHaveLength(4)
 }finally{release()}
 const result=await pending
 expect(result.success).toBe(true)
 expect(output(result).results).toEqual(expect.arrayContaining([
  expect.objectContaining({target:'missing',ok:false,status:'not_found'}),
  expect.objectContaining({target:'README',ok:true,data:expect.objectContaining({excerpt:expect.stringContaining('Import integration'),url:expect.stringContaining('#L1-L3')})}),
 ]))
})

it('keeps unavailable GitHub source paths out of the catalog and returns a recoverable tool error',async()=>{
 const host=hostFor({async run(){throw Error('Model unused')}})
 expect((await host.resources.read({resource:'catalog'})).resources).not.toContain('github/directory/<path>')
 const result=await host.resources.readTool({resource:'github/directory/'},{})
 expect(result.failure?.success).toBe(false)
 expect(output(result.failure!).status).toBe('unconfigured')
 expect((await host.resources.readTool({resource:'catalog'},{})).value.resources).toContain('models')
})

it('reads the public tree and links a commit-pinned excerpt when anonymous API quota is exhausted',async()=>{
 const calls:string[]=[]
 const reader=new GithubReader(async(input,init)=>{
  const url=new URL(String(input))
  calls.push(url.hostname+url.pathname)
  expect(new Headers(init?.headers).has('authorization')).toBe(false)
  if(url.hostname==='api.github.com')return new Response('limit',{status:403,headers:{'x-ratelimit-remaining':'0','retry-after':'60'}})
  if(url.hostname==='github.com'){
   const payload={codeViewTreeRoute:{refInfo:{currentOid:sha},tree:{items:[{path:'README.md',contentType:'file'},{path:'src',contentType:'directory'}]}},
    codeViewLayoutRoute:{repo:{defaultBranch:'main'}},sidebarAbout:{description:'Fallback fixture'}}
   return new Response('<script type="application/json" data-target="react-app.embeddedData">'+JSON.stringify({payload})+'</script>')
  }
  expect(url.pathname).toBe('/fixture/project/'+sha+'/README.md')
  return new Response('# Project\nContains the fallback evidence.')
 })
 const result=await reader.read({repository},()=>undefined)
 expect(result.success).toBe(true)
 expect(output(result).results).toEqual(expect.arrayContaining([
  expect.objectContaining({target:'repository',ok:true,data:expect.objectContaining({description:'Fallback fixture'})}),
  expect.objectContaining({target:'README',ok:true,data:expect.objectContaining({url:'https://github.com/'+repository+'/blob/'+sha+'/README.md#L1-L2'})}),
 ]))
 expect(calls.filter(path=>path.startsWith('github.com'))).toEqual(['github.com/fixture/project/tree/HEAD'])
})

it('recovers interrupted connector setup and keeps committed GitHub tokens out of the host environment',async()=>{
 const host=hostFor({async run(){throw Error('Model unused')}}),state=host.config.stateDir
 const name='AGENTHUB_SETUP_GITHUB_ACCESS_FIXTURE'
 const credentials={[name]:token}
 prepareManagedConfig(state,'abandoned-github-connection',managedConnections(state),credentials,true)
 expect(managedSecrets(state)).toEqual(credentials)
 recoverManagedFiles(state)
 expect(managedSecrets(state)).toEqual({})
 const revision='committed-github-connection'
 const prepared=prepareManagedConfig(state,revision,managedConnections(state),credentials,true)
 host.store.put('github-connection-change',revision,{action:'connect'})
 loadManagedConfig(host.config)
 expect(managedSecrets(state)).toEqual(credentials)
 expect(process.env[name]).toBeUndefined()
 prepared.finish()
})

it('connects with a token alone, writes across repositories and never repeats an uncertain comment',async()=>{
 const realFetch=fetch
 let comments=0,merges=0
 const readTokens:string[]=[]
 vi.stubGlobal('fetch',async(input:URL|string|Request,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url)
  if(url.hostname==='api.github.com'){
   const auth=new Headers(init?.headers).get('authorization')??''
   readTokens.push(auth)
   const path=url.pathname
   if(path==='/user')return json({login:'fixture-user'})
   if(path==='/repos/'+repository)return json({full_name:repository,default_branch:'main'})
   if(path.endsWith('/branches/main'))return json({name:'main',commit:{sha}})
   if(path.endsWith('/branches/another'))return json({name:'another',commit:{sha}})
   if(path.endsWith('/pulls/2'))return json({number:2,title:'Fixture pull',head:{sha},base:{ref:'main'}})
   if(path.endsWith('/pulls/1/merge')){
    expect(JSON.parse(String(init?.body))).toMatchObject({sha,merge_method:'squash'})
    merges++
    return json({merged:true,sha:mergeSha})
   }
   if(path.endsWith('/pulls/1'))return json({number:1,merged:merges>0,head:{sha},merge_commit_sha:mergeSha,html_url:'https://github.com/'+repository+'/pull/1'})
   return json({},404)
  }
  if(url.hostname==='api.githubcopilot.com'){
   expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+token)
   if(init?.method!=='POST')return new Response(null,{status:405})
   const request=JSON.parse(String(init.body))
   if(request.id===undefined)return new Response(null,{status:202})
   const reply=(result:unknown)=>json({jsonrpc:'2.0',id:request.id,result})
   if(request.method==='initialize')return reply({protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}})
   if(request.method==='tools/list')return reply({tools:[{
    name:'add_issue_comment',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'},issue_number:{type:'integer'},body:{type:'string'}},required:['owner','repo','issue_number','body']},
   }]})
   if(request.method==='tools/call'){
    expect(request.params.arguments).toEqual({owner:'fixture',repo:'project',issue_number:1,body:'test'})
    comments++
    throw Error('transport interrupted after submission')
   }
   throw Error('Unexpected MCP method')
  }
  return realFetch(input,init)
 })
 const observed:unknown[]=[]
 const model:Model={async run(request){
  const threadId=request.threadId??randomUUID(),turnId=randomUUID()
  request.onThread?.(threadId);request.onTurn?.(turnId)
  const call=async(name:string,args:unknown)=>request.onTool!(name,args,randomUUID())
  await call('chat_opening',{text:'I will check the repository.'})
  const program=[
   'const a=await tools.github_read({repository:"fixture/project",action:"files",paths:["gone"]});',
   'const [b,c]=await Promise.all(["main","another"].map(ref=>tools.github_read({repository:"fixture/project",action:"branch",ref})));',
   'return [a.success,b.success,c.success];',
  ].join('')
  observed.push(output(await call('code_mode',{source:program})))
  observed.push(output(await call('github_read',{repository,action:'pull',number:2})))
  const comment={repository,action:'comment',number:1,body:'test'}
  observed.push(output(await call('github_write',comment)))
  observed.push(output(await call('github_write',{...comment,repository:'https://github.com/Fixture/Project'})))
  observed.push(output(await call('github_write',{repository:'fixture/other',action:'merge_pull',number:1,expectedHead:sha})))
  return {threadId,turnId,text:'{"reply":"Checked."}'}
 }}
 const host=hostFor(model),http=await serve(host)
 cleanups.push(async()=>{http.server.closeAllConnections();await new Promise<void>(resolve=>http.server.close(()=>resolve()))})
 const post=(path:string,headers:Record<string,string>,body:unknown)=>fetch(http.url+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)})
 const credentials={token},endpoint='/api/connectors/github/'
 expect((await post(endpoint+'setup',{},credentials)).status).toBe(401)
 const headers={authorization:'Bearer '+readFileSync(http.tokenPath,'utf8').trim()}
 const connected=await post(endpoint+'setup',headers,credentials)
 expect(connected.status).toBe(200)
 const snapshot=await connected.json()
 expect(snapshot).toMatchObject({status:'connected',account:'fixture-user'})
 expect(snapshot).not.toHaveProperty('repositories')
 expect(JSON.stringify(snapshot)).not.toContain(token)
 expect(Object.values(managedSecrets(host.config.stateDir))).toContain(token)
 const chat=host.chat.create('owner')
 host.chat.setApprovalMode('owner','full')
 host.chat.send(chat.id,'owner',{clientMessageId:randomUUID(),text:'Check and update the fixture repository.',openingLocale:'en'})
 for(let retry=0;retry<100&&!['completed','failed'].includes(host.chat.view(chat.id,'owner').run?.state??'');retry++){
  await host.tick();await delay(10)
 }
 expect(host.chat.view(chat.id,'owner').run?.state).toBe('completed')
 expect(observed).toEqual([
  [false,true,true],expect.objectContaining({repository,item:expect.objectContaining({number:2})}),expect.objectContaining({status:'uncertain'}),
  expect.objectContaining({status:'uncertain'}),expect.objectContaining({repository:'fixture/other',status:'complete',sha:mergeSha}),
 ])
 expect(comments).toBe(1)
 expect(merges).toBe(1)
 expect(readTokens.every(value=>value==='Bearer '+token)).toBe(true)
 expect((await post(endpoint+'disconnect',headers,{})).status).toBe(200)
 expect(host.github.snapshot()).toEqual({status:'disconnected'})
 expect(Object.values(managedSecrets(host.config.stateDir))).not.toContain(token)
})

it('uses the selected CLI login without saving its token and probes repository write access without writing',async()=>{
 const getToken=vi.spyOn(githubCli,'githubCliToken').mockResolvedValue(token)
 cleanups.push(async()=>{getToken.mockRestore()})
 let denied=true
 vi.stubGlobal('fetch',async(input:URL|string,init?:RequestInit)=>{
  const url=new URL(input)
  expect(init?.method??'GET').toBe('GET')
  if(url.origin==='https://github.com'){
   expect(url.searchParams.get('service')).toBe('git-receive-pack')
   expect(new Headers(init?.headers).get('authorization')).toBe('Basic '+Buffer.from('fixture-user:'+token).toString('base64'))
   return new Response(null,denied?{status:403}:{status:200,headers:{'content-type':'application/x-git-receive-pack-advertisement'}})
  }
  expect(url.origin).toBe('https://api.github.com')
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+token)
  return url.pathname==='/user'?json({login:'fixture-user'}):json([])
 })
 const host=hostFor({async run(){throw Error('Unexpected turn')}})
 vi.spyOn(host.toolConnections,'inspectManaged').mockResolvedValue([{name:'add_issue_comment',inputSchema:{type:'object'}}])
 const authorize=()=>{}
 await expect(host.github.connect({source:'cli',account:'another-user'},authorize)).rejects.toMatchObject({code:'auth_required'})
 expect(host.github.snapshot()).toEqual({status:'disconnected'})
 expect(await host.github.connect({source:'cli',account:'fixture-user'},authorize)).toMatchObject({source:'cli',account:'fixture-user',status:'connected'})
 expect(getToken).toHaveBeenLastCalledWith('fixture-user',expect.any(AbortSignal))
 expect(Object.values(managedSecrets(host.config.stateDir))).not.toContain(token)
 expect(await host.github.permissions({repository},authorize)).toMatchObject({
  read:{contents:{status:'allowed'},pullRequests:{status:'allowed'},issues:{status:'allowed'},actions:{status:'allowed'}},
  push:{status:'denied',httpStatus:403},
 })
 denied=false
 expect(await host.github.permissions({repository},authorize)).toMatchObject({push:{status:'allowed',httpStatus:200}})
 expect(host.github.disconnect(authorize)).toEqual({status:'disconnected'})
})

it('keeps a successful merge uncertain when GitHub refuses the subsequent confirmation read',async()=>{
 let mutations=0
 vi.stubGlobal('fetch',async(_input:URL|string,init?:RequestInit)=>{
  if(init?.method==='PUT'){
   mutations++
   return json({merged:true,sha:mergeSha})
  }
  return json({message:'Resource not accessible'},403)
 })
 const host=hostFor({async run(){throw Error('Unexpected turn')}})
 legacyConnection(host)
 const plan=await host.github.prepare('github_write',{repository,action:'merge_pull',number:1,expectedHead:sha})
 const result=await host.github.execute(plan,()=>{})
 expect(result.permission).toBe('uncertain')
 expect(output(result)).toMatchObject({status:'uncertain',operation:'merge_pull'})
 expect(mutations).toBe(1)
})

it('separates GitHub tool reads from writes and returns real provider errors for approved repository operations',async()=>{
 const calls:string[]=[]
 vi.stubGlobal('fetch',async(input:URL|string,init?:RequestInit)=>{
  const url=new URL(input)
  expect(url.hostname).toBe('api.github.com')
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+token)
  calls.push((init?.method??'GET')+' '+url.pathname)
  if(url.pathname.endsWith('/files'))return json([{filename:'src/main.ts'}])
  return json({message:'Resource not accessible'},403)
 })
 const host=hostFor({async run(){throw Error('Unexpected turn')}})
 legacyConnection(host)
 const target={type:'object' as const,properties:{owner:{type:'string'},repo:{type:'string'}}}
 const tools:Tool[]=[
  {name:'pull_request_read',annotations:{readOnlyHint:true},inputSchema:target},
  {name:'actions_run_trigger',annotations:{readOnlyHint:false},inputSchema:target},
 ]
 const inspect=vi.spyOn(host.toolConnections,'inspectManaged').mockResolvedValue(tools)
 const invoke=vi.spyOn(host.toolConnections,'invokeManaged').mockImplementation(async(_id,_config,_headers,_tool,args,beforeSend)=>{
  expect(args).toMatchObject({owner:'fixture',repo:'project',method:'get_files',pullNumber:1})
  beforeSend()
  return {result:{content:[{type:'text',text:'[{"filename":"src/main.ts"}]'}]}}
 })
 const check=()=>{}
 const read=(args:object,authorized=true)=>host.github.read({repository,...args},authorized,check).then(output)
 expect(await read({action:'catalog'})).toMatchObject({read:['pull_request_read'],write:['actions_run_trigger']})
 expect(inspect.mock.calls.some(([, ,headers])=>headers['X-MCP-Readonly']==='true')).toBe(true)
 expect(await read({action:'tool',tool:'actions_run_trigger'})).toMatchObject({status:'unsupported'})
 expect(await read({action:'tool',tool:'pull_request_read',arguments:{owner:'other'}})).toMatchObject({status:'invalid_request'})
 expect(invoke).not.toHaveBeenCalled()
 expect(await read({action:'tool',tool:'pull_request_read',arguments:{method:'get_files',pullNumber:1}})).toMatchObject({data:[{filename:'src/main.ts'}]})
 expect(await read({action:'api',apiPath:'repos/fixture/project/pulls/1/files'},false)).toMatchObject({status:'access_denied'})
 expect(await read({action:'api',apiPath:'repos/fixture/other/pulls/1/files'})).toMatchObject({status:'invalid_request'})
 expect(await read({action:'api',apiPath:'repos/fixture/project/pulls/1/files'})).toMatchObject({data:[{filename:'src/main.ts'}]})
 const api={repository,action:'api',verb:'PATCH',apiPath:'pulls/1',arguments:{title:'Updated'}}
 await expect(host.github.prepare('github_write',{...api,verb:'DELETE',apiPath:'../outside'})).rejects.toMatchObject({code:'invalid_request'})
 await expect(host.github.prepare('github_write',{...api,verb:'PUT',apiPath:'pulls/1/merge'})).rejects.toMatchObject({code:'unsupported'})
 await expect(host.github.prepare('github_write',{...api,apiPath:'git/refs/heads/main',arguments:{force:true}})).rejects.toMatchObject({code:'unsupported'})
 const connected=await host.github.prepare('github_write',api)
 const chat=host.chat.create('owner')
 const turn=host.chat.send(chat.id,'owner',{clientMessageId:randomUUID(),text:'Update the PR title.'})
 const actor=host.chat.permissionActor(turn.runId)!
 expect(actor).toBeDefined()
 const run=()=>host.permissions.run(actor,'github_write',connected.args,host.github.facts(connected),()=>host.github.execute(connected,check))
 const pending=output(await run())
 expect(pending.permission).toBe('pending')
 expect(calls).toEqual(['GET /repos/fixture/project/pulls/1/files'])
 host.permissions.decide(pending.id,true,()=>{})
 expect(output(await run())).toMatchObject({status:'access_denied',source:'github',httpStatus:403})
 expect(output(await run())).toMatchObject({status:'access_denied'})
 expect(calls).toEqual(['GET /repos/fixture/project/pulls/1/files','PATCH /repos/fixture/project/pulls/1'])
})
