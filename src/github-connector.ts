import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {z} from 'zod'
import type {Tool} from '@modelcontextprotocol/sdk/types.js'
import {GithubError,githubFailure,githubResult} from './github-errors.ts'
import {GithubReader,githubRefSchema,githubRepository,githubRepositorySchema,githubReadSchema,githubReadSpec} from './github-read.ts'
import {githubGit,githubGitRevision,githubGitSchema,githubGitSpec,type GitRevision} from './github-git.ts'
import {managedConnections,managedSecrets,prepareManagedConfig} from './managed-config.ts'
import {OperationError} from './operation-errors.ts'
import {stableDigest} from './sources.ts'
import type {Runtime} from './runtime.ts'
import type {ToolConnection} from './connector-config.ts'
import type {ToolSpec} from './model.ts'
import type {ToolResult} from './chat-permissions.ts'
import {remoteCommitHistory,type CommitHistory} from './chat-commit-trail.ts'
import {githubCliToken} from './github-cli.ts'
import {GithubReadCache,type GithubReadOptions} from './github-read-cache.ts'
import {githubApiPath,githubArguments,githubEvidence,githubRestVerb,githubToolArguments,githubToolConnection,
 githubToolHeaders,githubToolName,githubToolOutput,githubWritePath,githubReadTools,githubWriteTools} from './github-tools.ts'
import {githubChangePull,githubCheckReviewThread,githubNodeId,githubPullControl,githubReviewThreads} from './github-review.ts'
import {githubPushAccess} from './github-git.ts'

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
const mergeMethod=z.enum(['merge','squash','rebase'])
export const githubWriteSchema=z.discriminatedUnion('action',[
 z.object({...target,action:z.literal('create_pull'),title,body:text.optional(),head:githubRefSchema,base:githubRefSchema,draft:z.boolean().optional()}).strict(),
 z.object({...target,action:z.literal('update_pull'),number,title:title.optional(),body:text.optional(),base:githubRefSchema.optional(),state:z.enum(['open','closed']).optional()}).strict(),
 z.object({...target,action:z.literal('review_pull'),number,body:text.optional(),event:z.enum(['APPROVE','REQUEST_CHANGES','COMMENT'])}).strict(),
 z.object({...target,action:z.literal('merge_pull'),number,expectedHead:sha,method:mergeMethod.optional()}).strict(),
 z.object({...target,action:z.literal('create_issue'),title,body:text.optional(),labels:z.array(label).max(30).optional()}).strict(),
 z.object({...target,action:z.literal('update_issue'),number,title:title.optional(),body:text.optional(),state:z.enum(['open','closed']).optional(),labels:z.array(label).max(30).optional()}).strict(),
 z.object({...target,action:z.literal('comment'),number,body:text.trim().min(1)}).strict(),
 z.object({...target,action:z.literal('tool'),tool:githubToolName,arguments:githubArguments.optional()}).strict(),
 z.object({...target,action:z.literal('api'),verb:githubRestVerb,apiPath:githubApiPath,arguments:githubArguments.optional()}).strict(),
 z.object({...target,action:z.literal('pull_control'),number,control:githubPullControl,threadId:githubNodeId.optional(),method:mergeMethod.optional()}).strict(),
])
// Older model and MCP transports expect an object at the schema root.
// prepare() applies the exact schema for the selected action before approval.
export const githubWriteInputSchema=z.object({...target,
 action:z.enum(['create_pull','update_pull','review_pull','merge_pull','create_issue','update_issue','comment','tool','api','pull_control']),
 number:number.optional(),title:title.optional(),body:text.optional(),head:githubRefSchema.optional(),base:githubRefSchema.optional(),
 draft:z.boolean().optional(),state:z.enum(['open','closed']).optional(),labels:z.array(label).max(30).optional(),
 event:z.enum(['APPROVE','REQUEST_CHANGES','COMMENT']).optional(),
 expectedHead:sha.optional(),method:mergeMethod.optional(),
 tool:githubToolName.optional(),arguments:githubArguments.optional(),verb:githubRestVerb.optional(),apiPath:githubApiPath.optional(),
 control:githubPullControl.optional(),threadId:githubNodeId.optional(),
}).strict()
export const githubWriteSpec:ToolSpec={type:'function',name:'github_write',inputSchema:z.toJSONSchema(githubWriteInputSchema,{target:'draft-07'}),
 description:'Perform a requested GitHub write with the connected account. Use create_pull, update_pull, review_pull, merge_pull, create_issue, update_issue or comment for common writes. merge_pull requires number and the current expectedHead SHA. action tool calls a native GitHub operation by its tool name and arguments (see github_read action catalog); repository supplies owner and repo. action api supports repository-relative REST write routes with verb, apiPath and JSON arguments for issues, PRs, files, git objects, labels, reactions and Actions reruns. action pull_control supports ready, draft, auto_merge, resolve_thread and unresolve_thread by PR number. An uncertain result requires readback before retrying.',
}
export {githubReadSpec,githubGitSpec}
// Cached clients may still send the old repository field.
const setupSchema=z.union([
 z.object({source:z.literal('token').optional(),token:z.string().trim().min(1).max(500).regex(/^[a-zA-Z0-9_]+$/),repositories:z.array(z.string()).optional()}).strict(),
 z.object({source:z.literal('cli'),account:z.string().trim().regex(/^[a-zA-Z\d][a-zA-Z\d-]{0,38}$/)}).strict(),
])
type Write=z.output<typeof githubWriteSchema>
type NativeWrite=Extract<Write,{action:'tool'|'api'|'pull_control'}>
type CommonWrite=Exclude<Write,NativeWrite>
type Connection={id:string;account:string;tools:string[];checkedAt:number;source?:'token'|'cli'}
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
 private readonly cliReadCredentials=new GithubReadCache(1,4096)
 private catalog?:{key:string;tools:Tool[]}
 private readonly nativeCatalogs=new Map<boolean,{key:string;tools:Tool[]}>()
 private repositoryChoices?:{id:string;at:number;names:string[]}
 private authFailure?:{id:string;status:GithubError['code']}
 constructor(private readonly host:Runtime){}
 private current(){return this.host.store.get<Connection>(namespace,current)}
 snapshot(){
  const connection=this.current()
  if(!connection)return {status:'disconnected' as const}
  const {account,tools,checkedAt}=connection
  const failure=this.authFailure?.id===connection.id?this.authFailure.status:undefined
  const status=failure??(connection.source==='cli'||managedSecrets(this.host.config.stateDir)[secretName(connection.id)]?'connected':'auth_required')
  return {status,account,tools,checkedAt,source:connection.source??'token'}
 }
 connected(){return !!this.current()}
 private async access(signal?:AbortSignal,read?:Omit<GithubReadOptions,'signal'>):Promise<Access>{
  const connection=this.current()
  if(!connection)throw new GithubError('unconfigured')
  try{
   const token=connection.source==='cli'?(read?await this.cliReadCredentials.read(connection.id,{...read,signal},async activeSignal=>{
    const data=await githubCliToken(connection.account,activeSignal)
    return {data,bytes:Buffer.byteLength(data),freshnessMs:5000}
   }):await githubCliToken(connection.account,signal))
    :managedSecrets(this.host.config.stateDir)[secretName(connection.id)]
   if(!token)throw new GithubError('auth_required')
   const access={connection,token}
   this.live(access)
   return access
  }catch(error){
   if(error instanceof GithubError&&['auth_required','cli_unavailable'].includes(error.code))
    this.rememberAuthFailure(connection,error.code)
   throw error
  }
 }
 private live(access:Access){
  if(this.current()?.id!==access.connection.id)throw new GithubError('conflict')
 }
 private rememberAuthFailure(connection:Connection,status:GithubError['code']){
  if(this.current()?.id!==connection.id)return
  this.cliReadCredentials.clear()
  this.reader.clearReads()
  this.authFailure={id:connection.id,status}
 }
 async connect(input:unknown,authorize:()=>void){
  authorize()
  const parsed=setupSchema.safeParse(input)
  if(!parsed.success)throw new GithubError('invalid_request')
  const previous=this.current(),id=randomUUID(),signal=AbortSignal.timeout(24_000)
  const source=parsed.data.source??'token'
  const token=parsed.data.source==='cli'?await githubCliToken(parsed.data.account,signal):parsed.data.token
  const key=this.managedKey({id,source},token)
  let identity:{login:string},tools:Tool[]
  try{
   const [account,discovered]=await Promise.all([
    this.probe(()=>this.reader.get('user',token,signal),signal),
    this.probe(()=>this.host.toolConnections.inspectManaged(key,remote,headers(token),signal),signal),
   ])
   if(typeof account?.login!=='string'||!account.login)throw new GithubError('auth_required')
   if(parsed.data.source==='cli'&&account.login.toLowerCase()!==parsed.data.account.toLowerCase())throw new GithubError('auth_required')
   if(!discovered.some(tool=>remote.allowedTools.includes(tool.name)&&tool.annotations?.readOnlyHint!==true))throw new GithubError('unsupported')
   identity=account;tools=discovered
  }catch(error){
   void this.host.toolConnections.closeManaged(key)
   if(error instanceof GithubError)throw error
   throw connectionFailure(error)
  }
  try{
   authorize()
   if(this.current()?.id!==previous?.id)throw new GithubError('conflict')
   this.closeCatalogs()
   this.persist(id,{id,account:identity.login,tools:tools.map(tool=>tool.name),checkedAt:Date.now(),source},source==='token'?token:undefined)
   this.catalog={key,tools}
   this.repositoryChoices=undefined
   this.authFailure=undefined
  }catch(error){
   void this.host.toolConnections.closeManaged(key)
   throw error
  }
  return this.snapshot()
 }
 private managedKey(connection:Pick<Connection,'id'|'source'>,token:string){
  return connection.id+(connection.source==='cli'?':'+stableDigest(token):'')
 }
 private closeCatalogs(){
  this.cliReadCredentials.clear()
  this.reader.clearReads()
  for(const entry of [this.catalog,...this.nativeCatalogs.values()]){
   if(entry)void this.host.toolConnections.closeManaged(entry.key)
  }
  this.catalog=undefined
  this.nativeCatalogs.clear()
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
   this.closeCatalogs();this.authFailure=undefined;this.repositoryChoices=undefined
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
  const parsed=githubReadSchema.safeParse(input)
  if(!parsed.success)return githubFailure(new GithubError('invalid_request'))
  const {action}=parsed.data
  if(action&&['catalog','tool','api','review_threads'].includes(action)){
   if(!allowPrivate)return githubFailure(new GithubError('access_denied'))
   let access:Access|undefined
   try{
    access=await this.access(signal,{check,fresh:parsed.data.fresh})
    const authorized=()=>{check();this.live(access!)}
    authorized()
    const result=await this.readConnected(parsed.data,access,authorized,signal)
    authorized()
    this.authFailure=undefined
    return result
   }catch(error){
    signal?.throwIfAborted()
    check()
    if(access&&this.current()?.id!==access.connection.id)return githubFailure(new GithubError('conflict'))
    const failure=error instanceof GithubError?error:connectionFailure(error)
    if(access&&failure.code==='auth_required')this.rememberAuthFailure(access.connection,failure.code)
    return githubFailure(failure)
   }
  }
  let used:Connection|undefined
  const result=await this.reader.read(parsed.data,async(_,action)=>{
   if(action==='compare'&&!allowPrivate)throw new GithubError('access_denied')
   if(action!=='compare'&&(!allowPrivate||!this.current()))return
   const access=await this.access(signal,{check,fresh:parsed.data.fresh})
   check()
   used=access.connection
   return access.token
  },signal,()=>{
   check()
   if(used&&this.current()?.id!==used.id)throw new GithubError('conflict')
  })
  check()
  if(used&&this.current()?.id!==used.id)return githubFailure(new GithubError('conflict'))
  if(used){
   const statuses=result.contentItems.map(item=>item.type==='inputText'?item.text:'').join('')
   if(statuses.includes('"status":"auth_required"'))this.rememberAuthFailure(used,'auth_required')
   else if(result.success)this.authFailure=undefined
  }
  return result
 }
 private async getNativeTools(access:Access,readOnly:boolean,signal?:AbortSignal){
  const key=this.managedKey(access.connection,access.token)+(readOnly?':read':':write')
  const config=githubToolConnection(readOnly),headers=githubToolHeaders(access.token,readOnly)
  let entry=this.nativeCatalogs.get(readOnly)
  if(entry?.key!==key){
   if(entry)void this.host.toolConnections.closeManaged(entry.key)
   try{
    const tools=await this.reader.reuse(['mcp-catalog',key],access.token,{signal,check:()=>this.live(access)},
     (activeSignal,authorize)=>this.reader.schedule(access.token,activeSignal,()=>{
      authorize()
      return this.host.toolConnections.inspectManaged(key,config,headers,activeSignal).catch(error=>{throw connectionFailure(error)})
     }))
    this.live(access)
    entry={key,tools:tools.filter(tool=>readOnly?tool.annotations?.readOnlyHint===true:
     tool.annotations?.readOnlyHint!==true&&Object.hasOwn(tool.inputSchema.properties??{},'owner')&&Object.hasOwn(tool.inputSchema.properties??{},'repo'))}
    this.nativeCatalogs.set(readOnly,entry)
   }catch(error){
    if(this.current()?.id!==access.connection.id)void this.host.toolConnections.closeManaged(key)
    throw error
   }
  }
  return {...entry,config,headers}
 }
 private async readConnected(input:z.output<typeof githubReadSchema>,access:Access,check:()=>void,signal?:AbortSignal){
  const {action,tool,offset,number}=input,repository=githubRepository(input.repository)!
  const options={signal,check,fresh:input.fresh}
  if(action==='catalog'){
   if(tool){
    const readOnly=githubReadTools.includes(tool)
    if(!readOnly&&!githubWriteTools.includes(tool))throw new GithubError('unsupported')
    const catalog=await this.getNativeTools(access,readOnly,signal)
    const match=catalog.tools.find(item=>item.name===tool)
    if(!match)throw new GithubError('unsupported')
    return githubEvidence({repository,tool,readOnly},{description:match.description,inputSchema:match.inputSchema},offset)
   }
   const [reads,writes]=await Promise.allSettled([this.getNativeTools(access,true,signal),this.getNativeTools(access,false,signal)])
   if(reads.status==='rejected'&&writes.status==='rejected')throw reads.reason
   const names=(result:typeof reads)=>result.status==='fulfilled'?result.value.tools.map(tool=>tool.name).sort():null
   return githubResult({repository,read:names(reads),write:names(writes)})
  }
  if(action==='api'){
   if(!input.apiPath)throw new GithubError('invalid_request')
   const path=input.apiPath.replace(/^\//,'')
   const match=/^repos\/([^/]+\/[^/?]+)(?:[/?]|$)/.exec(path)
   if(match&&githubRepository(match[1]!)!==repository)throw new GithubError('invalid_request')
   const data=await this.reader.readRest(path,access.token,{...options,format:input.format})
   return githubEvidence({repository,path},data,offset)
  }
  if(action==='review_threads'){
   if(!number)throw new GithubError('invalid_request')
   const data=await this.reader.reuse(['review-threads',repository,number,input.cursor],access.token,options,
    (activeSignal,authorize)=>githubReviewThreads(this.reader,access.token,repository,number,input.cursor,activeSignal,authorize))
   return githubEvidence({repository,number,cursor:data.pageInfo?.endCursor,hasNextPage:!!data.pageInfo?.hasNextPage},data.nodes,offset)
  }
  if(!tool)throw new GithubError('invalid_request')
  const catalog=await this.getNativeTools(access,true,signal)
  const match=catalog.tools.find(item=>item.name===tool)
  if(!match)throw new GithubError('unsupported')
  const args=githubToolArguments(match,repository,input.arguments??{})
  const data=await this.reader.reuse(['mcp-read',catalog.key,tool,args],access.token,options,(activeSignal,authorize)=>
   this.reader.schedule(access.token,activeSignal,async()=>{
    authorize()
    const response=await this.host.toolConnections.invokeManaged(catalog.key,catalog.config,catalog.headers,match,args,authorize,activeSignal)
     .catch(error=>{throw connectionFailure(error)})
    if(response.invalid)throw new GithubError('invalid_request')
    return githubToolOutput(response.result)
   }))
  return githubEvidence({repository,tool},data,offset)
 }
 async permissions(input:unknown,check:()=>void){
  check()
  const parsed=z.object({repository:githubRepositorySchema}).strict().safeParse(input)
  if(!parsed.success)throw new GithubError('invalid_request')
  const repository=githubRepository(parsed.data.repository)!,signal=AbortSignal.timeout(26_000)
  const access=await this.access(signal)
  const root='repos/'+repository
  const read=async(path:string)=>{
   try{await this.reader.get(root+path,access.token,signal);return {status:'allowed'}}
   catch(error){return {status:error instanceof GithubError?error.code:'unavailable',httpStatus:error instanceof GithubError?error.httpStatus:undefined}}
  }
  const [contents,pullRequests,issues,actions,push]=await Promise.all([
   read('/contents'),read('/pulls?per_page=1'),read('/issues?per_page=1'),read('/actions/runs?per_page=1'),
   githubPushAccess(repository,access.connection.account,access.token,signal),
  ])
  check()
  this.live(access)
  if(contents.status==='allowed')this.authFailure=undefined
  return {repository,account:access.connection.account,source:access.connection.source??'token',
   checkedAt:Date.now(),read:{contents,pullRequests,issues,actions},push}
 }
 async visibleRepositories(check:()=>void,signal:AbortSignal):Promise<string[]>{
  signal.throwIfAborted()
  check()
  const access=await this.access(signal),id=this.managedKey(access.connection,access.token),cached=this.repositoryChoices
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
  const access=await this.access(signal)
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
   const access=await this.access(signal)
   const revision=await githubGitRevision(workspace,args,signal)
   this.live(access)
   return {name,args,access,revision}
  }
  const parsed=githubWriteSchema.safeParse(input)
  if(!parsed.success)throw new GithubError('invalid_request')
  const args={...parsed.data,repository:githubRepository(parsed.data.repository)!}
  if('labels'in args&&args.labels)args.labels=[...new Set(args.labels)].sort()
  if(args.action==='merge_pull')args.method??='squash'
  if(args.action==='api'){
   args.apiPath=githubWritePath(args.verb,args.apiPath)
   if(args.apiPath.startsWith('git/refs/')&&args.arguments?.force!==undefined&&args.arguments.force!==false)
    throw new GithubError('unsupported')
  }
  if(args.action==='tool'&&!githubWriteTools.includes(args.tool))throw new GithubError('unsupported')
  if(args.action==='pull_control'&&(
   ['resolve_thread','unresolve_thread'].includes(args.control)!==!!args.threadId||args.method!==undefined&&args.control!=='auto_merge'))
   throw new GithubError('invalid_request')
  const access=await this.access(signal)
  if(args.action in mcpName&&!access.connection.tools.includes(mcpName[args.action as keyof typeof mcpName]))throw new GithubError('unsupported')
  return {name,args,access}
 }
 facts(plan:Plan){
  const {args,access}=plan
  const action=args.action==='tool'?args.tool:args.action==='api'?args.verb+' '+args.apiPath:args.action==='pull_control'?args.control:args.action
  const key=this.managedKey(access.connection,access.token)
  return {tool:plan.name,action,target:args.repository,account:access.connection.account,
   version:stableDigest([key,plan.name==='github_git'?plan.revision:null]),
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
   const settled=this.host.permissions.confirmEffect(id,result)
   if(settled)this.reader.clearReads()
   return settled?'settled':'unavailable'
  }catch(error){
   return error instanceof GithubError&&['auth_required','access_denied','unconfigured','conflict'].includes(error.code)?'unavailable':'pending'
  }
 }
 async execute(plan:Plan,check:()=>void,signal?:AbortSignal):Promise<ToolResult>{
 const {access}=plan
  const current=()=>{signal?.throwIfAborted();check();this.live(access)}
  current()
  if(access.connection.source==='cli'){
   try{
    const currentAccess=await this.access(signal)
    current()
    if(currentAccess.token!==access.token)return githubFailure(new GithubError('conflict'))
   }catch(error){
    if(error instanceof GithubError)return githubFailure(error)
    throw error
   }
  }
  try{
   if(plan.name==='github_git'){
    try{
     const result=await githubGit(plan.args,plan.revision,access.connection.account,access.token,current,signal)
     return result.status==='uncertain'?uncertain(result):githubResult(result)
    }catch(error){
     signal?.throwIfAborted()
     return githubFailure(error instanceof GithubError?error:new GithubError('unavailable'))
    }
   }
   return await this.write(plan,current,signal)
  }finally{
   if(plan.name==='github_write'||plan.args.action==='push')this.reader.clearReads()
  }
 }
 private async write(plan:WritePlan,check:()=>void,signal?:AbortSignal):Promise<ToolResult>{
  const {args,access}=plan,{connection,token}=access
  if(args.action==='api'||args.action==='pull_control'||args.action==='tool')return this.writeConnected(args,access,check,signal)
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
   const key=this.managedKey(connection,token)
   if(this.catalog?.key!==key){
    if(this.catalog)void this.host.toolConnections.closeManaged(this.catalog.key)
    const tools=await this.host.toolConnections.inspectManaged(key,remote,headers(token),signal)
    check()
    this.catalog={key,tools}
   }
   const tool=this.catalog.tools.find(tool=>tool.name===mcpName[args.action])
   if(!tool)throw new GithubError('unsupported')
   const started=Date.now()
   const response=await this.host.toolConnections.invokeManaged(key,remote,headers(token),tool,mcpArguments(args),beforeSend,signal)
   if(response.invalid)return githubFailure(new GithubError('unsupported'))
   const result=response.result
   if(result.isError){
    try{githubToolOutput(result)}catch(error){
     if(error instanceof GithubError&&error.httpStatus!==undefined)sent=false
     throw error
    }
   }
   const data=resultData(result)
   const output=await this.confirm(args,data,get,connection.account,started)
   check()
   return output?githubResult({...receipt(args),...output,status:'complete'}):uncertain(receipt(args))
  }catch(error){
   if(connection.id===this.current()?.id&&(error instanceof GithubError&&error.code==='auth_required'||error instanceof OperationError&&error.code==='auth_required'))
    this.rememberAuthFailure(connection,'auth_required')
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
 private async writeConnected(args:NativeWrite,access:Access,check:()=>void,signal?:AbortSignal):Promise<ToolResult>{
  const {repository}=args,{token}=access
  let sent=false
  const beforeSend=()=>{check();sent=true}
  const operation=args.action==='tool'?args.tool:args.action==='api'?args.verb+' '+args.apiPath:args.control
  try{
   let data:unknown
   if(args.action==='api'){
    data=await this.reader.api('repos/'+repository+'/'+args.apiPath,token,
     {method:args.verb,body:args.arguments,beforeSend},signal)
   }else if(args.action==='pull_control'){
    data=await githubChangePull(this.reader,token,repository,args.number,args.control,args.threadId,args.method,beforeSend,signal)
   }else{
    const catalog=await this.getNativeTools(access,false,signal)
    const tool=catalog.tools.find(item=>item.name===args.tool)
    if(!tool)throw new GithubError('unsupported')
    const input=githubToolArguments(tool,repository,args.arguments??{})
    if(args.tool==='pull_request_review_write'&&input.threadId!==undefined){
     const id=githubNodeId.safeParse(input.threadId),pull=number.safeParse(input.pullNumber)
     if(!id.success||!pull.success)throw new GithubError('invalid_request')
     await githubCheckReviewThread(this.reader,token,repository,pull.data,id.data,signal)
    }
    const response=await this.host.toolConnections.invokeManaged(catalog.key,catalog.config,catalog.headers,tool,input,beforeSend,signal)
    if(response.invalid)throw new GithubError('invalid_request')
    data=githubToolOutput(response.result)
   }
   check()
   return githubEvidence({repository,operation,status:'complete'},data)
  }catch(error){
   if(sent&&(!(error instanceof GithubError)||error.httpStatus===undefined))
    return uncertain({repository,operation})
   signal?.throwIfAborted()
   return githubFailure(error instanceof GithubError?error:connectionFailure(error))
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
 if(error instanceof GithubError)return error
 if(error instanceof OperationError){
  if(error.code==='auth_required')return new GithubError('auth_required')
  if(error.code==='provider_rejected')return new GithubError('access_denied')
  if(error.code==='rate_limited')return new GithubError('rate_limited',60)
 }
 return new GithubError('unavailable')
}
function mcpArguments(input:Exclude<CommonWrite,{action:'merge_pull'}>){
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
