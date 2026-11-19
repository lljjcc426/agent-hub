import {modelToolCalls} from '../../src/execution-limits.ts'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {existsSync,readFileSync,mkdtempSync} from 'node:fs'
import {privateFile} from '../cli-shared/files.ts'
import type {ModelRequest} from '../backend-sdk.ts'
import {nativeTools} from './native-tools.ts'
import {webEvidenceModule} from './web-evidence.ts'
import {webFetchBatchModule} from './web-fetch-batch.ts'

/** OpenCode runs in a private project. Its own builtins resolve paths against the task,
 * without loading plugins, settings, instructions or custom tools from that task. */
export function workspaceGuard(root:string,request:ModelRequest,turnId:string){
 const directory=mkdtempSync(join(tmpdir(),'roppo-workspace-')),script=join(directory,'index.mjs'),ready=join(root,turnId+'.ready'),journal=join(root,turnId+'.operations')
 const policy={cwd:request.cwd,hidden:[...(request.harnessPrivateFiles??[]),...(request.privateState?[request.privateState]:[])],tools:nativeTools(request),
  native:!!request.opencodeNativeTools,writable:request.sandbox==='workspace-write'&&request.role==='worker',
  limit:request.options?.maxToolCalls??modelToolCalls.default,ready,journal,sessionDirectory:root,
  evidenceQuery:(request.webEvidenceQuery??request.input).slice(0,4000),
  opening:request.requiresChatOpening?join(root,turnId+'.opening'):null}
 const source=`import fs from 'node:fs'
import path from 'node:path'
import { focusWebFetch } from './web-evidence.mjs'
import { webFetchBatch } from './web-fetch-batch.mjs'
const policy = `+JSON.stringify(policy)+`
const root = policy.cwd
const inside = (parent, child) => {
 const relative = path.relative(parent, child)
 return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
const hidden = policy.hidden.filter(p=>inside(root,p))
function checkedPath(value, allowMissing = false) {
 if (typeof value !== 'string' || !value) throw Error('Select a workspace path')
 const target = path.resolve(root,value)
 if (!inside(root,target) || hidden.some(p=>inside(p,target)) ||
     path.relative(root,target).split(path.sep).some(s=>s==='.git'||s==='.opencode')) throw Error('Outside the task file scope')
 let existing = target
 while (allowMissing && existing !== root) {
  try { fs.lstatSync(existing); break }
  catch (error) {
   if (error.code !== 'ENOENT') throw error
   existing = path.dirname(existing)
  }
 }
 if (fs.realpathSync.native(existing)!==existing) throw Error('Outside the task file scope')
 const stat = fs.statSync(existing)
 if (stat.isFile() && stat.nlink!==1) throw Error('Select a regular task file')
 if (existing!==target && !stat.isDirectory()) throw Error('Select a task directory')
 return {target,stat,exists:existing===target}
}
function workspacePath(tool,args) {
 if (policy.native && ['edit','write','apply_patch'].includes(tool) && !policy.writable) throw Error('This task workspace is read-only')
 if (policy.native && tool==='apply_patch') {
  // OpenCode resolves the patch headers relative to its isolated startup project.
  // Redirect only those paths; OpenCode itself parses and applies the patch.
  args.patchText = args.patchText.replace(/^(\\*\\*\\* (Add File|Update File|Delete File|Move to): )(.+)$/gm, (_,prefix,operation,value)=>{
   const {target,stat,exists} = checkedPath(value.trim(),operation==='Add File'||operation==='Move to')
   if (exists && !stat.isFile()) throw Error('Select a regular task file')
   return prefix + target
  })
  return
 }
 if (policy.native && tool==='bash') {
  const {target,stat} = checkedPath(args.workdir||'.')
  if (!stat.isDirectory() || hidden.some(p=>inside(target,p))) throw Error('Select a task directory without private runtime files')
  return {target,field:'workdir',scan:false}
 }
 if (!['read','write','edit','glob','grep','lsp'].includes(tool)) return
 const scan = tool==='grep'||tool==='glob'
 const field = scan ? 'path' : 'filePath'
 const {target,stat,exists} = checkedPath(args[field] || (scan ? '.' : ''),tool==='write')
 if (scan || policy.native && tool==='read' && stat.isDirectory()) {
  if (!stat.isDirectory() || hidden.some(p=>inside(target,p))) throw Error('Select a task directory without private runtime files')
  const pattern = tool==='glob' ? args.pattern : args.include
  if (pattern && (path.isAbsolute(pattern) || pattern.split(path.sep).includes('..'))) throw Error('Use a pattern inside the selected directory')
  if (scan) return {target,field,scan:true}
 } else if (exists && !stat.isFile()) throw Error('Select a regular task file')
 return {target,field,scan:false}
}
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
let searchQuery = ''
export default {id:'roppo-workspace',server:async function () {
 fs.writeFileSync(policy.ready, 'ready', {mode:0o600})
 return {
  ...(policy.tools.includes('webfetch_batch') ? {
   tool:{webfetch_batch:webFetchBatch(policy.evidenceQuery,()=>searchQuery)},
  } : {}),
  'tool.definition': async (input,output) => {
   if (input.toolID==='webfetch' && policy.tools.includes('webfetch')) {
    output.description += '\\nReturns relevant passages and the source URL for one page. Use webfetch_batch for several known URLs.'
   }
  },
  'tool.execute.before': async (input,output) => {
   count += input.tool==='webfetch_batch' && Array.isArray(output.args.urls) ? Math.max(1,output.args.urls.length) : 1
   if (count > policy.limit) throw Error('Task tool-call limit reached')
   if (input.tool.startsWith('roppo_')) return
   if (!policy.tools.includes(input.tool)) throw Error('Tool unavailable for this role')
   if (policy.opening && !fs.existsSync(policy.opening)) {
    const deadline = Date.now() + 1000
    while (!fs.existsSync(policy.opening) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    if (!fs.existsSync(policy.opening)) throw Error('Call roppo_chat_opening before exercising this tool, then retry the call')
   }
   if (input.tool==='websearch') {
    output.args.numResults ??= 3
    output.args.contextMaxCharacters ??= 6000
   }
   if (input.tool==='webfetch') output.args.format = 'markdown'
   const operation = workspacePath(input.tool,output.args)
   if (operation) {
    if (operation.scan) await checkSearchTree(operation.target,input.tool==='grep')
    output.args[operation.field]=operation.target
   }
   fs.appendFileSync(policy.journal, JSON.stringify({id:input.callID,tool:input.tool,path:operation&&path.relative(root,operation.target)})+'\\n',{mode:0o600})
  },
  'tool.execute.after': async (input,output) => {
   if (input.tool==='websearch' && typeof input.args.query==='string') {
    searchQuery = (searchQuery + ' ' + input.args.query).slice(-2000)
   }
   if (input.tool==='webfetch') focusWebFetch(policy.sessionDirectory,policy.evidenceQuery,searchQuery,input.args,output)
  },
 }
}}`
 privateFile(join(directory,'package.json'),JSON.stringify({name:'roppo-workspace',type:'module',exports:{'./server':'./index.mjs'}}))
 privateFile(join(directory,'web-evidence.mjs'),webEvidenceModule)
 privateFile(join(directory,'web-fetch-batch.mjs'),webFetchBatchModule)
 privateFile(script,source)
 return {url:pathToFileURL(directory).href,ready:()=>existsSync(ready),operations:()=>existsSync(journal)?readFileSync(journal,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as {tool:string;path?:string;id:string}):[]}
}
