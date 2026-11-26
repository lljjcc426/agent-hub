import {spawnSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync,constants} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {sandboxCommand,sandboxEnvironment,type CommandSpec} from './sandbox.ts'

const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'"
/** Take both trees inside the command's filesystem policy. The command cannot access the private comparison index. */
export function beginWorkPatch(spec:CommandSpec) {
  const scratch=mkdtempSync(join(tmpdir(),'roppo-diff-'))
  const gitDir=join(scratch,'baseline.git')
  const git='git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.quotePath=false --git-dir='+quote(gitDir)+' --work-tree="$PWD"'
  function run(command:string){
    const launch=sandboxCommand({...spec,sandbox:'read-only',writablePaths:[],network:false,command,scratch})
    const result=spawnSync(launch.command,launch.args,{cwd:spec.cwd,timeout:16000,encoding:'utf8',maxBuffer:8192,
      env:{...sandboxEnvironment(scratch,launch.developerBin),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}})
    if(result.status!==0)throw Error('Workspace comparison unavailable')
    return result.stdout.trim()
  }
  const clean=()=>rmSync(scratch,{recursive:true,force:true})
  try{
    mkdirSync(join(gitDir,'info'),{recursive:true})
    writeFileSync(join(gitDir,'info','exclude'),'.git\n.superagent-prepared\nnode_modules/\n.venv/\n__pycache__/\n.DS_Store\n')
    run('git -c init.templateDir= init --bare -q '+quote(gitDir))
    const tree=()=>run(git+' add -A -- . && '+git+' write-tree')
    const before=tree()
    return {finish(destination:string){
      try{
        const after=tree()
        if(before===after)return
        const patch=join(scratch,'changes.patch')
        run(git+' diff --no-renames --no-ext-diff --no-textconv --output='+quote(patch)+' '+before+' '+after+' --')
        copyFileSync(patch,destination,constants.COPYFILE_EXCL)
      }catch{return undefined}finally{clean()}
    },discard:clean}
  }catch{clean();return undefined}
}
