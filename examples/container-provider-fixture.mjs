// Deterministic protocol fixture: no commercial model, credentials or external requests.
import {createServer} from 'node:http'
import {appendFileSync,readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
let sequence=0
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk)
 const input=JSON.parse(Buffer.concat(chunks).toString()||'{}')
 const messages=input.messages??[],tools=messages.filter(m=>m.role==='tool'),text=JSON.stringify(messages)
 const names=(input.tools??[]).map(tool=>tool.function.name)
 const toolName=name=>names.includes('roppo_'+name)?'roppo_'+name:name
 appendFileSync('/tmp/roppo-provider-calls.jsonl',JSON.stringify({model:input.model,tools:tools.map(m=>m.tool_call_id),at:Date.now()})+'\n')
 let content=null,call
 if(input.model==='container-worker'){
  if(!tools.length)call={id:'shell-read',type:'function',function:{name:toolName('superagent_shell'),arguments:JSON.stringify({command:'cat input.txt; if test -r /data/state/private-canary; then exit 91; fi; if test -r /data/state/config.json; then exit 92; fi',requestId:'read-container-file'})}}
  else{
   const receipt=JSON.parse(tools.find(t=>t.tool_call_id==='shell-read').content)
   if(receipt!==2&&(receipt.state!=='completed'||receipt.exitCode!==0||receipt.output.trim()!=='2'))throw Error('Actual shell result missing')
   content=JSON.stringify({state:'ready',summary:'Read actual input.txt through the managed shell',reply:'2',question:null,askedBy:null,decision:null,handbacks:[]})
  }
 }else if(text.includes('worker_result'))content=JSON.stringify({reply:'CONTAINER_API_VERIFIED_2'})
 else if(tools.length)content=JSON.stringify({reply:''})
 else{
  const revision=Number(readFileSync('/tmp/roppo-fixture-revision','utf8'))
  call={id:'assign-file-check',type:'function',function:{name:toolName('worker_manage'),arguments:JSON.stringify({action:'assign',id:'one',requestId:'container-assignment-'+createHash('sha256').update(text).digest('hex').slice(0,12),revision,text:'Read the actual input.txt via superagent_shell; report its value.',acceptance:'Actual sandbox output must contain 2'})}}
 }
 const id='fixture-'+(++sequence),finish=call?'tool_calls':'stop'
 if(input.stream){
  res.writeHead(200,{'content-type':'text/event-stream'})
  const chunk=(delta,finish_reason)=>res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model:input.model,choices:[{index:0,delta,finish_reason}]})+'\n\n')
  chunk(call?{role:'assistant',tool_calls:[{index:0,...call}]}:{role:'assistant',content},null)
  chunk({},finish)
  res.end('data: [DONE]\n\n')
 }else{
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id,choices:[{index:0,finish_reason:finish,message:{role:'assistant',content,...(call?{tool_calls:[call]}:{})}}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}}))
 }
})
server.listen(15431,'127.0.0.1')
