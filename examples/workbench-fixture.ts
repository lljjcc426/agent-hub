import {randomUUID} from 'node:crypto'
import {existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {execFile,spawnSync} from 'node:child_process'
import {promisify} from 'node:util'
import type {IncomingMessage,ServerResponse} from 'node:http'
import type {Runtime} from '../src/runtime.ts'
import type {ChatConversation,ChatMessage} from '../src/chat.ts'
import {splitWorkerPatch} from '../src/worker-patch.ts'

type Demo={chatId:string;runId:string;stage:number;call:string}
const router={id:'router',label:'Roppo',kind:'router' as const}
const source='src/summary.ts',helper='src/graphemes.ts',test='tests/summary.test.ts'
const allowed=['README.md','package.json',source,helper,test]
const initial="export function summarize(text: string, limit = 48) {\n  if (limit < 1) return ''\n  return text.slice(0, limit)\n}\n"
const first="export function summarize(text: string, limit = 48) {\n  if (limit < 1) return ''\n  const characters = Array.from(text)\n  return characters.slice(0, limit).join('')\n}\n"
const second="import { graphemes } from './graphemes.ts'\n\nexport function summarize(text: string, limit = 48) {\n  if (limit < 1) return ''\n  return graphemes(text).slice(0, limit).join('')\n}\n"
const segment="const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })\n\nexport function graphemes(text: string) {\n  return Array.from(segmenter.segment(text), part => part.segment)\n}\n"
const regression="import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { summarize } from '../src/summary.ts'\n\ntest('组合表情按一个字符计数', () => {\n  assert.equal(summarize('A👩‍💻B', 2), 'A👩‍💻')\n})\n"

export function workbenchFixture(runtime:Runtime,owner:string,workspace:string,base:string){
  const database=runtime.store
  const project=(id:string)=>join(workspace,'examples',id)
  function putMessage(d:Demo,msg:Omit<ChatMessage,'id'|'createdAt'|'sequence'|'conversationId'|'runId'>,id:string=randomUUID(),at=Date.now()){
    const chat=database.get<ChatConversation>('chat-conversation',d.chatId)!
    const sequence=chat.sequence+1
    database.put('chat-message',id,{...msg,id,conversationId:d.chatId,runId:d.runId,sequence,createdAt:at,status:'complete'} satisfies ChatMessage)
    database.put('chat-conversation',chat.id,{...chat,sequence,updatedAt:at,title:'修复摘要截断'})
  }
  function changeFile(d:Demo,path:string,after:string,messageId:string){
    const filename=join(project(d.chatId),path),exists=existsSync(filename)
    const previous=join(project(d.chatId),'.previous',path)
    mkdirSync(dirname(previous),{recursive:true});mkdirSync(dirname(filename),{recursive:true})
    if(exists)writeFileSync(previous,readFileSync(filename))
    writeFileSync(filename,after)
    const diff=spawnSync('git',['--no-pager','diff','--no-ext-diff','--no-index','--',exists?previous:'/dev/null',filename],{encoding:'utf8'})
    const hunk=diff.stdout?.indexOf('\n@@ ')
    if(diff.status!==1||hunk===undefined||hunk<0)throw Error('Missing fixture diff')
    const text='diff --git a/'+path+' b/'+path+'\n'+(exists?'':'new file mode 100644\n')+'--- '+(exists?'a/'+path:'/dev/null')+'\n+++ b/'+path+diff.stdout.slice(hunk)
    const {file}=splitWorkerPatch(text)[0]!,id=randomUUID()
    database.put('chat-worker-patch',id,{id,conversationId:d.chatId,ticketId:d.runId,messageId,path,text})
    return {...file,id}
  }
  function receipt(d:Demo,stage:number){
    const id=randomUUID(),speaker=stage===3?{id:'review',label:'测试 Worker',kind:'worker' as const}:{id:'editor',label:'开发 Worker',kind:'worker' as const}
    const changes=stage===1?[changeFile(d,source,first,id)]:stage===2?[changeFile(d,source,second,id),changeFile(d,helper,segment,id)]:[changeFile(d,test,regression,id)]
    putMessage(d,{role:'assistant',text:'',workerPatchReceipt:true,speaker,recipient:router,fileChanges:changes},id)
    d.stage=stage;database.put('workbench-demo',d.chatId,d)
    runtime.chat.usageChanged(d.call)
  }
  function newDemo(){
    const chat=runtime.chat.create(owner),d:Demo={chatId:chat.id,runId:randomUUID(),stage:0,call:randomUUID()}
    const root=project(d.chatId),now=Date.now()
    mkdirSync(join(root,'src'),{recursive:true})
    writeFileSync(join(root,source),initial)
    writeFileSync(join(root,'README.md'),'# 摘要工具\n\n按用户可见字符截断摘要。\n\n源码位于 src/，回归用例位于 tests/。\n')
    writeFileSync(join(root,'package.json'),JSON.stringify({name:'summary-kit',private:true,type:'module',scripts:{test:'node --test tests/*.test.ts'}},null,2)+'\n')
    database.atomic(()=>{
      putMessage(d,{role:'user',text:'摘要会截断组合表情。请修复这个问题，再补一个回归用例。'},randomUUID(),now-9500)
      putMessage(d,{role:'assistant',speaker:router,text:'我会先检查摘要的字符边界，再用组合表情验证结果。'},randomUUID(),now-8600)
      database.put('chat-call',d.call,{id:d.call,conversationId:d.chatId,runId:d.runId,workerId:'editor',kind:'worker',name:'worker',state:'completed',startedAt:now-7800,endedAt:now-4500,status:{phase:'working',label:'检查摘要的字符边界'}})
      receipt(d,1)
    })
    return d
  }
  const replay=new Map<string,string>()
  function think(d:Demo){
    const token=randomUUID(),at=Date.now()
    replay.set(d.chatId,token)
    const item={id:d.call,conversationId:d.chatId,runId:d.runId,workerId:'editor',kind:'worker',name:'worker',state:'running',startedAt:at}
    const update=(value:object)=>{if(replay.get(d.chatId)===token){database.put('chat-call',d.call,value);runtime.chat.usageChanged(d.call)}}
    update(item)
    const withStep={...item,status:{phase:'working',label:'读取 src/summary.ts 并检查字符边界'}}
    setTimeout(()=>update(withStep),2400).unref()
    setTimeout(()=>{update({...withStep,startedAt:at,endedAt:Date.now(),state:'completed'});if(replay.get(d.chatId)===token)replay.delete(d.chatId)},5100).unref()
  }
  function localFile(d:Demo,path:string){
    if(!allowed.includes(path))return
    const name=resolve(project(d.chatId),path)
    if(existsSync(name)&&realpathSync(name)===join(realpathSync(project(d.chatId)),path))return name
  }
  const send=(res:ServerResponse,status:number,result:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(result))}
  async function handle(req:IncomingMessage,res:ServerResponse,id:string,route:string){
    if(req.method!=='GET'&&(req.method!=='POST'||req.headers.origin!==base))return send(res,403,{})
    const account=await (await fetch(base+'/account/status',{headers:{cookie:req.headers.cookie??''}})).json() as {authenticated?:boolean;user?:{id:string}}
    if(!account.authenticated||account.user?.id!==owner)return send(res,401,{})
    const d=database.get<Demo>('workbench-demo',id)
    if(!d)return send(res,404,{})
    if(req.method==='GET'&&route==='files'){
      const files=allowed.flatMap(path=>{const name=localFile(d,path);return name?[{path,text:readFileSync(name,'utf8')}]:[]})
      return send(res,200,{files})
    }
    if(req.method==='GET'&&route==='demo')return send(res,200,d)
    if(req.method!=='POST')return send(res,405,{})
    let body=''
    for await(const chunk of req){body+=chunk.toString();if(body.length>2048)return send(res,413,{})}
    let data:{action?:string;stage?:number;path?:string}
    try{data=JSON.parse(body)}catch{return send(res,400,{})}
    if(route==='reveal'){
      const name=localFile(d,String(data.path))
      if(!name||process.platform!=='darwin')return send(res,404,{})
      await promisify(execFile)('/usr/bin/open',['-R',name]);return send(res,200,{ok:true})
    }
    if(route!=='demo')return send(res,404,{})
    const current=database.get<Demo>('workbench-demo',id)!
    if(data.action==='restart')return send(res,200,newDemo())
    if(data.action==='think')think(current)
    else if(data.action==='next'){
      if(current.stage===data.stage&&current.stage<3)database.atomic(()=>receipt(current,current.stage+1))
    }else return send(res,400,{})
    return send(res,200,current)
  }
  return {newDemo,handle}
}
