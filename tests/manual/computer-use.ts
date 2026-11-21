/**
 * Exercise a Chat Worker through the bundled OpenCode CLI and real native drivers.
 * The scripted loopback model makes tool names and action order reproducible.
 */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {Runtime} from '../../src/runtime.ts'
import {configSchema} from '../../src/config.ts'
import {BackendRegistry} from '../../src/backends/registry.ts'
import {bundledCLI} from '../../src/backends/bundled-opencode.ts'
import {serve} from '../../src/server.ts'

assert(bundledCLI,'Install the bundled OpenCode CLI before running this test')
const root=realpathSync(mkdtempSync(join(tmpdir(),'roppo-computer-use-')))
const outputDirectory=process.argv[2]?resolve(process.argv[2]):undefined
const operator='local-operator'
const values=new Map<string,any>()
const called:string[]=[]
const failures:string[]=[]
const browser=(action:string, extra:Record<string,unknown>={})=>({name:'roppo_superagent_browser',arguments:{action,requestId:action,...extra}})
const desktop=(action:string, args:Record<string,unknown>={})=>({name:'roppo_superagent_desktop',arguments:{action,requestId:action,arguments:args}})
const previous=(action:string)=>{assert(values.has(action),'Missing tool output for '+action);return values.get(action)}
const session=()=>previous('open').id
let step=0
let origin=''
const plan=[
  ()=>browser('open',{url:origin+'/page'}),
  ()=>browser('record_start',{sessionId:session(),durationMs:20_000}),
  ()=>browser('fill',{sessionId:session(),ref:'@e1',text:'Roppo checked this result',revision:previous('open').revision}),
  ()=>browser('click',{sessionId:session(),ref:'@e2',revision:previous('fill').revision}),
  ()=>browser('screenshot',{sessionId:session(),inlineImage:false}),
  ()=>browser('record_stop',{sessionId:session()}),
  ()=>desktop('check_permissions'),
  ()=>desktop('launch_app',{bundle_id:'com.apple.calculator'}),
  ()=>desktop('list_windows',{app:'com.apple.calculator'}),
  ()=>desktop('start_recording'),
  ()=>desktop('run_script',{
    script:'const app=await cua.getApp("Calculator"); for (const labels of [["全部清除","清除","All Clear","Clear"],["7"],["乘","multiply"],["6"],["等于","equals","="]]) { let hit; for (const name of labels) { [hit]=await app.query({role:"button",name}); if(hit)break; } if(!hit)throw Error("Missing calculator button "+labels); await app.click(hit.element_token); } return (await app.getState()).tree_markdown;',
    timeout_ms:20_000,
  }),
  ()=>{
    const target=previous('list_windows').result.windows[0]
    return desktop('get_window_state',{pid:target.pid,window_id:target.window_id,include_screenshot:true,max_elements:45})
  },
  ()=>desktop('stop_recording'),
]
const api=createServer(async(req,res)=>{
  try{
    if(req.url==='/page'){
      res.writeHead(200,{'content-type':'text/html'})
      res.end('<title>Roppo browser fixture</title><label>Value<input id="value"></label><button onclick="document.getElementById(\'result\').textContent=document.getElementById(\'value\').value">Set result</button><p id="result">pending</p>')
      return
    }
    if(req.method!=='POST'){res.writeHead(404).end();return}
    let body=''
    for await(const chunk of req)body+=chunk
    const input=JSON.parse(body)
    assert.equal(req.url,'/v1/responses')
    assert.equal(input.model,'fixture-worker')
    const tools=(input.tools??[]).map((item:any)=>item.name)
    if(tools.length){
      assert(tools.includes('roppo_superagent_browser'))
      assert(tools.includes('roppo_superagent_desktop'))
    }
    const next=tools.length ? plan[step++]?.() : undefined
    const report=JSON.stringify({state:'ready',summary:'Verified the browser and native desktop',reply:'Verified captures',question:null,askedBy:null,decision:null,handbacks:[],files:[]})
    res.writeHead(200,{'content-type':'text/event-stream'})
    let sequence=0
    const event=(type:string,data:object)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:sequence++,...data})+'\n\n')
    const item=next?{type:'function_call',id:'fc-'+step,call_id:'tool-'+step,name:next.name,status:'completed',arguments:JSON.stringify(next.arguments)}:
      {type:'message',id:'msg-'+step,role:'assistant',status:'completed',content:[{type:'output_text',text:report,annotations:[]}]}
    const response={id:'response-'+step,object:'response',created_at:1,model:'fixture-worker',status:'completed',output:[item],
      usage:{input_tokens:10,output_tokens:5,total_tokens:15}}
    event('response.created',{response:{...response,status:'in_progress',output:[]}})
    if(next){
      event('response.output_item.added',{output_index:0,item:{...item,arguments:'',status:'in_progress'}})
      event('response.function_call_arguments.delta',{output_index:0,item_id:item.id,delta:JSON.stringify(next.arguments)})
      event('response.function_call_arguments.done',{output_index:0,item_id:item.id,arguments:JSON.stringify(next.arguments)})
    }else{
      event('response.output_item.added',{output_index:0,item})
      event('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:report})
    }
    event('response.output_item.done',{output_index:0,item})
    event('response.completed',{response})
    res.end()
  }catch(error){
    failures.push(String(error))
    res.writeHead(400).end()
  }
})
await new Promise<void>(done=>api.listen(0,'127.0.0.1',done))
origin='http://127.0.0.1:'+(api.address() as {port:number}).port
process.env.ROPPO_COMPUTER_USE_FIXTURE_KEY='local-test'
const stateDir=join(root,'state')
const config=configSchema.parse({
  stateDir,port:0,
  work:{sandboxDriver:process.platform==='darwin'?'seatbelt':'bubblewrap'},
  execution:{router:{mode:'host',model:'fixture-router'},management:{enabled:true},workers:[{id:'test',backend:'native'}]},
  backends:{native:{kind:'openai-responses',model:'fixture-worker',baseUrl:origin+'/v1',apiKeyEnv:'ROPPO_COMPUTER_USE_FIXTURE_KEY',images:false}},
  sources:[{id:'local',kind:'local',cwd:root,allowedActors:[operator],sandbox:'workspace-write'}],
})
let registry:BackendRegistry
const host=new Runtime(config,{model:{
  async run(request){
    if(request.role==='worker'){
      return registry.run({...request,onTool:async(name,input,id)=>{
        const action=String((input as any).action)
        try {
          const result=await request.onTool!(name,input,id)
          assert(result.success,action+': '+JSON.stringify(result.contentItems).slice(0,750))
          const item=result.contentItems.find(item=>item.type==='inputText')
          assert(item?.text,action+' returned no structured result')
          values.set(action,JSON.parse(item.text))
          called.push(name+':'+action)
          console.log('Completed', name+':'+action)
          return result
        }catch(error){failures.push(action+': '+String(error));throw error}
      }})
    }
    const threadId=request.threadId??randomUUID(),turnId=randomUUID()
    request.onThread?.(threadId)
    request.onTurn?.(turnId)
    if(JSON.parse(request.input).kind==='user_message'){
      if(request.tools?.some(tool=>tool.name==='chat_opening'))
        await request.onTool!('chat_opening',{text:'I’ll verify the browser and desktop capture.'},'opening')
      const result=await request.onTool!('worker_manage',{action:'assign',revision:0,requestId:'computer-work',id:'test',
        text:'Operate the local test page and Calculator, and capture both results.'},'assign')
      assert(result.success,JSON.stringify(result))
    }
    return {threadId,turnId,text:JSON.stringify({reply:'Capture verification'})}
  },
}})
registry=new BackendRegistry(config,host.store)
const started=performance.now()
try {
  host.chat.setApprovalMode(operator,'full')
  const conversation=host.chat.create(operator)
  host.chat.send(conversation.id,operator,{clientMessageId:randomUUID(),text:'Verify the local browser and desktop capture.'})
  const deadline=Date.now()+140_000
  while(!failures.length&&Date.now()<deadline&&(!values.has('stop_recording')||
    !host.store.tickets.list().some(ticket=>ticket.assignments.at(-1)?.report?.state==='ready'))){
    await host.tick()
    const report=host.store.tickets.list().map(ticket=>ticket.assignments.at(-1)?.report)
      .find(item=>item?.state==='blocked'||item?.state==='failed')
    if(report)throw Error(report.summary)
    await delay(45)
  }
  assert.deepEqual(failures,[])
  assert.equal(called.length,plan.length,JSON.stringify(called))
  assert(host.store.tickets.list().some(ticket=>ticket.assignments.at(-1)?.report?.state==='ready'),
    JSON.stringify(host.status().tickets).slice(-1200))
  assert.equal(previous('open').provider,'ego-lite')
  assert(previous('click').snapshot.includes('Roppo checked this result'))
  const windowState=previous('get_window_state')
  assert(JSON.stringify(windowState.result).includes('42'),JSON.stringify(windowState.result).slice(0,500))
  const captures=[previous('screenshot').screenshot,previous('record_stop').recording,
    windowState.screenshot,previous('stop_recording').recording]
  assert.deepEqual(captures.map(a=>a.mime),['image/png','video/mp4','image/png','video/mp4'])
  const attached=host.browser.screenshots(conversation.id)
  const http=await serve(host)
  try{
    const headers={authorization:'Bearer '+readFileSync(http.tokenPath,'utf8').trim()}
    for(const [index,asset] of captures.entries()){
      const file=attached.find(item=>item.id===asset.id)
      assert(file)
      const response=await fetch(http.url+file.url,{headers})
      assert.equal(response.status,200)
      assert.equal(response.headers.get('content-type'),asset.mime)
      const bytes=Buffer.from(await response.arrayBuffer())
      assert.deepEqual(bytes,readFileSync(asset.path))
      if(outputDirectory){
        mkdirSync(outputDirectory,{recursive:true,mode:0o700})
        writeFileSync(join(outputDirectory,(index<2?'page-':'desktop-')+asset.name),bytes,{mode:0o600})
      }
    }
  }finally{
    http.server.closeAllConnections()
    await new Promise<void>(done=>http.server.close(()=>done()))
  }
  console.log(JSON.stringify({openCode:bundledCLI.cliVersion,elapsedMs:Math.round(performance.now()-started),called,
    captures:captures.map(asset=>({type:asset.mime,bytes:asset.bytes})),pageRecordedFrames:previous('record_stop').frameCount}))
}finally{
  await host.close()
  api.closeAllConnections()
  await new Promise<void>(done=>api.close(()=>done()))
  rmSync(root,{recursive:true,force:true})
}
