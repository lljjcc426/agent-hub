import {Ajv} from 'ajv'
import {z} from 'zod'
import {fitResourcePage,protocolBytes,textPage} from './context-budget.ts'
import type {ModelRequest,ToolSpec} from './model.ts'
import {toolDescriptionName} from './tool-dispatch.ts'

const descriptionInput=z.object({name:z.string().min(1).max(128),offset:z.number().int().nonnegative().optional()}).strict()
const describeTool:ToolSpec={type:'function',name:toolDescriptionName,
 description:'Read one available Roppo tool’s full instructions and argument schema by name. If paginated, read the nextOffset with this tool until it is null.',
 inputSchema:z.toJSONSchema(descriptionInput,{target:'draft-7',io:'input'})}

// These tools start a Chat turn or read a retained receipt, including after compaction.
const inlineTools=new Set(['chat_opening','router_read','superagent_read'])
const deferredInput={type:'object',properties:{},additionalProperties:true}
const instructions='\nRoppo tools show short summaries. Use tool_describe (roppo_tool_describe in OpenCode) with a tool name to get its full instructions and parameters when you need them. Then call the original tool by name with those parameters. Reuse details already known for this activation. The receipt reader and Chat opening have their parameters inline.'

function summary(description:string){
 const sentence=description.trim().split(/(?<=[.!?])\s+/u,1)[0]??''
 return sentence.length<=140?sentence:sentence.slice(0,137).replace(/\s+\S*$/u,'')+'…'
}

const textResult=(text:string,success=true)=>({success,contentItems:[{type:'inputText' as const,text}]})

/** Keep the dispatch names and full validators on the host. Only the model-facing definitions are shortened. */
export function withProgressiveTools(request:ModelRequest):ModelRequest{
 const {tools,onTool,onActive,signal}=request
 if(!onTool||!tools?.some(tool=>!inlineTools.has(tool.name)))return request
 const available=new Map(tools.map(tool=>[tool.name,tool]))
 const resultBudget=Math.min(24*1024,request.contextBudget?.toolReserveBytes??Infinity)
 let validator:Ajv|undefined
 return {...request,instructions:request.instructions+instructions,
  tools:[...tools.map(tool=>inlineTools.has(tool.name)?tool:{...tool,description:summary(tool.description),inputSchema:deferredInput}),describeTool],
  onActive:onActive?control=>onActive({...control,...(control.refresh?{refresh:text=>control.refresh!(text+instructions)}:{})}):undefined,
  onTool:async(name,args,id)=>{
   signal?.throwIfAborted()
   if(name===toolDescriptionName){
    const parsed=descriptionInput.safeParse(args)
    if(!parsed.success)return textResult('Provide an available tool name and, for a later page, its nextOffset.',false)
    const query=parsed.data
    const spec=available.get(query.name)??available.get(query.name.replace(/^roppo_/,''))
    if(!spec)return textResult('Tool is unavailable in this activation.',false)
    const encoded=JSON.stringify({name:spec.name,description:spec.description,inputSchema:spec.inputSchema})
    const full=textResult(encoded)
    if(query.offset===undefined&&protocolBytes(full)<=resultBudget)return full
    const offset=query.offset??0
    if(offset>=encoded.length)return textResult('The offset is outside this tool definition.',false)
    return fitResourcePage(textResult(JSON.stringify({name:spec.name,...textPage(encoded,offset,encoded.length)})),resultBudget)
   }
   const spec=available.get(name)
   if(!spec)return textResult('Tool is unavailable in this activation.',false)
   if(!inlineTools.has(name)){
    validator??=new Ajv({strict:false,addUsedSchema:false})
    if(!validator.validate(spec.inputSchema,args))return textResult('Invalid tool arguments for '+name+': '+validator.errorsText()+'. Read its schema with tool_describe and correct the arguments.',false)
   }
   return onTool(name,args,id)
  },
 }
}
