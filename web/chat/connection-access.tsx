import { useState } from 'react'
import { Button, Disclosure } from '../ui'
import type { ConnectorManagement } from '../../src/connector-management.ts'
import { EntryPeople } from './entry-people.tsx'
import { useWorkspaceRead } from './workspace-read.ts'
import { useWorkspaceTransport } from './workspace-context.tsx'
import type { Labels } from './memory-api.ts'
import './work-register.css'

type Access = ReturnType<ConnectorManagement['snapshot']>
export function ConnectionAccess({L,language}:{L:Labels;language:'en'|'zh-CN'}) {
  const info = useWorkspaceRead<Access>('/api/connectors')
  const { binding, readSignal } = useWorkspaceTransport()
  const [busy,setBusy] = useState(false), [message,setMessage] = useState('')
  async function change(sourceId:string,capability:'history'|'files',enabled:boolean) {
    if(!info.data)return
    setBusy(true);setMessage('')
    try {
      await binding.request('/api/connectors/resource-access',{sourceId,revision:info.data.revision,capability,enabled,intent:'update_resource_access',requestId:crypto.randomUUID()})
      if(!readSignal.aborted){info.refresh();setMessage(L('Setting saved.','设置已保存。'))}
    } catch {if(!readSignal.aborted){info.refresh();setMessage(L('Could not save the setting. Check its current value.','暂时无法保存，请核对当前设置。'))}}
    finally {if(!readSignal.aborted)setBusy(false)}
  }
  if(info.error)return <Button onClick={info.refresh}>{L('Retry loading access settings','重新读取权限设置')}</Button>
  if(!info.data)return <p role="status">{L('Loading access settings…','正在读取权限设置…')}</p>
  const caps = [['events',L('Receive events','接收新消息')],['replies',L('Reply','回复')],['history',L('Read history','读取历史')],['files',L('Read files','读取文件')],['mcp',L('Invoke tools','调用工具')]] as const
  return <section className="settings-group work-register connection-access"><h2>{L('Capabilities by connection','各连接的能力')}</h2>
    {info.data.instances.map(s=><Disclosure key={s.id} title={s.label+' · '+L('Access','访问权限')}><dl className="work-facts">
      {caps.map(([key,label])=>{const mode=s.capabilityMatrix.modes[key];return <div key={key}><dt>{label}</dt><dd>
        {mode==='disabled'?L('Locally disabled','本地已关闭'):mode==='requires_context'?L('Enabled locally, platform access unverified','本地已开，平台权限待核实'):L('Separately authorized','单独授权')}
        {(key==='history'||key==='files')&&s.resourceAccessControls&&<Button disabled={busy} aria-label={(mode==='disabled'?L('Allow ','允许'):L('Block ','禁止'))+label} onClick={()=>void change(s.id,key,mode==='disabled')}>{mode==='disabled'?L('Allow','允许'):L('Block','禁止')}</Button>}
      </dd></div>})}</dl></Disclosure>)}
    {message&&<p role="status">{message}</p>}
    <EntryPeople language={language} settingsRevision={info.data.revision}/>
  </section>
}
