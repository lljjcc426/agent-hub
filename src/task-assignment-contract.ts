import {realpathSync} from 'node:fs'
import {z} from 'zod'
import type {Runtime} from './runtime.ts'
import type {RouterContext} from './worker-manager.ts'
import type {AgentOptions} from './backend-config.ts'
import type {VerificationRound} from './goal-verification.ts'
import {agentOptionsSchema,isApiBackend} from './backend-config.ts'
import {boundedBackendOptions,checkWorkerAdmission} from './backend-admission.ts'
import {workerProfiles} from './worker-pool.ts'
import {stableDigest} from './sources.ts'
import {mergeOptions} from './agent-options.ts'
const names=z.array(z.string().min(1).max(200)).max(128)
const definition=z.object({key:z.string().min(1).max(200),version:z.number().int().positive(),inputs:names,outputs:names,acceptance:names}).strict()
export const assignmentSpecSchema=z.object({
 interface:z.union([definition,z.object({id:z.string().min(1),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()]).optional(),
 dependsOn:z.array(z.object({ticketId:z.string().min(1),assignmentId:z.string().min(1)}).strict()).max(50).optional(),
 requiredTools:names.optional(),requiredConnections:names.optional(),allowedTools:names.optional(),allowedConnections:names.optional(),
 workspace:z.object({mode:z.enum(['read-only','workspace-write']),readPaths:names.optional(),writePaths:names.optional()}).strict().optional(),
 limits:agentOptionsSchema.pick({timeoutMs:true,maxSteps:true,maxToolCalls:true,maxOutputTokens:true}).optional(),
}).strict()
export type AssignmentSpec=z.infer<typeof assignmentSpecSchema>
type Authority={source:string;actor:string;discussion:string;scopeId:string|null;entryId:string|null;parentTrigger:string|null;mandateDigest:string|null;provenance:'recorded_trigger'|'local_operator'}
export interface AssignmentInterface {id:string;digest:string;contextDigest:string;sourceId:string;scopeId:string|null;entryId:string|null;triggerId:string|null;key:string;version:number;inputs:string[];outputs:string[];acceptance:string[]}
export interface AssignmentPreview {spec:AssignmentSpec;workerId:string;backendId:string;authority:Authority;interface?:AssignmentInterface;dependencies:{ticketId:string;assignmentId:string;roundId:string;digest:string}[];effective:{tools:string[];connections:string[];options:AgentOptions;sandbox:'read-only'|'workspace-write';network:boolean;sourceRoot:string}}
const fail=(reason:string):never=>{throw Error('assignment_contract_'+reason)}
const unique=(xs:string[])=>[...new Set(xs)].sort()
const contextKey=(a:Authority)=>stableDigest([a.source,a.actor,a.discussion,a.scopeId,a.entryId])
function authority(host:Runtime,c:RouterContext):Authority {
 if(!c.trigger){
  if(c.scoped)return fail('recorded_context_required')
  const source=host.config.sources.find(s=>s.kind==='local'&&s.enabled),actor=source?.allowedActors[0]
  if(!source||!actor||!c.discussion)return fail('local_operator_unavailable')
  return {provenance:'local_operator',source:source.id,actor,discussion:c.discussion,scopeId:null,entryId:null,parentTrigger:null,mandateDigest:null}
 }
 const t=c.trigger,stored=t&&host.store.triggers.get(t.id)
 if(!t||!stored||stableDigest(t)!==stableDigest(stored))return fail('recorded_context_required')
 const mandate=host.routerIngress.authority(t.id,c.discussion),route=host.store.get<{scopeId:string;entryId:string}>('router-route',t.id)
 if(c.scoped&&(route?.scopeId!==c.scoped.route.scopeId||route?.entryId!==c.scoped.route.entryId))return fail('context_mismatch')
 return {provenance:'recorded_trigger',source:t.source,actor:t.actor.id,discussion:c.discussion,scopeId:route?.scopeId??null,entryId:route?.entryId??null,parentTrigger:t.id,mandateDigest:stableDigest(mandate)}
}
function readInterface(host:Runtime,id:string):AssignmentInterface|undefined {
 const stored=host.store.get<Omit<AssignmentInterface,'inputs'|'outputs'|'acceptance'>&{content?:{inputs?:string[];outputs?:string[];acceptance?:string[]}}>('assignment-interface',id)
 if(!stored)return undefined
 if(!Array.isArray(stored.content?.inputs)||!Array.isArray(stored.content?.outputs)||!Array.isArray(stored.content?.acceptance))return fail('interface_unavailable')
 const {content,...metadata}=stored
 return {...metadata,inputs:content!.inputs!,outputs:content!.outputs!,acceptance:content!.acceptance!}
}
function resolveInterface(host:Runtime,a:Authority,spec:AssignmentSpec):AssignmentInterface|undefined {
 const requested=spec.interface;if(!requested)return
 const contextDigest=contextKey(a)
 if('id'in requested){const saved=readInterface(host,requested.id);if(!saved||saved.digest!==requested.digest||saved.contextDigest!==contextDigest||host.memory.cleanup.blocked('assignment-interface',saved.id,saved))return fail('interface_unavailable');const {digest,...body}=saved;if(stableDigest(body)!==digest)return fail('interface_corrupt');if(host.store.get<{id:string}>('assignment-interface-current',stableDigest([contextDigest,saved.key]))?.id!==saved.id)return fail('interface_superseded');return saved}
 const id='interface-'+stableDigest([contextDigest,requested.key,requested.version]),saved=readInterface(host,id)
 if(saved){const {digest,...body}=saved;if(stableDigest(body)!==digest||host.memory.cleanup.blocked('assignment-interface',id,saved))return fail('interface_unavailable')}
 const body={...requested,contextDigest,id,sourceId:a.source,scopeId:a.scopeId,entryId:a.entryId,triggerId:saved?.triggerId??a.parentTrigger},result={...body,digest:stableDigest(body)}
 if(saved&&saved.digest!==result.digest)return fail('interface_version_conflict')
 const current=host.store.get<AssignmentInterface>('assignment-interface-current',stableDigest([contextDigest,requested.key]))
 if(current&&(requested.version<current.version||requested.version===current.version&&result.digest!==current.digest))return fail('interface_superseded')
 return result
}
function dependencies(host:Runtime,a:Authority,spec:AssignmentSpec){return (spec.dependsOn??[]).map(ref=>{
 const task=host.store.tickets.get(ref.ticketId),delegation=host.taskAuthority(ref.ticketId)
 if(!task||!delegation?.parentTrigger||host.memory.cleanup.blocked('ticket',task.id,task)||task.ended?.by==='human'||task.assignments.at(-1)?.id!==ref.assignmentId)return fail('dependency_unavailable')
 const c={trigger:host.store.triggers.get(delegation.parentTrigger),discussion:delegation.discussion}
 if(contextKey(authority(host,c))!==contextKey(a))return fail('dependency_context')
 const goal=host.store.list<any>('router-goal').find(g=>host.goals.taskIdsForGoal(g).includes(task.id)),node=goal?.nodes?.find((n:any)=>n.ticketId===task.id)
 const round=node?.roundId?host.store.get<VerificationRound>('goal-verification',node.roundId):undefined
 if(!goal||goal.supersededBy||['cancelled','held','paused'].includes(goal.state)||node?.state!=='passed'||!round||round.state!=='passed'||round.goalId!==goal.id||round.nodeId!==node.id||!round.snapshot.tasks.some(t=>t.ticketId===task.id&&t.assignmentId===ref.assignmentId)||!host.verification.current(round,goal,{readOnly:true}))return fail('dependency_not_independently_accepted')
 return {...ref,roundId:round.id,digest:stableDigest(round)}
})}
function preview(host:Runtime,workerId:string,c:RouterContext,value:unknown,existing=false):AssignmentPreview {
 // Reconstruct personal-management eligibility from retained route/Chat identity,
 // never from a persisted boolean or an invented scope during a read.
 if(c.trigger&&host.store.get('router-route',c.trigger.id))c={...c,scoped:host.scopes.context(c.trigger,c.discussion)}
 const spec=assignmentSpecSchema.parse(value??{}),a=authority(host,c),worker=workerProfiles(host.config).find(w=>w.id===workerId)
 if(!worker||worker.state&&worker.state!=='enabled'&&!(existing&&worker.state==='retiring'))return fail('worker_unavailable')
 if(a.scopeId){const scope=host.scopes.scope(a.scopeId);if(!scope.workerIds.includes(workerId)||!scope.backendIds.includes(worker.backend))return fail('worker_outside_scope')}
 const policy=host.config.execution.management;if(!policy?.enabled||!host.chat.personalManagement(c)&&policy.backends&&!policy.backends.includes(worker.backend))return fail('backend_not_allowed')
 checkWorkerAdmission(host.config,worker.backend,worker)
 const source=host.sources.get(a.source)?.config;if(!source?.enabled)return fail('source_unavailable')
 if(spec.workspace&&('readPaths'in spec.workspace||'writePaths'in spec.workspace))return fail('path_constraints_unsupported')
 if(spec.workspace?.mode==='workspace-write'&&source.sandbox!=='workspace-write')return fail('workspace_escalation')
 const backend=host.config.backends[worker.backend]??{kind:'codex' as const},options=agentOptionsSchema.parse(mergeOptions(backend.defaults,Object.fromEntries(Object.entries(worker).filter(([k])=>k in agentOptionsSchema.shape))))
 const available=host.availableWorkerSpecs().map(t=>t.name),tools=unique(options.tools?available.filter(n=>options.tools!.includes(n)):available)
 const connections=unique((options.toolConnections??[]).filter(id=>host.config.toolConnections[id]?.enabled))
 const subset=(requested:string[]|undefined,allowed:string[],reason:string)=>{if(requested?.some(n=>!allowed.includes(n)))fail(reason);return unique(requested??allowed)}
 const selectedTools=subset(spec.allowedTools,tools,'tool_escalation'),selectedConnections=subset(spec.allowedConnections,connections,'connection_escalation')
 subset(spec.requiredTools,selectedTools,'required_tool_unavailable');subset(spec.requiredConnections,selectedConnections,'required_connection_unavailable')
 if(spec.limits&&!isApiBackend(backend)&&['maxSteps','maxToolCalls','maxOutputTokens'].some(k=>(spec.limits as any)[k]!==undefined))return fail('budget_unsupported')
 for(const k of ['timeoutMs','maxSteps','maxToolCalls','maxOutputTokens'] as const)if(spec.limits?.[k]!==undefined&&options[k]!==undefined&&spec.limits[k]!>options[k]!)return fail('budget_escalation')
 const bounded=boundedBackendOptions(worker.backend,backend,{...options,...spec.limits,tools:selectedTools,toolConnections:selectedConnections},host.config.turnTimeoutMs)
 return {spec,workerId,backendId:worker.backend,authority:a,interface:resolveInterface(host,a,spec),dependencies:dependencies(host,a,spec),effective:{tools:selectedTools,connections:selectedConnections,options:bounded,sandbox:spec.workspace?.mode??source.sandbox,network:host.config.work.network,sourceRoot:realpathSync(source.cwd)}}
}
export function previewTaskAssignment(host:Runtime,workerId:string,c:RouterContext,spec?:unknown):AssignmentPreview{return host.scopes.readOnly(()=>host.memory.readOnly(()=>preview(host,workerId,c,spec)))}
