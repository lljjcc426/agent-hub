import {execFile} from 'node:child_process'
import {existsSync,mkdtempSync,realpathSync,renameSync,rmSync,statSync} from 'node:fs'
import {devNull,tmpdir} from 'node:os'
import {basename,dirname,join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {promisify} from 'node:util'
import {z} from 'zod'
import {githubRefSchema,githubRepository,githubRepositorySchema} from './github-read.ts'
import {GithubError} from './github-errors.ts'
import type {ToolSpec} from './model.ts'

export const githubGitSchema=z.object({
 action:z.enum(['clone','fetch','push']),repository:githubRepositorySchema,
 directory:z.string().max(100).regex(/^(\.|[a-zA-Z\d_-][a-zA-Z\d._-]{0,99})$/).optional(),
 branch:githubRefSchema.optional(),
}).strict()
export type GithubGitInput=z.output<typeof githubGitSchema>
export const githubGitSpec:ToolSpec={type:'function',name:'github_git',inputSchema:z.toJSONSchema(githubGitSchema,{target:'draft-07'}),
 description:'Clone a GitHub repository into a new task subdirectory, fetch a named branch into the existing repository’s origin tracking ref, or push a committed HEAD to a named branch. Fetch and push require a matching GitHub origin and branch. Set directory to the task-relative folder or ".". Use workspace tools to edit and commit. Push verifies the remote SHA and never force pushes.',
}

const exec=promisify(execFile)
const cleanEnv={PATH:process.env.PATH,LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}
const proxyEnv=()=>Object.fromEntries(['HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy'].flatMap(key=>process.env[key]?[[key,process.env[key]]]:[]))
const basicAuth=(login:string,token:string)=>'Basic '+Buffer.from(login+':'+token).toString('base64')

export async function githubPushAccess(repository:string,login:string,token:string,signal:AbortSignal){
 const url='https://github.com/'+repository+'.git/info/refs?service=git-receive-pack'
 const authorization=basicAuth(login,token),agent='git/2.51.0'
 try{
  const response=await fetch(url,{
   redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(6000)]),headers:{authorization,'user-agent':agent},
  })
  void response.body?.cancel().catch(()=>{})
  const result=pushAccess(response.status,response.headers.get('content-type')??'')
  if(result.status!=='unavailable')return result
 }catch{/* The host may reach GitHub through the HTTPS proxy used by git. */}
 if(signal.aborted)return {status:'unavailable'}
 try{
  const request=exec('curl',['--disable','--silent','--proto','=https','--http1.1','--max-time','10','--config','-',
   '--output',devNull,'--write-out','%{response_code} %{content_type}',url],{signal,timeout:11_000,maxBuffer:1024,encoding:'utf8'})
  const stdin=request.child.stdin
  stdin?.on('error',()=>{})
  stdin?.end('header = "Authorization: '+authorization+'"\nuser-agent = "'+agent+'"\n')
  const [status,contentType='']=(await request).stdout.trim().split(' ',2)
  return pushAccess(Number(status),contentType)
 }catch{return {status:'unavailable'}}
}

function pushAccess(httpStatus:number,contentType:string){
 const status=httpStatus===200&&contentType.includes('application/x-git-receive-pack-advertisement')
  ?'allowed':[401,403,404].includes(httpStatus)?'denied':'unavailable'
 return {status,httpStatus}
}

function gitPermissionError(error:unknown){
 const {stderr}=(error??{}) as {stderr?:string}
 if(!stderr)return
 if(/requested URL returned error: 403|write access to repository not granted/i.test(stderr))return new GithubError('access_denied',undefined,403)
 if(/requested URL returned error: 401|authentication failed/i.test(stderr))return new GithubError('auth_required',undefined,401)
}
async function git(cwd:string,args:string[],signal?:AbortSignal,secret?:string){
 const security=['-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-c','protocol.https.allow=always','-c','http.followRedirects=false','-c','http.version=HTTP/1.1','-c','http.lowSpeedLimit=1024','-c','http.lowSpeedTime=15','-c','credential.helper=']
 const auth=secret?['--config-env=http.https://github.com/.extraHeader=ROPPO_GITHUB_GIT_HEADER']:[]
 return (await exec('git',[...security,...auth,...args],{cwd,env:{...cleanEnv,...(secret?{...proxyEnv(),ROPPO_GITHUB_GIT_HEADER:secret}:{})},
  timeout:55_000,maxBuffer:1_000_000,signal,encoding:'utf8'})).stdout.trim()
}
function remoteRepo(url:string){
 if(!/^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(url))return
 return githubRepository(url.replace(/^(git@github\.com:|ssh:\/\/git@github\.com\/)/i,''))
}
export type GitRevision={cwd:string;branch?:string;sha?:string}
export async function githubGitRevision(root:string,input:GithubGitInput,signal?:AbortSignal):Promise<GitRevision>{
 const repository=githubRepository(input.repository)!,directory=input.directory??(input.action==='clone'?repository.split('/')[1]:'.')!
 const base=realpathSync(root),requested=join(base,directory)
 if(input.action==='clone'){
  if(directory==='.'||existsSync(requested))throw new GithubError('conflict')
  return {cwd:requested}
 }
 if(!input.branch||input.branch.startsWith('refs/')||!existsSync(requested))throw new GithubError('invalid_request')
 try{
  const cwd=realpathSync(requested)
  if(cwd!==resolve(requested)||!statSync(cwd).isDirectory())throw new GithubError('access_denied')
  const [top,origin,sha]=await Promise.all([
   git(cwd,['rev-parse','--show-toplevel'],signal),git(cwd,['remote','get-url','origin'],signal),
   git(cwd,['rev-parse','--verify','HEAD^{commit}'],signal),
  ])
  if(realpathSync(top)!==cwd||remoteRepo(origin)!==repository||!(/^[a-f0-9]{40,64}$/).test(sha))throw new GithubError('access_denied')
  await git(cwd,['check-ref-format','refs/heads/'+input.branch],signal)
  return {cwd,branch:input.branch,sha}
 }catch(error){
  signal?.throwIfAborted()
  throw error instanceof GithubError?error:new GithubError('invalid_request')
 }
}

export async function githubGit(input:GithubGitInput,revision:GitRevision,login:string,token:string,check:()=>void,signal?:AbortSignal){
 const repository=githubRepository(input.repository)!,remote='https://github.com/'+repository+'.git'
 const secret='Authorization: '+basicAuth(login,token)
 const scratch=mkdtempSync(join(tmpdir(),'roppo-github-'))
 try{
  if(input.action==='clone'){
   check()
   if(existsSync(revision.cwd))throw new GithubError('conflict')
   const staged=mkdtempSync(join(dirname(revision.cwd),'.roppo-github-'))
   try{
    await git(scratch,['clone','--template=','--no-recurse-submodules',...(input.branch?['--branch',input.branch]:[]),'--',remote,staged],signal,secret)
    const sha=await git(staged,['rev-parse','--verify','HEAD^{commit}'],signal)
    check()
    if(existsSync(revision.cwd))throw new GithubError('conflict')
    renameSync(staged,revision.cwd)
    return {status:'complete',repository,directory:input.directory??repository.split('/')[1],sha}
   }catch(error){
    signal?.throwIfAborted()
    throw error instanceof GithubError?error:gitPermissionError(error)??new GithubError('unavailable')
   }finally{rmSync(staged,{recursive:true,force:true})}
  }
  const sha=revision.sha!,branch=revision.branch!,ref='refs/heads/'+branch
  // Read the worktree's Git objects without a credential. Only the fresh bare
  // repository, with no user/repository config, can perform network operations.
  await git(scratch,['init','--bare','--template='],signal)
  if(input.action==='fetch'){
   check()
   try{await git(scratch,['fetch','--no-tags','--no-recurse-submodules','--',remote,ref+':'+ref],signal,secret)}
   catch(error){signal?.throwIfAborted();throw gitPermissionError(error)??new GithubError('unavailable')}
   const fetched=await git(scratch,['rev-parse','--verify',ref+'^{commit}'],signal)
   check()
   const worktree=await githubGitRevision(dirname(revision.cwd),{...input,directory:basename(revision.cwd)},signal)
   if(worktree.cwd!==revision.cwd)throw new GithubError('conflict')
   check()
   await git(revision.cwd,['-c','protocol.file.allow=always','fetch','--no-tags','--no-recurse-submodules','--',
    pathToFileURL(scratch).href,'+'+ref+':refs/remotes/origin/'+branch],signal)
   check()
   return {status:'complete',repository,branch,sha:fetched}
  }
  await git(scratch,['-c','protocol.file.allow=always','fetch','--no-tags','--no-recurse-submodules','--',pathToFileURL(revision.cwd).href,sha],signal)
  check()
  try{await git(scratch,['push','--porcelain','--',remote,sha+':'+ref],signal,secret)}
  catch(error){const denied=gitPermissionError(error);if(denied)throw denied}
  if(!signal?.aborted){
   try{
    check()
    const head=await git(scratch,['ls-remote','--refs','--',remote,ref],signal,secret)
    check()
    if(head===sha+'\t'+ref)return {status:'complete',repository,branch,sha,url:'https://github.com/'+repository+'/commit/'+sha}
   }catch{/* The caller retains an uncertain receipt. */}
  }
  return {status:'uncertain',repository,branch,sha,message:'Read the remote branch before retrying this push.'}
 }finally{rmSync(scratch,{recursive:true,force:true})}
}
