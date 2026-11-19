import {createHash} from 'node:crypto'
import {openSync,closeSync,readFileSync,fstatSync,realpathSync,constants} from 'node:fs'
import {basename} from 'node:path'
import type {Capability,CapabilityTool} from './capability-types.ts'

export const identifier=(...parts:string[])=>createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0,28)
export type Entry=Capability & {content?:()=>string|undefined;skillFile?:string;skillProjects?:readonly string[]}
export const strings=(value:unknown):string[]=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'):[]
export const object=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{}
export function toolInfo(tool:{name:string;description?:string;inputSchema?:unknown}):CapabilityTool {
  const schema=object(tool.inputSchema)
  return {name:tool.name,description:tool.description,inputs:tool.inputSchema?Object.entries(object(schema.properties)).map(([name,p])=>({name,type:typeof p?.type==='string'?p.type:undefined,required:strings(schema.required).includes(name)})):undefined}
}
// Only display actual skill documents. Never follow a skill-file link to a credential or special file.
export function skillText(path:string){
  try{
    const real=realpathSync(path)
    if(basename(real)!=='SKILL.md')return undefined
    const fd=openSync(real,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
    try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>2_000_000)return undefined;return readFileSync(fd,'utf8')}
    finally{closeSync(fd)}
  }catch{return undefined}
}
