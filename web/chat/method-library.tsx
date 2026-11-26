import { ReminderEditor } from './reminder-editor.tsx'
import { useState } from 'react'
import { Button, Dialog, Disclosure, EmptyState, SelectField, TextAreaField } from '../ui'
import { useWorkspaceTransport } from './workspace-context.tsx'
import { useWorkspaceRead } from './workspace-read.ts'
import type { Labels } from './memory-api.ts'
import './work-register.css'

type Ref = { id: string; version: number }
type Method = Ref & {title:string; objective:string; state:string; revision:number; entryId:string; overlay?:{base:Ref;resolvedVersion:string}}
type Plan = {id:string; title:string; kind:string; nextAt?:number; state:string; promoteText?:string}
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
  const methods = catalog.data?.skills ?? []
  const stateName=(state:string)=>({active:L('Active','可用'),candidate:L('Candidate','候选'),validated:L('Validated','已校验'),review_required:L('Needs review','待复核'),retired:L('Retired','已退役'),scheduled:L('Scheduled','已排期'),completed:L('Completed','已完成'),cancelled:L('Cancelled','已取消')}[state] ?? state)
  async function inspect(item:Method) {
    setBusy(true);setNotice('');setEditing(false);setConflicts([])
    try {
      const detail=await binding.request<Detail>('/router-skills/read',{...ref(item),scopeId:scope,entryId:item.entryId})
      if(readSignal.aborted)return
      setDialog({item,detail});setText('');setStep(detail.template.nodes[0]?.id ?? '')
      const next=methods.filter(m=>!m.overlay&&m.id===item.overlay?.base.id&&m.version>item.overlay.base.version&&m.state==='active').sort((a,b)=>b.version-a.version)[0]
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
  return <>
    {!catalog.data ? <p role="status">{catalog.error?L('Could not load plans and methods.','未能读取计划和方法。'):L('Loading…','正在读取…')}</p> : <>
      <section className="settings-group"><div className="work-section-title"><h2>{L('Reminders and goals','提醒与目标')}</h2><ReminderEditor scope={scope} L={L} saved={catalog.refresh}/></div>
        {catalog.data.commitments.length ? <ul className="work-list">{catalog.data.commitments.map(p=><li key={p.id}><div><strong>{p.title}</strong><small>{({reminder:L('One-time reminder','单次提醒'),commitment:L('Recurring commitment','长期承诺'),goal:L('Goal','正式目标')}[p.kind]??p.kind)} · {stateName(p.state)}{p.nextAt ? ' · '+new Date(p.nextAt).toLocaleString(language) : ''}</small></div>
          {p.promoteText && <Disclosure title={L('Promote to a goal','升级为目标')}><p>{L('Send this command in the original conversation, followed by the goal and acceptance criteria.','在原会话发送以下指令，并在下一行写下目标和验收条件。')}</p><code>{p.promoteText}</code></Disclosure>}
        </li>)}</ul> : <EmptyState>{L('No plans in this scope.','当前范围暂无计划。')}</EmptyState>}
      </section>
      <section className="settings-group"><h2>{L('Reusable methods','可复用方法')}</h2>{methods.length ? <ul className="work-list">{methods.map(m=><li key={m.id+'/'+m.version}>
        <div><strong>{m.title}</strong><small>{m.overlay ? L('Customized','定制版') : L('Base','基础版')} v{m.version} · {stateName(m.state)}</small></div>
        <Button disabled={busy} onClick={()=>void inspect(m)}>{m.overlay?L('Manage version','管理定制版'):L('Preview impact','预览影响')}</Button></li>)}</ul> : <EmptyState>{L('No saved methods.','暂无已存方法。')}</EmptyState>}</section>
    </>}
    {!dialog && notice && <p role="status">{notice}</p>}
    <Dialog open={!!dialog} title={item ? item.title+' · v'+item.version : L('Method','方法')} closeLabel={L('Close','关闭')} onClose={()=>setDialog(null)}>
      {dialog && item && <div className="work-detail"><p>{dialog.detail.template.objective}</p>
        <Disclosure title={L('Method steps','方法步骤')}>{dialog.detail.template.nodes.map(n=><p key={n.id}><strong>{n.title}</strong><br/>{n.instruction}</p>)}</Disclosure>
        {impact?.kind==='base' && <section><h3>{L('Upgrade impact','升级影响')}</h3><p>{L('Related customized versions','相关定制版本')} · {impact.total}</p>{impact.rows.map(row=><p key={row.id+'/'+row.version}>{row.title} · v{row.version} · {L('Pinned base','固定基础')} v{row.baseVersion}{row.conflictingFields.length>0?' · '+L('Step changes conflict','改动有冲突'):''}</p>)}</section>}
        {impact?.kind==='overlay' && <p>{L('Pinned base','固定基础')} v{impact.base.version} · {impact.integrity==='matches'?L('Content matches','内容一致'):L('Needs review','需要复核')}</p>}
        {!item.overlay && item.state==='active' && (editing ? <form onSubmit={e=>{e.preventDefault();void change({action:'overlay',base:ref(item),edits:[{field:'instruction',nodeId:step,value:text.trim()}],expectedVersion:Math.max(0,...methods.filter(m=>m.overlay?.base.id===item.id&&m.entryId===item.entryId).map(m=>m.version))})}}>
          <label className="work-field">{L('Step','步骤')}<SelectField value={step} onChange={e=>setStep(e.target.value)}>{dialog.detail.template.nodes.map(n=><option key={n.id} value={n.id}>{n.title}</option>)}</SelectField></label>
          <label className="work-field">{L('Custom instruction','定制说明')}<TextAreaField value={text} required rows={3} onChange={e=>setText(e.target.value)}/></label>
          <Button type="submit" tone="primary" disabled={busy||!text.trim()}>{L('Save candidate','保存候选版')}</Button>
        </form> : <Button onClick={()=>setEditing(true)}>{L('Customize a step','定制一个步骤')}</Button>)}
        {item.overlay && <div className="work-actions">
          {(item.state==='candidate'||item.state==='validated') && <Button disabled={busy} onClick={()=>void change({action:'overlay_lifecycle',skill:ref(item),transition:item.state==='candidate'?'validate':'enable',resolvedVersion:item.overlay!.resolvedVersion,expectedRevision:item.revision})}>{item.state==='candidate'?L('Validate version','校验这个版本'):L('Enable version','启用这个版本')}</Button>}
          {item.state!=='retired' && <Button disabled={busy} onClick={()=>void change({action:'retire',skill:ref(item),expectedRevision:item.revision})}>{L('Retire version','退役这个版本')}</Button>}
        </div>}
        {item.overlay && newer.length>0 && <form onSubmit={e=>{e.preventDefault();void change({action:'upgrade_overlay',skill:ref(item),base:{id:item.overlay!.base.id,version:Number(version)},expectedVersion:Math.max(...methods.filter(m=>m.id===item.id).map(m=>m.version))})}}>
          <label className="work-field">{L('New base version','新版基础方法')}<SelectField value={version} onChange={e=>setVersion(e.target.value)}>{newer.map(m=><option key={m.version} value={m.version}>{m.title} · v{m.version}</option>)}</SelectField></label>
          <Button type="submit" tone="primary" disabled={busy||!version}>{L('Try upgrade','尝试升级')}</Button></form>}
        {conflicts.length>0 && <section aria-live="polite"><h3>{L('Changes to the same field','同一处改动产生冲突')}</h3>{conflicts.map(c=><Disclosure key={c.field} title={c.field.startsWith('instruction:')?(dialog.detail.template.nodes.find(n=>n.id===c.field.slice(12))?.title ?? L('Step instruction','步骤说明')):c.field==='title'?L('Name','名称'):L('Objective','目标')}>{[[L('Original base','原基础版本'),c.oldBase],[L('Your changes','当前定制版'),c.overlay],[L('New base','新基础版本'),c.newBase]].map(([label,value])=><div key={label}><h4>{label}</h4><pre>{value??L('Removed','已移除')}</pre></div>)}</Disclosure>)}</section>}
        {notice&&<p role="status">{notice}</p>}
      </div>}
    </Dialog>
  </>
}

export function MethodLibrary({L,language}:{L:Labels;language:'en'|'zh-CN'}) {
  const {data,error,refresh}=useWorkspaceRead<{scopes:{id:string;name:string}[]}>('/router-scopes')
  const [chosen,setChosen]=useState(()=>new URLSearchParams(location.search).get('scope')??'')
  const scope=data?.scopes.find(s=>s.id===chosen)?.id ?? data?.scopes[0]?.id
  return <article className="settings-directory work-register"><h1>{L('Plans and methods','计划与方法')}</h1>
    {error ? <Button onClick={refresh}>{L('Retry','重试')}</Button> : data && !scope ? <EmptyState>{L('No management scope.','暂无管理范围。')}</EmptyState> : <>
      <label className="work-field">{L('Management scope','管理范围')}<SelectField value={scope??''} onChange={e=>setChosen(e.target.value)}>{data?.scopes.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</SelectField></label>
      {scope&&<ScopedMethods key={scope} scope={scope} L={L} language={language}/>}</>}</article>
}
