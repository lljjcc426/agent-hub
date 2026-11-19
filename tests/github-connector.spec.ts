import {randomUUID} from 'node:crypto'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {afterEach,expect,it,vi} from 'vitest'
import {Runtime} from '../src/runtime.ts'
import {configSchema} from '../src/config.ts'
import {GithubReader} from '../src/github-read.ts'
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
const hostFor=(model:Model)=>{
 const root=mkdtempSync(join(tmpdir(),'roppo-github-test-'))
 const host=new Runtime(configSchema.parse({stateDir:join(root,'state'),port:0,work:{sandboxDriver:'disabled',autoRecover:false},
  execution:{router:{mode:'host'}},sources:[{id:'local',kind:'local',cwd:root,allowedActors:['operator']}]}),{model})
 cleanups.push(async()=>{await host.close();rmSync(root,{recursive:true,force:true})})
 return host
}
const output=(result:{contentItems:{type:string;text?:string}[]})=>JSON.parse(result.contentItems[0]!.text!)

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

it('uses the approved Router and Code Mode paths, enforces repository grants and never repeats an uncertain comment',async()=>{
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
   if(path.endsWith('/contents/gone'))return json({},404)
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
   'const b=await tools.github_read({repository:"fixture/project",action:"branch",ref:"main"});',
   'return [a.success,b.success];',
  ].join('')
  observed.push(output(await call('code_mode',{source:program})))
  observed.push(output(await call('github_write',{repository:'fixture/other',action:'comment',number:1,body:'test'})))
  const comment={repository,action:'comment',number:1,body:'test'}
  observed.push(output(await call('github_write',comment)))
  observed.push(output(await call('github_write',{...comment,repository:'https://github.com/Fixture/Project'})))
  observed.push(output(await call('github_write',{repository,action:'merge_pull',number:1,expectedHead:sha})))
  return {threadId,turnId,text:'{"reply":"Checked."}'}
 }}
 const host=hostFor(model),http=await serve(host)
 cleanups.push(async()=>{http.server.closeAllConnections();await new Promise<void>(resolve=>http.server.close(()=>resolve()))})
 const post=(path:string,headers:Record<string,string>,body:unknown)=>fetch(http.url+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)})
 const credentials={token,repositories:[repository]},endpoint='/api/connectors/github/'
 expect((await post(endpoint+'setup',{},credentials)).status).toBe(401)
 const headers={authorization:'Bearer '+readFileSync(http.tokenPath,'utf8').trim()}
 const connected=await post(endpoint+'setup',headers,credentials)
 expect(connected.status).toBe(200)
 const snapshot=await connected.json()
 expect(snapshot).toMatchObject({status:'connected',account:'fixture-user',repositories:[repository]})
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
  [false,true],expect.objectContaining({status:'access_denied'}),expect.objectContaining({status:'uncertain'}),
  expect.objectContaining({status:'uncertain'}),expect.objectContaining({status:'complete',sha:mergeSha}),
 ])
 expect(comments).toBe(1)
 expect(merges).toBe(1)
 expect(readTokens.every(value=>value==='Bearer '+token)).toBe(true)
 expect((await post(endpoint+'disconnect',headers,{})).status).toBe(200)
 expect(host.github.snapshot()).toEqual({status:'disconnected'})
 expect(Object.values(managedSecrets(host.config.stateDir))).not.toContain(token)
})
