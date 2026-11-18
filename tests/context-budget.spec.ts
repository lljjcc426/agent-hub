import {expect,it} from 'vitest'
import {scopeCommandSchema} from '../src/router-scope.ts'
import {fitResourcePage,textPage,protocolBytes,checkBudget,scopeBudget} from '../src/context-budget.ts'
const command=(contextBytes?:number)=>({action:'scope.put',operationId:'budget',expectedRevision:0,scope:{id:'team',tenantId:'owner',name:'Team',managers:['manager'],workerIds:[],sourceIds:['local'],backendIds:['codex'],...(contextBytes===undefined?{}:{contextBytes})}})
it('accepts larger scope budgets while preserving explicit older budgets',()=>{
 for(const bytes of [undefined,64*1024*1024,10000000,256000]){const c=scopeCommandSchema.parse(command(bytes));if(c.action!=='scope.put')throw Error('Unexpected command');expect(c.scope.contextBytes).toBe(bytes??16_000_000)}
 expect(()=>scopeCommandSchema.parse(command(64*1024*1024+1))).toThrow()
 expect(scopeBudget(10000000)).toEqual({maxBytes:10000000,outputReserveBytes:65536,toolReserveBytes:1048576})
 expect(()=>checkBudget({text:'x'.repeat(10000000)},scopeBudget(10000000),'native-protocol','before_tool',undefined,true)).toThrow('Context budget exceeded')
})

it('pages escaped and multilingual text within the real wire allowance without creating nested receipts',()=>{
 const original='ä"签😀'.repeat(1500),resource='model-tool-receipt/one'
 let assembled='',offset=0
 while(offset<original.length){
  const payload={text:original.slice(offset),offset,characters:original.length,nextOffset:null,cursor:'',resource}
  const result=fitResourcePage({success:true,contentItems:[{type:'inputText',text:JSON.stringify(payload)}]},1600)
  expect(protocolBytes(result)).toBeLessThanOrEqual(1600)
  const page=JSON.parse(result.contentItems[0]!.text!)
  expect(page.resource).toBe(resource);expect(page.text.isWellFormed()).toBe(true)
  expect(page.nextOffset??original.length).toBe(offset+page.text.length)
  expect(page.text.length).toBeGreaterThan(0)
  assembled+=page.text;offset+=page.text.length
 }
 expect(assembled).toBe(original)
})

it('keeps an emoji whole when a one-unit page starts on it',()=>{
 const first=textPage('a😀b',0,2)
 expect(first).toMatchObject({text:'a',nextOffset:1})
 expect(textPage('a😀b',first.nextOffset!,1)).toMatchObject({text:'😀',nextOffset:3})
})
