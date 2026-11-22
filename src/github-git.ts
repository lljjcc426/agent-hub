import {execFile} from 'node:child_process'
import {existsSync,mkdtempSync,realpathSync,renameSync,rmSync,statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {promisify} from 'node:util'
import {z} from 'zod'
import {githubRefSchema,githubRepository,githubRepositorySchema} from './github-read.ts'
import {GithubError} from './github-errors.ts'
import type {ToolSpec} from './model.ts'

export const githubGitSchema=z.object({
 action:z.enum(['clone','push']),repository:githubRepositorySchema,
 directory:z.string().max(100).regex(/^(\.|[a-zA-Z\d_-][a-zA-Z\d._-]{0,99})$/).optional(),
 branch:githubRefSchema.optional(),
}).strict()
export type GithubGitInput=z.output<typeof githubGitSchema>
export const githubGitSpec:ToolSpec={type:'function',name:'github_git',inputSchema:z.toJSONSchema(githubGitSchema,{target:'draft-07'}),
 description:'Using the connected GitHub token, clone into a new task subdirectory or push the current committed HEAD to the named branch. Clone returns the task-relative directory. Push expects an existing task repository with matching GitHub origin; set directory to its task-relative folder or ".". Uses the connection identity without disclosing credentials. To edit and commit, use the usual Worker workspace tools first. Push requires branch and verifies the remote SHA. No force push.',
}

const exec=promisify(execFile)
const cleanEnv={PATH:process.env.PATH,LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}
const proxyEnv=()=>Object.fromEntries(['HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy'].flatMap(key=>process.env[key]?[[key,process.env[key]]]:[]))
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
 const secret='Authorization: Basic '+Buffer.from(login+':'+token).toString('base64')
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
    throw error instanceof GithubError?error:new GithubError('unavailable')
   }finally{rmSync(staged,{recursive:true,force:true})}
  }
  const sha=revision.sha!,branch=revision.branch!,ref='refs/heads/'+branch
  // Read the worktree's Git objects without a credential. Only the fresh bare
  // repository, with no user/repository config, can perform network operations.
  await git(scratch,['init','--bare','--template='],signal)
  await git(scratch,['-c','protocol.file.allow=always','fetch','--no-tags','--no-recurse-submodules','--',pathToFileURL(revision.cwd).href,sha],signal)
  check()
  try{await git(scratch,['push','--porcelain','--',remote,sha+':'+ref],signal,secret)}catch{/* Read back even when the transport did not confirm. */}
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
