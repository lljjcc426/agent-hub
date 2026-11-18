/** Isolated chat acceptance host. `native` uses the signed-in Codex CLI; default uses a model fixture. */
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Runtime} from '../src/runtime.ts'
import {configSchema} from '../src/config.ts'
import {serve} from '../src/server.ts'
import type {ModelRequest} from '../src/model.ts'
const native=process.argv[2]==='native',workflow=process.argv[2]==='workflow'
const root=resolve(process.argv[3]??('.local/chat-'+(native?'native':'fixture')+'-20261107'))
mkdirSync(join(root,'workspace'),{recursive:true})
const config=configSchema.parse({stateDir:join(root,'state'),port:Number(process.env.ROPPO_CHAT_PORT??0),work:{sandboxDriver:'disabled',network:false},turnTimeoutMs:180000,
  execution:{router:{mode:'host',model:'gpt-6.1-terra',effort:'medium'},management:{enabled:true,maxWorkers:4},workers:[{id:'research',label:'Research',backend:'codex',model:'gpt-6.1-sol',effort:'high'},{id:'planning',label:'Planning',backend:'codex',model:'gpt-6.1-sol',effort:'high'},{id:'review',label:'Review',backend:'codex',model:'gpt-6.1-sol',effort:'high'},{id:'worker-4',label:'Worker 4',backend:'codex',model:'gpt-6.1-sol',effort:'high'}]},
  sources:[{id:'local',kind:'local',cwd:join(root,'workspace'),allowedActors:['operator'],workspace:{mode:'source'}}]})
const model={async run(r:ModelRequest){
  const threadId=r.threadId??randomUUID(),turnId=randomUUID();r.onThread?.(threadId);r.onTurn?.(turnId)
  const wait=(ms=2800)=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(done,ms);function done(){r.signal?.removeEventListener('abort',stop);resolve()}function stop(){clearTimeout(timer);reject(Error('Fixture cancelled'))}r.signal?.addEventListener('abort',stop,{once:true});if(r.signal?.aborted)stop()})
  const reply=async(text:string)=>{const raw=JSON.stringify({reply:text});r.onOutput?.({id:turnId,type:'start',phase:'answer'});for(let i=0;i<raw.length;i+=9){r.onOutput?.({id:turnId,type:'delta',phase:'answer',text:raw.slice(i,i+9)});await wait(120)}return {threadId,turnId,text:raw}}
  if(workflow){
    if(r.role==='worker'){
      const approval=await r.onHumanRequest!({id:'command',method:'item/commandExecution/requestApproval',params:{command:'pwd',reason:'Inspect the working directory'}})
      if((approval as {decision:string}).decision!=='accept')return {threadId,turnId,text:JSON.stringify({state:'blocked',summary:'Access declined',reply:'Access declined.',question:null,askedBy:null,handbacks:[]})}
      const answers=await r.onHumanRequest!({id:'style',method:'item/tool/requestUserInput',params:{questions:[{id:'style',question:'Which layout?',options:[{label:'List'},{label:'Table'}]}]}}) as {answers:Record<string,{answers:string[]}>}
      const summary='Verified layout: '+answers.answers.style!.answers[0]
      return {threadId,turnId,text:JSON.stringify({state:'ready',summary,reply:summary,question:null,askedBy:null,handbacks:[]})}
    }
    const data=JSON.parse(r.input),text=data.trigger?.text
    r.onUsage?.({id:'preflight',inputTokens:3000})
    r.onUsage?.({id:'latest',inputTokens:137,contextWindowTokens:8192})
    if(data.kind!=='user_message')return reply('The Worker verified the layout.')
    if(text==='English'){
      await r.onTool!('superagent_plan',{title:'Release guide',steps:[{id:'format',title:'Choose language',state:'completed'},{id:'review',title:'Delegate review',state:'running'}]},'continue')
      await r.onTool!('worker_manage',{action:'assign',id:'research',revision:0,requestId:turnId,text:'Verify the layout'},'assign')
      await r.onTool!('superagent_plan',{title:'Release guide',steps:[{id:'format',title:'Choose language',state:'completed'},{id:'review',title:'Delegate review',state:'completed'}]},'delegate')
      return reply('Research is reviewing the guide.')
    }
    if(text==='Keep going')return reply('Still here.')
    if(text==='Let me review the release notes before delivery.'){
      await r.onTool!('chat_deliver_file',{name:'release-notes.md',content:'# Release notes\n\nLayout verified by Research.',requireApproval:true},'file')
      return {threadId,turnId,text:JSON.stringify({reply:''})}
    }
    await r.onTool!('superagent_plan',{title:'Release guide',steps:[{id:'format',title:'Choose language',state:'running'},{id:'review',title:'Delegate review',state:'pending'}]},'start')
    await r.onTool!('worker_manage',{action:'list'},'list')
    await r.onTool!('chat_request_decision',{question:'Which language?',options:[{label:'English'},{label:'Chinese'}]},'decision')
    return {threadId,turnId,text:JSON.stringify({reply:''})}
  }
  await wait()
  if(r.role==='worker'){await r.onTool?.('superagent_progress',{summary:'Checked the launch scope and milestones.'},turnId+'-progress');return {threadId,turnId,text:JSON.stringify({state:'ready',summary:'Review complete',reply:'Checked the launch scope and milestones.',question:null,askedBy:null,handbacks:[]})}}
  const data=JSON.parse(r.input)
  if(data.kind==='user_message'){
    const result=await r.onTool!('worker_manage',{action:'list'},'list')
    const revision=JSON.parse(result.contentItems[0]!.text!).revision
    let ticketId=''
    for(const [index,id] of ['research','planning','review'].entries()){const assigned=await r.onTool!('worker_manage',{action:'assign',id,revision,requestId:turnId+'-'+id,text:['Research the market for Roppo','Draft the release plan','Review the onboarding scope'][index]},id);ticketId=JSON.parse(assigned.contentItems[0]!.text!).ticketId}
    await r.onTool!('worker_manage',{action:'result',ticketId,waitMs:1800},turnId+'-result')
    return reply('I’ll split the research and launch planning across the team, then bring the results together.')
  }
  return reply('The team has returned its findings.\n\n## Recommended next steps\n\n1. Start with individual users.\n2. Make the first Router conversation easy to begin.\n3. Keep Worker progress visible and results easy to review.')
}}
const runtime=new Runtime(config,native?{}:{model}),host=await serve(runtime)
runtime.start()
const token=readFileSync(join(config.stateDir,'access-token'),'utf8').trim()
const username='chat-preview',password='Roppo-preview-2026!'
const status=await fetch(host.url+'/account/status').then(r=>r.json()) as {configured:boolean}
const response=await fetch(host.url+(status.configured?'/account/login':'/account/setup'),{method:'POST',headers:{authorization:'Bearer '+token,origin:host.url,'content-type':'application/json'},body:JSON.stringify(status.configured?{username,password,remember:true}:{username,displayName:'Alex',password,remember:true})})
if(!response.ok)throw Error('Synthetic acceptance account setup failed: '+response.status)
const cookie=response.headers.get('set-cookie')!.split(';')[0]!
writeFileSync(join(root,'browser.json'),JSON.stringify({base:host.url,url:host.url+'/chat',username,password,cookie,native}),{mode:0o600})
console.log(JSON.stringify({url:host.url+'/chat',mode:native?'native Codex':workflow?'workflow fixture':'model fixture',info:join(root,'browser.json')}))
async function close(){host.server.closeAllConnections();await new Promise<void>(r=>host.server.close(()=>r()));await host.closeRuntime()}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close())
