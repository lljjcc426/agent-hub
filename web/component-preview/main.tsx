import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowDownToLine,
  ArrowUpRight,
  FileText,
  LayoutGrid,
  Menu,
  MessageSquare,
  Moon,
  PanelRight,
  PanelsTopLeft,
  Settings2,
  SlidersHorizontal,
  Sun,
  Workflow,
} from 'lucide-react'
import {
  AgentIdentity,
  Brand,
  Breadcrumb,
  Button,
  CheckField,
  ChoiceGroup,
  Composer,
  Dialog,
  IconButton,
  Message,
  NavLink,
  ScheduleCard,
  DeliveryFileViewer,
  TaskActivityRow,
  Sidebar,
  Toast,
  Topbar,
  SwitchView,
  switchView,
} from '../ui'
import { ChatExample, reply, useDemoComposer, type DemoMessage } from './chat.tsx'
import { Basics, DisplayChoice, Feedback, NavigationExample, type DisplayMode } from './examples.tsx'
import {
  download,
  fileName,
  Sheet,
  states,
  TaskDetails,
  TaskList,
  tasks,
  type Task,
} from './samples.tsx'
import './preview.css'
import { sampleSchedule } from './schedule.ts'
import { nextTime } from '../../src/schedule-calendar.ts'
import { AgentGallery } from './agent-gallery.tsx'
import { DeliveredFileExample, DeliveryExample, sampleWorkbook, type ExampleReview } from './delivery.tsx'

const pages = [
  { id: 'overview', title: '总览', icon: LayoutGrid },
  { id: 'agents', title: 'Agent 组件', icon: Workflow },
  { id: 'basics', title: '基础控件', icon: SlidersHorizontal },
  { id: 'navigation', title: '导航与布局', icon: PanelsTopLeft },
  { id: 'chat', title: '对话', icon: MessageSquare },
  { id: 'work', title: '任务与文件', icon: FileText },
  { id: 'preferences', title: '设置选项', icon: Settings2 },
  { id: 'feedback', title: '浮层与反馈', icon: PanelRight },
] as const
type Page = (typeof pages)[number]['id']
const currentPage = () => pages.find((p) => '#' + p.id === location.hash)?.id ?? 'overview'

function Specimen({
  title,
  href,
  children,
  className = '',
}: {
  title: string
  href?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={'specimen ' + className}>
      <header className="specimen-head">
        <h2>{title}</h2>
        {href && (
          <a
            href={href}
            className="rp-icon-button"
            aria-label={'查看' + title + '组件'}
            title={'查看' + title + '组件'}
          >
            <ArrowUpRight size={17} />
          </a>
        )}
      </header>
      {children}
    </section>
  )
}

const workerReply = '发布清单已经核对，可以交付。'

function ReadOnlyWorker({ showTime, hasSample }: { showTime: boolean; hasSample: boolean }) {
  return (
    <div className="sample-chat readonly-worker">
      <div className="sample-transcript" aria-label="Worker 协作记录">
        {hasSample ? (
          <>
            <Message
              author="agent"
              time={showTime ? '09:41' : undefined}
              identity={<AgentIdentity name="Router" size={25} />}
            >
              <p>请整理附件里的三项发布检查。</p>
            </Message>
            <Message
              author="agent"
              time={showTime ? '09:42' : undefined}
              identity={<AgentIdentity name="文档助手" kind="worker" id="doc" size={25} />}
            >
              <p>{workerReply}</p>
            </Message>
          </>
        ) : (
          <p className="chat-empty">暂无协作记录</p>
        )}
      </div>
      <Composer
        value=""
        onChange={() => {}}
        onSend={() => {}}
        readOnly
        placeholder="请和 Router 对话"
        sendLabel="发送示例消息"
      />
    </div>
  )
}

function App() {
  const [page, setPage] = useState<Page>(currentPage)
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem('roppo-component-theme') === 'dark' ? 'dark' : 'light',
  )
  const [mobileNav, setMobileNav] = useState(false)
  const [time, setTime] = useState(true)
  const [mode, setMode] = useState<DisplayMode>('group')
  const [speaker, setSpeaker] = useState<'router' | 'worker'>('router')
  const [selectedTask, setSelectedTask] = useState(tasks[0]!.id)
  const [task, setTask] = useState<Task | null>(null)
  const [file, setFile] = useState(false)
  const [fileReview, setFileReview] = useState<ExampleReview>('pending')
  const [schedule, setSchedule] = useState(sampleSchedule)
  const [scheduleFile,setScheduleFile] = useState(false)
  const [targetMessage,setTargetMessage] = useState('')
  useEffect(()=>{
    if(page !== 'chat' || !targetMessage) return
    const row = document.querySelector<HTMLElement>('[data-message-id="'+CSS.escape(targetMessage)+'"] .message-line')
    row?.focus({preventScroll:true}); row?.scrollIntoView({block:'center'}); setTargetMessage('')
  },[page,targetMessage])
  const [confirmClear, setConfirmClear] = useState(false)
  const [messages, setMessages] = useState<DemoMessage[]>([])
  const draft = useDemoComposer()
  const [sample, setSample] = useState(true)
  const [notification, setNotification] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const label = pages.find((item) => item.id === page)!.title

  useEffect(() => {
    const navigate = () => {
      const next = currentPage()
      switchView('page', () => setPage(next))
      setMobileNav(false)
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('roppo-component-theme', theme)
  }, [theme])
  useEffect(() => {
    document.title = label + ' · Roppo 组件库'
  }, [label])
  useEffect(() => () => clearTimeout(timer.current), [])
  function notify(text: string) {
    clearTimeout(timer.current)
    setNotification(text)
    timer.current = setTimeout(() => setNotification(''), 2600)
  }
  function openTask(t: Task) {
    setSelectedTask(t.id)
    setTask(t)
  }
  function selectMode(next: DisplayMode) {
    switchView('panel', () => {
      setMode(next)
      setSpeaker('router')
    })
  }
  function clearSample() {
    setSample(false)
    setMessages([])
    draft.clearDraft()
    draft.setReactions({})
    setConfirmClear(false)
    notify('示例对话已清空')
  }
  const openFile = () => setFile(true)
  const deliveryExample = <DeliveryExample state={fileReview} onChange={setFileReview} />
  const showTask = () => openTask(tasks[0]!)
  const currentTask = tasks.find((item) => item.id === selectedTask)!
  const openTaskList = (compact = false) => (
    <TaskList compact={compact} selected={selectedTask} onSelect={openTask} />
  )
  const basics = (compact = false) => (
    <Basics
      compact={compact}
      openFile={openFile}
      taskDetails={openTask}
      showTime={time}
      setShowTime={setTime}
    />
  )
  function chat() {
    const latest = messages.at(-1)
    const routerDetail = latest ? latest.text || latest.attachment?.name : sample ? reply : '暂无消息'
    return (
      <SwitchView>
        <div className={mode === 'agents' ? 'sample-agents-layout' : 'sample-group-layout'}>
          {mode === 'agents' && (
            <div className="example-agent-list" aria-label="Agents 列表">
              {[
                { id: 'router', label: 'Router', detail: routerDetail },
                { id: 'worker', label: '文档助手', detail: sample ? workerReply : '暂无消息' },
              ].map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  aria-pressed={speaker === agent.id}
                  onClick={() => switchView('panel', () => setSpeaker(agent.id as typeof speaker))}
                >
                  <AgentIdentity
                    kind={agent.id === 'worker' ? 'worker' : 'router'}
                    id={agent.id === 'worker' ? 'doc' : agent.id}
                    name={agent.label}
                    detail={agent.detail}
                    size={23}
                  />
                </button>
              ))}
            </div>
          )}
          {mode === 'agents' && speaker === 'worker' ? (
            <ReadOnlyWorker showTime={time} hasSample={sample} />
          ) : (
            <ChatExample
              openFile={openFile}
              hasSample={sample}
              teamActivity={mode === 'group'}
              draft={draft}
              showTime={time}
              messages={messages}
              addMessage={(m) => setMessages((prev) => [...prev, m])}
            />
          )}
        </div>
      </SwitchView>
    )
  }
  const nav = pages.map(({ id, title, icon: Icon }) => (
    <NavLink
      current={page === id}
      key={id}
      href={'#' + id}
      icon={<Icon size={17} />}
      onClick={() => setMobileNav(false)}
    >
      {title}
    </NavLink>
  ))
  const brand = (
    <a className="brand-link" href="#overview" aria-label="Roppo 组件总览">
      <Brand />
    </a>
  )

  return (
    <div className="roppo-ui gallery" data-theme={theme}>
      <a
        className="skip"
        href="#gallery-content"
        onClick={(e) => {
          e.preventDefault()
          document.getElementById('gallery-content')?.focus()
        }}
      >
        跳到内容
      </a>
      <div className="gallery-rail">
        <Sidebar brand={brand} label="组件分类">
          {nav}
        </Sidebar>
      </div>
      <div className="gallery-workspace">
        <Topbar
          start={
            <>
              <span className="mobile-menu">
                <IconButton label="打开组件导航" onClick={() => setMobileNav(true)}>
                  <Menu size={19} />
                </IconButton>
              </span>
              <Breadcrumb label="当前位置" items={[{ label: '组件库', href: '#overview' }, { label }]} />
            </>
          }
          center={
            (page === 'overview' || page === 'chat') && (
              <button
                type="button"
                className="preview-companion"
                aria-label="查看当前任务进展"
                onClick={() => openTask(currentTask)}
              >
                <AgentIdentity name="Roppo" size={24} />
                <small>{states[currentTask.state]}</small>
              </button>
            )
          }
          end={
            <IconButton
              label={theme === 'light' ? '切换为深色' : '切换为浅色'}
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            >
              {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
            </IconButton>
          }
        />
        <SwitchView scope="page">
          <main id="gallery-content" tabIndex={-1} className={'gallery-main page-' + page}>
            <div className="page-title">
              <h1>{page === 'overview' ? '组件总览' : label}</h1>
              {(page === 'overview' || page === 'feedback') && (
                <a className="text-link" href="#agents">
                  Agent 组件
                  <ArrowUpRight size={15} />
                </a>
              )}
            </div>
            {page === 'overview' && (
              <div className="overview-grid">
                <Specimen title="对话" href="#chat" className="chat-spec">
                  {chat()}
                </Specimen>
                <Specimen title="基础控件" href="#basics" className="basics-spec">
                  {basics(true)}
                </Specimen>
                <Specimen title="任务与文件" href="#work" className="work-spec">
                  {openTaskList(true)}
                </Specimen>
                <Specimen title="聊天显示" href="#preferences" className="display-spec">
                  <DisplayChoice value={mode} onChange={selectMode} />
                </Specimen>
              </div>
            )}
            {page === 'agents' && <AgentGallery delivery={deliveryExample} />}
            {page === 'basics' && <div className="dedicated solo">{basics()}</div>}
            {page === 'navigation' && (
              <div className="dedicated">
                <Specimen title="侧栏与上栏">
                  <NavigationExample />
                </Specimen>
                <Specimen title="面包屑">
                  <Breadcrumb
                    label="路径示例"
                    items={[{ label: '组件库', href: '#overview' }, { label: '导航与布局' }]}
                  />
                </Specimen>
              </div>
            )}
            {page === 'chat' && (
              <div className="dedicated solo">
                <div className="view-controls">
                  <ChoiceGroup
                    label="对话显示"
                    value={mode}
                    onChange={selectMode}
                    choices={[
                      { value: 'group', label: '群聊' },
                      { value: 'agents', label: 'Agents 列表' },
                    ]}
                  />
                  <CheckField
                    appearance="switch"
                    label="消息时间"
                    checked={time}
                    onChange={(e) => setTime(e.target.checked)}
                  />
                </div>
                <div className="specimen chat-spec">{chat()}</div>
              </div>
            )}
            {page === 'work' && (
              <div className="dedicated">
                <div className="work-delivery-grid">
                  <Specimen title="交付验收">{deliveryExample}</Specimen>
                  <Specimen title="Worker 交付文件"><DeliveredFileExample file={sampleWorkbook} /></Specimen>
                </div>
                <Specimen title="任务列表">{openTaskList()}</Specimen>
                <Specimen title="任务动态">
                  <TaskActivityRow L={(_en, zh) => zh} agentName={() => tasks[0]!.agent}
                    activity={{id: 'release', title: tasks[0]!.title, state: 'completed', updatedAt: 0,
                      steps: [{id: 'owners', title: '按负责人分组', state: 'completed'}],
                      tickets: [{id: 'check', workerId: 'doc', title: '核对交付文件', state: 'completed',
                        reviewing: false, updatedAt: 0, summary: '已交付发布清单.xlsx'}]}}
                    onAgent={() => {setMode('agents'); setSpeaker('worker'); location.hash = 'chat'}}/>
                </Specimen>
                <Specimen title="定时任务">
                  <ScheduleCard plan={sample ? schedule : {...schedule,lastResult:null}} lang="zh-CN" L={(_en,zh)=>zh}
                    onMessage={id=>{setSpeaker('router');setTargetMessage(id);location.hash='chat'}}
                    onFile={()=>setScheduleFile(true)}
                    onChange={async (revision,patch)=>{
                      if(revision!==schedule.revision)throw Error('schedule_conflict')
                      const next={...schedule,...patch,revision:revision+1}
                      setSchedule({...next,nextAt:next.active?nextTime(next.timing,Date.now()):undefined})
                    }}/>
                  {scheduleFile && <DeliveryFileViewer file={sampleWorkbook} onClose={()=>setScheduleFile(false)} L={(_en,zh)=>zh}/>}
                  {import.meta.env.VITE_CHAT_URL && <a className="text-link" href={new URL('/chat#schedules',import.meta.env.VITE_CHAT_URL).href}>打开 Chat 定时任务<ArrowUpRight size={15}/></a>}
                </Specimen>
              </div>
            )}
            {page === 'preferences' && (
              <div className="dedicated solo">
                <section className="preferences-group">
                  <h2>聊天显示</h2>
                  <DisplayChoice value={mode} onChange={selectMode} />
                  <a className="text-link" href="#chat">
                    查看对话
                    <ArrowUpRight size={15} />
                  </a>
                </section>
                <section className="preferences-group">
                  <h2>记忆与上下文</h2>
                  <div className="preferences-row">
                    <span>仅限本页示例对话</span>
                    <div className="control-row">
                      {!sample && (
                        <Button
                          tone="quiet"
                          onClick={() => {
                            setSample(true)
                            notify('默认示例已恢复')
                          }}
                        >
                          恢复默认示例
                        </Button>
                      )}
                      <Button disabled={!sample && !messages.length} onClick={() => setConfirmClear(true)}>
                        清空…
                      </Button>
                    </div>
                  </div>
                </section>
              </div>
            )}
            {page === 'feedback' && (
              <div className="dedicated solo">
                <Feedback
                  notify={notify}
                  openTask={showTask}
                  openFile={openFile}
                  clear={() => setConfirmClear(true)}
                />
              </div>
            )}
          </main>
        </SwitchView>
      </div>
      <Dialog
        open={mobileNav}
        placement="start"
        title="组件导航"
        closeLabel="关闭导航"
        onClose={() => setMobileNav(false)}
      >
        <nav className="drawer-nav" aria-label="移动组件分类">
          {nav}
        </nav>
      </Dialog>
      <Dialog
        open={!!task}
        placement="side"
        title="任务详情"
        closeLabel="关闭任务详情"
        onClose={() => setTask(null)}
        footer={
          <Button
            tone="quiet"
            onClick={() => {
              setTask(null)
              location.hash = 'chat'
            }}
          >
            查看对话
            <ArrowUpRight size={15} />
          </Button>
        }
      >
        <TaskDetails task={task ?? currentTask} openFile={openFile} />
      </Dialog>
      <Dialog
        open={file}
        title={fileName}
        closeLabel="关闭文件预览"
        onClose={() => setFile(false)}
        footer={
          <a className="rp-button" data-tone="primary" href={download.href} download={fileName}>
            <ArrowDownToLine size={16} />
            下载文件
          </a>
        }
      >
        <Sheet />
      </Dialog>
      <Dialog
        open={confirmClear}
        title="清空示例对话？"
        role="alertdialog"
        closeLabel="关闭确认"
        onClose={() => setConfirmClear(false)}
        footer={
          <>
            <Button onClick={() => setConfirmClear(false)}>取消</Button>
            <Button tone="primary" onClick={clearSample}>
              确认清空
            </Button>
          </>
        }
      >
        <p>将移除本页的示例消息和附件。</p>
      </Dialog>
      <Toast message={notification} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
