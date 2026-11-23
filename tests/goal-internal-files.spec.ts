import {createHash} from 'node:crypto'
import {linkSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,symlinkSync,truncateSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it} from 'vitest'
import {Store} from '../src/store.ts'
import {captureInternalFile,installInternalFiles,internalEvidence,materializeInternalFile,maxGoalArchiveBytes} from '../src/goal-internal-files.ts'

const cleanup:(()=>void)[]=[]
afterEach(()=>{for(const close of cleanup.splice(0))close()})
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'goal-private-files-'))),cwd=join(root,'input'),s=new Store(join(root,'state.sqlite'))
 mkdirSync(cwd);installInternalFiles(s)
 cleanup.push(()=>{s.close();rmSync(root,{recursive:true,force:true})})
 return {s,root,cwd,capture:(path:string)=>captureInternalFile(s,'goal','step','ticket',cwd,path,()=>true),
  evidence:(path:string)=>internalEvidence(s,'goal','step','ticket',cwd,path)}
}
it('retains a private archive by chunks, verifies each version and removes bytes with its history',()=>{
 const f=fixture(),path='inputs.tar',file=join(f.cwd,path),out=join(f.root,'assets','input.tar')
 const original=Buffer.alloc(3*1024*1024+13,0xc3);writeFileSync(file,original)
 const first=f.capture(path),copy=f.capture(path)
 expect(first).toEqual(copy)
 expect(first).toMatchObject({internal:true,version:1,size:original.length,sha256:createHash('sha256').update(original).digest('hex')})
 expect(f.evidence(path)?.content.length).toBeLessThan(1000)
 expect(f.s.db.prepare('SELECT count(*) n FROM goal_output_chunks WHERE artifact=?').get(first.id)?.n).toBe(4)
 materializeInternalFile(f.s,first,out)
 expect(readFileSync(out).equals(original)).toBe(true);expect(statSync(out).mode&0o777).toBe(0o400)
 writeFileSync(file,'replacement')
 expect(()=>f.evidence(path)).toThrow('changed')
 const second=f.capture(path)
 expect(second.version).toBe(2);expect(f.evidence(path)?.artifact.id).toBe(second.id)
 f.s.db.prepare('DELETE FROM goal_output_chunks WHERE artifact=? AND part=1').run(first.id)
 expect(()=>materializeInternalFile(f.s,first,out)).toThrow()
 expect(readFileSync(out).equals(original)).toBe(true)
 f.s.put('goal-artifact',second.id,{deleted:true})
 expect(f.s.db.prepare('SELECT count(*) n FROM goal_output_chunks WHERE artifact=?').get(second.id)?.n).toBe(0)
 expect(()=>f.evidence(path)).toThrow('unavailable')
})
it('retains readable text evidence and rejects escaping paths, links and oversized files',()=>{
 const f=fixture(),file=join(f.cwd,'index.md')
 writeFileSync(file,'可核对的输入清单');f.capture('index.md')
 expect(f.evidence('index.md')?.content).toBe('可核对的输入清单')
 expect(f.evidence('unseen.md')).toBeUndefined()
 symlinkSync(file,join(f.cwd,'linked.md'))
 expect(()=>f.capture('linked.md')).toThrow()
 linkSync(file,join(f.cwd,'hard.md'))
 expect(()=>f.capture('hard.md')).toThrow()
 expect(()=>f.capture('../private.md')).toThrow()
 const big=join(f.cwd,'big.tar');writeFileSync(big,'');truncateSync(big,maxGoalArchiveBytes+1)
 expect(()=>f.capture('big.tar')).toThrow('limits')
 const rows=f.s.list<any>('goal-artifact')
 expect(rows).toHaveLength(1)
 const out=join(f.root,'unmatched.txt')
 materializeInternalFile(f.s,rows[0],out)
 expect(readFileSync(out,'utf8')).toBe('可核对的输入清单')
})

it('keeps the previous version when a new capture would exceed the per-goal storage limit',()=>{
 const f=fixture(),file=join(f.cwd,'index.txt')
 writeFileSync(file,'first');const first=f.capture('index.txt')
 f.s.put('goal-artifact','existing',{goalId:'goal',nodeId:'other',path:'other.tar',size:2*maxGoalArchiveBytes-5,internal:true})
 expect(f.capture('index.txt')).toEqual(first)
 writeFileSync(file,'second')
 expect(()=>f.capture('index.txt')).toThrow('storage limit')
 expect(f.s.db.prepare('SELECT count(*) n FROM goal_output_chunks').get()?.n).toBe(1)
})
