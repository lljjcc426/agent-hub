import { useState } from 'react'
import { Button, Dialog, InputControl, SelectField } from '../ui'
import type { Labels } from './memory-api.ts'
import { useWorkspaceRead } from './workspace-read.ts'
import { useWorkspaceTransport } from './workspace-context.tsx'

export function ReminderEditor({scope,L,saved}:{scope:string;L:Labels;saved:()=>void}) {
  const [open,setOpen]=useState(false)
  const catalog=useWorkspaceRead<{contexts:{id:string;scopeId:string;title:string;label:string}[]}>(open?'/router-management/catalog':null)
  const {binding,readSignal}=useWorkspaceTransport()
  const [daily,setDaily]=useState(false), [busy,setBusy]=useState(false), [error,setError]=useState(false)
  const [draftId,setDraftId]=useState('')
  const contexts=catalog.data?.contexts.filter(c=>c.scopeId===scope)??[]
  return <><Button onClick={()=>{setError(false);setDaily(false);setDraftId(crypto.randomUUID());setOpen(true)}}>{L('New reminder','新建提醒')}</Button>
    <Dialog open={open} title={L('New reminder','新建提醒')} closeLabel={L('Close','关闭')} onClose={()=>setOpen(false)}>
      <form className="work-detail" onChange={()=>setDraftId(crypto.randomUUID())} onSubmit={async e=>{
        e.preventDefault()
        const data=new FormData(e.currentTarget),dt=new Date(String(data.get('start'))),name=String(data.get('name')).trim()
        if(!name||!Number.isFinite(dt.getTime()))return
        const plan={id:draftId,name,triggerId:String(data.get('trigger')),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,startAt:dt.toISOString()}
        const input=daily?{action:'commitment.put',commitment:{...plan,time:String(data.get('time'))}}:{action:'reminder.put',reminder:plan}
        setBusy(true);setError(false)
        try {await binding.request('/router-proactive',{...input,scopeId:scope,expectedRevision:0,operationId:draftId});if(!readSignal.aborted){setOpen(false);saved()}}
        catch {if(!readSignal.aborted)setError(true)} finally {if(!readSignal.aborted)setBusy(false)}
      }}>
      <label className="work-field">{L('Name','名称')}<InputControl name="name" required maxLength={300}/></label>
      <label className="work-field">{L('Frequency','频率')}<SelectField value={daily?'daily':'once'} onChange={e=>setDaily(e.target.value==='daily')}><option value="once">{L('Once','仅一次')}</option><option value="daily">{L('Every day','每天')}</option></SelectField></label>
      <label className="work-field">{L('First notice · local time','首次提醒 · 本地时间')}<InputControl type="datetime-local" name="start" required/></label>
      {daily&&<label className="work-field">{L('Daily time','每天提醒时间')}<InputControl type="time" name="time" required/></label>}
      <label className="work-field">{L('Original conversation request','原会话中的请求')}<SelectField name="trigger" required defaultValue=""><option value="">{L('Select a request','选择原请求')}</option>{contexts.map(c=><option key={c.id} value={c.id}>{c.title || c.label}</option>)}</SelectField></label>
      {error&&<p role="alert">{L('Could not save the reminder. Check its time and original request.','保存失败，请核对时间和原请求。')}</p>}
      <Button type="submit" tone="primary" disabled={busy||!contexts.length}>{L('Save reminder','保存提醒')}</Button></form>
    </Dialog></>
}
