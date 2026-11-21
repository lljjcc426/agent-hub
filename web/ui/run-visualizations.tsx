import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type FocusEvent,
  type ReactNode,
} from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileText,
  GitBranch,
  Globe,
  Hourglass,
  LoaderCircle,
  Maximize2,
  Search,
  UserRound,
  Wrench,
  X,
} from 'lucide-react'
import { AgentAvatar } from '../chat/agent-avatar.tsx'
import { CopyButton } from '../chat/copy-button.tsx'
import type { Localize } from '../chat/composer-commands.tsx'
import { SelectField } from './controls.tsx'
import { getMotionPreference } from './motion.ts'
import './run-visualizations.css'

const chinese: Localize = (_, zh) => zh

function timecode(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const clock = String(seconds % 60).padStart(2, '0')
  return minutes < 60
    ? `${minutes}:${clock}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${clock}`
}

function moveRowFocus(event: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowUp', 'ArrowDown', 'Home', 'End']
  if (!keys.includes(event.key) || !(event.target instanceof HTMLElement)) return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-run-row]'))
    .filter((row) => !row.closest('[inert]'))
  const index = rows.indexOf(event.target)
  if (index < 0) return
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? rows.length - 1
    : index + (event.key === 'ArrowUp' ? -1 : 1)
  event.preventDefault()
  rows[Math.min(rows.length - 1, Math.max(0, next))]?.focus()
}

function RunFold({ id, open, children }: { id: string; open: boolean; children: ReactNode }) {
  return (
    <div id={id} className="rv-fold" data-open={open} inert={!open} aria-hidden={!open}>
      <div>{children}</div>
    </div>
  )
}

export interface ThinkingSource {
  label: string
  href?: string
  title?: string
}

export interface ThinkingStep {
  id: string
  label: string
  state: 'working' | 'done' | 'failed' | 'interrupted'
  kind?: 'search'
  activeLabel?: string
  content?: ReactNode
  detail?: string
  sources?: ThinkingSource[]
}

function ThinkingViewport({ open, L, children }: { open: boolean; L: Localize; children: ReactNode }) {
  const windowRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useLayoutEffect(() => {
    const container = windowRef.current, viewport = viewportRef.current
    const content = viewport?.firstElementChild
    if (!open || !container || !viewport || !content) return
    let frame = 0
    const distance = () => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
    const updateEdges = () => {
      const before = viewport.scrollTop > 2, after = distance() > 2
      container.toggleAttribute('data-before', before)
      container.toggleAttribute('data-after', after)
      viewport.tabIndex = before || after ? 0 : -1
    }
    const reduced = getMotionPreference()
    const bottom = () => {
      viewport.scrollTop = viewport.scrollHeight
      updateEdges()
    }
    const resize = () => {
      updateEdges()
      if (!follow.current || frame || distance() <= 2) return
      let last = performance.now()
      const step = (now: number) => {
        const delta = distance()
        if (delta <= 2 || reduced.matches) {
          frame = 0
          bottom()
          return
        }
        viewport.scrollTop += Math.max(1, delta * (1 - Math.exp(-Math.min(64, now - last) / 58)))
        last = now
        frame = requestAnimationFrame(step)
      }
      frame = requestAnimationFrame(step)
    }
    const scroll = () => {
      if (!frame) follow.current = distance() <= 2
      updateEdges()
    }
    const stop = () => {
      cancelAnimationFrame(frame)
      frame = 0
      follow.current = false
    }
    const wheel = (event: WheelEvent) => { if (frame || event.deltaY < 0) stop() }
    const pointer = (event: globalThis.PointerEvent) => {
      if (event.pointerType === 'touch' || event.target === viewport ||
          event.target instanceof Element && event.target.closest('summary')) stop()
    }
    const keys = (event: globalThis.KeyboardEvent) => {
      if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(event.key)) stop()
    }
    if (follow.current) bottom()
    else updateEdges()
    const observer = new ResizeObserver(resize)
    observer.observe(viewport)
    observer.observe(content)
    viewport.addEventListener('scroll', scroll, { passive: true })
    viewport.addEventListener('wheel', wheel, { passive: true })
    viewport.addEventListener('pointerdown', pointer)
    viewport.addEventListener('keydown', keys)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      viewport.removeEventListener('scroll', scroll)
      viewport.removeEventListener('wheel', wheel)
      viewport.removeEventListener('pointerdown', pointer)
      viewport.removeEventListener('keydown', keys)
    }
  }, [open])
  return (
    <div className="rv-thinking-window" ref={windowRef}>
      <div className="rv-thinking-viewport" ref={viewportRef} role="region" aria-label={L('Thinking history', '思考记录')} tabIndex={-1}>
        {children}
      </div>
    </div>
  )
}

function SourceChip({ source, index }: { source: ThinkingSource; index: number }) {
  const id = useId()
  const Icon = source.href ? Globe : FileText
  const text = source.title ?? source.href
  const label = <><Icon size={12} aria-hidden="true" /><span>{source.label}</span></>
  return (
    <span className="rv-source-entry" style={{ '--rv-chip-order': index } as CSSProperties}>
      {source.href
        ? <a className="rv-source" href={source.href} target="_blank" rel="noreferrer" aria-describedby={text ? id : undefined}>{label}</a>
        : <span className="rv-source" title={text}>{label}</span>}
      {source.href && text && <span className="rv-source-tip" id={id} role="tooltip">{text}</span>}
    </span>
  )
}

function ThinkingSources({ sources, L }: { sources: ThinkingSource[]; L: Localize }) {
  const [expanded, setExpanded] = useState(false)
  const extraId = useId()
  const limit = 4
  const extra = sources.slice(limit)
  return (
    <div className="rv-sources">
      {sources.slice(0, limit).map((source, index) => <SourceChip key={index} source={source} index={index} />)}
      {extra.length > 0 && (
        <>
          <span id={extraId} className="rv-sources-extra" hidden={!expanded}>
            {extra.map((source, index) => <SourceChip key={index} source={source} index={index} />)}
          </span>
          <button type="button" className="rv-source-more" aria-controls={extraId}
            aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
            {expanded ? L('Show fewer sources', '收起来源') : L('+' + extra.length + ' sources', '+' + extra.length + ' 个来源')}
          </button>
        </>
      )}
    </div>
  )
}

function ThinkingClock({elapsedMs,liveSince,L}: {elapsedMs: number; liveSince?: number; L: Localize}) {
  const [now,setNow] = useState(Date.now)
  useEffect(() => {
    if (liveSince === undefined) return
    const tick = () => setNow(Date.now())
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [liveSince])
  const elapsed = liveSince === undefined ? elapsedMs : now - liveSince
  const seconds = Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / 1000)) : 0
  return <span className="rv-clock">{L(seconds + ' s', seconds + ' 秒')}</span>
}

export function ThinkingState({
  steps,
  state,
  elapsedMs,
  liveSince,
  L = chinese,
  defaultExpanded = true,
  scrollable = false,
}: {
  L?: Localize
  defaultExpanded?: boolean
  scrollable?: boolean
  steps: ThinkingStep[]
  state: 'running' | 'done' | 'failed'
  elapsedMs: number
  liveSince?: number
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const toggled = useRef(false)
  useEffect(() => {
    if (scrollable && defaultExpanded && !toggled.current) setExpanded(true)
  }, [scrollable, defaultExpanded])
  const id = useId()
  const label = { running: L('Thinking', '正在思考'), done: L('Thought for', '已思考'), failed: L('Interrupted', '思考已中断') }[state]
  const list = (
    <ol className="rv-thinking-steps" aria-live="polite" aria-relevant="additions">
      {steps.map((step) => {
        const active = state === 'running' && step.state === 'working'
        const search = step.kind === 'search' || !!step.sources?.length
        const failed = step.state === 'failed' || step.state === 'interrupted'
        return (
          <li className="rv-thinking-step" key={step.id} data-active={active || undefined} data-search={search || undefined}
            data-failed={failed || undefined}>
            <span className="rv-step-mark" aria-hidden="true">{failed ? <CircleAlert size={13} /> : search ? <Search size={15} /> : <i />}</span>
            <div className="rv-step-content">
              {step.content ?? <span className={active ? 'rv-thinking-sheen' : undefined}>{active && step.activeLabel ? step.activeLabel : step.label}</span>}
              {step.detail && <p>{step.detail}</p>}
              {!!step.sources?.length && <ThinkingSources sources={step.sources} L={L} />}
            </div>
          </li>
        )
      })}
      {state !== 'running' && (
        <li className="rv-thinking-step rv-thinking-terminal" data-result={state}>
          <span className="rv-step-mark" aria-hidden="true">{state === 'done' ? <Check size={13} /> : <CircleAlert size={14} />}</span>
          <span>{state === 'done' ? L('Finished thinking', '思考完成') : L('Thinking interrupted', '思考已中断')}</span>
        </li>
      )}
    </ol>
  )
  return (
    <section className="rv-thinking" aria-label={L("Thinking status", "思考状态")} data-state={state}>
      <button type="button" className="rv-thinking-head" aria-expanded={expanded} aria-controls={id}
        onClick={() => { toggled.current = true; setExpanded((open) => !open) }}>
        <span className="rv-thinking-mark" aria-hidden="true">
          <AgentAvatar size={17} />
          {state === 'running' && <span className="rv-thinking-sparks"><i /><i /><i /></span>}
        </span>
        <span className="rv-thinking-label" key={state}>
          <span className={state === 'running' ? 'rv-thinking-sheen' : undefined}>{label}</span>
        </span>
        <ThinkingClock L={L} elapsedMs={elapsedMs} liveSince={liveSince} />
        <ChevronDown className="rv-chevron" size={13} aria-hidden="true" />
      </button>
      <RunFold id={id} open={expanded}>
        {scrollable ? <ThinkingViewport open={expanded} L={L}>{list}</ThinkingViewport> : list}
      </RunFold>
    </section>
  )
}

interface CommitAuthor {
  name: string
  agent?: boolean
}

export interface TrailCommit {
  id: string
  message: string
  author: CommitAuthor
  coAuthor?: CommitAuthor
  time: string
  date?: string
  kind?: 'feature' | 'fix' | 'docs' | 'merge' | 'release'
  files?: number
  added?: number
  removed?: number
  body?: string
  pending?: boolean
  commits?: TrailCommit[]
}

const commitKinds = { feature: ['Feature','功能'], fix: ['Fix','修复'], docs: ['Docs','文档'],
  merge: ['Merge','合并'], release: ['Release','发布'] } as const

function CommitMessage({ message }: { message: string }) {
  return message.split(/([`][^`]+[`])/).map((text, index) => {
    if (!text.startsWith('`') || !text.endsWith('`')) return text
    const name = text.slice(1, -1)
    const Icon = /\.[\da-z]+$/i.test(name) ? FileText : GitBranch
    return <code key={index} title={name}><Icon size={11} aria-hidden="true" /><span>{name}</span></code>
  })
}

function CommitPerson({ author }: { author: CommitAuthor }) {
  return <span className="rv-commit-person">
    {author.agent
      ? <AgentAvatar id={author.name} kind={author.name === 'Router' ? 'router' : 'worker'} size={14} />
      : <UserRound size={14} aria-hidden="true" />}
    {author.name}
  </span>
}

function CommitRow({
  commit,
  open,
  nested,
  index,
  subRows,
  onToggle,
  L,
}: {
  L: Localize
  commit: TrailCommit
  open: boolean
  nested: boolean
  index: number
  subRows?: ReactNode
  onToggle: () => void
}) {
  const detailsId = useId()
  const [wasWriting, setWasWriting] = useState(Boolean(commit.pending))
  useEffect(() => {
    if (commit.pending) setWasWriting(true)
  }, [commit.pending])
  const title = commit.message.replaceAll('`', '')
  const merging = !!subRows
  const names = commit.author.name + (commit.coAuthor ? L(' with ', ' 与 ') + commit.coAuthor.name : '')
  const visibleKind = commit.kind && L(commitKinds[commit.kind][0],commitKinds[commit.kind][1])
  const content = (
    <>
      <span className="rv-commit-mark" data-trail-point aria-hidden="true">
        {commit.pending ? <LoaderCircle size={14} className="rv-pending-arc" />
          : !nested && <Check size={12} />}
      </span>
      <span className="rv-commit-message">
        <span><CommitMessage message={commit.message} /></span>
        {merging && <ChevronRight size={12} className="rv-commit-chevron" aria-hidden="true" />}
      </span>
      {commit.pending ? <span className="rv-commit-writing">{L("Committing", "正在提交")}</span> : (
        <>
          {!merging && visibleKind && <span className="rv-commit-kind" data-kind={commit.kind}>{visibleKind}</span>}
          {merging && <span className="rv-merge-count">{L(commit.commits?.length + ' commits', commit.commits?.length + ' 条')}</span>}
          <span className="rv-commit-time">{commit.time}</span>
        </>
      )}
    </>
  )
  return (
    <li className="rv-commit"
      data-commit={commit.id}
      data-merge={merging || undefined}
      data-nested={nested || undefined}
      data-selected={!merging && open || undefined}
      data-landed={wasWriting && !commit.pending || undefined}
      style={{ '--rv-row-order': index } as CSSProperties}>
      {commit.pending ? (
        <div className="rv-commit-row" role="status" aria-label={L(names + ' is committing ' + title, names + ' 正在提交 ' + title)}>{content}</div>
      ) : (
        <>
          <button type="button" className="rv-commit-row" data-run-row aria-expanded={open} aria-controls={detailsId}
            aria-label={[title, names, merging ? L(commit.commits?.length + ' branch commits', commit.commits?.length + ' 条分支提交') : visibleKind, commit.time].filter(Boolean).join('，')}
            onClick={onToggle}>
            {content}
          </button>
          <RunFold id={detailsId} open={open}>
            {merging ? subRows : (
              <div className="rv-commit-detail">
                <div className="rv-commit-meta">
                  <CommitPerson author={commit.author} />
                  {commit.coAuthor && <>{L('with', '与')} <CommitPerson author={commit.coAuthor} /></>}
                  <span className="rv-commit-date">{commit.date ?? commit.time}</span>
                </div>
                <div className="rv-commit-meta rv-commit-counts">
                  <span className="rv-commit-hash">
                    <code>{commit.id.slice(0, 8)}</code>
                    <CopyButton value={commit.id} label={L("Copy commit hash", "复制提交哈希")} L={L} />
                  </span>
                  {commit.files !== undefined && <span>{L(commit.files + ' files', commit.files + ' 个文件')}</span>}
                  {commit.added !== undefined && <span data-diff="added">+{commit.added}</span>}
                  {commit.removed !== undefined && <span data-diff="removed">−{commit.removed}</span>}
                </div>
                {commit.body && <p>{commit.body}</p>}
              </div>
            )}
          </RunFold>
        </>
      )}
    </li>
  )
}

function countCommits(commits: TrailCommit[]): number {
  return commits.reduce((total, commit) => commit.pending ? total : total + 1 + countCommits(commit.commits ?? []), 0)
}

function useCommitWire(commits: TrailCommit[], hasMore: boolean) {
  const canvas = useRef<HTMLDivElement>(null)
  const rail = useRef<SVGPathElement>(null)
  const light = useRef<SVGPathElement>(null)

  useLayoutEffect(() => {
    const surface = canvas.current
    if (!surface) return
    const markers = surface.querySelectorAll<HTMLElement>('[data-trail-point]')
    const folds = surface.querySelectorAll<HTMLElement>('.rv-fold')
    function draw() {
      if (!surface) return
      const bounds = surface.getBoundingClientRect()
      const points = Array.from(markers).flatMap((marker) => {
        const rect = marker.getBoundingClientRect()
        const y = rect.top + rect.height / 2
        // A folded branch stays mounted during the height transition.
        for (let fold = marker.closest('.rv-fold'); fold; fold = fold.parentElement?.closest('.rv-fold') ?? null) {
          if (y >= fold.getBoundingClientRect().bottom) return []
        }
        return [{ x: rect.left + rect.width / 2 - bounds.left, y: y - bounds.top }]
      })
      let path = ''
      const first = points[0]
      const last = points.at(-1)
      if (first && last) {
        path = 'M ' + first.x + ' ' + first.y
        for (let i = 1; i < points.length; i++) {
          const before = points[i - 1]!
          const next = points[i]!
          const mid = (before.y + next.y) / 2
          path += next.x === before.x
            ? ' V ' + next.y
            : ' C ' + before.x + ' ' + mid + ', ' + next.x + ' ' + mid + ', ' + next.x + ' ' + next.y
        }
        if (hasMore) path += ' V ' + bounds.height
      }
      rail.current?.setAttribute('d', path)
      light.current?.setAttribute('d', path)
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(surface)
    folds.forEach((fold) => observer.observe(fold))
    return () => observer.disconnect()
  }, [commits, hasMore])

  return { canvas, rail, light }
}

export function CommitTrail({
  branch,
  branches,
  commits,
  onBranchChange,
  hasMore = false,
  defaultExpanded = [],
  L = chinese,
}: {
  L?: Localize
  branch: string
  branches: readonly string[]
  commits: TrailCommit[]
  onBranchChange: (branch: string) => void
  hasMore?: boolean
  defaultExpanded?: readonly string[]
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(defaultExpanded))
  const list = useRef<HTMLDivElement>(null)
  const wire = useCommitWire(commits, hasMore)
  const latest = commits[0]
  const pending = commits.some((commit) => commit.pending)

  function toggleMerge(id: string) {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function commitRows(items: TrailCommit[], nested = false): ReactNode {
    return items.map((commit, index) => {
      const children = commit.commits
      const isMerge = !!children?.length && !commit.pending
      return <CommitRow key={commit.id} L={L} commit={commit} nested={nested} index={index}
        open={isMerge ? expanded.has(commit.id) : openId === commit.id}
        onToggle={() => {
          if (isMerge) {
            setOpenId(null)
            toggleMerge(commit.id)
          } else setOpenId((current) => current === commit.id ? null : commit.id)
        }}
        subRows={isMerge ? <ol className="rv-merge-children" aria-label={L("Branch commits", "分支提交")}>{commitRows(children, true)}</ol> : undefined} />
    })
  }
  function trailKeyDown(event: KeyboardEvent<HTMLOListElement>) {
    if (event.key !== 'Escape') return moveRowFocus(event)
    if (!(event.target instanceof HTMLElement)) return
    const row = event.target.closest<HTMLElement>('.rv-commit[data-selected]')
    if (row) {
      event.preventDefault()
      row.querySelector<HTMLButtonElement>('[data-run-row]')?.focus()
      setOpenId(null)
      return
    }
    const merge = event.target.closest<HTMLElement>('.rv-commit[data-merge]')
    const id = merge?.dataset.commit
    if (id && expanded.has(id)) {
      event.preventDefault()
      merge?.querySelector<HTMLButtonElement>('[data-run-row]')?.focus()
      toggleMerge(id)
    }
  }

  return (
    <section className="rv-commit-trail" aria-label={L("Commit trail", "提交轨迹")}>
      <header className="rv-trail-head">
        <div className="rv-trail-branch">
          <GitBranch size={15} aria-hidden="true" />
          {branches.length > 1 ? (
            <SelectField label={L("Choose branch", "选择分支")} value={branch} onChange={(event) => {
              setOpenId(null)
              setExpanded(new Set(defaultExpanded))
              list.current?.scrollTo(0, 0)
              onBranchChange(event.currentTarget.value)
            }}>
              {branches.map((item) => <option value={item} key={item}>{item}</option>)}
            </SelectField>
          ) : <strong>{branch}</strong>}
        </div>
        <span>{L(countCommits(commits) + ' commits', countCommits(commits) + ' 条提交')}</span>
      </header>
      <span className="rp-sr-only" role="status">
        {latest && !latest.pending && latest.author.name + L(' committed ', ' 已提交 ') + latest.message.replaceAll('`', '')}
      </span>
      <div className="rv-commits-pane" data-more={hasMore || undefined}>
        <div className="rv-commits-scroll" ref={list}>
          <div className="rv-commits-canvas" ref={wire.canvas} data-pending={pending || undefined}>
            <svg className="rv-commit-wire" aria-hidden="true" width="100%" height="100%">
              <path ref={wire.rail} className="rv-commit-rail" />
              <path ref={wire.light} className="rv-commit-beam" pathLength="100" />
            </svg>
            <ol className="rv-commits" data-inspecting={openId !== null || undefined}
              aria-label={branch + L(' commit history', ' 提交记录')} onKeyDown={trailKeyDown}>
              {commitRows(commits)}
              {!commits.length && <li className="rv-empty">{L("No commits", "暂无提交")}</li>}
            </ol>
          </div>
        </div>
      </div>
    </section>
  )
}

export interface SequenceParticipant {
  id: string
  name: string
  kind: 'person' | 'agent' | 'tool'
  model?: string
  description?: string
  avatarId?: string
  avatarKind?: 'router' | 'worker'
}

export interface SequenceMessage {
  id: string
  from: string
  to: string
  label: string
  timeMs?: number
  kind?: 'reply'
  replyTo?: string
  state?: 'failed' | 'waiting'
  frame?: string
  detail?: string
}

type SequenceTip = {key: string; anchor: HTMLElement; title: string; details: string[]; x?: number}

function SequenceTooltip({tip,id}: {tip:SequenceTip|null; id:string}) {
  const ref=useRef<HTMLDivElement>(null)
  useLayoutEffect(()=>{
    const popup=ref.current!
    if (!tip) return
    const {anchor,x: pointerX}=tip
    function place(){
      const target=anchor.getBoundingClientRect()
      const scroll=anchor.closest('.rv-sequence-scroll')?.getBoundingClientRect()
      const visible=anchor.isConnected && (!scroll ||
        (target.bottom>scroll.top&&target.top<scroll.bottom&&target.right>scroll.left&&target.left<scroll.right))
      if(!visible){
        if(popup.matches(':popover-open'))popup.hidePopover()
        return
      }
      if(!popup.matches(':popover-open'))popup.showPopover()
      const width=popup.offsetWidth,height=popup.offsetHeight
      const center=pointerX??target.left+target.width/2
      const x=Math.max(8,Math.min(center-width/2,innerWidth-width-8))
      const below=target.bottom+6,above=target.top-height-6
      popup.style.left=x+'px'
      popup.style.top=Math.max(8,below+height<=innerHeight-8?below:above)+'px'
    }
    place()
    window.addEventListener('scroll',place,true)
    window.addEventListener('resize',place)
    return ()=>{
      window.removeEventListener('scroll',place,true)
      window.removeEventListener('resize',place)
      if(popup.matches(':popover-open'))popup.hidePopover()
    }
  },[tip])
  return <div ref={ref} id={id} role="tooltip" popover="manual" className="rv-sequence-tooltip">
    {tip && <><strong>{tip.title}</strong>{tip.details.map((line,index)=><span key={index}>{line}</span>)}</>}
  </div>
}

function useSequenceReveal(count:number,playOnMount:boolean,active:boolean) {
  const [total]=useState(count)
  const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)')
  const [visible,setVisible]=useState(()=>playOnMount && total>1 && !reduced().matches?1:Infinity)
  useEffect(()=>{
    if(!playOnMount||!active||total<=1)return
    const media=reduced()
    if(media.matches)return
    const step=Math.min(220,4700/(total-1))
    const started=performance.now()
    const timer=window.setInterval(()=>{
      const next=1+Math.floor((performance.now()-started)/step)
      if(next>=total){setVisible(Infinity);window.clearInterval(timer)}
      else setVisible(previous=>Math.max(previous,next))
    },Math.max(32,step))
    function end(){
      if(!media.matches)return
      window.clearInterval(timer)
      setVisible(Infinity)
    }
    media.addEventListener('change',end)
    return ()=>{window.clearInterval(timer);media.removeEventListener('change',end)}
  },[total,playOnMount,active])
  return Math.min(count,visible)
}

const messageStatuses = { failed: ['Failed', '失败'], waiting: ['Waiting', '等待确认'] } as const

function SequenceArrow({ backward, self, state }: { backward: boolean; self: boolean; state?: SequenceMessage['state'] }) {
  const EndIcon = state === 'failed' ? X : Hourglass
  return (
    <span className="rv-sequence-arrow" data-backward={backward || undefined} data-self={self || undefined} aria-hidden="true">
      <span className="rv-arrow-line" />
      <span className="rv-arrow-flight"><span /></span>
      <span className="rv-arrow-end">{state && <EndIcon size={14} />}</span>
      <span className="rv-arrow-ring" />
    </span>
  )
}

export function AgentSequence({
  title,
  participants,
  messages,
  running,
  statusLabel,
  playOnMount = false,
  active = true,
  onExpand,
  L = chinese,
}: {
  L?: Localize
  title: string
  participants: SequenceParticipant[]
  messages: SequenceMessage[]
  running: boolean
  statusLabel?: string
  playOnMount?: boolean
  active?: boolean
  onExpand?: () => void
}) {
  const [focused, setFocused] = useState('')
  const [tip,setTip] = useState<SequenceTip|null>(null)
  const tipId=useId()
  const participantIndex = new Map(participants.map((participant, index) => [participant.id, index]))
  const exchanges = messages.filter((message) => participantIndex.has(message.from) && participantIndex.has(message.to))
  const count=useSequenceReveal(exchanges.length,playOnMount,active)
  const rows=exchanges.slice(0,count)
  const currentTip=active?tip:null
  const restingRow = rows.some((row) => row.id === focused) ? focused : rows[0]?.id
  const positions = new Map(rows.map((row, index) => [row.id, index]))
  const replies = new Map(rows.flatMap((row, index) => {
    const call = row.replyTo ? positions.get(row.replyTo) : undefined
    return row.replyTo && call !== undefined && call < index ? [[row.replyTo, index] as const] : []
  }))
  const calls = rows.flatMap((message, start) => {
    if (message.kind === 'reply' || message.state || message.from === message.to) return []
    const end = replies.get(message.id)
    return [{ id: message.id, owner: message.to, start, end: end ?? rows.length, active: running && end === undefined }]
  })
  const busy = new Set(calls.filter((call) => call.active).map((call) => call.owner))
  const failed = exchanges.filter((row) => row.state === 'failed').length
  const last = rows.at(-1)
  const laneX = (lane: number) => ((lane + .5) / participants.length) * 100
  function tipEvents(key:string,title:string,details:Array<string|undefined>) {
    function show(anchor:HTMLElement,x?:number) {
      setTip({key,title,anchor,x,details:details.filter((line):line is string=>!!line)})
    }
    function hide(){
      setTip(current=>current?.key===key?null:current)
    }
    return {
      'aria-describedby':currentTip?.key===key?tipId:undefined,
      onPointerEnter:(event:PointerEvent<HTMLElement>)=>{
        if(event.pointerType!=='touch')show(event.currentTarget,event.clientX)
      },
      onPointerLeave:hide,
      onFocus:(event:FocusEvent<HTMLElement>)=>show(event.currentTarget),
      onBlur:hide,
    }
  }
  return (
    <section className="rv-sequence" aria-label={L("Handoff sequence", "接力时序")} onKeyDown={event=>{
      if(event.key==='Escape'&&currentTip){
        event.preventDefault()
        setTip(null)
      }
    }}>
      <header className="rv-sequence-head">
        <div>
          <strong>{title}</strong>
          <small>{L(exchanges.length + ' exchanges', exchanges.length + ' 条消息')}{failed ? L(' · ' + failed + ' failed', ' · ' + failed + ' 次失败') : ''}</small>
        </div>
        <div className="rv-sequence-actions">
          <span className="rv-sequence-state" data-running={running}>{statusLabel ?? (running ? L('Running', '运行中') : L('Ended', '已结束'))}</span>
          {onExpand&&<button className="rv-sequence-expand" type="button" aria-haspopup="dialog"
            aria-label={L('Enlarge sequence diagram','放大时序图')} title={L('Enlarge sequence diagram','放大时序图')} onClick={event=>{event.currentTarget.focus({preventScroll:true});onExpand()}}>
            <Maximize2 size={16} aria-hidden="true"/>
          </button>}
        </div>
      </header>
      <div className="rv-sequence-scroll">
        <div className="rv-sequence-board" style={{ '--rv-lanes': Math.max(1, participants.length) } as CSSProperties}>
          <div className="rv-participants" aria-label={L("Participants", "参与者")}>
            {participants.map((participant) => {
              const working = busy.has(participant.id)
              const role={person:L('User','用户'),agent:L('Agent','助手'),tool:L('Tool','工具')}[participant.kind]
              return (
                <div key={participant.id} role="group" tabIndex={0} aria-label={participant.name}
                  className="rv-participant" data-kind={participant.kind} data-working={working||undefined}
                  {...tipEvents('participant:'+participant.id,participant.name,
                    [role,participant.model,working?L('Working','工作中'):undefined,participant.description])}>
                  {participant.kind==='tool'
                    ? <Wrench className="rv-participant-tool" size={28} strokeWidth={1.65} aria-hidden="true"/>
                    : <AgentAvatar id={participant.avatarId??participant.id}
                      kind={participant.avatarKind??(participant.id==='router'||participant.id==='lead'?'router':'worker')} size={28}/>}
                  <span className="rv-participant-name">{participant.name}</span>
                  {working&&<span className="rp-sr-only">{L('Working','工作中')}</span>}
                </div>
              )
            })}
          </div>
          <div className="rv-sequence-plot">
            {participants.map((participant, lane) => (
              <span key={participant.id} className="rv-lifeline" style={{ left: `${laneX(lane)}%` }} aria-hidden="true" />
            ))}
            {calls.map((call) => (
              <span
                key={call.id}
                className="rv-activation"
                data-active={call.active || undefined}
                style={{
                  left: `${laneX(participantIndex.get(call.owner)!)}%`,
                  '--rv-start': call.start,
                  '--rv-length': call.end - call.start,
                } as CSSProperties}
                aria-hidden="true"
              />
            ))}
            <ol className="rv-sequence-rows" aria-label={L("Exchanges", "接力消息")} onKeyDown={moveRowFocus}>
              {rows.map((message, index) => {
                const from = participantIndex.get(message.from)!
                const to = participantIndex.get(message.to)!
                const sender = participants[from]!
                const receiver = participants[to]!
                const self = from === to
                const frameStart = message.frame && rows[index - 1]?.frame !== message.frame
                const frameEnd = message.frame && rows[index + 1]?.frame !== message.frame
                const hasTime = Number.isFinite(message.timeMs)
                const stamp = hasTime ? timecode(message.timeMs!) : ''
                const status = message.state ? L(messageStatuses[message.state][0],messageStatuses[message.state][1]) : message.kind === 'reply' ? L('Reply','回复') : L('Call','调用')
                const route = `${sender.name} → ${receiver.name}`
                const parent = message.replyTo ? rows[positions.get(message.replyTo) ?? -1] : undefined
                const tooltip=tipEvents('exchange:'+message.id,message.label||status,
                  [route,[status,stamp].filter(Boolean).join(' · '),message.detail??parent?.label])
                return (
                  <li
                    key={message.id}
                    className="rv-sequence-row"
                    data-frame={message.frame || undefined}
                    data-frame-start={frameStart || undefined}
                    data-frame-end={frameEnd || undefined}
                  >
                    <div
                      role="group"
                      className="rv-sequence-message"
                      data-run-row
                      data-kind={message.kind ?? 'call'}
                      data-state={message.state}
                      aria-label={[route,status,message.label,stamp].filter(Boolean).join('，')}
                      tabIndex={restingRow===message.id?0:-1}
                      {...tooltip}
                      onFocus={event=>{
                        setFocused(message.id)
                        tooltip.onFocus(event)
                      }}
                      style={{
                        '--rv-left': `${laneX(Math.min(from, to))}%`,
                        '--rv-span': `${Math.abs(to - from) / participants.length * 100}%`,
                        '--rv-mid': `${(laneX(from) + laneX(to)) / 2}%`,
                      } as CSSProperties}
                    >
                      <span className="rv-sequence-time">{frameStart && <span>{message.frame}</span>}{stamp}</span>
                      <SequenceArrow backward={to < from || (self && from === participants.length - 1)} self={self} state={message.state} />
                      {message.label && <span className="rv-sequence-label">{message.label}</span>}
                    </div>
                  </li>
                )
              })}
              {!rows.length && <li className="rv-empty">{running ? L('Waiting for the first exchange', '等待第一条消息') : L('No exchanges recorded', '暂无消息')}</li>}
            </ol>
          </div>
        </div>
      </div>
      <footer className="rv-sequence-key" aria-label={L("Legend", "图例")}>
        <span><i data-key="call" />{L("Call", "调用")}</span>
        <span><i data-key="reply" />{L("Reply", "回复")}</span>
        <span><i data-key="working" />{L("Working", "工作中")}</span>
        <span><X size={13} />{L("Failed", "失败")}</span>
      </footer>
      <span role="status" className="rp-sr-only">{last && `${participants[participantIndex.get(last.from)!]?.name}：${last.label}`}</span>
      <SequenceTooltip tip={currentTip} id={tipId}/>
    </section>
  )
}
