import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import { IconButton } from './controls.tsx'

export function Dialog({
  open,
  title,
  closeLabel,
  onClose,
  placement = 'center',
  role = 'dialog',
  children,
  footer,
}: {
  open: boolean
  title: string
  closeLabel: string
  onClose: () => void
  placement?: 'center' | 'side' | 'start'
  role?: 'dialog' | 'alertdialog'
  children: ReactNode
  footer?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useId()
  useEffect(() => {
    const el = ref.current!
    if (!open) return
    el.showModal()
    return () => el.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="rp-dialog"
      role={role}
      data-placement={placement}
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section>
        <header>
          <h2 id={heading}>{title}</h2>
          <IconButton label={closeLabel} onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="rp-dialog-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </dialog>
  )
}

export function Disclosure({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <details className="rp-disclosure">
      <summary>
        {title}
        <ChevronDown size={16} />
      </summary>
      <div>{children}</div>
    </details>
  )
}

export function Toast({ message }: { message: string }) {
  return (
    <div className="rp-toast-region" role="status" aria-live="polite" aria-atomic="true">
      {message && (
        <span className="rp-toast" key={message}>
          <Check size={16} aria-hidden="true" />
          {message}
        </span>
      )}
    </div>
  )
}

export function Popover({
  label,
  trigger,
  children,
}: {
  label: string
  trigger: ReactNode
  children: (dismiss: () => void) => ReactNode
}) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="rp-icon-button"
        popoverTarget={id}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {trigger}
      </button>
      <div
        className="rp-popover"
        ref={panel}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={label}
        onToggle={(event) => setOpen(event.newState === 'open')}
      >
        {children(() => panel.current?.hidePopover())}
      </div>
    </>
  )
}
