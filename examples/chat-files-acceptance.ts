/** Isolated chat acceptance host. `native` uses the signed-in Codex CLI; default uses a model fixture. */
import {desktopChatFixture} from './chat-fixture-model.ts'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Runtime} from '../src/runtime.ts'
import {configSchema} from '../src/config.ts'
import {serve} from '../src/server.ts'
import type {ModelRequest} from '../src/model.ts'
const native=process.argv[2]==='native'
const root=resolve(process.argv[3]??('.local/chat-files-'+(native?'native':'fixture')+'-20261115'))
mkdirSync(join(root,'workspace'),{recursive:true})
const config=configSchema.parse({stateDir:join(root,'state'),port:Number(process.env.ROPPO_CHAT_PORT??0),work:{sandboxDriver:native?'codex':'disabled',network:false},turnTimeoutMs:180000,
  execution:{router:{mode:'host',label:'Rory',model:'gpt-6.1-terra',effort:'medium'},management:{enabled:true,maxWorkers:4},workers:[{id:'research',label:'Atlas',backend:'codex',model:'gpt-6.1-sol',effort:'high'},{id:'planning',label:'Planning',backend:'codex',model:'gpt-6.1-sol',effort:'high'},{id:'review',label:'Review',backend:'codex',model:'gpt-6.1-sol',effort:'high'},{id:'worker-4',label:'Worker 4',backend:'codex',model:'gpt-6.1-sol',effort:'high'}]},
  sources:[{id:'local',kind:'local',cwd:join(root,'workspace'),allowedActors:['operator'],workspace:{mode:'source'}}]})
const model={async run(r:ModelRequest){
  const threadId=r.threadId??randomUUID(),turnId=randomUUID();r.onThread?.(threadId);r.onTurn?.(turnId)
  const wait=(ms=2800)=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(done,ms);function done(){r.signal?.removeEventListener('abort',stop);resolve()}function stop(){clearTimeout(timer);reject(Error('Fixture cancelled'))}r.signal?.addEventListener('abort',stop,{once:true});if(r.signal?.aborted)stop()})
  const reply=async(text:string)=>{const raw=JSON.stringify({reply:text});r.onOutput?.({id:turnId,type:'start',phase:'answer'});for(let i=0;i<raw.length;i+=9){r.onOutput?.({id:turnId,type:'delta',phase:'answer',text:raw.slice(i,i+9)});await wait(120)}return {threadId,turnId,text:raw}}
  await wait(400)
  const input=JSON.parse(r.input)
  if(r.role==='worker')return {threadId,turnId,text:JSON.stringify({state:'ready',summary:'Fixture worker reply',reply:'Fixture only.',question:null,askedBy:null,handbacks:[]})}
  if(input.trigger?.meta.attachments?.length){
    for(const file of input.trigger.meta.attachments)await r.onTool!('router_read',{resource:file.id},'read-'+file.id)
  }
  return reply(String.raw`### Formula and file review

The quadratic equation $ax^2+bx+c=0$ has roots:

\[
x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}
\]

Inline \(E=mc^2\), and matrix:

$$
\begin{bmatrix}1&2\\3&4\end{bmatrix}
$$

| Item | Formula |
| --- | --- |
| Area | $A=\pi r^2$ |
| Mean | $\bar{x}=\frac{1}{n}\sum_i x_i$ |

~~~python
# This stays code: \(x^2\)
print("A😀B")
~~~

- [x] File received
- [x] Math rendered

This reply is a UI fixture; real model acceptance runs separately.`)
}}
const runtime=new Runtime(config,native?{}:{model:desktopChatFixture(model,'I’ll check which files the request needs.')}),host=await serve(runtime)
runtime.start()
const token=readFileSync(join(config.stateDir,'access-token'),'utf8').trim()
const username='chat-preview',password='Roppo-preview-2026!'
const status=await fetch(host.url+'/account/status').then(r=>r.json()) as {configured:boolean}
const response=await fetch(host.url+(status.configured?'/account/login':'/account/setup'),{method:'POST',headers:{authorization:'Bearer '+token,origin:host.url,'content-type':'application/json'},body:JSON.stringify(status.configured?{username,password,remember:true}:{username,displayName:'Alex',password,remember:true})})
if(!response.ok)throw Error('Synthetic acceptance account setup failed: '+response.status)
const cookie=response.headers.get('set-cookie')!.split(';')[0]!
writeFileSync(join(root,'browser.json'),JSON.stringify({base:host.url,url:host.url+'/chat',username,password,cookie,native}),{mode:0o600})
console.log(JSON.stringify({url:host.url+'/chat',mode:native?'native Codex':'model fixture',info:join(root,'browser.json')}))
async function close(){host.server.closeAllConnections();await new Promise<void>(r=>host.server.close(()=>r()));await host.closeRuntime()}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close())
