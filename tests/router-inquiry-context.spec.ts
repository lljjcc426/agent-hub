import {expect,it} from 'vitest'
import {inquiryHistory,statusQuestion,type InquiryTask} from '../src/router-inquiry-context.ts'

const contacts=[{id:'w1',label:'程序员1'},{id:'w2',label:'Release lead'}]
const tasks:InquiryTask[]=[{ticketId:'abcdff13',workerId:'w1',title:'Offline verification'}]
it.each([
 ['你和程序员1沟通下，看看进度',true,'w1'],['请问一下程序员1最新进度',true,'w1'],
 ['Ask Release lead for a progress update',true,'w2'],['问一下abcdff13进度',true,'w1'],
 ['What is the status of Release lead?',false,'w2'],['看看进度',false,undefined],
] as const)('recognizes a complete status question: %s',(text,contact,worker)=>{
 const q=statusQuestion(text,contacts,tasks)
 expect(q?.contact).toBe(contact);expect(q?.workerIds).toEqual(worker?[worker]:[])
})
it.each(['不用问程序员1进度','问一下程序员1进度，然后发布','Tell Release lead not to answer','Ask Release lead for a progress update and stop the job',
 '程序员1和程序员2分别进展如何','The note said “Ask Release lead for a progress update”','继续','问一下程序员10进度'])('leaves other or compound requests to the full Router: %s',text=>{
 expect(statusQuestion(text,contacts,tasks)).toBeUndefined()
})
it('keeps matching contacts distinct when labels collide',()=>{
 expect(statusQuestion('Ask Release lead for a progress update',[...contacts,{id:'w3',label:'Release lead'}],tasks)?.workerIds).toEqual(['w2','w3'])
})
it('returns an authorized archive reference for an oversized recent event without changing the journal',()=>{
 const events=[{id:'a',kind:'user',text:'older facts'},{id:'b',kind:'user',text:'中'.repeat(20000)}]
 const window=inquiryHistory(events)
 expect(window.archive).toMatchObject({resource:'journal',total:2})
 expect(window.history).toEqual([expect.objectContaining({resource:'journal/b',partial:true,id:'b'})])
 expect(events[1]!.text).toHaveLength(20000)
})
