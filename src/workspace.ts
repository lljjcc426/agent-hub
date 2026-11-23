import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, lstatSync, realpathSync, mkdirSync,writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { SourceConfig, Config } from './config.ts'

/** Code writes use a separate checkout; non-repository analysis needs only its configured read-only directory. */
const exec=promisify(execFile)
export const managedWorkspacePath=(stateDir:string,ticketId:string)=>
  join(stateDir,'work',createHash('sha256').update(ticketId).digest('hex').slice(0,20))
export type GoalWorkspaceMode = 'shared' | 'read-only' | 'worktree'
export interface WorkspaceSource {ticketId:string;ownerEpoch:number;dataRevision:number}
export interface GoalWorkspace {id:string;source?:WorkspaceSource}

export function retainedWorkspace(stateDir:string,id:string){
  const path=managedWorkspacePath(stateDir,id)
  if(!existsSync(path)||!lstatSync(path).isDirectory()||
     realpathSync(path)!==join(realpathSync(stateDir),'work',basename(path)))throw Error('Retained goal workspace is unavailable')
  return path
}

export async function prepareWorkspace(config: Config, source: SourceConfig, ticketId: string,signal?:AbortSignal,workspaceId=ticketId,head='HEAD'): Promise<string> {
  if (source.sandbox === 'read-only'||source.workspace?.mode==='source') return realpathSync(source.cwd)
  const directory=managedWorkspacePath(config.stateDir,workspaceId)
  if(source.workspace?.mode==='directory'||!source.workspace&&source.kind!=='github'&&!source.repository){
    mkdirSync(directory,{recursive:true})
    const prepared=join(directory,'.superagent-prepared')
    if(!existsSync(prepared)){
      if(source.workspace?.prepare)await exec(source.workspace.prepare.command,source.workspace.prepare.args,{cwd:directory,signal,timeout:600000,env:{...process.env,SUPERAGENT_TICKET_ID:ticketId,SUPERAGENT_SOURCE_DIR:source.cwd}})
      writeFileSync(prepared,'prepared\n',{mode:0o600})
    }
    return directory
  }
  if (existsSync(directory)) return directory
  const root = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd: source.cwd, encoding: 'utf8',signal,timeout:10000 })).stdout.trim()
  if (realpathSync(root) !== realpathSync(source.cwd)) throw new Error('Writable Git source cwd must be the repository root; use workspace.mode=directory for non-Git tasks')
  await exec('git', ['worktree', 'add', '-b', 'superagent/' + basename(directory), directory, head], { cwd: root,signal,timeout:60000 })
  return directory
}

export async function prepareGoalWorkspace(config:Config,source:SourceConfig,ticketId:string,workspace:GoalWorkspace,mode:GoalWorkspaceMode,signal:AbortSignal){
  const existing=workspace.source?retainedWorkspace(config.stateDir,workspace.id):undefined
  if(mode!=='worktree')return existing??prepareWorkspace(config,source,ticketId,signal,workspace.id)
  const shared=managedWorkspacePath(config.stateDir,workspace.id)
  let head='HEAD'
  // Resolve a registered checkout through the configured repository. Git never
  // loads config or hooks from an arbitrary Worker-created repository.
  if(existsSync(shared)){
    const root=realpathSync(retainedWorkspace(config.stateDir,workspace.id))
    const {stdout}=await exec('git',['worktree','list','--porcelain','-z'],{cwd:source.cwd,signal,timeout:10000})
    const checkout=stdout.split('\x00\x00').map(record=>record.split('\x00')).find(record=>record[0]==='worktree '+root)
    const commit=checkout?.find(field=>/^HEAD [a-f\d]{40}(?:[a-f\d]{24})?$/.test(field))
    if(!commit)throw Error('Parallel edits require a workspace checked out from the configured Git repository')
    head=commit.slice(5)
  }
  return prepareWorkspace(config,{...source,workspace:{mode:'git-worktree'}},ticketId,signal,ticketId,head)
}
