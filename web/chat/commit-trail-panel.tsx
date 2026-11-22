import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { ChatCommit, ChatCommitHistory } from '../../src/chat-commit-trail.ts'
import { Button, IconButton, SelectField } from '../ui/controls.tsx'
import { CommitTrail, type TrailCommit } from '../ui/run-visualizations.tsx'
import type { Localize } from './composer-commands.tsx'

type Target = { repository?: string; branch?: string }
export type GetCommitHistory = (target:Target, signal:AbortSignal) => Promise<ChatCommitHistory>

function timeAgo(at:number,L:Localize) {
  if (!Number.isFinite(at) || at <= 0) return ''
  const minutes = Math.max(0,Math.floor((Date.now()-at)/60000))
  if (!minutes) return L('Now','刚刚')
  if (minutes<60) return L(minutes+'m',minutes+' 分')
  if (minutes<1440) return L(Math.floor(minutes/60)+'h',Math.floor(minutes/60)+' 小时')
  return L(Math.floor(minutes/1440)+'d',Math.floor(minutes/1440)+' 天')
}

function viewCommit(commit:ChatCommit,L:Localize,dates:Intl.DateTimeFormat): TrailCommit {
  const date = new Date(commit.at)
  return {...commit,time:timeAgo(commit.at,L),date:commit.at>0&&Number.isFinite(date.getTime())?dates.format(date):undefined,
    commits:commit.commits?.map(child=>viewCommit(child,L,dates))}
}

export default function CommitTrailPanel({load, active, L, locale}: {
  load:GetCommitHistory; active:boolean; L:Localize; locale:string
}) {
  const [target,setTarget] = useState<Target>({})
  const [result,setResult] = useState<{target:Target; data:ChatCommitHistory}>()
  const data = result?.data
  const [failed,setFailed] = useState(false)
  const [pending,setPending] = useState(true)
  const [attempt,setAttempt] = useState(0)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    let timer:number|undefined
    async function refresh(initial=false) {
      try {
        if (initial || !document.hidden) {
          const history = await load(target,controller.signal)
          if (controller.signal.aborted) return
          setResult({target,data:history})
          setFailed(false)
          // Keep the local view fresh without polling an external connector.
          if (history.repository !== 'local') return
        }
        timer = window.setTimeout(()=>void refresh(),10000)
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      } finally {
        if (!controller.signal.aborted) setPending(false)
      }
    }
    void refresh(true)
    return ()=>{controller.abort();window.clearTimeout(timer)}
  }, [load, active, target, attempt])
  function retry() {
    setPending(true)
    setFailed(false)
    setAttempt(value=>value+1)
  }
  function select(next:Target) {
    setPending(true)
    setFailed(false)
    setTarget(next)
  }
  const visible = data && result?.target === target
  const dates = new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'})
  const commits = visible ? data.commits?.map(commit=>viewCommit(commit,L,dates)) ?? [] : []
  return <div className="commit-tray-content" aria-busy={pending}>
    <div className="commit-tray-controls">
      <h3>{L('Commit trail','提交轨迹')}</h3>
      {!!data?.repository && data.repositories.length>1 && <SelectField label={L('Choose repository','选择仓库')}
        value={pending ? target.repository??data.repository : data.repository} onChange={event=>select({repository:event.target.value})}>
        {data.repositories.map(repo=><option key={repo.id} value={repo.id}>{repo.label}</option>)}
      </SelectField>}
      {data?.repository && <IconButton label={L('Refresh commits','刷新提交记录')} onClick={retry} disabled={pending}><RefreshCw size={15}/></IconButton>}
    </div>
    {failed ? <div className="pending-empty" role="status">
      <p>{L('Could not read the commit history.','暂时无法读取提交记录。')}</p>
      <Button onClick={()=>{setTarget({});retry()}}>{L('Retry','重试')}</Button>
    </div> : pending && !visible ? <p className="pending-empty" role="status">{L('Loading commits…','正在读取提交记录…')}</p>
      : data?.repository && visible ? <>
        {data.repositories.length===1 && <p className="commit-tray-repository">{data.repositories[0]?.label}</p>}
        <CommitTrail key={data.repository+':'+data.branch} branch={data.branch || L('No branch','暂无分支')}
          branches={data.branches??[]} commits={commits} hasMore={data.hasMore} L={L}
          onBranchChange={branch=>select({repository:data.repository,branch})}/>
      </> : <p className="pending-empty" role="status">
        {L('Open a Git project conversation or connect your GitHub account.','打开关联 Git 项目的会话，或连接 GitHub 账号。')}
        {' '}<a href="/configure#connectors">{L('Connectors','连接器')}</a>
      </p>}
  </div>
}
