import {randomUUID} from 'node:crypto'
import type {Model} from '../src/model.ts'
import {chatOpeningTool,firstReplySchema} from '../src/chat-status.ts'

/** Publish the same opening as a real model before a browser fixture uses tools. */
export function desktopChatFixture(model:Model,opening:string):Model{
  const inputs=new Map<string,string>()
  return {...model,async run(request){
    if(request.schema===firstReplySchema){
      const threadId=request.threadId??randomUUID(),turnId=randomUUID()
      request.onThread?.(threadId)
      request.onTurn?.(turnId)
      inputs.set(threadId,request.input)
      return {threadId,turnId,text:JSON.stringify({reply:'',opening})}
    }
    const original=request.threadId&&inputs.get(request.threadId)
    if(original&&JSON.parse(request.input).kind==='continue_after_opening'){
      inputs.delete(request.threadId!)
      return model.run({...request,input:original})
    }
    if(request.requiresChatOpening&&request.onTool){
      const invoke=request.onTool
      let published:ReturnType<typeof invoke>|undefined
      return model.run({...request,onTool:async(name,args,id)=>{
        if(name===chatOpeningTool.name)return published??=invoke(name,args,id)
        const result=await (published??=invoke(chatOpeningTool.name,{text:opening},randomUUID()))
        if(!result.success)throw Error('Browser fixture opening was rejected')
        return invoke(name,args,id)
      }})
    }
    return model.run(request)
  }}
}
