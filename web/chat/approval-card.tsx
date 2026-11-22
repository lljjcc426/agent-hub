import {Check, CircleHelp, FileText, ShieldCheck, X} from 'lucide-react'
import {useId, useState, type ReactNode} from 'react'
import {Button, InputControl} from '../ui/controls.tsx'
import type {Localize} from './composer-commands.tsx'

export type ApprovalResult = 'approved' | 'denied' | 'answered' | 'closed'

export function ApprovalStatus({label, state}: {label: string; state?: ApprovalResult}) {
  const Icon = state === 'denied' ? X : state === 'approved' || state === 'answered' ? Check : undefined
  return <span className="chat-approval-status" data-result={state}>
    {Icon ? <Icon size={13} aria-hidden="true"/> : <i aria-hidden="true"/>}{label}
  </span>
}

export function ApprovalFrame({kind, title, id, notice, status, result, children, L}: {
  kind: 'permission' | 'choice' | 'file'; title: string; id?: string; notice?: string
  status: string; result?: ApprovalResult; children?: ReactNode; L: Localize
}) {
  const label = useId()
  const [Icon, category] = kind === 'permission' ? [ShieldCheck, L('Operation approval', '操作审批')] :
    kind === 'file' ? [FileText, L('File approval', '文件审批')] : [CircleHelp, L('Your decision', '请求确认')]
  return <section className="roppo-ui chat-approval-card" data-workflow-id={id} aria-labelledby={label}>
    <header className="chat-approval-head">
      <span><Icon size={15} aria-hidden="true"/>{category}</span>
      <ApprovalStatus label={status} state={result}/>
    </header>
    <h3 id={label}>{title}</h3>
    {notice && notice !== title && <p className="chat-approval-note">{notice}</p>}
    {children}
  </section>
}

export type AnswerOption = {label: string; detail?: string}

export function AnswerFields({label, options, value, change, disabled, custom = false, secret, maxLength = 8000, L}: {
  label: string; options: AnswerOption[]; value: string; change: (text: string) => void
  disabled?: boolean; custom?: boolean; secret?: boolean; maxLength?: number; L: Localize
}) {
  const group = useId()
  const [customSelected, setCustomSelected] = useState(!options.length)
  return <fieldset className="chat-approval-options" aria-label={label} disabled={disabled}>
    {options.map((option, index) => {
      const selected = !customSelected && value === option.label
      return <label className="chat-approval-option" key={index} data-selected={selected || undefined}>
        <input name={group} type="radio" checked={selected} onChange={() => {
          setCustomSelected(false)
          change(option.label)
        }}/>
        <span><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>
      </label>
    })}
    {custom && options.length > 0 && <label className="chat-approval-option" data-selected={customSelected || undefined}>
      <input name={group} type="radio" checked={customSelected} onChange={() => {
        setCustomSelected(true)
        change('')
      }}/>
      <span>{L('Write my own', '自己填写')}</span>
    </label>}
    {custom && customSelected && <InputControl className="chat-approval-answer" type={secret ? 'password' : 'text'}
      autoComplete="off" maxLength={maxLength} aria-label={L('Custom answer', '自定义答复')}
      placeholder={L('Write an answer…', '输入答复…')} value={value} onChange={event => change(event.target.value)}/>}
  </fieldset>
}

export function QuestionCard({id, question, notice, options, answer, custom, disabled, maxLength, onAnswer, footer, outcome, L}: {
  id?: string; question: string; notice?: string; options: AnswerOption[]; answer?: string | null
  custom?: boolean; disabled?: boolean; maxLength?: number; onAnswer: (answer: string) => void; footer?: ReactNode; outcome?: ReactNode; L: Localize
}) {
  const [value, setValue] = useState('')
  return <ApprovalFrame id={id} kind="choice" title={question} notice={notice} L={L}
    status={answer ? L('Answered', '已回答') : options.length ? L('Awaiting selection', '待选择') : L('Awaiting answer', '待答复')}
    result={answer ? 'answered' : undefined}>
    {answer ? <><div className="chat-approval-receipt"><span>{answer}</span>{footer}</div>{outcome}</> :
      <form className="chat-approval-form" onSubmit={event => {
        event.preventDefault()
        if (!disabled && value.trim()) onAnswer(value.trim())
      }}>
        <AnswerFields label={question} options={options} value={value} change={setValue} custom={custom} disabled={disabled} maxLength={maxLength} L={L}/>
        <div className="chat-approval-actions">
          <Button tone="primary" type="submit" disabled={disabled || !value.trim()}>
            {options.length ? L('Confirm selection', '确认选择') : L('Submit answer', '提交答复')}
          </Button>
        </div>
      </form>}
  </ApprovalFrame>
}
