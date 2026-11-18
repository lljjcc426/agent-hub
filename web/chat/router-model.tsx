import {useEffect,useState} from 'react';
import {Check,ChevronRight,LoaderCircle} from 'lucide-react';
import type {Config} from '../../src/config.ts';
import type {AgentOptions,BackendDefinition} from '../../src/backend-config.ts';
import {mergeParameters} from '../../src/agent-options.ts';
import './router-model.css';

type Effort=NonNullable<AgentOptions['effort']>;
type Configuration={current:{revision:number;config:Config};agentCapabilities?:Record<string,{efforts?:Effort[]}>};
type Props={onClose:()=>void;busy:boolean;L:(en:string,zh:string)=>string;onSaved:()=>Promise<void>};
async function request<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
 const response=await fetch(path,{credentials:'same-origin',signal,...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
 const data=await response.json();if(!response.ok)throw Error(data.code??'configuration_failed');return data;
}
export function RouterModelOptions({onClose,busy,L,onSaved}:Props){
 const [config,setConfig]=useState<Configuration|null>(null),[backend,setBackend]=useState(''),[effort,setEffort]=useState<Effort|''>(''),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const load=async(signal?:AbortSignal)=>{
  setError('');const data=await request<Configuration>('/configuration',undefined,signal);setConfig(data);
  setBackend(data.current.config.execution.router?.backend??data.current.config.execution.roles.router??data.current.config.execution.backend);
  setEffort(data.current.config.execution.router?.effort??'');
 };
 useEffect(()=>{
  const controller=new AbortController();
  void load(controller.signal).catch(e=>{if(!controller.signal.aborted)setError(e.message)});
  return ()=>controller.abort();
 },[]);
 const current=config?.current.config;
 const definitions:Record<string,BackendDefinition|{kind:'codex';label?:string;model?:string}>=current?{codex:{kind:'codex' as const},...current.backends}:{};
 const definition=definitions[backend];
 const supportsEffort=definition?.kind!=='anthropic';
 const efforts=config?.agentCapabilities?.[backend]?.efforts??(definition?.kind==='codex'?['low','medium','high','xhigh'] as Effort[]:['low','medium','high'] as Effort[]);
 const save=async()=>{
  if(!current||!config||busy||saving)return;
  setSaving(true);setError('');
  const previous=current.execution.router??{},selected=previous.backend??current.execution.roles.router??current.execution.backend,changed=selected!==backend;
  const router={...previous,backend};
  if(changed){delete router.model;delete router.parameters}
  if(supportsEffort&&effort)router.effort=effort;else delete router.effort;
  if(!effort&&definition&&(definition.kind==='openai-chat'||definition.kind==='openai-responses')&&router.parameters){
   router.parameters=structuredClone(router.parameters);
   delete router.parameters.reasoning_effort;
   const reasoning=router.parameters.reasoning as {effort?:string}|undefined;
   if(reasoning){delete reasoning.effort;if(!Object.keys(reasoning).length)delete router.parameters.reasoning}
   if(!Object.keys(router.parameters).length)delete router.parameters;
  }
  // Match explicit provider reasoning settings when a generic override is selected.
  if(effort&&definition&&(definition.kind==='openai-chat'||definition.kind==='openai-responses')){
   const parameters=mergeParameters(mergeParameters(definition.parameters,definition.defaults?.parameters),router.parameters);
   if(definition.kind==='openai-chat'&&parameters.reasoning_effort!==undefined)router.parameters={...router.parameters,reasoning_effort:effort};
   if(definition.kind==='openai-responses'&&(parameters.reasoning as {effort?:string}|undefined)?.effort!==undefined)router.parameters={...router.parameters,reasoning:{...(parameters.reasoning as object),effort}};
  }
  try{
   await request('/settings',{revision:config.current.revision,patch:{execution:{...current.execution,router},...(changed?{models:Object.fromEntries(Object.entries(current.models).filter(([key])=>key!=='router'))}:{})}});
   await onSaved();onClose();
  }catch(e){setError((e as Error).message)}finally{setSaving(false)}
 };
 const labels:Record<string,string>={none:L('Off','关闭'),minimal:L('Minimal','最少'),low:L('Low','低'),medium:L('Medium','中'),high:L('High','高'),xhigh:L('Extra high','最高')};
 return <div className="router-model-options">
   {!config&&!error?<div className="router-model-loading" role="status"><LoaderCircle className="spin" size={16}/>{L('Loading connections…','正在读取连接…')}</div>:null}
   {config?<form onSubmit={e=>{e.preventDefault();e.stopPropagation();void save()}}>
    <fieldset disabled={saving||busy}>
     <label htmlFor="router-connection">{L('Model connection','模型连接')}</label>
     <select autoFocus id="router-connection" value={backend} onChange={e=>{setBackend(e.target.value);setEffort('')}}>{Object.entries(definitions).map(([id,d])=><option key={id} value={id}>{d.label??(id==='codex'?'Codex':id)}{'model' in d&&d.model?' · '+d.model:''}</option>)}</select>
     {supportsEffort?<><label htmlFor="router-effort">{L('Reasoning effort','思考强度')}</label><select id="router-effort" value={effort} onChange={e=>setEffort(e.target.value as Effort|'')}><option value="">{L('Model default','模型默认')}</option>{[...new Set([...efforts,...(effort?[effort]:[])])].map(value=><option key={value} value={value}>{labels[value]??value}</option>)}</select></>:<a className="router-thinking-link" href="/configure#execution/configuration" onClick={onClose}>{L('Configure model thinking','配置模型思考参数')}<ChevronRight size={14}/></a>}
    </fieldset>
    {busy?<p className="router-model-notice">{L('Available when this run finishes.','本次任务结束后可切换。')}</p>:null}
    <div className="router-model-actions"><a href="/configure#models" onClick={onClose}>{L('Manage connections','管理连接')}<ChevronRight size={14}/></a><button disabled={saving||busy} className="router-model-save" type="submit">{saving?<LoaderCircle size={14} className="spin"/>:<Check size={14}/>} {saving?L('Saving…','正在保存…'):L('Apply','应用')}</button></div>
   </form>:null}
   {error?<div className="router-model-error" role="alert"><p>{error==='settings_conflict'?L('Settings changed. Reload before saving.','配置已更新，请重新读取后保存。'):L('Could not update the model. Please retry.','未能更新模型，请重试。')}</p><button type="button" onClick={()=>void load().catch(e=>setError(e.message))}>{L('Reload settings','重新读取配置')}</button></div>:null}
 </div>;
}
