import { ArrowUpRight, Check, ChevronRight, CircleGauge, GitCommitHorizontal, Hand, Paperclip, ShieldCheck, ShieldOff, SlidersHorizontal } from 'lucide-react'
import { useId, useState } from 'react'
import type { ChatSpace } from './chat-settings.tsx'
import type { CurrentContext } from './context-card.tsx'

export type Localize = (en: string, zh: string) => string
export const commands = [
  { id: 'model', title: (L: Localize) => L('Model connection', '模型连接'), Icon: SlidersHorizontal },
  { id: 'attach', title: (L: Localize) => L('Add files', '添加文件'), Icon: Paperclip },
  { id: 'permissions', title: (L: Localize) => L('Approval policy', '审批策略'), Icon: ShieldCheck },
  { id: 'context', title: (L: Localize) => L('Context usage', '上下文用量'), Icon: CircleGauge },
  { id: 'commits', title: (L: Localize) => L('Commit trail', '提交轨迹'), Icon: GitCommitHorizontal },
] as const
export type ChatCommand = (typeof commands)[number]['id']
export type Mode = ChatSpace['approvalMode']

export function matchingCommands(query: string, L: Localize, commits = false) {
  return commands.filter(command => (commits || command.id !== 'commits') &&
    (command.id.startsWith(query) || command.title(L).toLowerCase().includes(query)))
}

export function approvalLabel(mode: Mode, L: Localize) {
  return mode === 'full' ? L('Full access', '无需审批') : L('Request approval', '请求批准')
}

export function CommandList({ items, active, slash, listId, uploadDisabled, mode, L, onHighlight, onChoose }: {
  items: readonly (typeof commands)[number][]
  active: number
  slash: boolean
  listId: string
  uploadDisabled: boolean
  mode?: Mode
  L: Localize
  onHighlight: (index: number) => void
  onChoose: (command: ChatCommand) => void
}) {
  return <div id={listId} role={slash ? 'listbox' : 'menu'}
    aria-label={slash ? L('Chat commands', 'Chat 命令') : L('Chat actions', '对话操作')}>
    {items.map(({ id, title, Icon }, index) => (
      <button key={id} id={listId + '-' + index} type="button" className="palette-row"
        role={slash ? 'option' : 'menuitem'} aria-selected={slash ? index === active : undefined}
        tabIndex={slash ? -1 : 0} disabled={id === 'attach' && uploadDisabled}
        onPointerMove={() => slash && onHighlight(index)} onMouseDown={event => slash && event.preventDefault()}
        onClick={() => onChoose(id)}>
        <Icon size={16}/><span>{title(L)}</span>
        {slash ? <small>/{id}</small> : id === 'permissions' && mode && <small data-mode={mode}>{approvalLabel(mode, L)}</small>}
        {id !== 'attach' && id !== 'commits' && <ChevronRight size={13} className="palette-trailing"/>}
      </button>
    ))}
  </div>
}

export function ApprovalOptions({ mode, L, onSave, onClose }: {
  mode?: Mode; L: Localize; onSave: (next: Mode) => Promise<void>; onClose: () => void
}) {
  const [saving, setSaving] = useState(false), [failed, setFailed] = useState(false)
  const descriptionId = useId()
  async function change(next: Mode) {
    if (next === mode) { onClose(); return }
    setSaving(true)
    setFailed(false)
    try {
      await onSave(next)
      onClose()
    } catch {
      setFailed(true)
      setSaving(false)
    }
  }
  return <div role="menu" aria-label={L('Approval policy', '审批策略')}>
    {(['ask', 'full'] as const).map(id => {
      const Icon = id === 'full' ? ShieldOff : Hand
      const label = approvalLabel(id, L)
      return <button key={id} type="button" className="palette-row policy-option" role="menuitemradio"
        aria-label={label} aria-describedby={descriptionId + id}
        aria-checked={mode === id} data-mode={id} disabled={saving} onClick={() => void change(id)}>
        <Icon size={17}/><span><strong>{label}</strong><small id={descriptionId + id}>{id === 'ask'
          ? L('Ask before sensitive actions.', '敏感操作执行前询问你。')
          : L('Allow sensitive actions in new tasks.', '新任务可自主执行敏感操作。')}</small></span>
        {mode === id && <Check size={15}/>}
      </button>
    })}
    {failed && <p role="alert">{L('Could not save. Try again.', '保存失败，请重试。')}</p>}
  </div>
}

export function windowReadout(current: CurrentContext, L: Localize) {
  const input = current.data?.inputTokens, capacity = current.data?.capacity
  const fraction = input != null && capacity != null && capacity > 0 ? input / capacity : null
  const locale = L('en', 'zh-CN')
  const percent = fraction === null ? null : new Intl.NumberFormat(locale, {
    style: 'percent', maximumFractionDigits: 1,
  }).format(fraction)
  const label = percent ? L(percent + ' used', '已用 ' + percent)
    : current.failed ? L('Usage unavailable', '暂时无法读取用量')
    : input != null ? L('Window capacity not reported', '模型未提供窗口容量')
    : current.data?.budget || current.data?.composition ? L('Model token count not reported yet', '模型尚未上报 token 数')
    : !current.empty && !current.data ? L('Loading…', '读取中…') : L('No usage reported yet', '暂无用量记录')
  const tokens = input != null ? input.toLocaleString(locale) + (capacity ? ' / ' + capacity.toLocaleString(locale) : '') + ' tokens' : null
  const previous = current.data?.previous && (input != null || current.data.budget || current.data.composition)
  return { fraction, label: previous ? label + L(' (last reading)', '（上次记录）') : label, tokens }
}

export function UsageRing({ fraction, size = 19 }: { fraction: number | null; size?: number }) {
  return <svg className="usage-ring" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle className="usage-track" cx="12" cy="12" r="8.5" strokeDasharray={fraction === null ? '2 3' : undefined}/>
    {fraction !== null && fraction > 0 && <circle className="usage-fill" cx="12" cy="12" r="8.5"
      pathLength="100" strokeDasharray="100" strokeDashoffset={100 - Math.min(1, fraction) * 100}
      transform="rotate(-90 12 12)"/>}
  </svg>
}

export function ContextOverview({ readout, L, onDetails }: {
  readout: ReturnType<typeof windowReadout>; L: Localize; onDetails: () => void
}) {
  return <>
    <div className="palette-context"><UsageRing fraction={readout.fraction} size={38}/>
      <div><strong>{readout.label}</strong>{readout.tokens && <small>{readout.tokens}</small>}</div>
    </div>
    <button type="button" className="palette-row palette-details" onClick={onDetails}>
      <span>{L('View usage details', '查看用量明细')}</span><ArrowUpRight size={15}/>
    </button>
  </>
}
