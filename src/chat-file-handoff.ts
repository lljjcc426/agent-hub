import {createHash} from 'node:crypto'
import {constants,createWriteStream,realpathSync} from 'node:fs'
import {mkdir,mkdtemp,open,realpath,rm,stat,writeFile} from 'node:fs/promises'
import {basename,dirname,join,resolve} from 'node:path'
import {pipeline} from 'node:stream/promises'
import {z} from 'zod'
import type {Runtime} from './runtime.ts'
import type {Run} from './store.ts'
import {stableDigest} from './sources.ts'
import {managedWorkspacePath,retainedWorkspace} from './workspace.ts'
import {projectWorkspace} from './project-code.ts'
import {isHostPrivateFile} from './private-files.ts'

export interface FileHandoffOutcome {
  state:'ready'|'missing'
  missing:string[]
}
interface ExpectedFile {path:string;bytes?:number;sha256?:string}
interface Request {
  ticketId:string;conversationId:string;triggerId:string;question:string;paths:string[]
  outcome?:FileHandoffOutcome
}
export interface HandoffMaterial {id:string;kind:'task-handoff';ticketId:string;sourceTicketId:string;name:string;relativePath:string;path:string;bytes:number;sha256?:string}
interface Delivery {id:string;ticketId:string;name:string}

export const validRetainedPath=(path:string)=>path.length<=1000&&path.split('/').every(
  part=>part!==''&&part!=='.'&&part!=='..'&&!/[\\:\x00-\x1f\x7f]/.test(part)&&!/^\.(git|env(?:\..*)?|ssh|aws|superagent(?:-.*)?)$/i.test(part)
)
export const retainedFileHandoffSchema=z.object({
  ticketId:z.string().min(1).max(200),sourceTicketId:z.string().min(1).max(200),
  files:z.array(z.object({
    path:z.string().refine(validRetainedPath),bytes:z.number().int().nonnegative().safe(),sha256:z.string().regex(/^[a-f\d]{64}$/),
  }).strict()).min(1).max(128).refine(files=>new Set(files.map(file=>file.path)).size===files.length,'Duplicate file path'),
}).strict()
type RetainedFileHandoff=z.infer<typeof retainedFileHandoffSchema>
const quotedPaths=(text:string)=>[...text.matchAll(/`([^`\r\n]+)`/g)].map(match=>match[1]!).filter(path=>/\.[a-z\d]+$/i.test(path))

export function fileHandoffOutcome(host:Runtime,id:string){
  const record=host.store.get<Request>('chat-file-handoff',id)
  return record&&!host.memory.cleanup.blocked('chat-file-handoff',id,record)?record.outcome:undefined
}

function sourceFiles(host:Runtime,request:Request){
  const {store}=host
  const trigger=store.triggers.get(request.triggerId)
  const run=store.get<{conversationId:string;decisionTicketId?:string}>('chat-run',request.triggerId)
  if(!trigger?.human||run?.conversationId!==request.conversationId||run.decisionTicketId!==request.ticketId)return
  const authority=host.taskAuthority(request.ticketId)
  if(!authority?.parentTrigger)return
  const current=store.triggers.get(authority.parentTrigger)
  const chat=store.get<{conversationId:string}>('chat-run',authority.parentTrigger)
  if(!current?.human||chat?.conversationId!==request.conversationId||
     current.actor.source!==trigger.actor.source||current.actor.id!==trigger.actor.id)return
  host.routerIngress.authority(trigger.id,authority.discussion)
  if(current.id!==trigger.id)host.routerIngress.authority(current.id,authority.discussion)
  const scoped=host.scopes.context(current,authority.discussion)
  const deliveries=store.db.prepare(`SELECT r.body FROM records r
    WHERE r.kind='chat-delivery' AND json_extract(r.body,'$.conversationId')=?
    AND json_extract(r.body,'$.ticketId')!=? AND json_extract(r.body,'$.mime') IS NOT NULL`).all(request.conversationId,request.ticketId)
  const names=new Set(request.paths.map(path=>basename(path)))
  const candidates=new Map<string,Delivery[]>()
  for(const row of deliveries){
    const file=JSON.parse(String(row.body)) as Delivery
    if(!names.has(file.name)||host.memory.cleanup.blocked('chat-delivery',file.id,file))continue
    const task=store.tickets.get(file.ticketId),source=host.taskAuthority(file.ticketId)
    if(!task?.ended||!source||source.discussion!==authority.discussion||task.mandate.actor.source!==trigger.actor.source||
       task.mandate.actor.id!==trigger.actor.id||host.memory.cleanup.blocked('ticket',task.id,task))continue
    const previous=store.get<Run>('run',task.id)?.workspaceSource
    if(previous&&!scoped)continue
    if(scoped)try{
      host.scopes.checkTask(task.id,scoped)
      host.scopes.checkTaskEntry(host.scopes.ownership(task.id)!,scoped.route.entryId,'result')
      if(previous)host.goals.checkWorkspaceSource(previous,scoped)
    }catch{continue}
    const files=candidates.get(task.id)??[]
    files.push(file)
    candidates.set(task.id,files)
  }
  // Confirmed names must identify a single prior task. Never choose by newest or merge sources.
  if(candidates.size!==1)return
  const [ticketId,files]=[...candidates][0]!
  const sourceRun=store.get<Run>('run',ticketId),cwd=sourceRun?.cwd
  const roots=[managedWorkspacePath(host.config.stateDir,sourceRun?.workspaceId??ticketId),projectWorkspace(host.config.stateDir,ticketId)]
  const root=cwd&&roots.some(path=>resolve(path)===resolve(cwd))?cwd:undefined
  return {ticketId,files,root}
}

function retainedBytes(host:Runtime,source:ReturnType<typeof sourceFiles>,path:string){
  const matches=source?.files.filter(file=>file.name===basename(path))
  if(matches?.length!==1)return
  const row=host.store.db.prepare('SELECT bytes FROM chat_delivery_bytes WHERE id=?').get(matches[0]!.id)
  if(row)return Buffer.from(row.bytes as Uint8Array)
}

function packageRows(report:string){
  const result:ExpectedFile[]=[]
  for(const line of report.split('\n')){
    const columns=line.split('|')
    for(let i=1;i+2<columns.length;i++){
      const path=quotedPaths(columns[i]!)[0],bytes=Number(columns[i+1]!.trim()),sha256=/^`([a-f\d]{64})`$/i.exec(columns[i+2]!.trim())?.[1]
      if(path&&validRetainedPath(path)&&/\.(zip|dmg|exe|msi|appimage|deb|rpm|pkg)$/i.test(path)&&Number.isSafeInteger(bytes)&&bytes>0&&sha256)result.push({path,bytes,sha256:sha256.toLowerCase()})
    }
  }
  return result
}

async function copyOriginal(root:string,file:ExpectedFile,destination:string,signal:AbortSignal){
  if(await realpath(root)!==root)throw Error('Original workspace is unavailable')
  const source=join(root,file.path)
  if(await realpath(source)!==source||isHostPrivateFile(source))throw Error('Original file is outside its retained workspace')
  const descriptor=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try{
    const before=await descriptor.stat()
    if(!before.isFile()||before.nlink!==1||file.bytes!==undefined&&before.size!==file.bytes)throw Error('Original file changed')
    const hash=createHash('sha256')
    await pipeline(descriptor.createReadStream({autoClose:false}),async function*(chunks){
      for await(const chunk of chunks){hash.update(chunk);yield chunk}
    },createWriteStream(destination,{flags:'wx',mode:0o400}),{signal})
    const after=await descriptor.stat(),live=await stat(source)
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||live.ino!==after.ino||live.dev!==after.dev||
       await realpath(source)!==source||file.sha256&&hash.digest('hex')!==file.sha256)throw Error('Original file changed')
    return before.size
  }finally{await descriptor.close()}
}

/** Recover explicitly identified inputs for a held Chat task without reopening its source task. */
export async function restoreRetainedFiles(host:Runtime,input:RetainedFileHandoff,authorize:()=>void,signal:AbortSignal){
  const {ticketId,sourceTicketId,files}=input,{store}=host
  const locate=()=>{
    authorize()
    const goal=host.goals.forTask(ticketId),target=store.tickets.get(ticketId),source=host.scopes.ownership(sourceTicketId)
    const targetRoute=host.taskAuthority(ticketId),sourceRoute=host.taskAuthority(sourceTicketId)
    const triggerId=targetRoute?.parentTrigger
    const chatRun=triggerId&&store.get<{conversationId:string;cancelled?:boolean;cancelRequested?:boolean}>('chat-run',triggerId)
    const sourceRun=sourceRoute?.parentTrigger&&store.get<{conversationId:string}>('chat-run',sourceRoute.parentTrigger)
    if(!goal||goal.state!=='held'||!target||target.ended||!source||!triggerId||!chatRun||
       chatRun.cancelled||chatRun.cancelRequested||!sourceRun||sourceRun.conversationId!==chatRun.conversationId||
       targetRoute.discussion!==goal.discussion||sourceRoute.discussion!==goal.discussion)
      throw Error('Retained files require a held task and an original task in the same Chat')
    const scoped=host.goals.context(goal)
    if(host.sources.get(scoped.trigger.source)?.config.kind!=='local')throw Error('Retained files require a local Chat')
    host.routerIngress.authority(triggerId,goal.discussion)
    host.routerIngress.authority(sourceRoute.parentTrigger!,goal.discussion)
    host.scopes.checkTask(ticketId,scoped,true)
    const reference={ticketId:sourceTicketId,ownerEpoch:source.ownerEpoch,dataRevision:source.dataRevision??1}
    host.goals.checkWorkspaceSource(reference,scoped)
    const run=store.get<Run>('run',sourceTicketId)
    if(!run?.prepared||run.phase!=='idle'||host.memory.cleanup.blocked('run',sourceTicketId,run)||
       host.executionActive(sourceTicketId)||host.work.active(sourceTicketId,run.assignmentId).length)
      throw Error('Original workspace is unavailable')
    if(run.workspaceSource)host.goals.checkWorkspaceSource(run.workspaceSource,scoped)
    const root=retainedWorkspace(host.config.stateDir,run.workspaceId??sourceTicketId)
    if(run.cwd!==root)throw Error('Original workspace does not match the task')
    return {root:realpathSync(root),conversationId:chatRun.conversationId,triggerId,reference,revision:goal.revision}
  }
  const location=locate()
  const id=stableDigest(['retained-files',location.conversationId,input])
  const existing=()=>store.get<{outcome:FileHandoffOutcome}>('chat-file-handoff',id)?.outcome.state==='ready'
  const result={id,ticketId,sourceTicketId,files:files.map(file=>({...file,id:stableDigest(['task-handoff',id,file.path])}))}
  if(existing())return result
  const assets=join(host.config.stateDir,'assets')
  await mkdir(assets,{recursive:true,mode:0o700})
  const directory=await mkdtemp(join(assets,'retained-'))
  let committed=false
  try{
    const materials:HandoffMaterial[]=[]
    for(const file of result.files){
      signal.throwIfAborted()
      const destination=join(directory,file.path)
      await mkdir(dirname(destination),{recursive:true,mode:0o700})
      await copyOriginal(location.root,file,destination,signal)
      materials.push({id:file.id,kind:'task-handoff',ticketId,sourceTicketId,name:basename(file.path),
        relativePath:file.path,path:destination,bytes:file.bytes,sha256:file.sha256})
    }
    signal.throwIfAborted()
    committed=store.atomic(()=>{
      if(stableDigest(locate())!==stableDigest(location))throw Error('Retained file authority changed')
      if(existing())return false
      for(const material of materials)store.put('asset',material.id,material)
      store.put('chat-file-handoff',id,{...input,conversationId:location.conversationId,triggerId:location.triggerId,
        outcome:{state:'ready',missing:[]} satisfies FileHandoffOutcome})
      return true
    })
    return result
  }finally{if(!committed)await rm(directory,{force:true,recursive:true})}
}

/** Finish handoffs already recorded by older releases. New assignments carry explicit file references. */
export async function prepareFileHandoff(host:Runtime,ticketId:string,signal:AbortSignal){
  const {store}=host
  const row=store.db.prepare(`SELECT id,body FROM records WHERE kind='chat-file-handoff'
    AND json_extract(body,'$.ticketId')=? AND json_extract(body,'$.outcome') IS NULL ORDER BY rowid DESC LIMIT 1`).get(ticketId)
  if(!row)return
  const id=String(row.id),request=JSON.parse(String(row.body)) as Request
  if(host.memory.cleanup.blocked('chat-file-handoff',id,request))return
  const source=sourceFiles(host,request)
  const originalRoot=source?.root&&join(await realpath(host.config.stateDir),'work',basename(source.root))
  const files=new Map<string,ExpectedFile>(request.paths.map(path=>[path,{path}]))
  const missing:string[]=[]
  // Older requests refer to the exact packages listed in a named verification report.
  if(/报告所列.*安装包|packages? listed in (?:the )?report/i.test(request.question)){
    const manifests=request.paths.filter(path=>path.endsWith('.md')).flatMap(path=>{
      const data=retainedBytes(host,source,path)
      const listed=data?packageRows(data.toString('utf8')):[]
      return listed.length?[listed]:[]
    })
    const packages=manifests.length===1?manifests[0]:undefined
    if(!packages)missing.push(/\p{Script=Han}/u.test(request.question)?'报告所列的原始安装包':'Original packages listed in the report')
    for(const file of packages??[])files.set(file.path,file)
  }
  const assets=join(host.config.stateDir,'assets')
  await mkdir(assets,{recursive:true,mode:0o700})
  // The row and its mounts commit together. Retry can discard its own uncommitted copies.
  const directory=join(assets,stableDigest(['file-handoff',id]))
  await rm(directory,{force:true,recursive:true})
  await mkdir(directory,{mode:0o700})
  const materials:HandoffMaterial[]=[]
  let retained=false
  try{
    for(const file of files.values()){
      signal.throwIfAborted()
      if(!source||!validRetainedPath(file.path)){missing.push(file.path);continue}
      const destination=join(directory,file.path)
      try{
        await mkdir(dirname(destination),{recursive:true,mode:0o700})
        const data=retainedBytes(host,source,file.path)
        let bytes:number
        if(data&&(file.sha256===undefined||createHash('sha256').update(data).digest('hex')===file.sha256)){
          await writeFile(destination,data,{flag:'wx',mode:0o400,signal})
          bytes=data.length
        }else if(originalRoot)bytes=await copyOriginal(originalRoot,file,destination,signal)
        else {missing.push(file.path);continue}
        materials.push({id:stableDigest(['task-handoff',id,file.path]),kind:'task-handoff',ticketId,sourceTicketId:source.ticketId,name:basename(file.path),relativePath:file.path,path:destination,bytes})
      }catch(error){
        signal.throwIfAborted()
        missing.push(file.path)
      }
    }
    signal.throwIfAborted()
    const current=sourceFiles(host,request)
    if(source&&current?.ticketId!==source.ticketId)throw Error('File handoff source was withdrawn')
    const outcome:FileHandoffOutcome=missing.length?{state:'missing',missing:[...new Set(missing)]}:{state:'ready',missing:[]}
    store.atomic(()=>{
      if(host.memory.cleanup.blocked('chat-file-handoff',id,request))throw Error('File handoff was withdrawn')
      if(outcome.state==='ready')for(const item of materials)store.put('asset',item.id,item)
      store.put('chat-file-handoff',id,{...request,outcome})
    })
    retained=outcome.state==='ready'
    return outcome
  }finally{if(!retained)await rm(directory,{force:true,recursive:true})}
}

export function handedOffFiles(host:Runtime,ticketId:string){
  return host.store.list<HandoffMaterial>('asset').filter(item=>item.kind==='task-handoff'&&item.ticketId===ticketId&&
    !host.memory.cleanup.blocked('asset',item.id,item)).map(item=>({
      name:item.name,path:item.path,relativePath:item.relativePath,resource:'asset/'+item.id,
      ...(item.sha256?{bytes:item.bytes,sha256:item.sha256}:{}),
    }))
}
