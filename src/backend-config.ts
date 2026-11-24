import {modelSteps,modelToolCalls,maxOutputTokens,maxTurnMs,maxWireBytes,workerPoolDefault,messageCharacters} from './execution-limits.ts'
import {nativeToolFor} from './cli-native-tools.ts'
import {z} from 'zod'
import {teamTargetSchema} from './delegation/contract.ts'
import type {DecisionConfig} from './decision-config.ts'
import {browserOptionsSchema} from './browser-contract.ts'
import {personaSchema} from './persona.ts'
import {reasoningEfforts} from './reasoning-effort.ts'
const envName=z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const name=z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const apiBase=z.string().url().superRefine((s,ctx)=>{
 const u=new URL(s),local=['localhost','127.0.0.1','[::1]'].includes(u.hostname)
 if(!['https:','http:'].includes(u.protocol)||u.protocol==='http:'&&!local||u.username||u.password||u.search||u.hash)ctx.addIssue({code:'custom',message:'Backend requires HTTPS, or loopback HTTP, with no URL credentials/query/fragment'})
})
export const parametersSchema=z.record(z.string(),z.unknown()).superRefine((p,ctx)=>{
 const reserved=['model','messages','input','instructions','system','tools','tool_choice','stream','store','previous_response_id','conversation','include','response_format','n','max_tokens','max_completion_tokens','max_output_tokens']
 if(Object.keys(p).some(k=>reserved.includes(k)))ctx.addIssue({code:'custom',message:'Provider parameters cannot replace managed model, history, tools or output configuration'})
 for(const key of ['output_config','text'])if(key in p){const value=p[key];if(!value||typeof value!=='object'||Array.isArray(value)||'format'in value)ctx.addIssue({code:'custom',message:key+' accepts provider options but its format is managed by AgentHub'})}
})
export const effortSchema=z.enum(reasoningEfforts)
export const agentOptionsSchema=z.object({
 persona:personaSchema.optional(),
 // Omission inherits the connection setting. Null lets the selected model choose.
 effort:effortSchema.nullable().optional(),parameters:parametersSchema.optional(),prompt:z.string().max(messageCharacters).optional(),
 maxOutputTokens:z.number().int().min(64).max(maxOutputTokens).optional(),maxSteps:z.number().int().min(1).max(modelSteps.max).optional(),
 maxToolCalls:z.number().int().min(1).max(modelToolCalls.max).optional(),timeoutMs:z.number().int().min(1000).max(maxTurnMs).optional(),
 tools:z.array(z.string().min(1)).optional().describe('Host tool names from worker_manage list. Omit to inherit connection defaults; with no default, all available host tools are enabled. An empty array disables tools.'),
 toolConnections:z.array(name).optional().describe('Existing MCP/tool connection IDs from worker_manage list. This selects connections; it does not create credentials or new connections.'),
 browser:browserOptionsSchema.optional(),
}).strict()
export type AgentOptions=z.infer<typeof agentOptionsSchema>
const parameters=parametersSchema.prefault({})
export const backendLimitsSchema=z.object({timeoutMs:z.number().int().min(1000).max(maxTurnMs).optional(),maxOutputTokens:z.number().int().min(64).max(maxOutputTokens).optional(),maxSteps:z.number().int().min(1).max(modelSteps.max).optional(),maxToolCalls:z.number().int().min(1).max(modelToolCalls.max).optional()}).strict()
export const modelWindowSchema=z.object({
 context:z.number().int().positive().safe(),output:z.number().int().min(64).safe(),
}).strict().refine(limit=>limit.output<limit.context,'Output reserve must fit inside the context window')
export type ModelWindow=z.infer<typeof modelWindowSchema>
export const apiBackendDefinition=z.object({
  kind:z.enum(['openai-responses','openai-chat','anthropic']),limits:backendLimitsSchema.optional(),label:z.string().trim().min(1).max(100).optional(),baseUrl:apiBase,model:z.string().min(1),apiKeyEnv:envName.optional(),
  images:z.boolean().default(false),maxSteps:z.number().int().min(1).max(modelSteps.max).default(modelSteps.default),
  maxToolCalls:z.number().int().min(1).max(modelToolCalls.max).default(modelToolCalls.default),
  maxContextBytes:z.number().int().min(4096).max(maxWireBytes).default(32_000_000),
  compaction:z.union([z.literal(false),z.object({models:z.record(z.string().min(1),modelWindowSchema).optional(),discover:z.boolean().optional()}).strict()]).optional(),
  maxOutputTokens:z.number().int().min(64).max(maxOutputTokens).default(8192),
  requestTimeoutMs:z.number().int().min(100).max(1_800_000).default(300_000),
  outputFormat:z.enum(['prompt','json-object','json-schema']).default('prompt'),parameters,
  headers:z.record(z.string().regex(/^[A-Za-z0-9-]+$/),z.string().regex(/^[^\r\n]*$/)).optional(),
  headerEnv:z.record(z.string().regex(/^[A-Za-z0-9-]+$/),envName).optional(),defaults:agentOptionsSchema.optional(),
  subscription:z.object({provider:z.literal('chatgpt'),account:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),owner:z.object({source:z.string().min(1),actor:z.string().min(1)}).strict(),backgroundAuthorized:z.boolean()}).strict().optional(),
  chatTokenField:z.enum(['max_completion_tokens','max_tokens']).default('max_completion_tokens'),
 }).strict()
export const backendDefinition=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('plugin'),limits:backendLimitsSchema.optional(),plugin:name,label:z.string().trim().min(1).max(100).optional(),model:z.string().min(1).optional(),config:z.record(z.string(),z.unknown()).prefault({}),env:z.record(envName,envName).prefault({}),readPaths:z.array(z.string().min(1)).default([]),writePaths:z.array(z.string().min(1)).default([]),defaults:agentOptionsSchema.optional()}).strict(),
 z.object({kind:z.literal('codex'),limits:backendLimitsSchema.optional(),label:z.string().trim().min(1).max(100).optional(),command:z.string().min(1).optional(),
  args:z.array(z.string()).optional(),env:z.record(envName,envName).optional(),model:z.string().min(1).optional(),defaults:agentOptionsSchema.optional(),
 }).strict(),
 apiBackendDefinition,
])
export type BackendDefinition=z.infer<typeof backendDefinition>
export type ApiDefinition=Exclude<BackendDefinition,{kind:'codex'|'plugin'}>
export const backendsSchema=z.record(name,backendDefinition).prefault({})
const nativeTool=z.enum(['cached-web-search','task-list']).optional()
export const workerProfileSchema=agentOptionsSchema.extend({nativeTool,id:name,label:z.string().trim().min(1).max(100).optional(),backend:name,model:z.string().trim().min(1).max(300).optional(),state:z.enum(['enabled','paused','retiring']).optional()}).strict()
export type WorkerProfile=z.infer<typeof workerProfileSchema>
// Discard the former role-level engine setting when opening pre-preset configurations.
function dropLegacyHarness(profile:unknown){
 if(!profile||typeof profile!=='object'||!Object.hasOwn(profile,'harness'))return profile
 const {harness,...rest}=profile as Record<string,unknown>
 return rest
}
export const executionSchema=z.object({backend:name.default('codex'),roles:z.object({router:name.optional(),worker:name.optional(),subagent:name.optional()}).strict().prefault({}),
 router:z.preprocess(dropLegacyHarness,agentOptionsSchema.extend({nativeTool,label:z.string().trim().min(1).max(100).optional(),backend:name.optional(),model:z.string().min(1).optional(),mode:z.enum(['assessment','host','client']).optional()})).optional(),
 management:z.object({enabled:z.boolean().default(false),maxWorkers:z.number().int().min(1).default(workerPoolDefault),backends:z.array(name).optional()}).strict().optional(),
 workers:z.array(z.preprocess(dropLegacyHarness,workerProfileSchema)).optional(),teamTargets:z.array(teamTargetSchema).max(16).optional()}).strict().prefault({})
export function validateBackendSelection(c:{execution:z.infer<typeof executionSchema>;backends:Record<string,BackendDefinition>;toolConnections?:Record<string,unknown>;decision?:DecisionConfig}){
 const provider=c.decision?.provider
 if(provider?.kind==='backend'){const d=c.backends[provider.id];if(!d||!isApiBackend(d)||d.subscription)throw Error('Decision provider must reference an API backend without an agent subscription')}
 if(c.backends.codex&&c.backends.codex.kind!=='codex')throw Error('The backend ID codex is reserved for native Codex conversations')
 for(const id of [c.execution.backend,c.execution.router?.backend,...Object.values(c.execution.roles),...(c.execution.workers??[]).map(w=>w.backend),...(c.execution.management?.backends??[])])if(id&&id!=='codex'&&!c.backends[id])throw Error('Unknown execution backend: '+id)
 for(const d of Object.values(c.backends))if(d.kind!=='codex'&&d.kind!=='plugin'&&d.subscription&&(d.kind!=='openai-responses'||d.baseUrl.replace(/\/+$/,'')!=='https://api.openai.com/v1'||d.apiKeyEnv))throw Error('ChatGPT subscription requires the public Responses API and its own OAuth account')
 for(const d of Object.values(c.backends))if(d.kind==='plugin'&&d.plugin==='opencode-cli'&&'apiProtocol' in d.config)throw Error('The API protocol is supplied internally by Roppo')
 if(c.execution.workers&&new Set(c.execution.workers.map(w=>w.id)).size!==c.execution.workers.length)throw Error('Duplicate worker id')
 for(const profile of [c.execution.router,...(c.execution.workers??[])]){
  if(!profile)continue
  if(!profile.nativeTool)continue
  const backend=profile.backend??c.execution.roles.router??c.execution.backend
  if(nativeToolFor(c.backends[backend])!==profile.nativeTool||profile===c.execution.router&&c.execution.router.mode!=='host')throw Error('Selected CLI native tool is unavailable for this role or connection')
 }
 if(c.execution.router?.toolConnections?.length)throw Error('MCP tools are executed by Workers; configure their toolConnections instead of the Router')
 for(const options of [c.execution.router,...(c.execution.workers??[]),...Object.values(c.backends).map(b=>b.defaults)])for(const id of options?.toolConnections??[])if(!c.toolConnections?.[id])throw Error('Unknown tool connection: '+id)
}

export type PluginBackendDefinition=Extract<BackendDefinition,{kind:'plugin'}>
export function isApiBackend(d:BackendDefinition):d is ApiDefinition{return d.kind!=='codex'&&d.kind!=='plugin'}
