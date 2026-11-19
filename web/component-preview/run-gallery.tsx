import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowUpRight, Play, RotateCcw } from 'lucide-react'
import { Button } from '../ui/controls.tsx'
import {
  AgentSequence,
  CommitTrail,
  ThinkingState,
  type SequenceMessage,
  type SequenceParticipant,
  type ThinkingStep,
  type TrailCommit,
} from '../ui/run-visualizations.tsx'
import './agent-gallery.css'
import './run-gallery.css'

const thinkingSteps: Array<Omit<ThinkingStep, 'state'> & { at: number }> = [
  {
    id: 'search', at: 0, kind: 'search', label: '已搜索', activeLabel: '正在搜索',
    sources: [
      { label: '本周发布清单.md', title: '本次发布的核对项目' },
      { label: 'GitHub 发布指南', href: 'https://docs.github.com/zh/repositories/releasing-projects-on-github/about-releases' },
      { label: '历史版本记录.md', title: '上一版的变更与已知问题' },
      { label: '验收结果汇总.csv', title: '已通过和待补充的验收项' },
      { label: '版本号规范', href: 'https://semver.org/lang/zh-CN/' },
      { label: '回滚记录.md', title: '上一次发布的回滚演练结果' },
      { label: '对外说明.md', title: '发布公告草稿' },
    ],
  },
  { id: 'read', at: 1720, label: '阅读 7 处发布资料' },
  { id: 'compare', at: 3380, label: '比对本次改动和历史版本' },
  { id: 'verify', at: 4850, label: '核对验收结果和回滚记录' },
  { id: 'review', at: 6280, label: '整理待确认项' },
]

const router = { name: 'Router', agent: true }
const worker = { name: '文档助手', agent: true }
const releaseBranch = 'release/checklist'
const docsBranch = 'docs/release-guide'
const defaultExpanded = ['4a64da90']
const branchNames = ['main', releaseBranch, docsBranch] as const
const branchCommits: TrailCommit[] = [
  {
    id: 'c7f823b4', message: '标记发布前必查项', author: worker, time: '27 分',
    date: '11 月 19 日 17:32', files: 2, added: 37, removed: 5,
    body: '按风险和负责人标记检查项目。',
  },
  {
    id: 'a493dd16', message: '补齐链接核对说明', author: { name: 'Alex' }, coAuthor: worker,
    time: '41 分', date: '11 月 19 日 17:18', files: 1, added: 14,
    body: '补充文档链接的核对方法。',
  },
  {
    id: '23fe896c', message: '归档 `checklist.csv`', author: router, time: '48 分',
    date: '11 月 19 日 17:11', files: 1, added: 11, removed: 3,
  },
]
const docsCommits: TrailCommit[] = [
  {
    id: '3a9d8815', message: '记录回滚检查顺序', author: worker, time: '55 分',
    date: '11 月 19 日 17:04', kind: 'docs', files: 1, added: 9,
    body: '按恢复优先级组织回滚前的检查清单。',
  },
  {
    id: '2bd440da', message: '补充通知渠道', author: { name: 'Alex' }, time: '1 小时',
    date: '11 月 19 日 16:56', kind: 'docs', added: 6,
  },
]
const mainCommits: TrailCommit[] = [
  {
    id: 'bbe14a25', message: '更新 `package.json` 的版本', author: { name: 'Alex' },
    time: '12 分', date: '11 月 19 日 17:47', kind: 'release', files: 1, added: 2, removed: 2,
    body: '更新本次发布的版本号。',
  },
  {
    id: '4a64da90', message: '合并 `release/checklist`', author: router, time: '22 分',
    kind: 'merge', commits: branchCommits,
  },
  {
    id: 'fa236825', message: '统一检查项的状态文案', author: { name: 'Alex' },
    time: '49 分', date: '11 月 19 日 17:10', kind: 'fix', files: 3, added: 18, removed: 9,
    body: '统一待核对、已通过和需调整三个状态的显示。',
  },
  {
    id: '125eb4b3', message: '合并 `docs/release-guide`', author: router, time: '52 分',
    kind: 'merge', commits: docsCommits,
  },
]
const firstCommit: TrailCommit = {
  id: '7c821fa6', message: '保存发布前核对结果', author: worker, time: '刚刚',
  date: '11 月 19 日 17:59', kind: 'feature', files: 2, added: 28, removed: 4,
  body: '更新发布清单，附上各项检查的验收记录。',
}
const secondCommit: TrailCommit = {
  id: 'ff20ea4c', message: '修复 `summary.md` 的引用', author: router, coAuthor: worker,
  time: '刚刚', date: '11 月 19 日 18:00', kind: 'fix', files: 1, added: 3, removed: 3,
  body: '指向本次发布的验收记录和对外说明。',
}

const participants: SequenceParticipant[] = [
  { id: 'user', name: '你', kind: 'person', description: '提交发布核对请求，查看检查结果。' },
  { id: 'router', name: 'Router', kind: 'agent', model: 'Codex', description: '拆解请求、派发工作并汇总结果。' },
  { id: 'worker', name: '文档助手', kind: 'agent', description: '读取清单，逐项核对已有的验收记录。' },
  { id: 'files', name: '文件工具', kind: 'tool', description: '读取任务工作区里的文件。' },
]
const messages: SequenceMessage[] = [
  {
    id: 'request', from: 'user', to: 'router', label: '核对发布清单', timeMs: 180,
    detail: '检查本次发布的清单，标出需要我确认的项目。',
  },
  {
    id: 'plan', from: 'router', to: 'router', label: '列出检查步骤', timeMs: 930,
    detail: '读取清单，对照验收记录，汇总待确认项。',
  },
  {
    id: 'delegate', from: 'router', to: 'worker', label: '检查文档与验收记录', timeMs: 1650,
    detail: '核对发布清单和验收记录，返回有疑问的条目。',
  },
  {
    id: 'read', from: 'worker', to: 'files', label: '读取预览版清单', timeMs: 2360, frame: '首次读取',
    detail: '请求读取 release/preview-checklist.md。',
  },
  {
    id: 'missing', from: 'files', to: 'worker', label: '预览文件不存在', kind: 'reply',
    replyTo: 'read', state: 'failed', timeMs: 3080, frame: '首次读取',
    detail: '预览版清单尚未生成，可以读取当前版本。',
  },
  {
    id: 'retry', from: 'worker', to: 'files', label: '读取当前清单', timeMs: 3800, frame: '重试',
    detail: '请求读取 release/checklist.md。',
  },
  {
    id: 'contents', from: 'files', to: 'worker', label: '返回 6 条检查项', timeMs: 4520,
    kind: 'reply', replyTo: 'retry', frame: '重试', detail: '读取成功。当前清单包含 6 个检查项。',
  },
  {
    id: 'report', from: 'worker', to: 'router', label: '4 项通过，2 项待确认', timeMs: 5320,
    kind: 'reply', replyTo: 'delegate', detail: '请确认版本号和对外说明，其他项目均已通过。',
  },
  {
    id: 'answer', from: 'router', to: 'user', label: '交付核对结果', timeMs: 6160,
    kind: 'reply', replyTo: 'request', detail: '清单核对完毕。请确认本次版本号和对外说明。',
  },
]

function useDemoTimeline(duration: number, autoStart = false) {
  const [run, setRun] = useState(autoStart ? 1 : 0)
  const [elapsed, setElapsed] = useState(autoStart ? 0 : duration)
  useEffect(() => {
    if (!run) return
    const start = performance.now()
    const timer = window.setInterval(() => {
      const next = Math.min(duration, performance.now() - start)
      setElapsed(next)
      if (next >= duration) window.clearInterval(timer)
    }, 65)
    return () => window.clearInterval(timer)
  }, [duration, run])
  return {
    run,
    elapsed,
    playing: elapsed < duration,
    play() {
      setElapsed(0)
      setRun((value) => value + 1)
    },
  }
}

function RunExample({
  id,
  title,
  name,
  demo,
  children,
}: {
  id: string
  title: string
  name: string
  demo: { run: number; play: () => void }
  children: ReactNode
}) {
  return (
    <section className="agent-example run-example">
      <header>
        <div>
          <h2>{title}</h2>
          <a href={`https://www.affectui.com/components/${id}`} target="_blank" rel="noreferrer">
            {name} <ArrowUpRight size={12} aria-hidden="true" />
          </a>
        </div>
        <Button
          tone="quiet"
          aria-label={`${demo.run ? '重播' : '播放'}${title}演示`}
          onClick={demo.play}
        >
          {demo.run ? <RotateCcw size={14} /> : <Play size={14} />}
          {demo.run ? '重播' : '播放'}
        </Button>
      </header>
      {children}
    </section>
  )
}

function ThinkingExample() {
  const demo = useDemoTimeline(7630, true)
  const visible = thinkingSteps.filter((step) => step.at <= demo.elapsed)
  return (
    <RunExample id="thinking-state" title="思考状态" name="Thinking State" demo={demo}>
      <ThinkingState
        key={demo.run}
        state={demo.playing ? 'running' : 'done'}
        elapsedMs={demo.elapsed}
        steps={visible.map(({ at: _at, ...step }, index) => ({
          ...step,
          state: demo.playing && index === visible.length - 1 ? 'working' : 'done',
        }))}
      />
    </RunExample>
  )
}

function CommitExample() {
  const [branch, setBranch] = useState<string>(branchNames[0])
  const demo = useDemoTimeline(11600, true)
  const firstVisible = demo.elapsed >= 1500
  const firstPending = demo.elapsed < 4810
  const secondVisible = demo.elapsed >= 8120
  const secondPending = demo.elapsed < 11480
  const commits = useMemo(() => {
    if (branch === releaseBranch) return branchCommits
    if (branch === docsBranch) return docsCommits
    return [
      ...(secondVisible ? [{ ...secondCommit, pending: secondPending }] : []),
      ...(firstVisible ? [{ ...firstCommit, pending: firstPending }] : []),
      ...mainCommits,
    ]
  }, [branch, firstVisible, firstPending, secondVisible, secondPending])
  return (
    <RunExample id="commit-trail" title="提交轨迹" name="Commit Trail" demo={{
      ...demo, play: () => { setBranch('main'); demo.play() },
    }}>
      <CommitTrail
        key={demo.run}
        branch={branch}
        branches={branchNames}
        commits={commits}
        onBranchChange={setBranch}
        hasMore={branch === 'main'}
        defaultExpanded={defaultExpanded}
      />
    </RunExample>
  )
}

function SequenceExample() {
  const demo = useDemoTimeline(7250)
  return (
    <RunExample id="agent-sequence" title="接力时序" name="Agent Sequence" demo={demo}>
      <AgentSequence
        key={demo.run}
        title="核对发布清单"
        participants={participants}
        messages={messages.filter((message) => message.timeMs! <= demo.elapsed)}
        running={demo.playing}
      />
    </RunExample>
  )
}

export function RunGallery() {
  return (
    <div className="agent-gallery run-gallery">
      <p className="run-gallery-note">使用示例数据，可单独播放每个组件。</p>
      <div className="agent-example-grid">
        <ThinkingExample />
        <CommitExample />
        <SequenceExample />
      </div>
    </div>
  )
}
