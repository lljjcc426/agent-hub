import { useId, type ReactNode } from 'react'
import { ArrowUp } from 'lucide-react'

export function Message({
  author,
  identity,
  time,
  actions,
  messageId,
  sideActions,
  reactions,
  children,
}: {
  author: 'user' | 'agent'
  identity?: ReactNode
  time?: string
  actions?: ReactNode
  messageId?: string
  sideActions?: ReactNode
  reactions?: ReactNode
  children: ReactNode
}) {
  return (
    <article className={'rp-message message ' + (author === 'user' ? 'user-message' : 'assistant-message')} data-author={author} data-message-id={messageId}>
      {author === 'agent' && (identity || time) && (
        <header>
          {identity}
          {time && <span className="rp-time">{time}</span>}
        </header>
      )}
      {sideActions ? <div className="message-line" tabIndex={-1}>
        <div className="message-surface rp-message-content" data-message-body>{children}</div>{sideActions}
      </div> : <div className="rp-message-content">{children}</div>}
      {reactions}
      {author === 'user' && time && <span className="rp-time">{time}</span>}
      {actions && <div className="rp-message-actions">{actions}</div>}
    </article>
  )
}

export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  sendLabel,
  readOnly,
  hasAttachments,
  leading,
  tools,
  context,
}: {
  value: string
  onChange: (text: string) => void
  onSend: () => void
  placeholder: string
  sendLabel: string
  readOnly?: boolean
  hasAttachments?: boolean
  leading?: ReactNode
  tools?: ReactNode
  context?: ReactNode
}) {
  const formId = useId()
  const canSend = !readOnly && (!!value.trim() || hasAttachments === true)
  return (
    <div className="rp-composer">
      {context && <div className="rp-composer-context">{context}</div>}
      <div className="rp-composer-line">
        {leading}
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault()
            if (canSend) onSend()
          }}
        >
          <textarea
            aria-label={placeholder}
            placeholder={placeholder}
            value={value}
            readOnly={readOnly}
            rows={1}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229
              ) {
                event.preventDefault()
                if (canSend) event.currentTarget.form?.requestSubmit()
              }
            }}
          />
        </form>
        {tools}
        <button
          className="rp-send"
          type="submit"
          form={formId}
          disabled={!canSend}
          aria-label={sendLabel}
          title={sendLabel}
        >
          <ArrowUp size={19} />
        </button>
      </div>
    </div>
  )
}
