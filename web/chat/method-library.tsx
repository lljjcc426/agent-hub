import { BookOpen, ChevronRight } from 'lucide-react'
import { PlanList, type Plan } from './plan-list.tsx'
import { useState } from 'react'
import { Button, ChoiceGroup, Dialog, Disclosure, EmptyState, SelectField, TextAreaField } from '../ui'
import { useWorkspaceTransport } from './workspace-context.tsx'
import { useWorkspaceRead } from './workspace-read.ts'
import type { Labels } from './memory-api.ts'
import './work-pages.css'

type Ref = { id: string; version: number }
type Method = Ref & {title:string; objective:string; state:string; revision:number; entryId:string; overlay?:{base:Ref;resolvedVersion:string}}
type Step = {id:string; title:string; instruction:string}
type Conflict = {field:string;oldBase:string|null;overlay:string|null;newBase:string|null}
type Impact = {kind:'base';total:number;rows:{id:string;version:number;title:string;baseVersion:number;relation:string;conflictingFields:string[]}[]}|{kind:'overlay';base:Ref;integrity:string}
type Detail = {template:{title:string;objective:string;nodes:Step[]};inspection:{overlayImpact:Impact}}
const ref = ({id,version}:Ref) => ({id,version})

function ScopedMethods({scope,L,language}:{scope:string;L:Labels;language:'en'|'zh-CN'}) {
  const catalog = useWorkspaceRead<{skills:Method[];commitments:Plan[]}>('/router-proactive/state?scopeId='+encodeURIComponent(scope))
  const { binding, readSignal } = useWorkspaceTransport()
  const [dialog, setDialog] = useState<{item:Method;detail:Detail}|null>(null)
  const [editing, setEditing] = useState(false), [step,setStep] = useState(''), [text,setText] = useState('')
  const [version,setVersion] = useState(''), [conflicts,setConflicts] = useState<Conflict[]>([])
  const [busy, setBusy] = useState(false), [notice,setNotice] = useState('')
  const [tab,setTab] = useState<'reminders'|'goals'|'methods'>('reminders')
  const methods = catalog.data?.skills ?? []
  const familyKey = (method: Method) => JSON.stringify([method.entryId, method.overlay?.base.id ?? method.id])
  const families = new Map<string,[Method, ...Method[]]>()
  for (const method of methods) {
    const key=familyKey(method), family=families.get(key)
    if (family) family.push(method)
    else families.set(key,[method])
  }
  const versionName=(m:Method)=>(m.overlay ? L('Custom','定制版') : L('Base','基础版'))+' v'+m.version
  const versionKey=(m:Method)=>JSON.stringify([m.id,m.version])
  const stateName=(state:string)=>({active:L('Active','可用'),candidate:L('Candidate','候选'),validated:L('Validated','已校验'),review_required:L('Needs review','待复核'),retired:L('Retired','已退役'),scheduled:L('Scheduled','已排期'),completed:L('Completed','已完成'),cancelled:L('Cancelled','已取消')}[state] ?? state)
  async function inspect(item:Method) {
    setBusy(true);setNotice('');setEditing(false);setConflicts([])
    try {
      const detail=await binding.request<Detail>('/router-skills/read',{...ref(item),scopeId:scope,entryId:item.entryId})
      if(readSignal.aborted)return
      setDialog({item,detail});setText('');setStep(detail.template.nodes[0]?.id ?? '')
      const next=methods.filter(m=>!m.overlay&&m.id===item.overlay?.base.id&&m.entryId===item.entryId&&m.version>item.overlay.base.version&&m.state==='active').sort((a,b)=>b.version-a.version)[0]
      setVersion(next ? String(next.version) : '')
    } catch {if(!readSignal.aborted)setNotice(L('Could not read this version.','未能读取这个版本。'))}
    finally {if(!readSignal.aborted)setBusy(false)}
  }
  async function change(body:Record<string,unknown>) {
    if(!dialog)return
    setBusy(true);setNotice('');setConflicts([])
    try {
      const result=await binding.request<{conflictDetails?:Conflict[]}>('/router-skills',{...body,scopeId:scope,entryId:dialog.item.entryId})
      if(readSignal.aborted)return
      if(result.conflictDetails?.length)setConflicts(result.conflictDetails)
      else {catalog.refresh();setDialog(null);setNotice(L('Saved.','已保存。'))}
    } catch {if(!readSignal.aborted)setNotice(L('Could not save this change. Reopen the version to check its status.','未能保存，请重新打开版本核对当前状态。'))}
    finally {if(!readSignal.aborted)setBusy(false)}
  }
  const item=dialog?.item,impact=dialog?.detail.inspection.overlayImpact
  const newer=item?.overlay ? methods.filter(m=>!m.overlay&&m.id===item.overlay?.base.id&&m.entryId===item.entryId&&m.version>item.overlay.base.version&&m.state==='active') : []
  const versions=item ? families.get(familyKey(item)) ?? [] : []
  return <>
    <div className="work-switch"><ChoiceGroup label={L('Show','查看内容')} choices={[
      {value:'reminders',label:L('Reminders','提醒')},{value:'goals',label:L('Goals','目标')},{value:'methods',label:L('Saved methods','常用方法')},
    ]} value={tab} onChange={setTab}/></div>
    {catalog.error ? <p role="alert">{L('Could not read this workspace.','暂时无法读取这个范围。')} <Button onClick={catalog.refresh}>{L('Retry','重试')}</Button></p>
      : !catalog.data ? <p role="status">{L('Loading…','正在读取…')}</p>
      : tab!=='methods' ? <PlanList key={tab} scope={scope} goals={tab==='goals'} plans={catalog.data.commitments} L={L} language={language} saved={catalog.refresh}/>
      : <section className="work-block"><h2>{L('Saved methods','已保存的方法')}</h2>
        {families.size ? <ul className="work-rows">{Array.from(families.entries()).map(([key,versions])=>{
          const latest=versions.filter(m=>!m.overlay).sort((a,b)=>Number(b.state==='active')-Number(a.state==='active')||b.version-a.version)[0] ?? versions[0]
          return <li key={key} className="work-item"><span className="work-item-icon"><BookOpen size={21}/></span>
            <div className="work-item-copy"><strong>{latest.title}</strong><span>{versions.length} {L(versions.length===1?'version':'versions','个版本')}</span></div>
            <Button disabled={busy} onClick={()=>void inspect(latest)}>{L('View steps','查看步骤')}<ChevronRight size={16}/></Button></li>
        })}</ul>:<EmptyState icon={<BookOpen size={24}/>}>{L('No saved methods here','这里还没有保存的方法')}</EmptyState>}</section>}
    {!dialog && notice && <p role="status">{notice}</p>}
    <Dialog open={!!dialog} title={conflicts.length ? L('Compare conflicting steps','对照升级冲突') : item?.title ?? L('Method','方法')} closeLabel={L('Close','关闭')} onClose={()=>setDialog(null)}>
      {dialog && item && <div className="work-sheet">
        {conflicts.length ? <><div className="method-conflicts">{conflicts.map(c=><section key={c.field}><h3>{c.field.startsWith('instruction:')?(dialog.detail.template.nodes.find(n=>n.id===c.field.slice(12))?.title ?? L('Step','步骤')):c.field==='title'?L('Name','名称'):L('Goal','目标')}</h3>
          {[[L('Original base','原基础版本'),c.oldBase],[L('Your version','当前定制版'),c.overlay],[L('New base','新基础版本'),c.newBase]].map(([label,value])=><div key={label}><strong>{label}</strong><p>{value??L('Removed','已移除')}</p></div>)}</section>)}</div>
          <Button onClick={()=>setConflicts([])}>{L('Back to method','返回方法')}</Button></> : <>
        <label className="work-field">{L('Version','版本')}<SelectField value={versionKey(item)} disabled={busy} onChange={e=>{const next=versions.find(m=>versionKey(m)===e.target.value);if(next)void inspect(next)}}>
          {versions.map(m=><option key={versionKey(m)} value={versionKey(m)}>{versionName(m)} · {stateName(m.state)}</option>)}</SelectField></label>
        {dialog.detail.template.objective && <p className="work-quote">{dialog.detail.template.objective}</p>}
        <section><h3>{L('Steps','操作步骤')}</h3><ol className="method-steps">{dialog.detail.template.nodes.map(n=><li key={n.id}><strong>{n.title}</strong>{n.instruction && n.instruction!==n.title && <p>{n.instruction}</p>}</li>)}</ol></section>
        {impact?.kind==='base' && <Disclosure title={L('Preview upgrade impact','查看升级影响')}><div className="method-impact">
          {impact.total===0?<p>{L('No custom versions use this method.','还没有使用这个方法的定制版。')}</p>:<p>{L('Linked custom versions','受影响的定制版')} · {impact.total}</p>}
          {impact.rows.map(row=><p key={row.id+'/'+row.version}>{row.title} · v{row.version} · {L('Based on','基于')} v{row.baseVersion}{row.conflictingFields.length?' · '+L('Conflicting changes','改动有冲突'):''}</p>)}</div></Disclosure>}
        {impact?.kind==='overlay' && <p>{L('Based on','基于基础版')} v{impact.base.version} · {impact.integrity==='matches'?L('Content matches','内容一致'):L('Needs review','需要复核')}</p>}
        {!item.overlay && item.state==='active' && (editing ? <form onSubmit={e=>{e.preventDefault();void change({action:'overlay',base:ref(item),edits:[{field:'instruction',nodeId:step,value:text.trim()}],expectedVersion:Math.max(0,...methods.filter(m=>m.overlay?.base.id===item.id&&m.entryId===item.entryId).map(m=>m.version))})}}>
          <label className="work-field">{L('Step','步骤')}<SelectField value={step} onChange={e=>setStep(e.target.value)}>{dialog.detail.template.nodes.map(n=><option key={n.id} value={n.id}>{n.title}</option>)}</SelectField></label>
          <label className="work-field">{L('Custom instruction','定制说明')}<TextAreaField value={text} required rows={3} onChange={e=>setText(e.target.value)}/></label>
          <Button type="submit" tone="primary" disabled={busy||!text.trim()}>{L('Save candidate','保存候选版')}</Button>
        </form> : <Button onClick={()=>setEditing(true)}>{L('Customize a step','定制一个步骤')}</Button>)}
        {item.overlay && <div className="work-buttons">
          {(item.state==='candidate'||item.state==='validated') && <Button disabled={busy} onClick={()=>void change({action:'overlay_lifecycle',skill:ref(item),transition:item.state==='candidate'?'validate':'enable',resolvedVersion:item.overlay!.resolvedVersion,expectedRevision:item.revision})}>{item.state==='candidate'?L('Validate version','校验这个版本'):L('Enable version','启用这个版本')}</Button>}
          {item.state!=='retired' && <Button disabled={busy} onClick={()=>void change({action:'retire',skill:ref(item),expectedRevision:item.revision})}>{L('Retire version','退役这个版本')}</Button>}
        </div>}
        {item.overlay && newer.length>0 && <form onSubmit={e=>{e.preventDefault();void change({action:'upgrade_overlay',skill:ref(item),base:{id:item.overlay!.base.id,version:Number(version)},expectedVersion:Math.max(...methods.filter(m=>m.id===item.id).map(m=>m.version))})}}>
          <label className="work-field">{L('New base version','新版基础方法')}<SelectField value={version} onChange={e=>setVersion(e.target.value)}>{newer.map(m=><option key={m.version} value={m.version}>{m.title} · v{m.version}</option>)}</SelectField></label>
          <Button type="submit" tone="primary" disabled={busy||!version}>{L('Try upgrade','尝试升级')}</Button></form>}
        </>}
        {notice&&<p role="status">{notice}</p>}
      </div>}
    </Dialog>
  </>
}

export function MethodLibrary({L,language}:{L:Labels;language:'en'|'zh-CN'}) {
  const {data,error,refresh}=useWorkspaceRead<{scopes:{id:string;name:string}[]}>('/router-scopes')
  const [chosen,setChosen]=useState(()=>new URLSearchParams(location.search).get('scope')??'')
  const scope=data?.scopes.find(s=>s.id===chosen)?.id ?? data?.scopes[0]?.id
  return <article className="settings-directory work-page plans-page"><header className="work-heading"><h1>{L('Reminders and methods','提醒与方法')}</h1>
    {scope&&<label className="work-scope"><span className="work-scope-label">{L('Work scope','工作范围')}</span>
      <SelectField value={scope} onChange={e=>setChosen(e.target.value)}>{data?.scopes.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</SelectField></label>}</header>
    {error ? <Button onClick={refresh}>{L('Retry','重试')}</Button> : data && !scope ? <EmptyState>{L('No workspaces available','暂无可用工作范围')}</EmptyState> :
      scope ? <ScopedMethods key={scope} scope={scope} L={L} language={language}/> : <p role="status">{L('Loading…','正在读取…')}</p>}</article>
}
