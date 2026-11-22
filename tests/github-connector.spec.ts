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
 const reader=new GithubReader(async(input,init)=>{
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
  expect(output(await call('github_read',compare))).toMatchObject({code:'worker_required'})
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
  expect(outbound).toEqual([])
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
   'return [a.success,b.success,JSON.parse(c.contentItems[0].text).code];',
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
  [false,true,'worker_required'],expect.objectContaining({code:'worker_required'}),expect.objectContaining({status:'uncertain'}),
  expect.objectContaining({status:'uncertain'}),expect.objectContaining({repository:'fixture/other',status:'complete',sha:mergeSha}),
 ])
 expect(comments).toBe(1)
 expect(merges).toBe(1)
 expect(readTokens.every(value=>value==='Bearer '+token)).toBe(true)
 expect((await post(endpoint+'disconnect',headers,{})).status).toBe(200)
 expect(host.github.snapshot()).toEqual({status:'disconnected'})
 expect(Object.values(managedSecrets(host.config.stateDir))).not.toContain(token)
})
