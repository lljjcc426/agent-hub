import {toolParallelism} from './execution-limits.ts'

// These host tools only read scoped resources. Unclassified tools take the
// exclusive path, including externally advertised MCP tools and browser input.
const independentReads = new Set([
  'router_read', 'router_skill', 'superagent_read', 'superagent_tools', 'superagent_knowledge',
  'orchestrator_eval_read', 'orchestrator_followup_read', 'backend_recall', 'github_read', 'chat_artifact_find',
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
  constructor(private readonly signal?:AbortSignal){}

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
    while (!this.exclusive && this.active < toolParallelism) {
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
