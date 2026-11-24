import {AsyncLocalStorage} from 'node:async_hooks'
import type {ToolResult} from './chat-permissions.ts'

/** Issued only by the host, before this tool has been handed to a handler. */
export class WorkerToolNotDispatched extends Error {
 constructor(readonly attemptId:string,readonly dataRevision:number|null){super('Worker attempt has ended')}
}
export function undispatchedToolResult():ToolResult {
 return {success:false,contentItems:[{type:'inputText',text:'This operation was not dispatched. The host is handing the task to the current input.'}]}
}
type ChildRecorder=(name:string,args:unknown,id:string,invoke:()=>Promise<ToolResult>)=>Promise<ToolResult>
export const workerToolChildren=new AsyncLocalStorage<ChildRecorder>()
