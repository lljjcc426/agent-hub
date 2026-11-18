import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUpRight,
  ClipboardCheck,
  FileCheck2,
  FileText,
  FolderOpen,
  GitBranch,
  ListChecks,
  Network,
  PackageCheck,
  Pause,
  Play,
} from 'lucide-react'
import {
  AgentCrew,
  AgentHandoff,
  ToolAccessMap,
  ToolCallCard,
  type CallEntry,
  type HandoffLeg,
  type TeamMember,
  type ToolNode,
} from '../ui/agent-team.tsx'
import {
  AgentCheckpoints,
  AgentMonitor,
  AgentPlan,
  type Attempt,
  type PlanStep,
  type RunPhase,
} from '../ui/agent-run.tsx'
import {
  ApprovalCard,
  ContextWindow,
  DecisionCard,
  MemoryPanel,
  type Approval,
  type MemoryEntry,
} from '../ui/agent-decisions.tsx'
import { Button, ChoiceGroup, SwitchView, switchView } from '../ui'
import './agent-gallery.css'

const examples = [
  { id: 'agent-crew', title: 'Agent 团队', name: 'Agent Crew', group: 'team' },
  { id: 'tool-access-map', title: '工具连接图', name: 'Tool Access Map', group: 'team' },
  { id: 'agent-plan', title: '执行计划', name: 'Agent Plan', group: 'run' },
  { id: 'agent-monitor', title: '运行监视器', name: 'Agent Monitor', group: 'run' },
  { id: 'tool-call-card', title: '工具调用', name: 'Tool Call Card', group: 'run' },
  { id: 'agent-checkpoints', title: '检查点', name: 'Agent Checkpoints', group: 'run' },
  { id: 'agent-handoff', title: '任务交接', name: 'Agent Handoff', group: 'team' },
  { id: 'file-delivery', title: '交付验收', name: '任务与文件', group: 'run', href: '#work' },
  { id: 'context-window', title: '上下文用量', name: 'Context Window', group: 'context' },
  { id: 'approval-card', title: '授权请求', name: 'Approval Card', group: 'context' },
  { id: 'decision-card', title: '决策卡', name: 'Decision Card', group: 'context' },
  { id: 'memory-panel', title: '记忆', name: 'Memory Panel', group: 'context' },
] as const
type Category = 'all' | (typeof examples)[number]['group']
const defaultPlan: PlanStep[] = [
  { id: 'read', title: '读取发布清单', tool: 'read_file' },
  { id: 'verify', title: '核对文档链接', tool: 'check_links' },
  { id: 'deliver', title: '生成交付文件', tool: 'write_sheet' },
]
const members: TeamMember[] = [
  {
    id: 'router',
    name: 'Router',
    kind: 'router',
    model: 'Codex',
    task: '统筹发布清单',
    working: false,
    tokens: 12400,
    capacity: 128000,
    tools: ['团队', '派发', '交付'],
  },
  {
    id: 'doc',
    name: '文档助手',
    kind: 'worker',
    model: 'DeepSeek',
    task: '按负责人整理检查项',
    working: false,
    tokens: 28600,
    capacity: 128000,
    tools: ['文件', '链接', '表格'],
  },
  {
    id: 'research',
    name: '研究助手',
    kind: 'worker',
    model: 'Codex',
    task: '待命',
    working: false,
    tokens: 4300,
    capacity: 128000,
    tools: ['检索', '文档'],
  },
]
const handoffs: HandoffLeg[] = [
  {
    id: 'dispatch',
    label: '派发',
    from: 'Router',
    to: '文档助手',
    items: [
      { name: '原始清单.csv', carried: true },
      { name: '交付格式 · XLSX', carried: true },
      { name: '其他任务的聊天记录', carried: false },
    ],
  },
  {
    id: 'receipt',
    label: '交付',
    from: '文档助手',
    to: 'Router',
    items: [
      { name: '发布清单.xlsx', carried: true },
      { name: '三项检查的核对结果', carried: true },
      { name: '临时中间文件', carried: false },
    ],
  },
]
interface DemoTool extends ToolNode {
  owner: string
  success: string
}
const initialTools: DemoTool[] = [
  {
    id: 'team',
    owner: 'router',
    name: '查看团队',
    icon: <Network />,
    calls: 1,
    state: 'done',
    duration: '0.2 s',
    input: 'list_agents',
    args: { scope: 'chat' },
    result: '2 个 Worker',
    success: '2 个 Worker',
  },
  {
    id: 'assign',
    owner: 'router',
    name: '派发任务',
    icon: <GitBranch />,
    calls: 1,
    state: 'done',
    duration: '0.3 s',
    input: 'assign',
    args: { worker: 'doc' },
    result: '文档助手已接收',
    success: '文档助手已接收',
  },
  {
    id: 'status',
    owner: 'router',
    name: '查询进度',
    icon: <ListChecks />,
    calls: 0,
    state: 'unused',
    duration: '0.1 s',
    input: 'task_status',
    args: { task: 'release' },
    result: '等待调用',
    success: '清单已归类',
  },
  {
    id: 'deliver',
    owner: 'router',
    name: '读取交付',
    icon: <PackageCheck />,
    calls: 1,
    state: 'done',
    duration: '0.2 s',
    input: 'get_artifact',
    args: { name: '发布清单.xlsx' },
    result: '已找到发布清单.xlsx',
    success: '已找到发布清单.xlsx',
  },
  {
    id: 'read',
    owner: 'doc',
    name: '读取文件',
    icon: <FolderOpen />,
    calls: 2,
    state: 'done',
    duration: '0.4 s',
    input: 'read_file',
    args: { path: '原始清单.csv' },
    result: '3 行，2 位负责人',
    success: '3 行，2 位负责人',
  },
  {
    id: 'check',
    owner: 'doc',
    name: '核对链接',
    icon: <FileCheck2 />,
    calls: 1,
    state: 'error',
    duration: '0.6 s',
    input: 'check_links',
    args: { file: '发布说明.md' },
    result: '示例链接暂时无响应',
    success: '3 条链接检查通过',
  },
  {
    id: 'write',
    owner: 'doc',
    name: '写入表格',
    icon: <ClipboardCheck />,
    calls: 1,
    state: 'done',
    duration: '0.3 s',
    input: 'write_sheet',
    args: { sheet: '发布清单' },
    result: '已写入 3 行',
    success: '已写入 3 行',
  },
  {
    id: 'note',
    owner: 'doc',
    name: '写入摘要',
    icon: <FileText />,
    calls: 0,
    state: 'unused',
    duration: '0.2 s',
    input: 'write_note',
    args: { document: '交付摘要' },
    result: '等待调用',
    success: '摘要已保存',
  },
]
const initialAttempts: Attempt[] = [
  {
    id: 'first',
    label: '初次运行',
    points: [
      { id: 'read', title: '读入清单', time: '09:41' },
      { id: 'group', title: '按负责人归类', time: '09:42' },
      { id: 'check', title: '检查链接', time: '09:43' },
    ],
  },
]
const initialMemories: MemoryEntry[] = [
  { id: 'format', category: '偏好', text: '交付清单优先使用 XLSX 格式。', source: '来自对话' },
  { id: 'brief', category: '偏好', text: '完成后先告诉我结果。', source: '来自对话' },
  { id: 'release', category: '项目', text: '发布前需要核对文档链接。', source: '发布清单' },
]
const contextFiles = [
  { id: 'checklist', name: '发布清单.xlsx', tokens: 6800 },
  { id: 'notes', name: '发布说明.md', tokens: 4700 },
]

function useSampleRun(steps: PlanStep[]) {
  const [run, setRun] = useState<{ phase: RunPhase; elapsed: number }>({ phase: 'ready', elapsed: 0 })
  const stepMs = 1600,
    total = steps.length * stepMs
  useEffect(() => {
    if (run.phase !== 'running') return
    let last = performance.now()
    const clock = window.setInterval(() => {
      const now = performance.now(),
        delta = now - last
      last = now
      setRun((prev) => {
        if (prev.phase !== 'running') return prev
        const elapsed = Math.min(total, prev.elapsed + delta)
        return { phase: elapsed >= total ? 'done' : 'running', elapsed }
      })
    }, 100)
    return () => clearInterval(clock)
  }, [run.phase, total])
  function toggle() {
    setRun((r) =>
      r.phase === 'running'
        ? { ...r, phase: 'paused' }
        : r.phase === 'paused'
          ? { ...r, phase: 'running' }
          : { phase: 'running', elapsed: 0 },
    )
  }
  return {
    phase: run.phase,
    current: Math.min(steps.length, Math.floor(run.elapsed / stepMs)),
    measured: steps.map((s, i) => ({
      ...s,
      elapsed: Math.min(stepMs, Math.max(0, run.elapsed - i * stepMs)),
    })),
    cost: '$' + (run.elapsed * 0.0000025).toFixed(3),
    toggle,
    reset: () => setRun({ phase: 'ready', elapsed: 0 }),
  }
}

export function AgentGallery({ delivery }: { delivery: ReactNode }) {
  const [category, setCategory] = useState<Category>('all')
  const [crewMember, setCrewMember] = useState('router')
  const [owner, setOwner] = useState('doc'),
    [toolId, setToolId] = useState('read'),
    [tools, setTools] = useState(initialTools)
  const timers = useRef(new Set<number>())
  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t)
    },
    [],
  )
  const [leg, setLeg] = useState(0)
  const [plan, setPlan] = useState(defaultPlan)
  const run = useSampleRun(plan)
  const [attempts, setAttempts] = useState(initialAttempts),
    [activeAttempt, setActiveAttempt] = useState('first')
  const [files, setFiles] = useState(contextFiles),
    [compacted, setCompacted] = useState(false)
  const [memories, setMemories] = useState(initialMemories)
  const [removed, setRemoved] = useState<{ memory: MemoryEntry; index: number } | null>(null)
  const [approval, setApproval] = useState<Approval>('pending'),
    [answer, setAnswer] = useState<string | null>(null)

  const crew = members.map((m) =>
    m.id === 'doc' && run.phase === 'running'
      ? { ...m, working: true, task: plan[run.current]?.title ?? m.task }
      : m,
  )
  function replay(id: string, args?: Record<string, unknown>) {
    const tool = tools.find((t) => t.id === id)
    if (!tool || tool.state === 'running') return
    setTools((list) =>
      list.map((t) =>
        t.id === id ? { ...t, state: 'running', calls: t.calls + 1, args: args ?? t.args } : t,
      ),
    )
    const token = window.setTimeout(() => {
      setTools((list) => list.map((t) => (t.id === id ? { ...t, state: 'done', result: t.success } : t)))
      timers.current.delete(token)
    }, 1150)
    timers.current.add(token)
  }
  function rewind(attemptId: string, pointId: string) {
    const base = attempts.find((a) => a.id === attemptId)!
    const index = base.points.findIndex((p) => p.id === pointId),
      point = base.points[index]!
    const branch: Attempt = {
      id: crypto.randomUUID(),
      label: '尝试 ' + (attempts.length + 1),
      parent: { attemptId, pointId, title: point.title },
      points: [
        ...base.points.slice(0, index + 1),
        {
          id: crypto.randomUUID(),
          title: '重新执行' + point.title,
          time: new Intl.DateTimeFormat('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }).format(new Date()),
        },
      ],
    }
    switchView('panel', () => {
      setAttempts((a) => [...a, branch])
      setActiveAttempt(branch.id)
    })
  }
  const liveTools: DemoTool[] = tools.map((t) => {
    if (t.owner !== 'doc' || run.phase === 'ready') return t
    const active = plan[run.current]?.tool === t.input
    const finished = plan.slice(0, run.current).filter((s) => s.tool === t.input).length
    if (!active && !finished) return t
    const state = active
      ? run.phase === 'paused'
        ? 'paused'
        : 'running'
      : t.state === 'running'
        ? 'running'
        : 'done'
    return {
      ...t,
      state,
      calls: t.calls + finished + Number(active),
      result: state === 'done' ? t.success : state === 'paused' ? '已暂停' : '等待结果…',
    }
  })
  const calls: CallEntry[] = liveTools
    .filter((t) => t.id === 'read' || t.id === 'check')
    .map((t) => ({
      id: t.id,
      name: t.input,
      summary: t.name,
      status:
        t.state === 'error'
          ? 'error'
          : t.state === 'running'
            ? 'working'
            : t.state === 'paused'
              ? 'paused'
              : 'done',
      elapsed: t.state === 'running' ? '…' : t.duration,
      args: t.args,
      result: t.result,
    }))
  const content: Record<(typeof examples)[number]['id'], ReactNode> = {
    'file-delivery': delivery,
    'agent-crew': (
      <AgentCrew
        lead={crew[0]!}
        workers={crew.slice(1)}
        selected={crewMember}
        onSelect={(id) => switchView('panel', () => setCrewMember(id))}
      />
    ),
    'tool-access-map': (
      <ToolAccessMap
        agents={members.slice(0, 2)}
        agentId={owner}
        onAgentChange={(id) =>
          switchView('panel', () => {
            setOwner(id)
            setToolId(tools.find((t) => t.owner === id)!.id)
          })
        }
        tools={liveTools.filter((t) => t.owner === owner)}
        selected={toolId}
        onSelect={(id) => switchView('panel', () => setToolId(id))}
        onReplay={replay}
      />
    ),
    'agent-handoff': (
      <AgentHandoff
        route={[members[0]!, members[1]!, members[0]!]}
        legs={handoffs}
        active={leg}
        onChange={(n) => switchView('panel', () => setLeg(n))}
      />
    ),
    'tool-call-card': <ToolCallCard calls={calls} onRetry={replay} />,
    'agent-plan': (
      <AgentPlan
        title="发布清单"
        steps={plan}
        current={run.current}
        phase={run.phase}
        onChange={(steps) => {
          run.reset()
          setPlan(steps)
        }}
        onRun={run.toggle}
        createStep={() => ({ id: crypto.randomUUID(), title: '新步骤', tool: 'review' })}
      />
    ),
    'agent-monitor': (
      <AgentMonitor
        name="文档助手"
        model="DeepSeek"
        steps={run.measured}
        current={run.current}
        phase={run.phase}
        cost={run.cost}
        onToggle={run.toggle}
      />
    ),
    'agent-checkpoints': (
      <AgentCheckpoints
        attempts={attempts}
        active={activeAttempt}
        onSelect={setActiveAttempt}
        onRewind={rewind}
      />
    ),
    'context-window': (
      <ContextWindow
        capacity={64000}
        parts={[
          { id: 'system', label: '系统提示', tokens: 4200 },
          { id: 'tools', label: '工具定义', tokens: 8300 },
          { id: 'attachments', label: '附件', tokens: files.reduce((a, f) => a + f.tokens, 0), files },
          { id: 'conversation', label: '对话', tokens: compacted ? 7200 : 21600 },
          { id: 'memory', label: '记忆', tokens: 1800 },
        ]}
        canCompact={!compacted}
        onCompact={() => setCompacted(true)}
        onRemoveFile={(id) => setFiles((f) => f.filter((file) => file.id !== id))}
      />
    ),
    'approval-card': (
      <ApprovalCard
        title="发送发布清单"
        risk="外部发送"
        state={approval}
        details={[
          { label: '目的地', value: '测试群聊' },
          { label: '附件', value: '发布清单.xlsx' },
        ]}
        onDecision={setApproval}
        onReset={() => setApproval('pending')}
      />
    ),
    'decision-card': (
      <DecisionCard
        question="发布清单按什么顺序排列？"
        options={[
          { id: 'owner', label: '按负责人', detail: '同一位负责人的检查项放在一起', recommended: true },
          { id: 'time', label: '按截止时间', detail: '最早到期的排在前面' },
        ]}
        answer={answer}
        onAnswer={setAnswer}
        onReset={() => setAnswer(null)}
      />
    ),
    'memory-panel': (
      <>
        <MemoryPanel
          items={memories}
          categories={['偏好', '项目']}
          onEdit={(id, text) => setMemories((ms) => ms.map((m) => (m.id === id ? { ...m, text } : m)))}
          onDelete={(id) => {
            const index = memories.findIndex((m) => m.id === id)
            setRemoved({ memory: memories[index]!, index })
            setMemories((ms) => ms.filter((m) => m.id !== id))
          }}
        />
        {removed && (
          <div className="rp-undo">
            <span>已删除一条记忆</span>
            <Button
              tone="quiet"
              onClick={() => {
                const next = memories.slice()
                next.splice(removed.index, 0, removed.memory)
                setMemories(next)
                setRemoved(null)
              }}
            >
              撤销
            </Button>
          </div>
        )}
      </>
    ),
  }
  return (
    <div className="agent-gallery">
      <div className="agent-gallery-bar">
        <ChoiceGroup
          label="Agent 组件分类"
          value={category}
          onChange={(v) => switchView('filter', () => setCategory(v))}
          choices={[
            { value: 'all', label: '全部 ' + examples.length },
            { value: 'team', label: '协作' },
            { value: 'run', label: '执行' },
            { value: 'context', label: '上下文与决策' },
          ]}
        />
        <div className="agent-gallery-play">
          <span>发布清单 · 本地示例</span>
          <Button tone="primary" disabled={!plan.length} onClick={run.toggle}>
            {run.phase === 'running' ? <Pause size={14} /> : <Play size={14} />}
            {{ ready: '播放演示', running: '暂停演示', paused: '继续演示', done: '重新播放' }[run.phase]}
          </Button>
        </div>
      </div>
      <SwitchView scope="filter">
        <div className="agent-example-grid">
          {examples.map((ex) => (
            <section
              className="agent-example"
              key={ex.id}
              data-example={ex.id}
              hidden={category !== 'all' && category !== ex.group}
            >
              <header>
                <h2>{ex.title}</h2>
                <a
                  href={'href' in ex ? ex.href : 'https://www.affectui.com/components/' + ex.id}
                  target={'href' in ex ? undefined : '_blank'}
                  rel={'href' in ex ? undefined : 'noreferrer'}
                  aria-label={'href' in ex ? ex.name : '查看 Affect UI 的 ' + ex.name}
                  title={ex.name}
                >
                  {ex.name}
                  <ArrowUpRight size={13} />
                </a>
              </header>
              {content[ex.id]}
            </section>
          ))}
        </div>
      </SwitchView>
    </div>
  )
}
