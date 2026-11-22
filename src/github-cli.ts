import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {GithubError} from './github-errors.ts'

const exec=promisify(execFile)

// Ask gh for the login it already stores on the deployment host. Tokens
// injected for other processes must not select a different GitHub account.
export async function githubCliToken(account:string,signal?:AbortSignal){
 const env={...process.env,GH_PROMPT_DISABLED:'1'}
 for(const key of ['GH_TOKEN','GITHUB_TOKEN','GH_HOST','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN']){
  delete (env as NodeJS.ProcessEnv)[key]
 }
 try{
  const {stdout}=await exec('gh',['auth','token','--hostname','github.com','--user',account],{
   env,signal,timeout:5000,maxBuffer:4096,encoding:'utf8',
  })
  const token=stdout.trim()
  if(!/^[a-zA-Z\d_]{1,500}$/.test(token))throw new GithubError('auth_required')
  return token
 }catch(error){
  signal?.throwIfAborted()
  if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw new GithubError('cli_unavailable')
  throw new GithubError('auth_required')
 }
}
