import {toolParallelism} from './execution-limits.ts'

// These host tools only read scoped resources. Unclassified tools take the
// exclusive path, including externally advertised MCP tools and browser input.
const independentReads = new Set([
  'router_read', 'router_skill', 'superagent_read', 'superagent_tools', 'superagent_knowledge',
  'orchestrator_eval_read', 'orchestrator_followup_read', 'backend_recall', 'github_read',
])

export function isParallelRead(name: string): boolean {
  return independentReads.has(name)
}

/** FIFO admission with a barrier for exclusive calls. */
export class ToolDispatch {
  private active = 0
  private exclusive = false
  private readonly waiting: { shared: boolean; start: () => void }[] = []

  run<T>(shared: boolean, work: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({shared, start: async () => {
        await Promise.resolve()
        try{resolve(await work())}catch(error){reject(error)}finally{
          this.active--
          this.exclusive = false
          this.admit()
        }
      }})
      this.admit()
    })
  }

  private admit() {
    while (!this.exclusive && this.active < toolParallelism) {
      const next = this.waiting[0]
      if (!next || !next.shared && this.active > 0) return
      this.waiting.shift()
      this.active++
      this.exclusive = !next.shared
      next.start()
    }
  }
}
