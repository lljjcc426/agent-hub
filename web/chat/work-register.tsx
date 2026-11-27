import { Button } from '../ui'
import type { ResourceUsageSnapshot } from '../../src/resource-usage.ts'
import type { WorkPageProps as Props } from './work-items.ts'
import { useWorkspaceRead } from './workspace-read.ts'
import './work-register.css'

export function ResourceBreakdown({L,language}:Props) {
  const {data,error,refresh}=useWorkspaceRead<ResourceUsageSnapshot>('/api/resource-usage')
  const context=data?.accounting?.lastContextCheck
  return <section className="settings-group work-register" aria-labelledby="resource-breakdown"><h2 id="resource-breakdown">{L('Usage and reservations','实际用量与预留')}</h2>
    {error ? <Button onClick={refresh}>{L('Retry','重试')}</Button> : !data ? <p role="status">{L('Loading…','正在读取…')}</p> :
    <dl className="work-facts"><div><dt>{L('Reported model tokens','模型已报告 Token')}</dt><dd>{data.usage.tokens.totalTokens !== null ? data.usage.tokens.totalTokens.toLocaleString(language) : L('Unreported','尚未报告')}</dd></div>
    <div><dt>{L('Context reserved at last check','最近一次上下文预留')}</dt><dd>{context ? context.reservedBytes.toLocaleString(language)+' B' : L('No measurement','暂无测量')}</dd></div>
    <div><dt>{L('Billed cost','实际费用')}</dt><dd>{L('No billing evidence','暂无账单凭据')}</dd></div></dl>}</section>
}
