import type {ExecutionContext} from './execution-activity.ts'
import type {AgentOptions} from './backend-config.ts'
export interface NativeControl {
  /** onRead acknowledges a durable source input only once it enters model history. */
  steer(text:string,onRead?:()=>void):Promise<void>
  interrupt():Promise<void>
  refresh?(instructions:string):Promise<void>
}
/** A temporary provider/transport failure, distinct from cancellation or invalid output. */
export class TransientModelError extends Error {}
export interface NativeRequest { id:string; method:string; params:any }
export interface ToolSpec {type:'function';name:string;description:string;inputSchema:Record<string,unknown>}
export interface ToolContent {type:'inputText'|'inputImage';text?:string;imageUrl?:string}
/** Public assistant output only. Provider reasoning and tool arguments never enter this channel. */
export interface ModelOutput {id:string;type:'start'|'delta'|'end';text?:string;phase:'answer'|'commentary'}
export interface ModelRequest {
  /** A tool-free API read of material supplied in this message. */
  suppliedText?:true
  validateSuppliedRead?:()=>void
  onUsage?:(usage:import('./model-usage.ts').ModelUsage)=>void
  contextBudget?:import('./context-budget.ts').ContextBudget
  contextId?:string
  /** Host callback to rebuild this same task after an evidenced size rejection. */
  rebuildWorkingInput?:(maxBytes:number)=>string
  onBudget?:(receipt:import('./context-budget.ts').BudgetReceipt)=>void
  retainToolResult?:(callId:string,result:unknown)=>string|Promise<string>
  options?:AgentOptions
  principal?:{source:string;actor:string}
  onConfiguration?:(value:{requested:AgentOptions;sent:Record<string,unknown>;confirmed?:Record<string,unknown>})=>void
  activity?:ExecutionContext
  cwd: string; instructions: string; input: string; schema: Record<string, unknown>
  role?: 'router'|'worker'|'subagent'; backendId?:string; onBackend?:(id:string)=>void
  model?:string;onModel?:(model:string)=>void
  /** Preserve the connection default selected when this Chat message was accepted. */
  useConnectionDefault?:boolean
  title?: string; threadId?: string; ephemeral?: boolean; sandbox?: 'read-only' | 'workspace-write'
  signal?: AbortSignal
  operator?:boolean
  archiveOnComplete?:boolean
  tools?:ToolSpec[]
  onTool?:(name:string,args:unknown,callId:string)=>Promise<{contentItems:ToolContent[];success:boolean}>
  /** Host classification for calls whose failure cannot leave an unknown write. */
  isReadOnlyTool?:(name:string)=>boolean
  workerMcp?:{command:string;args:string[]}
  /** A regular host Router turn can use the managed harness and compose authorized host tools. */
  coordinationTurn?:boolean
  /** An OpenCode Chat reply can arrive as plain text even with a structured reply schema. */
  allowPlainTextReply?:boolean
  /** Grants native tools only on assigned execution turns. */
  allowNativeTools?:boolean
  /** A human Chat turn presents a model-authored opening before its first tool effects. */
  requiresChatOpening?:boolean
  chatOpeningReady?:()=>Promise<boolean>
  /** Current task text for ranking excerpts in the managed OpenCode adapter. */
  webEvidenceQuery?:string
  /** Host-owned reference to a previous read in the same task. */
  webFetchReplay?:import('./backends/opencode-web-checkpoint.ts').WebBatchReplay
  /** Scoped excerpts transferred only to the native batch adapter. */
  opencodeWebPages?:import('./backends/opencode-web-checkpoint.ts').WebPageCheckpoint[]
  /** Ephemeral host transport, only supplied to the selected OpenCode adapter. */
  harnessProviderUrl?:string
  harnessModelWindow?:import('./backend-config.ts').ModelWindow
  /** Host-only callbacks for a managed goal's handoff between inference steps. */
  workerCheckpointReady?:()=>boolean
  /** The provider accepted a real task inference containing these inputs. */
  workerInputAccepted?:()=>void
  /** A snapshot of the host attempt at an inference or tool boundary. */
  workerInputState?:()=>{attemptId:string;dataRevision:number|null;current:boolean}
  harnessCheckpointed?:()=>boolean
  harnessWorkspace?:'read'|'edit'
  harnessPrivateFiles?:string[]
  /** Host-owned grant for the bundled or configured OpenCode adapter. */
  opencodeNativeTools?:{network:boolean}
  nativeTool?:import('./cli-native-tools.ts').CliNativeTool
  managed?:boolean
  /** Host-owned migration of legacy native context; never replaces the thread. */
  compactBeforeTurn?:boolean
  skipContextCompaction?:boolean
  onContextReady?:()=>void
  privateState?:string
  /** Exact host-owned attachment files, read-only even when nested under privateState. */
  attachments?:string[]
  onCapabilities?:(value:{mcpServers:string[];disabledPlugins:string[];managed:boolean;backend?:BackendDescription})=>void
  onActive?: (control:NativeControl)=>void
  onHumanRequest?: (request:NativeRequest)=>Promise<unknown>
  onProgress?: (event:string)=>void
  onBackendIssue?: (issue:import('./backends/plugin-contract.ts').BackendIssue)=>void
  onNativeToolBatch?: (batch:import('./backends/native-tool-batch.ts').NativeToolBatch)=>void
  onOutput?: (event:ModelOutput)=>void
  onThread?: (id: string) => void; onTurn?: (id: string) => void
}
export interface ModelResult { threadId: string; turnId: string; text: string }
export interface BackendDescription { id:string;kind:string;nativeTakeover:boolean;images:boolean;resume:boolean;tools:boolean;steering:boolean;promptRefresh:boolean;model?:string }
export interface Model { describe?(threadId?:string,role?:'router'|'worker'|'subagent'):BackendDescription; run(request: ModelRequest): Promise<ModelResult>; expose?(threadId:string,cwd:string):Promise<void>;history?(threadId:string,cwd:string):Promise<any>;purge?(threadId:string,cwd:string):Promise<{local:'verified';provider:'not_managed'}>;catalog?(provider?:string):Promise<any> }
