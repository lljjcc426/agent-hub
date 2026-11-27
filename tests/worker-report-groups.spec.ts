import {expect,it} from 'vitest'
import type {ChatMessage} from '../src/chat.ts'
import {reportsForTranscript} from '../web/chat/worker-report-groups.ts'

function receipt(id:string,worker:string,paths:string[],runId='r'):ChatMessage{
  return {id,conversationId:'c',runId,sequence:1,createdAt:1,role:'assistant',text:'',workerPatchReceipt:true,
    speaker:{id:worker,kind:'worker',label:worker},fileChanges:paths.map(path=>({path,id:id+path,hunks:[]}))}
}

it('keeps the first receipt as anchor and retains both revisions of the same path',()=>{
  const messages=[receipt('1','dev',['a.ts']),receipt('2','dev',['a.ts','b.ts'])]
  const {byMessage,groups}=reportsForTranscript(messages,messages)
  expect([...byMessage.keys()]).toEqual(['1'])
  expect(groups[0]?.files.map(f=>[f.path,f.versions.map(v=>v.id)])).toEqual([['a.ts',['1a.ts','2a.ts']],['b.ts',['2b.ts']]])
})
it('respects worker and turn boundaries even when another worker is hidden',()=>{
  const messages=[receipt('1','dev',['a']),receipt('2','test',['b']),receipt('3','dev',['a']),receipt('4','dev',['b'],'new')]
  expect(reportsForTranscript(messages,messages.filter(m=>m.speaker?.id==='dev')).groups.map(g=>g.messageId)).toEqual(['1','3','4'])
})
it('projects legacy sources on router messages once and keeps unpublished sources out',()=>{
  const a=receipt('1','dev',['a']),b=receipt('2','dev',['b']),c=receipt('3','test',['unpublished'])
  const router:ChatMessage={...a,id:'result',fileChanges:undefined,workerPatchReceipt:undefined,speaker:{kind:'router',id:'router',label:'Router'},fileChangeSources:['1','2','1']}
  const later={...router,id:'later',fileChangeSources:['2']}
  const {byMessage,groups}=reportsForTranscript([a,b,c,router,later],[router,later])
  expect([...byMessage.keys()]).toEqual(['result'])
  expect(groups.map(g=>g.files.map(f=>f.path))).toEqual([['a','b']])
})
