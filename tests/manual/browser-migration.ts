/** Real Chromium test for upgrading, profile grants, and reverting to the old driver. */
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp, rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {AgentBrowserDriver} from '../../src/browser-driver.ts'
import {configSchema} from '../../src/config.ts'
import {Runtime} from '../../src/runtime.ts'
import type {WorkOwner} from '../../src/work.ts'

const root=await mkdtemp(join(tmpdir(),'roppo-browser-upgrade-'))
const stateDir=join(root,'state')
const config=configSchema.parse({stateDir,work:{sandboxDriver:'disabled'},
  execution:{workers:[{id:'allowed',backend:'codex'},{id:'denied',backend:'codex'}]},
  sources:[{id:'local',kind:'local',cwd:root,allowedActors:['operator']}],
  browser:{...(process.env.ROPPO_TEST_CHROMIUM?{executablePath:process.env.ROPPO_TEST_CHROMIUM}:{})},
})
const site=createServer((req,res)=>{
  const path=req.url??'/'
  res.setHeader('Content-Type','text/html')
  if(path==='/sign-in')res.setHeader('Set-Cookie','login=alice; Max-Age=3600; HttpOnly; Path=/')
  const signed=path==='/sign-in'||req.headers.cookie?.includes('login=alice')
  res.end(`<title>Browser upgrade</title><h1>${signed?'Signed in':'Public'}</h1><p id="note"></p><script>
    if(location.pathname==='/sign-in')localStorage.setItem('note','Original profile state');
    if(location.pathname==='/edit')localStorage.setItem('note','Changed in Worker A');
    document.getElementById('note').textContent=localStorage.getItem('note')||'Empty';
  </script>`)
})
await new Promise<void>(done=>site.listen(0,'127.0.0.1',done))
const port=(site.address() as {port:number}).port, origin='http://127.0.0.1:'+port
const client=randomUUID(), user='host'
const legacy=()=>new Runtime(config,{browserDriver:new AgentBrowserDriver(join(stateDir,'browser'),config.browser)})
let runtime:Runtime|undefined
try{
  runtime=legacy()
  const profile=runtime.browser.saveProfile(user,{name:'Existing browser',allowedWorkers:['allowed']})
  const before=await runtime.browser.openPersonal(user,profile.id,client)
  await runtime.browser.action(user,before.id,client,before.epoch,{action:'navigate',url:origin+'/sign-in'})
  await runtime.browser.action(user,before.id,client,before.epoch,{action:'navigate',url:origin+'/page'})
  await runtime.close()

  runtime=new Runtime(config)
  const manager=runtime.browser
  const after=await manager.openDefault(user,client,randomUUID())
  assert.equal(after.profileId,profile.id)
  assert.equal(after.provider,'roppo')
  assert.equal(after.url,origin+'/page')
  const restored=manager.list(user).profiles.find(item=>item.id===profile.id)
  assert.equal(restored?.name,'Existing browser')
  assert.deepEqual(restored?.allowedWorkers,['allowed'])
  assert.equal(restored?.shareWithWorkers,undefined)
  assert.equal((await manager.openPersonal(user,profile.id,client)).id,after.id)

  const owner=(workerId:string):WorkOwner=>{
    const actor={ticketId:randomUUID(),assignmentId:randomUUID(),cwd:root,sandbox:'read-only' as const,depth:0}
    runtime!.store.put('run',actor.ticketId,{workerId})
    return actor
  }
  const [a,b,c]=[owner('allowed'),owner('allowed'),owner('denied')]
  runtime.validWork=work=>[a,b,c].some(actor=>actor.ticketId===work.ticketId&&actor.assignmentId===work.assignmentId)
  const open=async(actor:WorkOwner,profileId?:string,url=origin+'/page')=>
    await manager.tool(actor,{action:'open',requestId:randomUUID(),profileId,url}) as {id:string;snapshot:string}
  const [first,second,publicPage,otherOrigin]=await Promise.all([
    open(a,profile.id),open(b,profile.id),open(c),open(a,profile.id,'http://localhost:'+port+'/page'),
  ])
  for(const page of [first,second]){
    assert.match(page.snapshot,/Signed in/)
    assert.match(page.snapshot,/Original profile state/)
  }
  for(const page of [publicPage,otherOrigin]){
    assert.match(page.snapshot,/Public/)
    assert.match(page.snapshot,/Empty/)
  }
  await assert.rejects(open(c,profile.id),{code:'browser_profile_denied'})
  const changed=await manager.tool(a,{action:'navigate',sessionId:first.id,requestId:randomUUID(),url:origin+'/edit'}) as {snapshot:string}
  assert.match(changed.snapshot,/Changed in Worker A/)
  const isolated=await manager.tool(b,{action:'snapshot',sessionId:second.id,requestId:randomUUID()}) as {snapshot:string}
  assert.match(isolated.snapshot,/Original profile state/)
  manager.saveProfile(user,{name:'Existing browser',shareWithWorkers:false},profile.id)
  await assert.rejects(manager.tool(b,{action:'snapshot',sessionId:second.id,requestId:randomUUID()}),{code:'browser_profile_denied'})
  await runtime.close()

  runtime=legacy()
  const rolledBack=await runtime.browser.openPersonal(user,profile.id,client)
  const session={id:rolledBack.id,directory:join(stateDir,'browser','profiles',profile.id)}
  assert.equal(rolledBack.url,origin+'/page')
  assert.match((await runtime.browser.driver.run(session,['snapshot'])).snapshot,/Signed in/)
  assert.equal(await runtime.browser.driver.evaluate(session,"localStorage.getItem('note')"),'Original profile state')
  console.log('Verified real profile upgrade, scoped login reuse, per-Worker isolation, revocation and reopening with the old driver.')
}finally{
  await runtime?.close()
  site.closeAllConnections()
  await new Promise<void>(done=>site.close(()=>done()))
  await rm(root,{recursive:true,force:true})
}
