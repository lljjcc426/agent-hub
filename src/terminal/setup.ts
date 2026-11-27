import {byName} from './list-order.ts'
import {createInterface} from 'node:readline/promises'
import {Writable} from 'node:stream'
import {spawn} from 'node:child_process'
import {existsSync,readFileSync,mkdirSync,openSync,closeSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {homedir} from 'node:os'
import {setTimeout as delay} from 'node:timers/promises'
import {TerminalClient,CliError,clean} from './client.ts'
import {preparePersonalSetup} from '../personal-setup.ts'
import {ui} from './language.ts'
import type {terminalSetupInfo} from './setup-host.ts'

export interface SetupUI {
 text(message:string,options?:{secret?:boolean;initial?:string}):Promise<string>
 choose(message:string,choices:string[]):Promise<number>
 note(message:string):void
}
export class SetupCancelled extends Error {constructor(){super(ui('Setup cancelled.','已取消设置。'))}}
export function terminalSetupUI():SetupUI {
 const text=async(message:string,options:{secret?:boolean;initial?:string}={})=>{
  let muted=false
  const output=new Writable({write(chunk,_encoding,done){if(!muted)process.stderr.write(chunk);done()}})
  const rl=createInterface({input:process.stdin,output,terminal:true}),abort=new AbortController()
  rl.once('SIGINT',()=>abort.abort());rl.once('close',()=>abort.abort())
  try{
   const answer=rl.question(clean(message)+(options.initial?' ['+clean(options.initial)+']':'')+': ',{signal:abort.signal})
   muted=!!options.secret
   const value=await answer
   if(options.secret)process.stderr.write('\n')
   return value.trim()||options.initial||''
  }catch(error){if(abort.signal.aborted)throw new SetupCancelled();throw error}finally{rl.close();output.end()}
 }
 return {text,note:message=>process.stderr.write(clean(message)+'\n'),choose:async(message,choices)=>{
  const ordered=byName(choices.map((label,index)=>({label,index})),choice=>choice.label)
  process.stderr.write('\n'+clean(message)+'\n'+ordered.map((choice,i)=>'  '+(i+1)+'. '+clean(choice.label)).join('\n')+'\n')
  for(;;){const input=await text(ui('Choose a number','选择编号'),{initial:'1'}),index=Number(input)-1;if(Number.isInteger(index)&&index>=0&&index<ordered.length)return ordered[index]!.index;process.stderr.write(ui('Choose one of the numbers above.\n','请输入上面的编号。\n'))}
 }}
}
export async function setupClient(host:string|undefined,dialog:SetupUI){
 let client:TerminalClient|undefined
 try{client=new TerminalClient(host);await client.request('/health',undefined,{native:true});return client}
 catch(error){if(!(error instanceof CliError)||!['host_not_found','host_unavailable'].includes(error.code)||host||process.env.ROPPO_HOST||process.env.ROPPO_CONNECTION_FILE)throw error}
 const personal=preparePersonalSetup(process.env.ROPPO_HOME??join(homedir(),'.agent-hub'))
 if(client&&personal.config.port&&client.base!=='http://127.0.0.1:'+personal.config.port)throw new CliError(ui('The selected service is offline. Start it before reconnecting.','已选服务离线，请先启动该服务。'))
 dialog.note(ui('Starting your local Roppo service…','正在启动本机 Roppo 服务…'))
 const logs=join(dirname(personal.file),'logs');mkdirSync(logs,{recursive:true,mode:0o700})
 const log=openSync(join(logs,'terminal-service.log'),'a',0o600)
 const child=spawn(process.env.ROPPO_NODE??process.execPath,['--import',fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('../cli.ts',import.meta.url)),'setup',dirname(personal.file),'--no-open'],{detached:true,stdio:['ignore',log,log]})
 closeSync(log);let failure:Error|undefined;child.once('error',error=>{failure=error});child.unref()
 const file=join(personal.config.stateDir,'connection.json')
 for(let i=0;i<120;i++){
  if(failure)throw failure
  if(child.exitCode!==null)break
  if(existsSync(file)){
   const value=JSON.parse(readFileSync(file,'utf8'));const candidate=new TerminalClient(value.url)
   try{await candidate.request('/health',undefined,{native:true});return candidate}catch(error){if(!(error instanceof CliError)||error.code!=='host_unavailable')throw error}
  }
  await delay(250)
 }
 throw new CliError(ui('Service did not start. See ','服务未能启动，请查看 ')+join(logs,'terminal-service.log'))
}
export async function accountSetup(client:TerminalClient,dialog:SetupUI){
 if(client.signedIn)return
 const status=await client.request<{configured:boolean}>('/account/status',undefined,{native:true})
 dialog.note(status.configured?ui('\nSign in to your local Roppo account.','\n登录你的本机 Roppo 账号。'):ui('\nCreate your local Roppo account (shared with the web).','\n创建本机 Roppo 账号（与网页共享）。'))
 let token:string|undefined
 if(!status.configured){
  const info=await client.request<{connectionFile:string}>('/connect-info',undefined,{native:true})
  const connection=JSON.parse(readFileSync(info.connectionFile,'utf8'))
  if(connection.url!==client.base)throw new CliError('The local setup file belongs to another service.')
  token=readFileSync(join(dirname(info.connectionFile),'access-token'),'utf8').trim()
 }
 for(;;){
  const username=await dialog.text(ui('Username','用户名'))
  const displayName=token?await dialog.text(ui('What should Roppo call you?','Roppo 怎么称呼你？'),{initial:username}):undefined
  const password=await dialog.text(token?ui('Create a password (at least 12 characters; hidden)','设置密码（至少 12 个字符，输入隐藏）'):ui('Password (hidden)','密码（输入隐藏）'),{secret:true})
  if(token){const confirmation=await dialog.text(ui('Repeat password','再次输入密码'),{secret:true});if(password!==confirmation){dialog.note(ui('Passwords do not match.','两次密码不一致。'));continue}}
  try{
   const result=await client.loginWithPassword({username,password,...(displayName?{displayName}:{})},token)
   if(result.recoveryCode){dialog.note(ui('Save this account recovery code somewhere private: ','请妥善保存账号恢复码：')+result.recoveryCode);await dialog.text(ui('Press Enter after saving it','保存后按 Enter 继续'))}
   return
  }catch(error){if(!(error instanceof CliError))throw error;dialog.note(error.message);if(await dialog.choose(ui('Sign-in did not complete','登录尚未完成'),[ui('Try again','重试'),ui('Cancel','取消')])===1)throw new SetupCancelled()}
 }
}
export async function configureConnection(client:TerminalClient,dialog:SetupUI){
 const request=<T>(body:unknown)=>client.request<T>('/api/terminal/setup',body,{timeoutMs:120_000})
 for(;;){
  const info=await client.request<ReturnType<typeof terminalSetupInfo>>('/api/terminal/setup')
  const choice=await dialog.choose(ui('How would you like to connect a model?','你想怎样连接模型？'),[ui('API key / compatible endpoint','API 密钥 / 兼容接口'),ui('ChatGPT account (OAuth)','ChatGPT 账号（OAuth）'),ui('Use an existing connection','使用已有连接'),ui('Cancel','取消')])
  if(choice===3)throw new SetupCancelled()
  let connection:Record<string,unknown>,name:string|undefined
  if(choice===0){
   const provider=await dialog.choose(ui('API provider','API 服务类型'),['OpenAI','Anthropic',ui('OpenAI-compatible service / local model','OpenAI 兼容服务 / 本机模型')])
   let protocol=provider===1?'anthropic':'openai-responses'
   if(provider===2)protocol=['openai-chat','openai-responses','anthropic'][await dialog.choose(ui('API format','API 格式'),['Chat Completions','Responses','Anthropic Messages'])]!
   const baseUrl=await dialog.text(ui('API base URL','API 基础地址'),{initial:provider===1?'https://api.anthropic.com':provider===0?'https://api.openai.com/v1':'http://127.0.0.1:11434/v1'})
   const apiKey=await dialog.text(ui('API key (hidden; Enter if none is required)','API 密钥（隐藏输入，无需密钥时直接 Enter）'),{secret:true})
   connection={kind:'api',protocol,baseUrl,...(apiKey?{apiKey}:{})}
   let models:string[]=[]
   try{dialog.note(ui('Loading available models…','正在读取可用模型…'));models=(await request<{models:string[]}>({action:'models',connection})).models}catch(error){dialog.note(ui('Model discovery unavailable; enter the model ID manually.','无法读取模型列表，请手动输入模型 ID。'))}
   const selected=models.length?await dialog.choose(ui('Model','模型'),[...models,ui('Enter a model ID','手动输入模型 ID')]):0
   connection.model=models[selected]??await dialog.text(ui('Model ID','模型 ID'))
   name=await dialog.text(ui('Connection name','连接名称'),{initial:provider===1?'Anthropic':provider===0?'OpenAI':'My API'})
  }else if(choice===1){
   const accounts=info.accounts.filter(a=>a.signedIn)
   const selected=await dialog.choose(ui('Choose an account','选择账号'),[...accounts.map(a=>a.email??a.id),ui('Sign in with a new account','登录新账号')])
   let account=accounts[selected]?.id
   if(!account){
    const auth=await request<{account:string;url:string;attempt:string}>({action:'oauth.start'})
    dialog.note(ui('Open this official sign-in link in your browser:\n','请在浏览器打开官方登录链接：\n')+auth.url)
    for(;;){
     if(await dialog.choose(ui('Return here after browser sign-in','在浏览器登录后回到这里'),[ui('I have signed in','我已完成登录'),ui('Cancel','取消')])===1)throw new SetupCancelled()
     const result=await request<{status:string}>({action:'oauth.status',attempt:auth.attempt})
     if(result.status==='completed'){account=auth.account;break}
     if(result.status==='failed')throw new CliError(ui('Sign-in failed or expired. Run setup again.','登录失败或过期，请重新运行设置。'))
     dialog.note(ui('Waiting for the provider to finish sign-in.','还在等待服务商完成登录。'))
    }
   }
   if(await dialog.choose(ui('Allow Roppo background tasks to use this account?','允许 Roppo 后台任务使用此账号？'),[ui('Allow','允许'),ui('Cancel','取消')])===1)throw new SetupCancelled()
   const owners=info.owners;const owner=owners.defaultOwner??owners.choices[await dialog.choose(ui('Account access identity','账号使用身份'),owners.choices.map(c=>c.label))]!
   const catalog=await request<{data?:{id:string}[]}>({action:'oauth.models',account})
   const models=(catalog.data??[]).map(m=>m.id)
   const selectedModel=models.length?await dialog.choose(ui('Model','模型'),[...models,ui('Enter a model ID','手动输入模型 ID')]):0
   connection={kind:'subscription',account,model:models[selectedModel]??await dialog.text(ui('Model ID','模型 ID')),owner:{source:owner.source,actor:owner.actor},backgroundAuthorized:true}
   name='ChatGPT'
  }else{
   if(!info.connections.length){dialog.note(ui('No saved connections yet.','还没有已有连接。'));continue}
   const selected=await dialog.choose(ui('Saved connections','已有连接'),info.connections.map(c=>c.label+(c.model?' · '+c.model:'')))
   connection={kind:'existing',id:info.connections[selected]!.id}
  }
  const target=info.initial?'router':await dialog.choose(ui('Use this connection for…','此连接用于……'),[ui('Router (existing Workers keep their settings)','Router（已有 Worker 配置保持不变）'),ui('Save to library; choose an agent later','保存到连接库，稍后选择 Agent')])===0?'router':'library'
  try{
   const plan=await request<{id:string;connection:{label:string;model?:string}}>({action:'plan',value:{revision:info.revision,connection,name,target}})
   dialog.note(ui('Testing the connection (one small model request may use credits)…','正在检测连接（少量模型请求可能消耗额度）…'))
   const check=await request<{ok:boolean;remoteVerified:boolean;checks:{code:string;detail?:string}[]}>({action:'check',id:plan.id})
   if(!check.ok){dialog.note(check.checks.map(c=>c.code+(c.detail?' · '+c.detail:'')).join('\n'));if(await dialog.choose(ui('Connection check failed','连接检测未通过'),[ui('Edit connection and retry','重新填写连接并检测'),ui('Cancel','取消')])===1)throw new SetupCancelled();continue}
   dialog.note(check.remoteVerified?ui('The model replied successfully.','模型已成功回复。'):ui('Local CLI installation and sign-in checked; no model request was sent.','已检查本机 CLI 安装与登录状态，未发送模型请求。'))
   const summary=plan.connection.label+(plan.connection.model?' · '+plan.connection.model:'')+(info.initial?ui('\nSet up the Router and one initial Worker. Memory stays enabled.','\n配置 Router 和一个初始 Worker，记忆保持开启。'):target==='router'?ui('\nUse for future Router turns.','\n用于后续 Router 对话。'):ui('\nSave in the connection library.','\n保存到连接库。'))
   if(await dialog.choose(summary,[ui('Save and finish','保存并完成'),ui('Cancel','取消')])===1)throw new SetupCancelled()
   await request({action:'apply',id:plan.id});dialog.note(ui('Connection saved. You are ready to chat.','连接已保存，可以开始对话。'));return
  }catch(error){if(error instanceof SetupCancelled)throw error;dialog.note((error as Error).message);if(await dialog.choose(ui('Setup did not finish','设置尚未完成'),[ui('Try again','重试'),ui('Cancel','取消')])===1)throw new SetupCancelled()}
 }
}
