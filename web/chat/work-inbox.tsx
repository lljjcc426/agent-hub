import { useState } from 'react'
import { ArrowRight, CircleCheck, ClipboardCheck, Inbox, MessageCircle, RefreshCw, ScanLine } from 'lucide-react'
import { Button, Dialog, Disclosure, EmptyState, IconButton } from '../ui'
import type { OperatorAttentionItem, OperatorAttentionSnapshot } from '../../src/operator-attention.ts'
import { useWorkspaceRead } from './workspace-read.ts'
import { useWorkspaceTransport } from './workspace-context.tsx'
import { workDate, workHref, originalTaskHref, workspaceTasks, type Workflow, type WorkItems, type WorkPageProps, type WorkTask } from './work-items.ts'
import './work-pages.css'

type Item = OperatorAttentionItem
type TaskDetail = WorkTask & { message: string; sourceUrl?: string }

export function WorkInbox({ L, language }: WorkPageProps) {
  const [offset, setOffset] = useState(0)
  const inbox = useWorkspaceRead<OperatorAttentionSnapshot>('/entry-workspace/attention?inbox=1&offset=' + offset)
  const work = useWorkspaceRead<WorkItems>('/entry-workspace')
  const { binding } = useWorkspaceTransport()
  const [selected, select] = useState('')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [decisionResult, setDecisionResult] = useState('')
  const items = inbox.data?.items ?? []
  const tasks = workspaceTasks(work.data)
  const current = items.find(item => item.id === selected)
  const detail = useWorkspaceRead<TaskDetail>(current?.taskRef ? '/entry-workspace/task/' + encodeURIComponent(current.taskRef.id) : null)
  const workflowFor = (item: Item) => item.next.kind === 'workflow' ? work.data?.workflowActions.find(row => row.id === item.next.id) : undefined
  const linkedTask = (item: Item) => item.taskRef && tasks.get(item.taskRef.id)
  const names = {
    task_question: L('Task question','任务提问'), native_question: L('Agent question','助手提问'),
    native_approval: L('Permission request','权限申请'), workflow_review: L('Proposed change','待确认的变更'),
    project_review: L('Delivery to review','待验收的交付'), effect_unknown: L('Delivery receipt','发布回执'),
    open_work: L('Ongoing task','正在跟进的任务'),
  }
  const title = (item: Item) => {
    const task = linkedTask(item)
    const project = item.next.kind === 'project_review' && work.data?.projectReviews.find(row => row.id === item.next.id)
    return workflowFor(item)?.view?.label || (project && project.title) || task?.displayTitle || names[item.kind]
  }
  const isQuestion = (item: Item) => item.kind === 'task_question' || item.kind === 'native_question'
  const needsReply = items.filter(item => isQuestion(item) && item.state === 'needs_reply')
  const ongoing = items.filter(item => item.kind === 'open_work')
  const confirmations = items.filter(item => !needsReply.includes(item) && item.kind !== 'open_work')
  const extraActions = offset === 0 ? work.data?.workflowActions.filter(action => action.state === 'pending' && !items.some(item => item.next.kind === 'workflow' && item.next.id === action.id)) ?? [] : []
  const receipt = current && workflowFor(current)?.effectSummary
  const question = current?.kind === 'task_question' ? detail.data?.question || linkedTask(current)?.question : ''
  const states: Record<string,string> = {
    confirmed: L('Written and verified','已写入并核对'), observed: L('Remote state verified','已核对远端状态'), unknown: L('Publish result unconfirmed','写入结果待核对'),
    prepared: L('Ready to send','等待发送'), not_executed: L('Change not applied','变更未执行'), legacy: L('Earlier receipt','历史回执'),
    stale: L('Item has changed','事项已变更'), expired: L('Request expired','请求已过期'), unavailable: L('Request unavailable','请求已失效'),
  }
  function refresh() { work.refresh(); inbox.refresh() }
  function show(item: Item) { setFeedback(''); select(item.id) }
  async function decide(action: Workflow, decision: 'approve' | 'decline') {
    setPending(true); setDecisionResult('')
    try {
      const updated = await binding.request<Workflow>('/workflow-actions', { id: action.id, decision })
      const kind = updated.effectSummary?.kind
      const outcome = kind === 'confirmed' ? L('Written and verified','已写入并回读') : kind === 'not_executed' ? L('Change not applied','未执行变更') : L('Result still unconfirmed','结果待核对')
      setDecisionResult((action.view?.label ?? names.workflow_review) + ' · ' + outcome)
      refresh()
    } catch { setDecisionResult(L('Could not confirm the change. Check the receipt.','暂时无法确认，请查看回执。')) }
    finally { setPending(false) }
  }
  async function reconcile(id: string) {
    setPending(true); setFeedback('')
    try {
      const updated = await binding.request<Workflow>('/workflow-actions', { id, decision: 'reconcile' })
      const message = updated.effectSummary?.kind === 'observed' ? L('Remote state confirmed.','已核对远端状态。') : L('Remote state still unconfirmed.','远端状态仍待核对。')
      setFeedback(message); setDecisionResult(message); refresh()
    } catch { setFeedback(L('The connection could not confirm the result.','当前连接无法核对结果。')) }
    finally { setPending(false) }
  }
  async function mark(item: Item) {
    setPending(true); setFeedback('')
    try { await binding.request('/entry-workspace/attention/read', { id: item.id, observed: item.observed }); inbox.refresh() }
    catch { setFeedback(L('This item changed. Refresh to read it again.','事项已变化，请刷新后重试。')) }
    finally { setPending(false) }
  }
  function approval(action: Workflow) {
    return <article className="work-approval"><div><strong>{action.view?.label ?? names.workflow_review}</strong>
      {action.view?.current && action.next && <p>{action.view.current.name} → {action.next.name}</p>}</div>
      <div className="work-buttons"><Button tone="primary" disabled={pending} onClick={() => void decide(action, 'approve')}>{L('Approve','批准')}</Button>
        <Button disabled={pending} onClick={() => void decide(action, 'decline')}>{L('Decline','拒绝')}</Button></div></article>
  }
  function row(item: Item) {
    const action = workflowFor(item)
    if (action?.state === 'pending') return <li key={item.id}>{approval(action)}</li>
    const task = linkedTask(item)
    const prompt = item.kind === 'task_question' && task?.question
    const Icon = isQuestion(item) ? MessageCircle : item.kind === 'effect_unknown' ? ScanLine : item.kind === 'open_work' ? ClipboardCheck : CircleCheck
    const actionText = states[item.state] ? L('View item','查看事项') : isQuestion(item) ? L('View original request','查看原请求') : item.kind === 'effect_unknown' ? L('Check receipt','核对回执') : item.kind === 'open_work' ? L('View task','查看任务') : L('Review item','审核事项')
    return <li key={item.id} className="work-item"><span className="work-item-icon"><Icon size={21} aria-hidden="true"/></span>
      <div className="work-item-copy"><strong>{prompt || title(item)}</strong>
        {prompt && <span>{title(item)}</span>}
        {states[item.state] && <span>{states[item.state]}</span>}
        {item.kind === 'open_work' && task?.updatedAt && <time dateTime={task.updatedAt}>{workDate(task.updatedAt, language)}</time>}
        {item.read && <span className="work-read"><CircleCheck size={15}/>{L('Read','已读')}</span>}</div>
      {
        item.taskRef && ((item.kind==='native_question' && item.state==='needs_reply') || (item.kind==='native_approval' && item.state==='waiting_permission'))
          ? <a className="rp-button" data-tone="secondary" href={originalTaskHref(item.taskRef.id)}>{item.kind==='native_question'?L('Answer question','回答问题'):L('Review request','审核申请')}<ArrowRight size={16} aria-hidden="true"/></a>
          : <Button onClick={() => show(item)}>{actionText}<ArrowRight size={16} aria-hidden="true"/></Button>
      }</li>
  }
  return <section className="settings-directory work-page"><header className="work-heading"><h1>{L('Needs my attention','待我处理')}</h1>
    <IconButton label={L('Refresh inbox','刷新待办')} onClick={refresh}><RefreshCw size={18}/></IconButton></header>
    {decisionResult && <p role="status">{decisionResult}</p>}
    {inbox.error ? <p role="alert">{L('Could not load your inbox.','待办读取失败。')} <Button onClick={refresh}>{L('Retry','重试')}</Button></p>
      : !inbox.data ? <p role="status">{L('Loading your inbox…','正在读取待办…')}</p> : <>
        {needsReply.length > 0 && <section className="work-block inbox-questions"><h2>{L('Waiting for a reply','等你回复')}</h2><ul className="work-rows">{needsReply.map(row)}</ul></section>}
        {(confirmations.length > 0 || extraActions.length > 0) && <section className="work-block"><h2>{L('To review','需要确认')}</h2><ul className="work-rows">{confirmations.map(row)}{extraActions.map(a => <li key={a.id}>{approval(a)}</li>)}</ul></section>}
        {!needsReply.length && !confirmations.length && !extraActions.length && <EmptyState icon={<Inbox size={23}/>}>{inbox.data.more || offset ? L('No decisions on this page','这一页没有待处理事项') : L('You’re all caught up','待办已处理完')}</EmptyState>}
        {ongoing.length > 0 && <div className="work-follow"><Disclosure title={L('Tasks I’m following','跟进中的任务') + ' (' + ongoing.length + ')'}><ul className="work-rows">{ongoing.map(row)}</ul></Disclosure></div>}
        {(offset > 0 || inbox.data.more) && <div className="work-buttons"><Button disabled={!offset} onClick={() => setOffset(offset - 25)}>{L('Previous','上一页')}</Button><Button disabled={!inbox.data.more} onClick={() => setOffset(offset + 25)}>{L('Next','下一页')}</Button></div>}
      </>}
    <Dialog open={!!current} title={current ? title(current) : L('Item','事项')} closeLabel={L('Close','关闭')} onClose={() => select('')}>
      {current && <div className="work-sheet">
        {question && <section><h3>{L('Question for you','需要你回复的问题')}</h3><p className="work-quote">{question}</p></section>}
        {detail.data?.message && (isQuestion(current) || current.kind === 'open_work') && <section><h3>{L('Original request','原始请求')}</h3><p>{detail.data.message}</p></section>}
        <dl className="work-pairs">{question && !detail.data?.sourceUrl && <div><dt>{L('Where to reply','在哪里回复')}</dt><dd>{L('Original conversation','发起任务的原会话')}</dd></div>}<div><dt>{L('Source','来源')}</dt><dd>{current.sourceLabel === 'Local operator' ? L('Local workspace','本地工作区') : current.sourceLabel}</dd></div>
          {current.createdAt !== null && <div><dt>{L('Created','创建时间')}</dt><dd>{workDate(current.createdAt, language)}</dd></div>}
          {receipt && <div><dt>{L('Receipt','操作回执')}</dt><dd>{states[receipt.kind] ?? receipt.kind}</dd></div>}
          {receipt?.attemptedAt !== undefined && <div><dt>{L('Last attempt','尝试时间')}</dt><dd>{workDate(receipt.attemptedAt, language)}</dd></div>}
          {receipt?.observedAt !== undefined && <div><dt>{L('Last verified','核对时间')}</dt><dd>{workDate(receipt.observedAt, language)}</dd></div>}</dl>
        <div className="work-buttons">
          {receipt?.kind === 'unknown' && <Button tone="primary" disabled={pending} onClick={() => void reconcile(current.next.id)}>{L('Check remote state','核对远端状态')}</Button>}
          {detail.data?.sourceUrl && <a className="rp-button" data-tone="primary" href={detail.data.sourceUrl}>{L('Open original conversation','打开原会话')}</a>}
          {current.taskRef && <a className="rp-button" data-tone="secondary" href={workHref('execution-trace/' + encodeURIComponent(current.taskRef.id))}>{L('View progress','查看任务进度')}</a>}
          <a className="rp-button" data-tone="secondary" href={current.taskRef ? originalTaskHref(current.taskRef.id) : workHref('tasks/attention')}>{current.taskRef ? L('Open original task','打开原任务') : L('Open activity','打开待办记录')}</a>
          {!current.read && <Button tone="quiet" disabled={pending} onClick={() => void mark(current)}>{L('Mark read','标为已读')}</Button>}
        </div>{feedback && <p role="status">{feedback}</p>}
      </div>}
    </Dialog>
  </section>
}
