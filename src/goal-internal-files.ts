import {createHash,randomUUID} from 'node:crypto'
import {closeSync,constants,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs'
import {dirname,extname,isAbsolute,join,resolve} from 'node:path'
import {stableDigest} from './sources.ts'
import {isHostPrivateFile} from './private-files.ts'
import type {Store} from './store.ts'
import type {ArtifactVersion} from './goal-artifacts.ts'

const chunkSize=1024*1024
const maxIndexBytes=4*1024*1024
const media:Record<string,string>={'.tar':'application/x-tar','.md':'text/markdown','.txt':'text/plain','.json':'application/json'}
export const maxGoalArchiveBytes=512*1024*1024
export const outputKey=(goalId:string,nodeId:string,path:string)=>stableDigest([goalId,nodeId,path])

export function installInternalFiles(store:Store){
 store.db.exec(`CREATE TABLE IF NOT EXISTS goal_output_chunks(
   artifact TEXT NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(artifact,part)) WITHOUT ROWID;
   CREATE TRIGGER IF NOT EXISTS erase_goal_output_chunks AFTER UPDATE OF body ON records
    WHEN NEW.kind='goal-artifact' AND json_extract(NEW.body,'$.mime') IS NULL
    BEGIN DELETE FROM goal_output_chunks WHERE artifact=NEW.id; END;
   CREATE TRIGGER IF NOT EXISTS delete_goal_output_chunks AFTER DELETE ON records WHEN OLD.kind='goal-artifact'
    BEGIN DELETE FROM goal_output_chunks WHERE artifact=OLD.id; END;`)
}

// Keep one descriptor from the boundary check through the final identity check.
// Large private archives never enter a model message or a single SQLite value.
function readOutput(cwd:string,path:string,consume?:(chunk:Buffer,part:number)=>void){
 const mime=media[extname(path).toLowerCase()]
 if(!mime||isAbsolute(path)||path.split(/[\\/]/).some(part=>!part||part==='.'||part==='..'))throw Error('Unsupported internal goal output path')
 const file=join(realpathSync(cwd),path)
 if(realpathSync(file)!==file||isHostPrivateFile(file))throw Error('Internal output must be a regular workspace file')
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
 try{
  const before=fstatSync(fd),archive=mime==='application/x-tar'
  if(!before.isFile()||before.nlink!==1||before.size>(archive?maxGoalArchiveBytes:maxIndexBytes))throw Error('Internal goal output exceeds its file or size limits')
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(chunkSize),text:Buffer[]=[]
  let offset=0,part=0
  while(offset<before.size){
   const n=readSync(fd,buffer,0,Math.min(buffer.length,before.size-offset),offset)
   if(!n)throw Error('Internal goal output changed during capture')
   const chunk=buffer.subarray(0,n)
   hash.update(chunk);consume?.(chunk,part++)
   if(!archive)text.push(Buffer.from(chunk))
   offset+=n
  }
  const after=fstatSync(fd),live=lstatSync(file)
  if(before.size!==after.size||before.ctimeMs!==after.ctimeMs||before.mtimeMs!==after.mtimeMs||after.nlink!==1||
     live.ino!==after.ino||live.dev!==after.dev||realpathSync(file)!==file)throw Error('Internal goal output changed during capture')
  return {sha256:hash.digest('hex'),size:offset,mime,content:archive?undefined:Buffer.concat(text).toString('utf8')}
 }finally{closeSync(fd)}
}

export function captureInternalFile(store:Store,goalId:string,nodeId:string,ticketId:string,cwd:string,path:string,canRetain:(artifact:ArtifactVersion)=>boolean){
 const source=readOutput(cwd,path),key=outputKey(goalId,nodeId,path)
 const id=stableDigest(['private-goal-output',key,source.sha256])
 return store.atomic(()=>{
  let artifact=store.get<ArtifactVersion>('goal-artifact',id)
  if(!artifact?.internal){
   const retained=store.db.prepare("SELECT coalesce(sum(json_extract(body,'$.size')),0) AS bytes FROM records WHERE kind='goal-artifact' AND json_extract(body,'$.goalId')=? AND json_extract(body,'$.internal')=1").get(goalId)!
   if(Number(retained.bytes)+source.size>2*maxGoalArchiveBytes)throw Error('This goal has reached its internal output storage limit (1 GiB)')
   const count=store.db.prepare("SELECT count(*) AS n FROM records WHERE kind='goal-artifact' AND json_extract(body,'$.goalId')=? AND json_extract(body,'$.nodeId')=? AND json_extract(body,'$.path')=?").get(goalId,nodeId,path)!
   artifact={id,goalId,nodeId,ticketId,path,version:Number(count.n)+1,sha256:source.sha256,size:source.size,mime:source.mime,internal:true}
   if(!canRetain(artifact))throw Error('History for this goal output was deleted')
   store.requireWorkflowSchema()
   const put=store.db.prepare('INSERT INTO goal_output_chunks(artifact,part,bytes) VALUES(?,?,?)')
   const copied=readOutput(cwd,path,(chunk,part)=>{put.run(id,part,chunk)})
   if(copied.sha256!==source.sha256||copied.size!==source.size)throw Error('Internal goal output changed during capture')
   store.put('goal-artifact',id,artifact)
  }
  if(!canRetain(artifact))throw Error('History for this goal output was deleted')
  store.put('goal-captured-output',key,{goalId,nodeId,ticketId,path,artifactId:id})
  return artifact
 })
}

export function internalEvidence(store:Store,goalId:string,nodeId:string,ticketId:string,cwd:string,path:string){
 const pointer=store.get<{artifactId:string}>('goal-captured-output',outputKey(goalId,nodeId,path))
 if(!pointer?.artifactId)return
 const artifact=store.get<ArtifactVersion>('goal-artifact',pointer.artifactId)
 if(!artifact?.internal||artifact.goalId!==goalId||artifact.nodeId!==nodeId||artifact.ticketId!==ticketId||artifact.path!==path)throw Error('Captured internal output is unavailable')
 const current=readOutput(cwd,path)
 if(current.sha256!==artifact.sha256||current.size!==artifact.size)throw Error('Capture the changed internal goal output again before verification')
 return {artifact,content:current.content??JSON.stringify({kind:'binary_artifact',artifact,observation:'File identity only. The archive contents have not been inspected.'})}
}

export function materializeInternalFile(store:Store,artifact:ArtifactVersion,destination:string){
 const directory=dirname(destination)
 mkdirSync(directory,{recursive:true,mode:0o700})
 if(realpathSync(directory)!==resolve(directory))throw Error('Internal output destination is unavailable')
 const temporary=destination+'.'+randomUUID()+'.tmp'
 try{
  const fd=openSync(temporary,'wx',0o400)
  try{
   const hash=createHash('sha256');let size=0,part=0
   for(const row of store.db.prepare('SELECT part,bytes FROM goal_output_chunks WHERE artifact=? ORDER BY part').iterate(artifact.id)){
    const chunk=row.bytes as Uint8Array
    if(row.part!==part++||chunk.length>chunkSize||size+chunk.length>artifact.size)throw Error('Internal output chunks are inconsistent')
    hash.update(chunk);writeFileSync(fd,chunk);size+=chunk.length
   }
   if(size!==artifact.size||hash.digest('hex')!==artifact.sha256)throw Error('Internal output bytes are unavailable')
   fsyncSync(fd)
  }finally{closeSync(fd)}
  renameSync(temporary,destination)
 }finally{rmSync(temporary,{force:true})}
}
