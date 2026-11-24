import {it,expect} from 'vitest'
import {evidenceAccess,inlineEvidenceBudget,type GoalEvidence} from '../src/goal-evidence.ts'
import {protocolBytes} from '../src/context-budget.ts'
import {restoreInlineExecution} from '../src/execution-output.ts'
const evidence=(id:string,content:string):GoalEvidence=>({id,content,hash:'immutable-hash',kind:'file',ticketId:'owned',key:'file.txt',criterionIds:['criterion']})
it('delivers complete originals within the byte budget and only acknowledges them after a validated return',()=>{
 const originals=[evidence('a','完整原件 👩‍💻\nquotes " and \\'),evidence('b','x'.repeat(10000)),evidence('c','small')]
 const access=evidenceAccess(originals,1024,()=>{},500)
 expect(access.inlineEvidence).toEqual([{id:'a',content:originals[0]!.content},{id:'c',content:'small'}])
 expect(protocolBytes(access.inlineEvidence)).toBeLessThanOrEqual(500)
 expect(access.read.size).toBe(0)
 const input=JSON.parse(access.input({kind:'verification',evidence:originals.map(({content,...meta})=>meta)}))
 expect(input.inlineEvidence[0].content).toBe(originals[0]!.content)
 access.confirmInline();expect([...access.read]).toEqual(['a','c']);expect(access.read.has('b')).toBe(false)
})
it('keeps full-page fallback, gap checks and original metadata unchanged',async()=>{
 const original=evidence('large','资料 🧪 '.repeat(2000)),a=evidenceAccess([original],800,()=>{},32)
 expect(a.inlineEvidence).toEqual([]);let offset:number|null=0,content=''
 do{const result=await a.onTool('goal_evidence',{id:original.id,offset},'call');expect(protocolBytes(result)).toBeLessThanOrEqual(800);const page=JSON.parse(result.contentItems[0]!.text!);content+=page.content;offset=page.nextOffset;if(offset!==null){expect(a.read.has(original.id)).toBe(false);await expect(a.onTool('goal_evidence',{id:original.id,offset:page.totalCharacters},'skip')).rejects.toThrow('without gaps')}}while(offset!==null)
 expect(content).toBe(original.content);expect(a.read.has(original.id)).toBe(true)
})
it('does not acknowledge inline evidence after authority or snapshot invalidation',()=>{
 const a=evidenceAccess([evidence('a','original')],4096,()=>{throw Error('Authority changed')},1024)
 expect(()=>a.confirmInline()).toThrow('Authority changed');expect(a.read.size).toBe(0)
})
it('pages and searches the scoped GitHub catalog without treating its index as evidence',async()=>{
 const originals:GoalEvidence[]=Array.from({length:70},(_,i)=>({
  ...evidence('e'+i,''),kind:'provider',key:'github_read owner/repo '+(i===65?'unique-job':'checks')+' '+i,
  provider:{kind:'model-tool-receipt',id:'receipt'+i,digest:'d',contextId:'ctx',activity:'worker',at:1,repository:'owner/repo',success:true},
 }))
 const access=evidenceAccess(originals,1200,()=>{},50000,e=>JSON.stringify({result:e.id}))
 const catalog=async(offset:number,query?:string)=>{
  const response=await access.onTool('goal_evidence',{id:'github-receipts',offset,query},'list')
  expect(protocolBytes(response)).toBeLessThanOrEqual(1200)
  return JSON.parse(response.contentItems[0]!.text!)
 }
 const first=await catalog(0)
 expect(first.total).toBe(70);expect(first.nextOffset).toBeGreaterThan(0);expect(first.nextOffset).toBeLessThan(70)
 const second=await catalog(first.nextOffset)
 expect(second.items[0].id).toBe('e'+first.nextOffset)
 const match=await catalog(0,'UNIQUE-JOB')
 expect(match.items.map((e:GoalEvidence)=>e.id)).toEqual(['e65']);expect(match.nextOffset).toBeNull()
 access.confirmInline();expect(access.read.size).toBe(0)
 await access.onTool('goal_evidence',{id:'e65'},'read')
 expect([...access.read]).toEqual(['e65'])
})
it('keeps legacy paging when the base input leaves no bundle budget',()=>{
 expect(inlineEvidenceBudget({text:'x'.repeat(2000)},4096)).toBe(0)
 const a=evidenceAccess([evidence('a','original')],4096,()=>{})
 expect(JSON.parse(a.input({kind:'test'}))).toEqual({kind:'test'});expect(a.read.size).toBe(0)
})
it('uses the increased budget to deliver larger originals and lossless output sharing without changing snapshots',()=>{
 const text=('original output '.repeat(12)+'\n').repeat(80),content=JSON.stringify({jobs:[{id:'one',output:{text,complete:true}},{id:'two',output:{text,complete:false}}]})
 const original={...evidence('ledger',content),kind:'execution' as const},file=evidence('file','x'.repeat(80000)),before=JSON.stringify([original,file])
 const access=evidenceAccess([original,file],4096,()=>{},inlineEvidenceBudget({},10000000)),input=JSON.parse(access.input({kind:'test'}))
 expect(input.inlineEvidence).toHaveLength(2)
 expect(JSON.stringify(restoreInlineExecution(input.inlineEvidence[0].execution))).toBe(content)
 expect(input.inlineEvidence[1].content).toBe(file.content)
 expect(JSON.stringify([original,file])).toBe(before);expect(access.read.size).toBe(0)
 access.confirmInline();expect([...access.read]).toEqual(['ledger','file'])
})
