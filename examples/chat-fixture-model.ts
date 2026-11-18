import {randomUUID} from 'node:crypto'
import type {Model} from '../src/model.ts'
import {firstReplySchema} from '../src/chat-status.ts'

/** Give stateless browser fixtures the same two-turn conversation as a real model. */
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
    return model.run(request)
  }}
}
