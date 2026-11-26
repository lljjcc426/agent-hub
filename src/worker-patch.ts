/** A chat page carries a short excerpt. The immutable full file patch is fetched on demand. */
export interface PatchHunk {oldStart:number;newStart:number;header?:string;lines:string[]}
export interface WorkerFilePatch {
  path:string;hunks:PatchHunk[];id?:string;added?:number;removed?:number;binary?:boolean
}
export function parseHunks(text:string):PatchHunk[] {
  const result:PatchHunk[]=[]
  let hunk:PatchHunk|undefined
  for(const line of text.split('\n')){
    const match=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if(match){
      hunk={header:line,oldStart:Number(match[1]),newStart:Number(match[2]),lines:[]}
      result.push(hunk)
    }else if(hunk&&/^[ +\\-]/.test(line))hunk.lines.push(line)
  }
  return result
}
function gitPath(value:string){
  if(!value.startsWith('"'))return value.split('\t')[0]!
  // Git quotes UTF-8 bytes as octal, in addition to the usual C escapes.
  const bytes:number[]=[]
  const escapes:Record<string,number>={t:9,n:10,r:13,b:8,f:12,a:7,v:11,'\\':92,'"':34}
  for(const match of value.slice(1).matchAll(/\\([0-7]{1,3}|.)|("|[^\\"]+)/gu)){
    if(match[2]==='"')break
    if(match[1])bytes.push(/^[0-7]/.test(match[1])?parseInt(match[1],8):escapes[match[1]]??match[1].charCodeAt(0))
    else bytes.push(...new TextEncoder().encode(match[2]!))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}
function stripSide(path:string){return path.replace(/^[ab]\//,'')}
export function splitWorkerPatch(text:string){
  const offsets=Array.from(text.matchAll(/^diff --git /gm),match=>match.index!)
  return offsets.flatMap((offset,index)=>{
    const raw=text.slice(offset,offsets[index+1]??text.length)
    const header=raw.split(/^@@ /m,1)[0]!
    const to=/^\+\+\+ (.*)$/m.exec(header)?.[1],from=/^--- (.*)$/m.exec(header)?.[1]
    const renamed=/^rename to (.*)$/m.exec(header)?.[1]
    let path=renamed?gitPath(renamed):to&&to!=='/dev/null'?stripSide(gitPath(to)):from&&from!=='/dev/null'?stripSide(gitPath(from)):''
    // Empty files, mode changes and binary patches have only a diff --git header.
    if(!path){
      const line=header.split('\n',1)[0]!.slice(11)
      if(line.startsWith('"')) {
        const fields=/^("(?:\\.|[^"\\])*"|\S+) ("(?:\\.|[^"\\])*"|.+)$/.exec(line)
        if(fields)path=stripSide(gitPath(fields[2]!))
      }else {
        for(let index=line.indexOf(' b/');index>=0;index=line.indexOf(' b/',index+1)){
          const oldPath=stripSide(line.slice(0,index)),newPath=stripSide(line.slice(index+1))
          if(oldPath===newPath){path=newPath;break}
        }
      }
    }
    if(!path)return []
    const binary=/^(?:Binary files |GIT binary patch)/m.test(header)
    let added=0,removed=0,inHunk=false,first=true
    let preview:PatchHunk|undefined
    for(const match of raw.matchAll(/[^\n]+/g)){
      const line=match[0]
      if(line.startsWith('@@ ')){
        inHunk=true
        if(preview)first=false
        else preview=parseHunks(line)[0]
        continue
      }
      if(!inHunk)continue
      if(line[0]==='+')added++
      else if(line[0]==='-')removed++
      if(first&&preview&&preview.lines.length<7)preview.lines.push(line.slice(0,420))
    }
    const file:WorkerFilePatch={path,added,removed,binary,hunks:preview?[preview]:[]}
    return [{file,raw}]
  })
}
