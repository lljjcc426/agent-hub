import { useState } from 'react'
import {
  Activity,
  ArrowUpRight,
  Bell,
  Check,
  CircleAlert,
  File,
  FileSearch,
  FileText,
  Folder,
  Inbox,
  LayoutPanelLeft,
  ListTodo,
  LoaderCircle,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Search,
} from 'lucide-react'
import {
  AgentAvatar,
  AgentIdentity,
  Brand,
  Breadcrumb,
  Button,
  CheckField,
  ChoiceGroup,
  Disclosure,
  EmptyState,
  IconButton,
  NavLink,
  SelectField,
  Sidebar,
  StatusMark,
  TextField,
  Topbar,
  SwitchView,
  switchView,
} from '../ui'
import { fileName, tasks, type Task } from './samples.tsx'

export type DisplayMode = 'group' | 'agents'

export function Basics({
  openFile,
  taskDetails,
  compact = false,
  showTime,
  setShowTime,
}: {
  openFile: () => void
  taskDetails: (task: Task) => void
  compact?: boolean
  showTime: boolean
  setShowTime: (v: boolean) => void
}) {
  const [scope, setScope] = useState<'all' | 'files' | 'tasks'>('all')
  const [q, setQ] = useState('')
  const [checked, setChecked] = useState(false)
  const [order, setOrder] = useState('default')
  const options = [
    { name: fileName, kind: 'files', icon: FileText, open: openFile },
    ...tasks.map((t) => ({ name: t.title, kind: 'tasks', icon: ListTodo, open: () => taskDetails(t) })),
  ]
  const results = options.filter(
    (item) => (scope === 'all' || item.kind === scope) && item.name.includes(q.trim()),
  )
  if (order === 'name') results.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  const searching = !!q.trim() || scope !== 'all' || !compact
  return (
    <div className="control-samples">
      <div className="sample-group">
        <h3>按钮</h3>
        <div className="control-row">
          <Button tone="primary" onClick={openFile}>
            <File size={15} />
            预览文件
          </Button>
          <Button onClick={() => taskDetails(tasks[0]!)}>详情</Button>
          <Button disabled>禁用</Button>
        </div>
      </div>
      <div className="sample-group">
        <h3>输入与筛选</h3>
        <TextField
          type="search"
          icon={<Search size={16} />}
          placeholder="搜索文件或任务"
          label="搜索文件或任务"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="control-row">
          <ChoiceGroup
            label="范围"
            value={scope}
            onChange={(v) => switchView('panel', () => setScope(v))}
            choices={[
              { value: 'all', label: '全部' },
              { value: 'files', label: '文件' },
              { value: 'tasks', label: '任务' },
            ]}
          />
          {!compact && (
            <SelectField label="结果排序" value={order} onChange={(e) => setOrder(e.target.value)}>
              <option value="default">默认顺序</option>
              <option value="name">按名称</option>
            </SelectField>
          )}
        </div>
        <SwitchView>
          <div>
            {searching && (
              <div className="search-results">
                {results.map((item) => (
                  <button key={item.name} onClick={item.open}>
                    <item.icon size={15} />
                    {item.name}
                    <ArrowUpRight size={13} />
                  </button>
                ))}
                {!results.length && <EmptyState icon={<FileSearch size={18} />}>没有匹配的结果</EmptyState>}
              </div>
            )}
          </div>
        </SwitchView>
      </div>
      <div className="sample-group">
        <h3>选择与开关</h3>
        <div className="control-row split">
          <CheckField label="标记为已读" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <CheckField
            label="消息时间"
            appearance="switch"
            checked={showTime}
            onChange={(e) => setShowTime(e.target.checked)}
          />
        </div>
      </div>
    </div>
  )
}

function LayoutMiniature({ type }: { type: DisplayMode }) {
  return (
    <span aria-hidden="true" className="layout-miniature" data-mode={type}>
      {type === 'agents' && (
        <span className="mini-list">
          <span>
            <AgentAvatar size={11} />
            Router
          </span>
          <span>
            <AgentAvatar id="doc" kind="worker" size={11} />
            文档助手
          </span>
        </span>
      )}
      <span className="mini-thread">
        <span className="mini-user">发布清单</span>
        <span className="mini-reply">
          <AgentAvatar size={13} />
          <span>已整理好</span>
        </span>
      </span>
    </span>
  )
}

export function DisplayChoice({
  value,
  onChange,
}: {
  value: DisplayMode
  onChange: (v: DisplayMode) => void
}) {
  return (
    <ChoiceGroup
      label="聊天显示"
      appearance="tiles"
      value={value}
      onChange={onChange}
      choices={[
        { value: 'group', label: '群聊', visual: <LayoutMiniature type="group" /> },
        { value: 'agents', label: 'Agents 列表', visual: <LayoutMiniature type="agents" /> },
      ]}
    />
  )
}

export function NavigationExample() {
  const [selected, setSelected] = useState('对话')
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className="shell-example" data-collapsed={collapsed}>
      <Sidebar brand={<Brand />} label="示例导航">
        {[
          { label: '对话', icon: MessageSquare },
          { label: '任务', icon: ListTodo },
          { label: '待处理', icon: Inbox },
        ].map(({ label, icon: Icon }) => (
          <NavLink
            key={label}
            href="#navigation"
            current={selected === label}
            title={label}
            icon={<Icon size={17} />}
            onClick={(e) => {
              e.preventDefault()
              switchView('panel', () => setSelected(label))
            }}
          >
            {label}
          </NavLink>
        ))}
      </Sidebar>
      <div className="shell-stage">
        <Topbar
          start={
            <IconButton
              label={collapsed ? '展开示例导航' : '折叠示例导航'}
              onClick={() => setCollapsed(!collapsed)}
            >
              <PanelLeft size={17} />
            </IconButton>
          }
          end={<span className="shell-mobile-title">{selected}</span>}
        />
        <SwitchView>
          <div className="shell-page">
            <Breadcrumb label="示例路径" items={[{ label: '工作区' }, { label: selected }]} />
            <h3>{selected}</h3>
            {selected === '对话' ? (
              <AgentIdentity name="Router" detail="准备就绪" />
            ) : selected === '任务' ? (
              <div className="sample-line">
                <ListTodo size={17} />
                整理发布清单
              </div>
            ) : (
              <EmptyState icon={<Inbox size={20} />}>暂无待处理事项</EmptyState>
            )}
          </div>
        </SwitchView>
      </div>
    </div>
  )
}

export function Feedback({
  notify,
  openFile,
  openTask,
  clear,
}: {
  notify: (text: string) => void
  openFile: () => void
  openTask: () => void
  clear: () => void
}) {
  const [state, setState] = useState<'content' | 'loading' | 'empty' | 'error'>('content')
  return (
    <div className="feedback-sections">
      <section>
        <h2>浮层</h2>
        <div className="control-row">
          <Button onClick={openTask}>
            <PanelRight size={16} />
            侧面板
          </Button>
          <Button onClick={openFile}>
            <LayoutPanelLeft size={16} />
            预览弹窗
          </Button>
          <Button onClick={clear}>确认弹窗</Button>
          <Button onClick={() => notify('操作提示示例')}>
            <Bell size={15} />
            显示提示
          </Button>
        </div>
      </section>
      <section>
        <h2>任务状态</h2>
        <div className="control-row status-examples">
          <StatusMark state="working">进行中</StatusMark>
          <StatusMark state="waiting">待处理</StatusMark>
          <StatusMark state="done">已完成</StatusMark>
        </div>
      </section>
      <section>
        <h2>内容状态</h2>
        <ChoiceGroup
          label="内容状态"
          value={state}
          onChange={(v) => switchView('panel', () => setState(v))}
          choices={[
            { value: 'content', label: '内容' },
            { value: 'loading', label: '加载' },
            { value: 'empty', label: '空' },
            { value: 'error', label: '错误' },
          ]}
        />
        <SwitchView>
          <div className="feedback-stage">
            {state === 'content' && (
              <div className="feedback-content">
                <Folder size={21} />
                <span>交付文件</span>
                <Button tone="quiet" onClick={openFile}>
                  查看
                  <ArrowUpRight size={14} />
                </Button>
              </div>
            )}
            {state === 'loading' && (
              <div role="status" className="sample-line">
                <LoaderCircle className="rp-spin" size={18} />
                正在加载
              </div>
            )}
            {state === 'empty' && <EmptyState icon={<Inbox size={23} />}>暂无交付文件</EmptyState>}
            {state === 'error' && (
              <div className="sample-line" role="alert">
                <CircleAlert size={18} />
                文件未能载入
                <Button onClick={() => switchView('panel', () => setState('content'))}>重试</Button>
              </div>
            )}
          </div>
        </SwitchView>
      </section>
      <section>
        <h2>折叠详情</h2>
        <Disclosure
          title={
            <span className="sample-line">
              <Activity size={15} />
              工具调用
            </span>
          }
        >
          <span className="detail-receipt">
            <span>读取发布清单</span>
            <span>
              <Check size={14} /> 已完成
            </span>
          </span>
        </Disclosure>
      </section>
    </div>
  )
}
