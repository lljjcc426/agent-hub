import { useState } from 'react'
import { Button, Dialog, EmptyState, SelectField } from '../ui'
import type { OperatorAttentionItem, OperatorAttentionSnapshot } from '../../src/operator-attention.ts'
import type { ResourceUsageSnapshot } from '../../src/resource-usage.ts'
import type { Labels } from './memory-api.ts'
import { useWorkspaceRead } from './workspace-read.ts'
import { useWorkspaceTransport } from './workspace-context.tsx'
import { TaskProgressSnapshot } from './progress-snapshot.tsx'
import './work-register.css'

type Lang = 'en' | 'zh-CN'
type Props = { L: Labels; language: Lang }
type Workflow = { id: string; state?:string; next?:{name:string}; view?: { label: string; issue:string; current?:{name:string} }; effectSummary?: { kind: string; attemptedAt?: number; observedAt?: number } }

export function WorkInbox({ L, language }: Props) {
  const [offset, setOffset] = useState(0)
  const inbox = useWorkspaceRead<OperatorAttentionSnapshot>('/entry-workspace/attention?inbox=1&offset='+offset)
  const work = useWorkspaceRead<{ workflowActions: Workflow[] }>('/entry-workspace')
  const { binding } = useWorkspaceTransport()
  const [selected, select] = useState<string | null>(null)
  const [observation,setObservation] = useState(''), [decisionResult,setDecisionResult]=useState('')
  const [pending, setPending] = useState(false), [failed, setFailed] = useState(false)
  const current = inbox.data?.items.find(item => item.id === selected)
  const workflowFor = (item: OperatorAttentionItem) => item.next.kind === 'workflow' ? work.data?.workflowActions.find(row => row.id === item.next.id) : undefined
  const labels = {task_question:L('Task question','任务待回复'), native_question:L('Agent question','Agent 提问'), native_approval:L('Permission request','待审批'), workflow_review:L('Review change','待审核变更'), project_review:L('Project review','项目待评审'), effect_unknown:L('External result unknown','外部写入结果未知'), open_work:L('Ongoing task','进行中的任务')}
  const stamp = (at: number) => new Date(at).toLocaleString(language)
  const effect = current && workflowFor(current)?.effectSummary
  async function decide(action:Workflow,decision:'approve'|'decline') {
    setPending(true);setDecisionResult('')
    try {
      const updated=await binding.request<Workflow>('/workflow-actions',{id:action.id,decision})
      const outcome=updated.effectSummary?.kind
      const detail=outcome==='confirmed' ? L('Written and verified','已写入并回读') : outcome==='not_executed' ? L('Change not applied','未执行变更') : L('Result still unconfirmed','结果待核对')
      setDecisionResult((action.view?.label ?? action.id)+' · '+detail)
      work.refresh();inbox.refresh()
    } catch { setDecisionResult(L('Could not confirm this change. Refresh to view its receipt.','暂时无法确认，请刷新查看回执。')) }
    finally { setPending(false) }
  }
  async function reconcile(id:string) {
    setPending(true);setObservation('')
    try {
      const receipt=await binding.request<Workflow>('/workflow-actions',{id,decision:'reconcile'})
      setObservation(receipt.effectSummary?.kind==='observed' ? L('The remote state matches.','远端状态已确认。') : L('The remote state is still unconfirmed.','远端状态仍未确认。'))
      work.refresh();inbox.refresh()
    } catch { setObservation(L('The connection could not confirm the remote state.','当前连接暂时无法核对远端状态。')) }
    finally {setPending(false)}
  }
  async function mark(item: OperatorAttentionItem) {
    setPending(true); setFailed(false)
    try { await binding.request('/entry-workspace/attention/read',{id:item.id,observed:item.observed}); inbox.refresh() }
    catch { setFailed(true) } finally { setPending(false) }
  }
  return <section className="settings-directory work-register"><div className="work-section-title"><h1>{L('Work inbox','工作收件箱')}</h1><Button onClick={()=>{inbox.refresh();work.refresh()}}>{L('Refresh','刷新')}</Button></div>
    {decisionResult && <p role="status">{decisionResult}</p>}
    {work.data?.workflowActions.filter(action=>action.state==='pending').map(action=><article key={action.id} className="settings-group">
      <h2>{action.view?.label ?? action.id}</h2><p>{action.view?.current?.name} → {action.next?.name}</p>
      <div className="work-actions"><Button tone="primary" disabled={pending} onClick={()=>void decide(action,'approve')}>{L('Approve','批准')}</Button>
      <Button disabled={pending} onClick={()=>void decide(action,'decline')}>{L('Decline','拒绝')}</Button></div></article>)}
    {inbox.error ? <p role="alert">{L('Could not read the inbox.','收件箱读取失败。')} <Button onClick={inbox.refresh}>{L('Retry','重试')}</Button></p>
      : !inbox.data ? <p role="status">{L('Loading…','正在读取…')}</p>
      : <><p className="work-caption">{L('Unread','未读')} {inbox.data.unread ?? 0} · {L('Total','全部')} {inbox.data.total}</p>
        {inbox.data.items.length ? <ul className="work-list">{inbox.data.items.map(item => <li key={item.id}>
          <div><strong>{workflowFor(item)?.view?.label ?? labels[item.kind]}</strong><small>{labels[item.kind]} · {item.sourceLabel==='Local operator'?L('Local workspace','本地工作区'):item.sourceLabel}{item.read ? ' · '+L('Read','已读') : ''}</small></div>
          <Button onClick={() => {select(item.id);setFailed(false);setObservation('')}}>{L('View record','查看记录')}</Button>
        </li>)}</ul> : <EmptyState>{L('Your inbox is empty.','收件箱暂无记录。')}</EmptyState>}
        {(offset > 0 || inbox.data.more) && <div className="work-actions"><Button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-25))}>{L('Previous','上一页')}</Button><Button disabled={!inbox.data.more} onClick={()=>setOffset(offset+25)}>{L('Next','下一页')}</Button></div>}
      </>}
    <Dialog open={!!current} title={current ? workflowFor(current)?.view?.label ?? labels[current.kind] : L('Record','记录')} closeLabel={L('Close','关闭')} onClose={()=>select(null)}>
      {current && <div className="work-detail"><p>{labels[current.kind]} · {current.sourceLabel}</p>
        {current.createdAt !== null && <p>{L('Created','创建时间')} · {stamp(current.createdAt)}</p>}
        {effect && <section><h3>{L('Effect receipt','操作回执')}</h3><p>{effect.kind === 'unknown' ? L('External write result unknown','外部写入结果未知') : effect.kind}</p>
          {typeof effect.attemptedAt === 'number' && <p>{L('Last attempt','尝试时间')} · {stamp(effect.attemptedAt)}</p>}
          {typeof effect.observedAt === 'number' && <p>{L('Remote observation','远端核对时间')} · {stamp(effect.observedAt)}</p>}</section>}
        {effect?.kind==='unknown' && current.next.kind==='workflow' && <Button disabled={pending} onClick={()=>void reconcile(current.next.id)}>{L('Check remote state','核对远端状态')}</Button>}
        {observation && <p role="status">{observation}</p>}
        {failed && <p role="alert">{L('This record changed. Refresh the inbox.','记录已变化，请刷新收件箱。')}</p>}
        <div className="work-actions">{!current.read && <Button disabled={pending} onClick={()=>void mark(current)}>{L('Mark read','标为已读')}</Button>}
        {current.taskRef && <a className="rp-button" href={'/configure#execution-trace/'+encodeURIComponent(current.taskRef.id)}>{L('Task progress','查看任务进展')}</a>}
        <a className="rp-button" href="/configure#tasks/attention">{L('Handle in activity','前往处理原事项')}</a></div>
      </div>}
    </Dialog>
  </section>
}

export function TaskProgress({ L, language, requested }: Props & { requested: string }) {
  const {data,error,refresh} = useWorkspaceRead<{tasks:{id:string;label:string}[];more:boolean;total:number}>('/api/execution-trace?limit=100')
  const [selected, select] = useState(requested)
  const taskId = selected || data?.tasks[0]?.id
  return <article className="settings-directory work-register"><h1>{L('Task progress','任务进展')}</h1>
    {error ? <Button onClick={refresh}>{L('Retry loading tasks','重新读取任务')}</Button> : !data ? <p role="status">{L('Loading…','正在读取…')}</p> : <>
      <label className="work-field">{L('Task','任务')}<SelectField id="trace-task" value={taskId ?? ''} onChange={e=>select(e.target.value)}>
        {requested && !data.tasks.some(task=>task.id===requested) && <option value={requested}>{requested}</option>}
        {data.tasks.map(task=><option key={task.id} value={task.id}>{task.label ?? task.id}</option>)}</SelectField></label>
      {taskId ? <TaskProgressSnapshot key={taskId} ticketId={taskId} language={language}/> : <EmptyState>{L('No recorded tasks.','暂无任务。')}</EmptyState>}
    </>}</article>
}

export function ResourceBreakdown({L,language}:Props) {
  const {data,error,refresh}=useWorkspaceRead<ResourceUsageSnapshot>('/api/resource-usage')
  const context=data?.accounting?.lastContextCheck
  return <section className="settings-group work-register" aria-labelledby="resource-breakdown"><h2 id="resource-breakdown">{L('Usage and reservations','实际用量与预留')}</h2>
    {error ? <Button onClick={refresh}>{L('Retry','重试')}</Button> : !data ? <p role="status">{L('Loading…','正在读取…')}</p> :
    <dl className="work-facts"><div><dt>{L('Reported model tokens','模型已报告 Token')}</dt><dd>{data.usage.tokens.totalTokens !== null ? data.usage.tokens.totalTokens.toLocaleString(language) : L('Unreported','尚未报告')}</dd></div>
    <div><dt>{L('Context reserved at last check','最近一次上下文预留')}</dt><dd>{context ? context.reservedBytes.toLocaleString(language)+' B' : L('No measurement','暂无测量')}</dd></div>
    <div><dt>{L('Billed cost','实际费用')}</dt><dd>{L('No billing evidence','暂无账单凭据')}</dd></div></dl>}</section>
}
