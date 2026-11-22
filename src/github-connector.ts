import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {z} from 'zod'
import type {Tool} from '@modelcontextprotocol/sdk/types.js'
import {GithubError,githubFailure,githubResult} from './github-errors.ts'
import {GithubReader,githubRefSchema,githubRepository,githubRepositorySchema,githubReadSpec} from './github-read.ts'
import {githubGit,githubGitRevision,githubGitSchema,githubGitSpec,type GitRevision} from './github-git.ts'
import {managedConnections,managedSecrets,prepareManagedConfig} from './managed-config.ts'
import {OperationError} from './operation-errors.ts'
import {stableDigest} from './sources.ts'
import type {Runtime} from './runtime.ts'
import type {ToolConnection} from './connector-config.ts'
import type {ToolSpec} from './model.ts'
import type {ToolResult} from './chat-permissions.ts'
import {remoteCommitHistory,type CommitHistory} from './chat-commit-trail.ts'

const mcpName={
 create_pull:'create_pull_request',update_pull:'update_pull_request',review_pull:'pull_request_review_write',
 create_issue:'issue_write',update_issue:'issue_write',comment:'add_issue_comment',
} as const
const remote:ToolConnection={enabled:true,transport:{kind:'http',url:'https://api.githubcopilot.com/mcp/',headerEnv:{}},
 allowedTools:[...new Set(Object.values(mcpName))],timeoutMs:15_000}
const sha=z.string().regex(/^[a-f0-9]{40,64}$/)
const number=z.number().int().positive().max(2147483647)
const title=z.string().trim().min(1).max(256)
const text=z.string().max(32_000)
const label=z.string().trim().min(1).max(100)
const target={repository:githubRepositorySchema}
export const githubWriteSchema=z.discriminatedUnion('action',[
 z.object({...target,action:z.literal('create_pull'),title,body:text.optional(),head:githubRefSchema,base:githubRefSchema,draft:z.boolean().optional()}).strict(),
 z.object({...target,action:z.literal('update_pull'),number,title:title.optional(),body:text.optional(),base:githubRefSchema.optional(),state:z.enum(['open','closed']).optional()}).strict(),
 z.object({...target,action:z.literal('review_pull'),number,body:text.optional(),event:z.enum(['APPROVE','REQUEST_CHANGES','COMMENT'])}).strict(),
 z.object({...target,action:z.literal('merge_pull'),number,expectedHead:sha,method:z.enum(['merge','squash','rebase']).optional()}).strict(),
 z.object({...target,action:z.literal('create_issue'),title,body:text.optional(),labels:z.array(label).max(30).optional()}).strict(),
 z.object({...target,action:z.literal('update_issue'),number,title:title.optional(),body:text.optional(),state:z.enum(['open','closed']).optional(),labels:z.array(label).max(30).optional()}).strict(),
 z.object({...target,action:z.literal('comment'),number,body:text.trim().min(1)}).strict(),
])
// Older model and MCP transports expect an object at the schema root.
// prepare() applies the exact schema for the selected action before approval.
export const githubWriteInputSchema=z.object({...target,
 action:z.enum(['create_pull','update_pull','review_pull','merge_pull','create_issue','update_issue','comment']),
 number:number.optional(),title:title.optional(),body:text.optional(),head:githubRefSchema.optional(),base:githubRefSchema.optional(),
 draft:z.boolean().optional(),state:z.enum(['open','closed']).optional(),labels:z.array(label).max(30).optional(),
 event:z.enum(['APPROVE','REQUEST_CHANGES','COMMENT']).optional(),
 expectedHead:sha.optional(),method:z.enum(['merge','squash','rebase']).optional(),
}).strict()
export const githubWriteSpec:ToolSpec={type:'function',name:'github_write',inputSchema:z.toJSONSchema(githubWriteInputSchema,{target:'draft-07'}),
 description:'Make a requested write in a GitHub repository using the connected token. create_pull needs title, head and base; update_pull, review_pull, merge_pull, update_issue and comment need number; review_pull needs event; merge_pull needs the current expectedHead SHA; create_issue needs title; comment needs body. Supply only fields for the selected action. A result with status uncertain requires remote readback before any retry.',
}
export {githubReadSpec,githubGitSpec}
// Cached clients may still send the old repository field.
const setupSchema=z.object({token:z.string().trim().min(1).max(500).regex(/^[a-zA-Z0-9_]+$/),repositories:z.array(z.string()).optional()}).strict()
type Write=z.output<typeof githubWriteSchema>
type Connection={id:string;account:string;tools:string[];checkedAt:number}
const namespace='github-access',current='current'
const secretName=(id:string)=>'AGENTHUB_SETUP_GITHUB_ACCESS_'+id.replaceAll('-','').toUpperCase()
const headers=(token:string)=>({Authorization:'Bearer '+token,'X-MCP-Toolsets':'issues,pull_requests'})
const configKey='github-connection-change'
type Access={connection:Connection;token:string}
type WritePlan={name:'github_write';args:Write;access:Access}
type GitPlan={name:'github_git';args:z.output<typeof githubGitSchema>;access:Access;revision:GitRevision}
type Plan=WritePlan|GitPlan

export class GithubConnector {
 private readonly reader=new GithubReader()
 private catalog?:{id:string;tools:Tool[]}
 private repositoryChoices?:{id:string;at:number;names:string[]}
 private authFailure?:{id:string;status:GithubError['code']}
 constructor(private readonly host:Runtime){}
 private current(){return this.host.store.get<Connection>(namespace,current)}
 snapshot(){
  const connection=this.current()
  if(!connection)return {status:'disconnected' as const}
  const {account,tools,checkedAt}=connection
  const failure=this.authFailure?.id===connection.id?this.authFailure.status:undefined
  const status=failure??(managedSecrets(this.host.config.stateDir)[secretName(connection.id)]?'connected':'auth_required')
  return {status,account,tools,checkedAt}
 }
 connected(){return !!this.current()}
 private access():Access{
  const connection=this.current()
  if(!connection)throw new GithubError('unconfigured')
  const token=managedSecrets(this.host.config.stateDir)[secretName(connection.id)]
  if(!token)throw new GithubError('auth_required')
  return {connection,token}
 }
 private live(access:Access){
  if(this.current()?.id!==access.connection.id)throw new GithubError('conflict')
 }
 async connect(input:unknown,authorize:()=>void){
  authorize()
  const parsed=setupSchema.safeParse(input)
  if(!parsed.success)throw new GithubError('invalid_request')
  const {token}=parsed.data
  const previous=this.current(),id=randomUUID(),signal=AbortSignal.timeout(24_000)
  let identity:{login:string},tools:Tool[]
  try{
   const [account,discovered]=await Promise.all([
    this.probe(()=>this.reader.get('user',token,signal),signal),
    this.probe(()=>this.host.toolConnections.inspectManaged(id,remote,headers(token),signal),signal),
   ])
   if(typeof account?.login!=='string'||!account.login)throw new GithubError('auth_required')
   if(!discovered.some(tool=>remote.allowedTools.includes(tool.name)&&tool.annotations?.readOnlyHint!==true))throw new GithubError('unsupported')
   identity=account;tools=discovered
  }catch(error){
   void this.host.toolConnections.closeManaged(id)
   if(error instanceof GithubError)throw error
   throw connectionFailure(error)
  }
  try{
   authorize()
   if(this.current()?.id!==previous?.id)throw new GithubError('conflict')
   this.persist(id,{id,account:identity.login,tools:tools.map(tool=>tool.name),checkedAt:Date.now()},token)
   this.catalog={id,tools}
   this.repositoryChoices=undefined
   this.authFailure=undefined
  }catch(error){
   void this.host.toolConnections.closeManaged(id)
   throw error
  }
  if(previous)void this.host.toolConnections.closeManaged(previous.id)
  return this.snapshot()
 }
 private async probe<T>(read:()=>Promise<T>,signal:AbortSignal):Promise<T>{
  try{return await read()}catch(error){
   if((error instanceof GithubError?error:connectionFailure(error)).code!=='unavailable')throw error
   await delay(150,undefined,{signal})
   return read()
  }
 }
 disconnect(authorize:()=>void){
  authorize()
  const previous=this.current()
  if(previous){
   this.persist(randomUUID())
   this.catalog=undefined;this.authFailure=undefined;this.repositoryChoices=undefined
   void this.host.toolConnections.closeManaged(previous.id)
  }
  return this.snapshot()
 }
 private persist(id:string,next?:Connection,token?:string){
  const state=this.host.config.stateDir,previous=this.current(),secrets=managedSecrets(state)
  if(previous)delete secrets[secretName(previous.id)]
  if(next&&token)secrets[secretName(id)]=token
  const files=prepareManagedConfig(state,id,managedConnections(state),secrets,true)
  try{
   this.host.store.atomic(()=>{
    // An older release expects this array and must fail closed if rolled back.
    this.host.store.put(namespace,current,next?{...next,repositories:[]}:null)
    this.host.store.put(configKey,id,{at:Date.now(),action:next?'connect':'disconnect'})
   })
  }catch(error){files.rollback();throw error}
  files.finish()
 }
 async read(input:unknown,allowPrivate:boolean,check:()=>void,signal?:AbortSignal){
  check()
  let used:Connection|undefined
  const result=await this.reader.read(input,(_,action)=>{
   if(action==='compare'&&!allowPrivate)throw new GithubError('access_denied')
   if(action!=='compare'&&(!allowPrivate||!this.current()))return
   const access=this.access()
   used=access.connection
   return access.token
  },signal)
  check()
  if(used&&this.current()?.id!==used.id)return githubFailure(new GithubError('conflict'))
  if(used){
   const statuses=result.contentItems.map(item=>item.type==='inputText'?item.text:'').join('')
   if(statuses.includes('"status":"auth_required"'))this.authFailure={id:used.id,status:'auth_required'}
  }
  return result
 }
 async visibleRepositories(check:()=>void,signal:AbortSignal):Promise<string[]>{
  signal.throwIfAborted()
  check()
  const access=this.access(),id=access.connection.id,cached=this.repositoryChoices
  if(cached?.id===id&&Date.now()-cached.at<60_000)return cached.names
  const rows=await this.reader.get('user/repos?per_page=100&sort=pushed&direction=desc',access.token,signal)
  check()
  this.live(access)
  if(!Array.isArray(rows))throw new GithubError('unavailable')
  const names=[...new Set<string>(rows.flatMap(row=>{
   const repo=typeof row?.full_name==='string'?githubRepository(row.full_name):undefined
   return repo?[repo]:[]
  }))]
  this.repositoryChoices={id,at:Date.now(),names}
  return names
 }
 async commitHistory(repository:string,requested:string|undefined,check:()=>void,signal:AbortSignal):Promise<CommitHistory>{
  check()
  const target=githubRepository(repository)
  if(!target)throw new GithubError('invalid_request')
  const access=this.access()
  const root='repos/'+target
  const get=(path:string)=>this.reader.get(root+path,access.token,signal)
  const [metadata,rawBranches]=await Promise.all([get(''),get('/branches?per_page=60')])
  if(typeof metadata?.default_branch!=='string'||!Array.isArray(rawBranches))throw new GithubError('unavailable')
  const heads=new Map<string,string>(rawBranches.flatMap(item=>typeof item?.name==='string'&&typeof item.commit?.sha==='string'
    ? [[item.name,item.commit.sha]] : []))
  const branches=[...new Set<string>([metadata.default_branch,...heads.keys()])]
  const branch=requested&&branches.includes(requested)?requested:metadata.default_branch
  const head=heads.get(branch)
  const raw=await get('/commits?'+new URLSearchParams({sha:head??branch,per_page:'60'})).catch(error=>{
   if(error instanceof GithubError&&error.code==='conflict')return []
   throw error
  })
  check()
  this.live(access)
  if(!Array.isArray(raw))throw new GithubError('unavailable')
  return {branch,branches,...remoteCommitHistory(raw,head)}
 }
 async prepare(name:'github_write'|'github_git',input:unknown,workspace?:string,signal?:AbortSignal):Promise<Plan>{
  if(name==='github_git'){
   const parsed=githubGitSchema.safeParse(input)
   if(!parsed.success||!workspace)throw new GithubError('invalid_request')
   const args={...parsed.data,repository:githubRepository(parsed.data.repository)!}
   const access=this.access()
   const revision=await githubGitRevision(workspace,args,signal)
   this.live(access)
   return {name,args,access,revision}
  }
  const parsed=githubWriteSchema.safeParse(input)
  if(!parsed.success)throw new GithubError('invalid_request')
  const args={...parsed.data,repository:githubRepository(parsed.data.repository)!}
  if('labels'in args&&args.labels)args.labels=[...new Set(args.labels)].sort()
  if(args.action==='merge_pull')args.method??='squash'
  const access=this.access()
  if(args.action!=='merge_pull'&&!access.connection.tools.includes(mcpName[args.action]))throw new GithubError('unsupported')
  return {name,args,access}
 }
 facts(plan:Plan){
  return {tool:plan.name,action:plan.args.action,target:plan.args.repository,account:plan.access.connection.account,
   version:stableDigest([plan.access.connection.id,plan.name==='github_git'?plan.revision:null]),
   ...(plan.name==='github_git'&&plan.revision.sha?{sha:plan.revision.sha,branch:plan.revision.branch!}:{})}
 }
 enqueueReadbacks(){
  if(!this.host.config.work.network||!this.host.config.work.autoRecover||!this.current())return
  const {store}=this.host
  const rows=store.db.prepare(`SELECT r.id,json_extract(r.body,'$.actor.ticketId') AS ticket
    FROM records r WHERE r.kind='chat-permission' AND json_extract(r.body,'$.phase')='uncertain'
    AND json_extract(r.body,'$.actor.ticketId') IS NOT NULL
    AND EXISTS (SELECT 1 FROM records t WHERE t.kind='ticket' AND t.id=json_extract(r.body,'$.actor.ticketId') AND json_extract(t.body,'$.ended') IS NULL)
    AND ((json_extract(r.body,'$.tool')='github_write' AND json_extract(r.body,'$.args.action') IN ('create_pull','merge_pull','update_pull','update_issue'))
      OR (json_extract(r.body,'$.tool')='github_git' AND json_extract(r.body,'$.args.action')='push'))
    AND NOT EXISTS (SELECT 1 FROM jobs WHERE id='github-confirm:'||r.id) LIMIT 32`).all()
  for(const {id,ticket} of rows){
   const ticketId=String(ticket)
   if(this.host.executionActive(ticketId))continue
   store.enqueue('github-confirm:'+id,'github-confirm',{ticketId,permissionId:id})
  }
 }
 async confirmTaskEffect(ticketId:string,id:string):Promise<'settled'|'pending'|'unavailable'>{
  const {store}=this.host
  const action=this.host.permissions.get(id)
  if(action?.phase!=='uncertain'||action.actor.ticketId!==ticketId)return 'settled'
  if(action.tool!=='github_write'&&action.tool!=='github_git')return 'unavailable'
  const check=()=>{
   const ticket=store.tickets.get(ticketId),actor=this.host.chat.permissionActor(action.actor.triggerId,ticketId)
   if(!this.host.config.work.network||!this.host.config.work.autoRecover||!ticket||ticket.ended||this.host.executionActive(ticketId)||
    !this.host.scopes.taskRunnable(ticketId)||!this.host.webhooks.taskExecutionAllowed(ticketId)||
    actor?.runId!==action.actor.runId||actor.conversationId!==action.actor.conversationId||
    actor.workerId!==action.actor.workerId)throw new GithubError('access_denied')
  }
  const signal=AbortSignal.timeout(8000)
  try{
   check()
   const workspace=store.get<{cwd:string}>('run',ticketId)?.cwd
   const plan=await this.prepare(action.tool,action.args,workspace,signal),facts=this.facts(plan)
   if(facts.version!==action.facts.version||facts.account!==action.facts.account||facts.target!==action.facts.target)return 'unavailable'
   const get=(path:string)=>{
    check();this.live(plan.access)
    return this.reader.get('repos/'+plan.args.repository+path,plan.access.token,signal)
   }
   let result:ToolResult|undefined
   if(plan.name==='github_git'){
    const {sha,branch}=plan.revision
    if(plan.args.action!=='push'||!branch||!sha)return 'unavailable'
    const head=await get('/branches/'+encodeURIComponent(branch))
    if(head.name===branch&&head.commit?.sha===sha)result=githubResult({status:'complete',repository:plan.args.repository,branch,sha,reconciled:true})
   }else{
    const args=plan.args
    const update=args.action==='update_issue'||args.action==='update_pull'
    if(update&&!Object.entries(args).some(([key,value])=>!['action','repository','number'].includes(key)&&value!==undefined))return 'unavailable'
    const observed=update
     ? await this.confirm(args,{},get,plan.access.connection.account,action.createdAt)
     : await this.reconcile(args,get)
    if(observed)result=githubResult({...receipt(args),...observed,status:'complete',reconciled:true})
   }
   check();this.live(plan.access)
   if(!result)return 'pending'
   return this.host.permissions.confirmEffect(id,result)?'settled':'unavailable'
  }catch(error){
   return error instanceof GithubError&&['auth_required','access_denied','unconfigured','conflict'].includes(error.code)?'unavailable':'pending'
  }
 }
 async execute(plan:Plan,check:()=>void,signal?:AbortSignal):Promise<ToolResult>{
 const {access}=plan
  const current=()=>{signal?.throwIfAborted();check();this.live(access)}
  current()
  if(plan.name==='github_git'){
   try{
    const result=await githubGit(plan.args,plan.revision,access.connection.account,access.token,current,signal)
    return result.status==='uncertain'?uncertain(result):githubResult(result)
   }catch(error){
    signal?.throwIfAborted()
    return githubFailure(error instanceof GithubError?error:new GithubError('unavailable'))
   }
  }
  return this.write(plan,current,signal)
 }
 private async write(plan:WritePlan,check:()=>void,signal?:AbortSignal):Promise<ToolResult>{
  const {args,access}=plan,{connection,token}=access
  const root='repos/'+args.repository
  const get=(path:string)=>{check();return this.reader.get(root+path,token,signal)}
  let sent=false
  const beforeSend=()=>{check();sent=true}
  try{
   if(args.action==='merge_pull'){
    const out=await this.reader.put(root+'/pulls/'+args.number+'/merge',token,{sha:args.expectedHead,merge_method:args.method??'squash'},beforeSend,signal)
     .catch(error=>{
      if(error instanceof GithubError&&error.code!=='unavailable')sent=false
      throw error
     })
    if(out.merged!==true)return githubFailure(new GithubError('conflict'))
    const confirmed=await get('/pulls/'+args.number)
    if(confirmed.merged!==true||confirmed.head?.sha!==args.expectedHead||confirmed.merge_commit_sha!==out.sha)return uncertain(receipt(args))
    check()
    return githubResult({...receipt(args),status:'complete',sha:out.sha})
   }
   if(this.catalog?.id!==connection.id){
    const tools=await this.host.toolConnections.inspectManaged(connection.id,remote,headers(token),signal)
    check()
    this.catalog={id:connection.id,tools}
   }
   const tool=this.catalog.tools.find(tool=>tool.name===mcpName[args.action])
   if(!tool)throw new GithubError('unsupported')
   const started=Date.now()
   const response=await this.host.toolConnections.invokeManaged(connection.id,remote,headers(token),tool,mcpArguments(args),beforeSend,signal)
   if(response.invalid)return githubFailure(new GithubError('unsupported'))
   const result=response.result
   if(result.isError)throw new GithubError('unavailable')
   const data=resultData(result)
   const output=await this.confirm(args,data,get,connection.account,started)
   check()
   return output?githubResult({...receipt(args),...output,status:'complete'}):uncertain(receipt(args))
  }catch(error){
   if(connection.id===this.current()?.id&&(error instanceof GithubError&&error.code==='auth_required'||error instanceof OperationError&&error.code==='auth_required'))
    this.authFailure={id:connection.id,status:'auth_required'}
   if(!sent){
    signal?.throwIfAborted()
    return githubFailure(error instanceof GithubError?error:connectionFailure(error))
   }
   if(!signal?.aborted){
    const confirmed=await this.reconcile(args,get).catch(()=>undefined)
    if(confirmed){
     try{check();return githubResult({...receipt(args),...confirmed,status:'complete',reconciled:true})}catch{/* Authority changed during readback. */}
    }
   }
   return uncertain(receipt(args))
  }
 }
 private async confirm(args:Write,data:Record<string,any>,get:(path:string)=>Promise<any>,account:string,started:number){
  if(args.action==='create_pull'){
   if(Number.isSafeInteger(data.number)&&data.number>0){
    const pull=await get('/pulls/'+data.number)
    if(samePull(args,pull))return {number:pull.number,url:pull.html_url,headSha:pull.head?.sha}
   }
   return this.reconcile(args,get)
  }
  if(args.action==='update_pull'){
   const item=await get('/pulls/'+args.number)
   if(matches(args,item))return {number:item.number,url:item.html_url,headSha:item.head?.sha}
   return
  }
  if(args.action==='create_issue'||args.action==='update_issue'){
   const number=args.action==='create_issue'?data.number:args.number
   if(!Number.isSafeInteger(number)||number<1)return
   const item=await get('/issues/'+number)
   if(matches(args,item))return {number:item.number,url:item.html_url}
   return
  }
  if(args.action==='comment'&&/^\d+$/.test(String(data.id))){
   const comment=await get('/issues/comments/'+data.id)
   if(comment.body===args.body&&comment.issue_url?.endsWith('/issues/'+args.number))return {url:comment.html_url,commentId:comment.id}
   return
  }
  if(args.action==='review_pull'){
   const expected={APPROVE:'APPROVED',REQUEST_CHANGES:'CHANGES_REQUESTED',COMMENT:'COMMENTED'}[args.event]
   const reviews=await get('/pulls/'+args.number+'/reviews?per_page=30&direction=desc')
   const review=reviews.find((review:Record<string,any>)=>review.user?.login?.toLowerCase()===account.toLowerCase()
    && review.state===expected&&(review.body??'')===(args.body??'')&&Date.parse(review.submitted_at)>=started-2000)
   if(review)return {number:args.number,url:review.html_url,headSha:review.commit_id,reviewId:review.id}
  }
 }
 private async reconcile(args:Write,get:(path:string)=>Promise<any>){
  if(args.action==='create_pull'){
   const owner=args.repository.split('/')[0],params=new URLSearchParams({state:'open',head:owner+':'+args.head,base:args.base,per_page:'10'})
   const match=(await get('/pulls?'+params)).find((pull:Record<string,any>)=>samePull(args,pull))
   if(match)return {number:match.number,url:match.html_url,headSha:match.head?.sha}
  }
  if(args.action==='merge_pull'){
   const pull=await get('/pulls/'+args.number)
   if(pull.merged===true&&pull.head?.sha===args.expectedHead&&typeof pull.merge_commit_sha==='string')return {sha:pull.merge_commit_sha}
  }
 }
}

function connectionFailure(error:unknown){
 if(error instanceof OperationError){
  if(error.code==='auth_required')return new GithubError('auth_required')
  if(error.code==='provider_rejected')return new GithubError('access_denied')
  if(error.code==='rate_limited')return new GithubError('rate_limited')
 }
 return new GithubError('unavailable')
}
function mcpArguments(input:Exclude<Write,{action:'merge_pull'}>){
 const {repository,action,...args}=input,[owner,repo]=repository.split('/')
 const destination={owner,repo}
 switch(action){
  case 'create_pull':return {...destination,...args}
  case 'update_pull':{
   const {number,title,body,base,state}=input
   return {...destination,pullNumber:number,title,body,base,state}
  }
  case 'review_pull':return {...destination,pullNumber:input.number,method:'create',body:input.body,event:input.event}
  case 'create_issue':return {...destination,method:'create',title:input.title,body:input.body,labels:input.labels}
  case 'update_issue':{
   const {number,title,body,state,labels}=input
   return {...destination,issue_number:number,method:'update',title,body,state,labels}
  }
  case 'comment':return {...destination,issue_number:input.number,body:input.body}
 }
}
function resultData(result:{[key:string]:unknown}):Record<string,any>{
 const structured=result.structuredContent
 if(structured&&typeof structured==='object'&&Object.keys(structured).length)return structured
 for(const item of Array.isArray(result.content)?result.content:[]){
  if(item.type!=='text'||typeof item.text!=='string')continue
  try{const value=JSON.parse(item.text);if(value&&typeof value==='object'&&!Array.isArray(value))return value}catch{/* Some tools return only a human-readable acknowledgement. */}
 }
 return {}
}
function samePull(args:Extract<Write,{action:'create_pull'}>,item:Record<string,any>){
 return item.head?.ref===args.head&&item.base?.ref===args.base&&item.head?.repo?.full_name?.toLowerCase()===args.repository
  && item.title===args.title&&(item.body??'')===(args.body??'')&&(args.draft===undefined||args.draft===item.draft)
}
function matches(args:Write,item:Record<string,any>){
 return (!('title' in args)||args.title===undefined||args.title===item.title)
  && (!('state' in args)||args.state===undefined||args.state===item.state)
  && (!('base' in args)||args.base===undefined||args.base===item.base?.ref)
  && (!('body' in args)||args.body===undefined||args.body===(item.body??''))
  && (!('labels' in args)||args.labels===undefined||[...args.labels].sort().join('\0')===item.labels?.map((label:{name:string})=>label.name).sort().join('\0'))
}
function receipt(args:Write){
 const number='number' in args?args.number:undefined
 const repo='https://github.com/'+args.repository
 return {repository:args.repository,operation:args.action,...(number?{number,url:repo+'/'+(args.action.endsWith('_pull')?'pull':'issues')+'/'+number}:{}),
  ...(args.action==='create_pull'?{head:args.head,base:args.base}:args.action==='merge_pull'?{expectedHead:args.expectedHead}:{})}
}
function uncertain(details:object):ToolResult{
 return {...githubResult({status:'uncertain',...details,message:'GitHub did not confirm the final state. Read the target before trying another write.'},false),permission:'uncertain'}
}
