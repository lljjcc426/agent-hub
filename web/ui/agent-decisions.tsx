import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, CornerDownLeft, FileText, Pencil, ShieldCheck, Trash2, X } from 'lucide-react'
import { Button, ChoiceGroup, IconButton, TextField } from './controls.tsx'
import { Disclosure } from './overlays.tsx'
import { SwitchView, switchView } from './transitions.tsx'

type Localize = (en: string, zh: string) => string
const chinese: Localize = (_en, zh) => zh

export interface ContextPart {
  id: string
  label: string
  tokens: number
  files?: { id: string; name: string; tokens: number }[]
}
const count = (n: number) =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
export function ContextWindow({
  capacity,
  label,
  unit = 'tokens',
  view = 'window',
  legend = true,
  L = chinese,
  parts,
  onCompact,
  canCompact,
  onRemoveFile,
}: {
  capacity: number | null
  label?: string
  unit?: string
  view?: 'window' | 'composition'
  legend?: boolean
  L?: Localize
  parts: ContextPart[]
  onCompact?: () => void
  canCompact?: boolean
  onRemoveFile?: (id: string) => void
}) {
  const [active, setActive] = useState<string | null>(null)
  const total = parts.reduce((s, p) => s + p.tokens, 0),
    cellCount = 100
  const scale = view === 'composition' ? total : capacity
  const locale = L('en', 'zh-CN')
  const percent = capacity != null && capacity > 0
    ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(total / capacity)
    : null
  let idx = 0,
    limit = parts[0]?.tokens ?? 0
  const fields = Array.from({ length: cellCount }, (_, i) => {
    const token = ((i + 0.5) * (scale ?? 0)) / cellCount
    while (token > limit && idx < parts.length - 1) limit += parts[++idx]!.tokens
    const part = token <= total ? parts[idx] : undefined
    return (
      <i
        aria-hidden="true"
        key={i}
        data-band={part ? idx % 5 : 'free'}
        data-category={part?.id}
        data-dim={!!active && part?.id !== active}
        style={{ transitionDelay: (i % 12) * 8 + 'ms' }}
      />
    )
  })
  return (
    <div className="rp-context">
      {view !== 'composition' && <div className="rp-capacity">
        <strong title={total.toLocaleString(locale)}>{total.toLocaleString(locale)}</strong>
        <span>
          {capacity ? '/ ' + capacity.toLocaleString(locale) + ' ' : ''}
          {unit}
        </span>
        {percent !== null && <b>{percent}</b>}
      </div>}
      {scale != null && scale > 0 && <div
        className="rp-cells"
        role={view === 'composition' ? 'img' : 'meter'}
        aria-label={label ?? L('Context usage', '上下文用量')}
        {...(view === 'window' ? {'aria-valuemin':0, 'aria-valuemax':scale, 'aria-valuenow':Math.min(total,scale), 'aria-valuetext':percent ?? undefined} : {})}
      >
        {fields}
      </div>}
      {legend && <div className="rp-context-legend" onMouseLeave={() => setActive(null)}>
        {parts.map((part, i) => (
          <div key={part.id}>
            <button
              type="button"
              aria-pressed={active === part.id}
              aria-label={L('Highlight ', '突出显示') + part.label}
              aria-description={part.tokens.toLocaleString(locale) + ' ' + unit}
              onMouseEnter={() => setActive(part.id)}
              onFocus={() => setActive(part.id)}
              onBlur={() => setActive(null)}
              onClick={() => setActive(part.id)}
            >
              <i data-band={i % 5} data-category={part.id} />
              <span>{part.label}</span>
              <b title={part.tokens.toLocaleString(locale) + ' ' + unit}>{count(part.tokens)}</b>
            </button>
            {part.files && part.files.length > 0 && (
              <Disclosure title={L('Files', '附件') + ' · ' + part.files.length}>
                {part.files.map((f) => (
                  <div className="rp-context-file" key={f.id}>
                    <FileText size={13} />
                    <span>{f.name}</span>
                    <small title={f.tokens.toLocaleString(locale) + ' ' + unit}>{count(f.tokens)}</small>
                    {onRemoveFile && (
                      <IconButton label={L('Remove ', '移除') + f.name} onClick={() => onRemoveFile(f.id)}>
                        <X size={13} />
                      </IconButton>
                    )}
                  </div>
                ))}
              </Disclosure>
            )}
          </div>
        ))}
      </div>}
      {onCompact && capacity && (
        <div className="rp-card-foot">
          <small>
            {L('Remaining', '剩余')} {count(Math.max(0, capacity - total))} {unit}
          </small>
          <Button onClick={onCompact} disabled={!canCompact}>
            {canCompact ? '压缩对话' : '已压缩'}
          </Button>
        </div>
      )}
    </div>
  )
}

export interface MemoryEntry {
  id: string
  category: string
  text: string
  source: string
}
export function MemoryPanel({
  items,
  categories,
  onEdit,
  onDelete,
}: {
  items: MemoryEntry[]
  categories: string[]
  onEdit: (id: string, text: string) => void
  onDelete: (id: string) => void
}) {
  const [category, setCategory] = useState('all')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const filtered = items.filter((m) => category === 'all' || category === m.category)
  function save() {
    if (editing && draft.trim()) {
      onEdit(editing, draft.trim())
      setEditing(null)
    }
  }
  return (
    <div className="rp-memory">
      <ChoiceGroup
        label="记忆分类"
        value={category}
        onChange={(v) =>
          switchView('panel', () => {
            setCategory(v)
            setEditing(null)
          })
        }
        choices={[
          { value: 'all', label: '全部 ' + items.length },
          ...categories.map((c) => ({ value: c, label: c })),
        ]}
      />
      <SwitchView>
        <div className="rp-memory-items">
          {filtered.map((m) => (
            <div className="rp-memory-row" key={m.id}>
              {editing === m.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    save()
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setEditing(null)
                    }
                  }}
                >
                  <TextField
                    label="记忆内容"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <IconButton type="submit" disabled={!draft.trim()} label="保存记忆">
                    <Check size={15} />
                  </IconButton>
                  <IconButton label="取消编辑记忆" onClick={() => setEditing(null)}>
                    <X size={15} />
                  </IconButton>
                </form>
              ) : (
                <>
                  <span>
                    <strong>{m.text}</strong>
                    <small>
                      {m.category} · {m.source}
                    </small>
                  </span>
                  <IconButton
                    label={'修改记忆：' + m.text}
                    onClick={() => {
                      setDraft(m.text)
                      setEditing(m.id)
                    }}
                  >
                    <Pencil size={14} />
                  </IconButton>
                  <IconButton label={'删除记忆：' + m.text} onClick={() => onDelete(m.id)}>
                    <Trash2 size={14} />
                  </IconButton>
                </>
              )}
            </div>
          ))}
          {!filtered.length && <p className="rp-muted">暂无记忆</p>}
        </div>
      </SwitchView>
    </div>
  )
}

export type Approval = 'pending' | 'approved' | 'denied' | 'expired' | 'resolved'
export function ApprovalCard({
  title,
  risk,
  details,
  state,
  onDecision,
  onReset,
  L = chinese,
  disabled = false,
}: {
  title: string
  risk: string
  details: { label: string; value: string }[]
  state: Approval
  onDecision: (decision: 'approved' | 'denied') => void
  onReset?: () => void
  L?: Localize
  disabled?: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  function decide(result: 'approved' | 'denied') {
    root.current?.focus({ preventScroll: true })
    onDecision(result)
  }
  function key(e: KeyboardEvent) {
    if (disabled || state !== 'pending') return
    if (e.key === 'Escape') {
      e.preventDefault()
      decide('denied')
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      decide('approved')
    }
  }
  const pending = state === 'pending'
  const facts = (
    <dl className="rp-fact-list">
      {details.map((d) => (
        <div key={d.label}>
          <dt>{d.label}</dt>
          <dd>{d.value}</dd>
        </div>
      ))}
    </dl>
  )
  return (
    <div
      className="rp-approval"
      role="group"
      ref={root}
      tabIndex={0}
      aria-label={L('Authorization request', '授权请求')}
      onKeyDown={key}
      data-resolved={!pending}
    >
      <div className="rp-approval-line">
        <span className="rp-feature-icon">
          {state === 'denied' ? (
            <X size={17} />
          ) : state === 'approved' ? (
            <Check size={17} />
          ) : (
            <ShieldCheck size={18} />
          )}
        </span>
        <strong>{title}</strong>
        {pending ? (
          <small>{risk}</small>
        ) : (
          <span role="status">
            {state === 'approved'
              ? L('Approved', '已批准')
              : state === 'denied'
                ? L('Denied', '已拒绝')
                : state === 'expired'
                  ? L('Expired', '已过期')
                  : L('Resolved', '已处理')}
          </span>
        )}
      </div>
      <div className="rp-fold" data-expanded={pending} inert={!pending}>
        <div>
          {facts}
          <div className="rp-card-foot">
            <Button disabled={disabled} onClick={() => decide('denied')}>
              {L('Deny', '拒绝')} <kbd>Esc</kbd>
            </Button>
            <Button disabled={disabled} tone="primary" onClick={() => decide('approved')}>
              {L('Allow once', '允许一次')} <kbd>⌘ ↵</kbd>
            </Button>
          </div>
        </div>
      </div>
      {!pending && !onReset && details.length > 0 && (
        <Disclosure title={L('Request details', '请求详情')}>{facts}</Disclosure>
      )}
      {!pending && onReset && (
        <Button tone="quiet" onClick={onReset}>
          {L('Try again', '重新查看')}
        </Button>
      )}
    </div>
  )
}

export interface DecisionOption {
  id: string
  label: string
  detail: string
  recommended?: boolean
}
export function DecisionCard({
  question,
  options,
  onAnswer,
  answer,
  onReset,
  L = chinese,
  disabled = false,
  allowCustom = true,
  secret = false,
}: {
  question: string
  options: DecisionOption[]
  onAnswer: (value: string) => void
  answer: string | null
  onReset?: () => void
  L?: Localize
  disabled?: boolean
  allowCustom?: boolean
  secret?: boolean
}) {
  const [later, setLater] = useState(false),
    [custom, setCustom] = useState(false),
    [text, setText] = useState('')
  const titleId = useId()
  const root = useRef<HTMLDivElement>(null)
  const expanded = !answer && !later
  function choose(value: string) {
    root.current?.focus({ preventScroll: true })
    setCustom(false)
    setText('')
    if (!disabled) onAnswer(value)
  }
  function key(e: KeyboardEvent<HTMLDivElement>) {
    if (
      disabled ||
      !expanded ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      (e.target as HTMLElement).matches('input,textarea')
    )
      return
    const option = /^[1-9]$/.test(e.key) ? options[Number(e.key) - 1] : undefined
    if (option) {
      e.preventDefault()
      choose(option.label)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('.rp-decision-option'))
      const index = rows.indexOf(document.activeElement as HTMLButtonElement),
        offset = e.key === 'ArrowDown' ? 1 : -1
      if (rows.length) {
        e.preventDefault()
        rows[(index + offset + rows.length) % rows.length]?.focus()
      }
    }
  }
  return (
    <div
      className="rp-decision"
      role="group"
      ref={root}
      tabIndex={0}
      aria-labelledby={titleId}
      onKeyDown={key}
    >
      <div className="rp-card-kicker">
        <span>{answer ? L('Decision', '决策') : L('Your decision', '待你决定')}</span>
        {(!answer || onReset) && (
          <button
            type="button"
            className="rp-text-control"
            onClick={() => {
              if (answer) {
                onReset?.()
                setLater(false)
              } else setLater(!later)
            }}
          >
            {answer ? L('Change', '重新选择') : later ? L('Expand', '展开问题') : L('Later', '稍后')}
          </button>
        )}
      </div>
      <strong id={titleId}>{question}</strong>
      {answer && (
        <p className="rp-chosen" role="status">
          <Check size={15} />
          {answer}
        </p>
      )}
      <div className="rp-fold" data-expanded={expanded} inert={!expanded}>
        <div>
          <div className="rp-decision-options">
            {options.map((o, i) => (
              <button
                disabled={disabled}
                type="button"
                key={o.id}
                className="rp-decision-option"
                onClick={() => choose(o.label)}
              >
                <kbd>{i + 1}</kbd>
                <span>
                  <strong>{o.label}</strong>
                  {o.detail && <small>{o.detail}</small>}
                </span>
                {o.recommended && <em>{L('Recommended', '推荐')}</em>}
              </button>
            ))}
            {allowCustom &&
              (custom || !options.length ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (text.trim()) choose(text.trim())
                  }}
                >
                  <TextField
                    autoFocus={custom}
                    type={secret ? 'password' : 'text'}
                    autoComplete="off"
                    maxLength={8000}
                    disabled={disabled}
                    label={L('Custom answer', '自定义答复')}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                  <IconButton
                    type="submit"
                    label={L('Submit answer', '提交答复')}
                    disabled={disabled || !text.trim()}
                  >
                    <CornerDownLeft size={16} />
                  </IconButton>
                </form>
              ) : (
                <Button disabled={disabled} tone="quiet" onClick={() => setCustom(true)}>
                  <Pencil size={13} />
                  {L('Write my own', '自己填写')}
                </Button>
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}
