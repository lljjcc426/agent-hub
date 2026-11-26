import {toolParallelism} from './execution-limits.ts'
import type {ToolResult} from './chat-permissions.ts'

export class ToolResourceUnavailable extends Error {}

export function failedRead(tool:string,error:unknown):ToolResult {
  const unavailable=error instanceof ToolResourceUnavailable
  return {success:false,contentItems:[{type:'inputText',text:JSON.stringify({
    status:unavailable?'resource_unavailable':'read_failed',tool,
    message:unavailable?'This receipt is unavailable. Use an exact resource reference returned by the host.':'The read returned no result. Check its arguments or continue with another authorized source.',
  })}]}
}

// These host tools only read scoped resources. Unclassified tools take the
// exclusive path, including externally advertised MCP tools and browser input.
const independentReads = new Set([
  'router_read', 'router_skill', 'superagent_read', 'superagent_tools', 'superagent_knowledge',
  'goal_evidence', 'review_file', 'review_directory', 'review_revision', 'orchestrator_eval_read', 'orchestrator_followup_read', 'backend_recall', 'github_read', 'chat_artifact_find',
])

export function isParallelRead(name: string): boolean {
  return independentReads.has(name)
}

/** FIFO admission with a barrier for exclusive calls. */
export class ToolDispatch {
  private active = 0
  private exclusive = false
  private readonly waiting: { shared: boolean; start: () => void; reject:(reason:unknown)=>void }[] = []
  private readonly abortQueued=()=>{
    for(const entry of this.waiting.splice(0))entry.reject(this.signal?.reason)
  }
  constructor(private readonly signal?:AbortSignal,private readonly concurrency=toolParallelism){}

  run<T>(shared: boolean, work: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.signal?.throwIfAborted()
      this.waiting.push({shared,reject,start: async () => {
        await Promise.resolve()
        try{this.signal?.throwIfAborted();resolve(await work())}catch(error){reject(error)}finally{
          this.active--
          this.exclusive = false
          this.admit()
        }
      }})
      this.signal?.addEventListener('abort',this.abortQueued,{once:true})
      this.admit()
    })
  }

  private admit() {
    while (!this.exclusive && this.active < this.concurrency) {
      const next = this.waiting[0]
      if (!next || !next.shared && this.active > 0) break
      this.waiting.shift()
      this.active++
      this.exclusive = !next.shared
      next.start()
    }
    if(!this.waiting.length)this.signal?.removeEventListener('abort',this.abortQueued)
  }
}
