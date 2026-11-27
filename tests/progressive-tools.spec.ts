import {expect,it,vi} from 'vitest'
import {withProgressiveTools} from '../src/progressive-tools.ts'
import {protocolBytes,scopeBudget} from '../src/context-budget.ts'
import {chatOpeningTool} from '../src/chat-status.ts'
import type {ModelRequest,ToolSpec} from '../src/model.ts'

const workTool:ToolSpec={type:'function',name:'test_work',description:'Update the record. Keep the original revision.',
 inputSchema:{type:'object',required:['revision'],additionalProperties:false,properties:{revision:{type:'integer',minimum:1}}}}
const request:ModelRequest={cwd:'.',instructions:'Work on the current record.',input:'Change the current record.',schema:{type:'object'}}

it('shows only a summary until lookup and validates the full contract before dispatch',async()=>{
 const invoke=vi.fn(async()=>({success:true,contentItems:[]}))
 const model=withProgressiveTools({...request,tools:[workTool,chatOpeningTool],onTool:invoke})
 expect(model.tools?.find(tool=>tool.name===workTool.name)).toMatchObject({name:'test_work',description:'Update the record.',inputSchema:{properties:{}}})
 expect(JSON.stringify(model.tools)).not.toContain('revision')
 expect(model.tools).toContain(chatOpeningTool)
 const lookup=await model.onTool!('tool_describe',{name:'roppo_test_work'},'lookup')
 expect(JSON.parse(lookup.contentItems[0]!.text!)).toEqual({name:workTool.name,description:workTool.description,inputSchema:workTool.inputSchema})
 expect((await model.onTool!('tool_describe',{name:'unavailable'},'unknown')).success).toBe(false)
 expect((await model.onTool!('unavailable',{},'unknown-call')).success).toBe(false)
 expect((await model.onTool!('test_work',{revision:0},'bad')).success).toBe(false)
 expect(invoke).not.toHaveBeenCalled()
 expect((await model.onTool!('test_work',{revision:2},'valid')).success).toBe(true)
 expect(invoke).toHaveBeenCalledExactlyOnceWith('test_work',{revision:2},'valid')
 const toolFree={...request,tools:[],onTool:invoke}
 expect(withProgressiveTools(toolFree)).toBe(toolFree)
})

it('pages exact definitions within the inline result budget',async()=>{
 const spec={...workTool,description:'Update the record. '+'Exact 🐈 details. '.repeat(140)}
 const contextBudget=scopeBudget(4096)
 const model=withProgressiveTools({...request,contextBudget,tools:[spec],onTool:vi.fn()})
 let content='',offset:number|null=0
 for(let i=0;offset!==null&&i<30;i++){
  const result=await model.onTool!('tool_describe',{name:spec.name,offset},'page-'+i)
  expect(result.success).toBe(true)
  expect(protocolBytes(result)).toBeLessThanOrEqual(contextBudget.toolReserveBytes)
  const page=JSON.parse(result.contentItems[0]!.text!)
  expect(page.offset).toBe(offset)
  if(page.nextOffset!==null)expect(page.nextOffset).toBeGreaterThan(offset)
  content+=page.text
  offset=page.nextOffset
 }
 expect(offset).toBeNull()
 expect(JSON.parse(content)).toEqual({name:spec.name,description:spec.description,inputSchema:spec.inputSchema})
})
