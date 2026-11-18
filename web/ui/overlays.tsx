import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import { IconButton } from './controls.tsx'

/** Keep the native top layer until its exit finishes. Reopening cancels the pending dismissal. */
export function finishLayerExit(layer: HTMLElement, hide: () => void) {
  let current = true
  const transitions = layer.getAnimations().map((motion) => motion.finished)
  void Promise.allSettled(transitions).then(() => {
    if (current) hide()
  })
  return () => {
    current = false
  }
}

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
  useLayoutEffect(() => {
    const el = ref.current!
    if (open) {
      if (!el.open) el.showModal()
    } else if (el.open) {
      return finishLayerExit(el, () => el.close())
    }
  }, [open])
  return (
    <dialog
      ref={ref}
      className="rp-dialog"
      role={role}
      inert={!open}
      aria-hidden={!open}
      data-closing={open ? undefined : ''}
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

export function Disclosure({ title, children, arrival }: { title: ReactNode; children: ReactNode; arrival?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="rp-disclosure" data-arrival={arrival||undefined} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {title}
        <ChevronDown size={16} />
      </summary>
      <div className="rp-disclosure-clip" inert={!open} aria-hidden={!open}>
        <div>{children}</div>
      </div>
    </details>
  )
}

export function Toast({ message }: { message: string }) {
  const previous = useRef(message)
  useEffect(() => {
    if (message) previous.current = message
  }, [message])
  return (
    <div className="rp-toast-region" role="status" aria-live="polite" aria-atomic="true">
      <span className="rp-toast" data-visible={!!message} aria-hidden={!message}>
        <Check size={16} aria-hidden="true" />
        {message || previous.current}
      </span>
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
  const invoker = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  function dismiss() {
    if (panel.current?.contains(document.activeElement)) invoker.current?.focus({ preventScroll: true })
    setOpen(false)
  }
  useLayoutEffect(() => {
    const el = panel.current!
    if (open) {
      if (!el.matches(':popover-open')) el.showPopover({ source: invoker.current! })
    } else if (el.matches(':popover-open')) {
      return finishLayerExit(el, () => el.hidePopover())
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    function outside(event: Event) {
      const path = event.composedPath()
      if (!path.includes(panel.current!) && !path.includes(invoker.current!)) setOpen(false)
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        dismiss()
      }
    }
    document.addEventListener('click', outside, true)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('click', outside, true)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  return (
    <>
      <button
        type="button"
        className="rp-icon-button"
        popoverTarget={id}
        ref={invoker}
        onClick={(event) => {
          event.preventDefault()
          setOpen(!open)
        }}
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
        popover="manual"
        role="dialog"
        inert={!open}
        aria-hidden={!open}
        aria-label={label}
        data-closing={open ? undefined : ''}
      >
        {children(dismiss)}
      </div>
    </>
  )
}
