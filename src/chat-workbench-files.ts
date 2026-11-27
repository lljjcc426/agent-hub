import {constants} from 'node:fs'
import {lstat,open,opendir,realpath} from 'node:fs/promises'
import {isAbsolute,join,relative,sep} from 'node:path'
import {ChatError} from './chat-errors.ts'
import {validRetainedPath} from './chat-file-handoff.ts'
import {isHostPrivateFile,hostPrivateFiles} from './private-files.ts'

const maxEntries=5000, maxTextBytes=512*1024
export const unavailableFile=()=>new ChatError('workbench_file_missing','This workspace file is unavailable.',404)
export const withinWorkspace=(root:string,path:string)=>{
  const rel=relative(root,path)
  return rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)
}
const projectDotfiles=new Set(['.github','.gitignore','.gitattributes','.editorconfig','.dockerignore'])
function visible(path:string){
  return validRetainedPath(path)&&path.split('/').every(part=>part!=='node_modules'&&(!part.startsWith('.')||projectDotfiles.has(part)))
}

/** Index names only. A file is opened and checked separately when the reader or terminal selects it. */
export async function listWorkbenchFiles(root:string){
  const files:{path:string}[]=[],directories=[''],privateFiles=new Set(hostPrivateFiles())
  let visited=0
  for(let i=0;i<directories.length;i++){
    const dir=directories[i]!,absolute=join(root,dir)
    if(await realpath(absolute).catch(()=>undefined)!==absolute)continue
    const entries=await opendir(absolute).catch(()=>undefined)
    if(!entries)continue
    for await(const entry of entries){
      const path=dir?dir+'/'+entry.name:entry.name
      if(!visible(path)||privateFiles.has(join(root,path)))continue
      if(++visited>maxEntries)return {files,truncated:true}
      if(entry.isDirectory())directories.push(path)
      else if(entry.isFile())files.push({path})
    }
  }
  return {files,truncated:false}
}

export async function openWorkbenchFile(root:string,relativePath:string){
  if(!visible(relativePath))throw unavailableFile()
  const path=join(root,relativePath)
  if(isHostPrivateFile(path)||await realpath(path).catch(()=>undefined)!==path)throw unavailableFile()
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(()=>{throw unavailableFile()})
  try{
    const before=await handle.stat({bigint:true})
    const verify=async()=>{
      const live=await lstat(path,{bigint:true}).catch(()=>undefined)
      if(!live?.isFile()||live.nlink!==1n||live.dev!==before.dev||live.ino!==before.ino||
        live.ctimeNs!==before.ctimeNs||await realpath(path).catch(()=>undefined)!==path)throw unavailableFile()
    }
    await verify()
    return {path,handle,verify,size:Number(before.size)}
  }catch(error){await handle.close();throw error}
}

export async function readWorkbenchFile(file:Awaited<ReturnType<typeof openWorkbenchFile>>){
  try{
    const bytes=Buffer.alloc(Math.min(file.size,maxTextBytes)),truncated=file.size>bytes.length
    let offset=0
    while(offset<bytes.length){
      const {bytesRead}=await file.handle.read(bytes,offset,bytes.length-offset,offset)
      if(!bytesRead)throw unavailableFile()
      offset+=bytesRead
    }
    await file.verify()
    if(!bytes.includes(0)){
      try{return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes,{stream:truncated}),truncated}}
      catch{/* A non-UTF-8 file is still available in the native file manager. */}
    }
    return {binary:true}
  }finally{await file.handle.close()}
}
