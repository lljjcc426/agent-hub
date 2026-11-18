import {modelToolCalls} from '../../src/execution-limits.ts'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {existsSync,readFileSync,mkdtempSync} from 'node:fs'
import {privateFile} from '../cli-shared/files.ts'
import type {ModelRequest} from '../backend-sdk.ts'

export function workspaceTools(mode:ModelRequest['harnessWorkspace']):string[]{
 return mode?['read','glob','grep',...(mode==='edit'?['edit']:[])]:[]
}

/** OpenCode runs in a private project. Its own builtins resolve paths against the task,
 * without loading plugins, settings, instructions or custom tools from that task. */
export function workspaceGuard(root:string,request:ModelRequest,turnId:string){
 const directory=mkdtempSync(join(tmpdir(),'roppo-workspace-')),script=join(directory,'index.mjs'),ready=join(root,turnId+'.ready'),journal=join(root,turnId+'.operations')
 const policy={cwd:request.cwd,hidden:request.harnessPrivateFiles??[],tools:workspaceTools(request.harnessWorkspace),
  limit:request.options?.maxToolCalls??modelToolCalls.default,ready,journal}
 const source=`import fs from 'node:fs'
import path from 'node:path'
const policy = `+JSON.stringify(policy)+`
const root = policy.cwd
const inside = (parent, child) => {
 const relative = path.relative(parent, child)
 return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
const hidden = policy.hidden.filter(p=>inside(root,p))
// The pinned ripgrep excludes .git directories and does not follow links.
// Content searches must also avoid hard links and private OpenCode settings.
async function checkSearchTree(directory, content) {
 const pending = [directory]
 let entries = 0
 while (pending.length) {
  const parent = pending.pop()
  for await (const entry of await fs.promises.opendir(parent)) {
   if (++entries > 50000) throw Error('Search a smaller task directory (at most 50000 entries)')
   const name = path.join(parent,entry.name)
   if (entry.name === '.git' && entry.isDirectory()) continue
   if (entry.name === '.opencode') throw Error('Search a task directory without OpenCode configuration')
   if (entry.isDirectory()) pending.push(name)
   else if (content && entry.isFile() && (await fs.promises.lstat(name)).nlink !== 1) throw Error('Search a task directory without hard-linked files')
  }
 }
}
let count = 0
export default {id:'roppo-workspace',server:async function () {
 fs.writeFileSync(policy.ready, 'ready', {mode:0o600})
 return {
  'tool.execute.before': async (input,output) => {
   if (++count > policy.limit) throw Error('Task tool-call limit reached')
   if (input.tool.startsWith('roppo_')) return
   if (!policy.tools.includes(input.tool)) throw Error('Tool unavailable for this role')
   const scan = input.tool === 'grep' || input.tool === 'glob'
   const field = scan ? 'path' : 'filePath'
   const value = output.args[field] || (scan ? '.' : '')
   if (!value) throw Error('Select a workspace file')
   const target = path.resolve(root, value)
   if (!inside(root,target) || fs.realpathSync.native(target)!==target || hidden.some(p=>inside(p,target)) ||
       path.relative(root,target).split(path.sep).some(s=>s==='.git'||s==='.opencode')) throw Error('Outside the task file scope')
   const stat = fs.statSync(target)
   if (scan) {
    if (!stat.isDirectory() || hidden.some(p=>inside(target,p))) throw Error('Select a task directory without private runtime files')
    const pattern = input.tool === 'glob' ? output.args.pattern : output.args.include
    if (pattern && (path.isAbsolute(pattern) || pattern.split(path.sep).includes('..'))) throw Error('Use a pattern inside the selected directory')
    await checkSearchTree(target,input.tool === 'grep')
   } else if (!stat.isFile() || stat.nlink!==1) throw Error('Select a regular task file')
   output.args[field] = target
   fs.appendFileSync(policy.journal, JSON.stringify({id:input.callID,tool:input.tool,path:path.relative(root,target)})+'\\n',{mode:0o600})
  }
 }
}}`
 privateFile(join(directory,'package.json'),JSON.stringify({name:'roppo-workspace',type:'module',exports:{'./server':'./index.mjs'}}))
 privateFile(script,source)
 return {url:pathToFileURL(directory).href,ready:()=>existsSync(ready),operations:()=>existsSync(journal)?readFileSync(journal,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as {tool:string;path:string;id:string}):[]}
}
