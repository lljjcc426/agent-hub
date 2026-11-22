import type {ToolResult} from './chat-permissions.ts'

const replyGraceMs=6000
const queuedInputGraceMs=250

/** After a durable Chat handoff, allow a short final reply and drain any admitted host tool. */
export class RouterHandoff {
  private readonly closeModel=new AbortController()
  private readonly workers=new Set<string>()
  private grace?:ReturnType<typeof setTimeout>
  private deadline=Infinity
  private stop?:ReturnType<typeof setImmediate>
  private tools=0
  private closing=false
  private assigned=false
  readonly signal:AbortSignal

  constructor(private readonly turnSignal:AbortSignal,private readonly chinese:boolean){
    this.signal=AbortSignal.any([turnSignal,this.closeModel.signal])
  }

  record(worker:string,assigned:boolean){
    this.workers.add(worker)
    this.assigned ||= assigned
    this.closeIn(replyGraceMs)
  }

  prioritizeInput(){
    this.closeIn(queuedInputGraceMs)
  }

  private closeIn(ms:number){
    const deadline=performance.now()+ms
    if(this.closing||this.deadline<=deadline)return
    this.deadline=deadline
    clearTimeout(this.grace)
    this.grace=setTimeout(()=>{
      this.closing=true
      this.stopWhenIdle()
    },ms).unref()
  }

  async tool(invoke:()=>Promise<ToolResult>):Promise<ToolResult>{
    if(this.closing)return {success:false,contentItems:[{type:'inputText',text:'The handoff was recorded. This Router turn is ending.'}]}
    this.tools++
    try{return await invoke()}
    finally{this.tools--;this.stopWhenIdle()}
  }

  private stopWhenIdle(){
    // Let the backend persist the tool receipt before stopping the model writer.
    if(this.closing&&!this.tools)this.stop??=setImmediate(()=>this.closeModel.abort(Error('Router handoff complete')))
  }

  get yielded(){return this.closeModel.signal.aborted&&!this.turnSignal.aborted}

  reply(){
    const names=[...this.workers].join(this.chinese?'、':', ')
    if(this.chinese)return this.assigned?`已交给 ${names} 处理。`:`已把补充发给 ${names}。`
    return this.assigned?`I assigned this to ${names}.`:`I sent your follow-up to ${names}.`
  }

  dispose(){
    clearTimeout(this.grace)
    clearImmediate(this.stop)
  }
}
