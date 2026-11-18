import {
  useId,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import { SelectionIndicator } from './transitions.tsx'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'primary' | 'secondary' | 'quiet'
  busy?: boolean
}
export function Button({
  tone = 'secondary',
  busy,
  disabled,
  type = 'button',
  className = '',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={'rp-button ' + className}
      data-tone={tone}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy && <LoaderCircle className="rp-spin" size={16} aria-hidden="true" />}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      {...props}
      className={'rp-icon-button ' + className}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  )
}

export function TextField({
  label,
  icon,
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; icon?: ReactNode }) {
  return (
    <label className={'rp-input ' + className}>
      {icon && <span aria-hidden="true">{icon}</span>}
      <input {...props} aria-label={label} />
    </label>
  )
}

export function TextAreaField({
  label, ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  return <textarea {...props} className={'rp-textarea ' + (props.className || '')} aria-label={label} />
}

export function SelectField({
  label,
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <label className={'rp-select ' + className}>
      <select {...props} aria-label={label}>
        {children}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </label>
  )
}

export interface Choice<T extends string> {
  value: T
  label: string
  visual?: ReactNode
  disabled?: boolean
}

/** Segments and illustrated preferences both select exactly one value. */
export function ChoiceGroup<T extends string>({
  label,
  choices,
  value,
  onChange,
  appearance = 'segments',
}: {
  label: string
  choices: readonly Choice<T>[]
  value: T
  onChange: (value: T) => void
  appearance?: 'segments' | 'tiles'
}) {
  const name = useId()
  const drag = useRef<{ x: number; y: number; moving: boolean } | null>(null)
  const suppressClick = useRef(false)
  function optionAt(root: HTMLFieldSetElement, x: number) {
    const options = Array.from(
      root.querySelectorAll<HTMLLabelElement>('.rp-choice:not(:has(input:disabled))'),
    )
    return options.find((option) => x <= option.getBoundingClientRect().right) ?? options.at(-1)
  }
  function move(event: ReactPointerEvent<HTMLFieldSetElement>) {
    const start = drag.current
    if (!start) return
    if (!event.buttons) {
      drag.current = null
      return
    }
    const root = event.currentTarget,
      dx = event.clientX - start.x,
      dy = event.clientY - start.y
    if (!start.moving) {
      if (Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx)) {
        drag.current = null
        return
      }
      if (Math.abs(dx) < 6) return
      start.moving = true
      root.setPointerCapture(event.pointerId)
      root.dataset.dragging = ''
    }
    const marker = root.querySelector<HTMLElement>('.rp-selection-indicator')!
    const x = Math.max(
      3,
      Math.min(
        root.clientWidth - marker.offsetWidth - 3,
        event.clientX - root.getBoundingClientRect().left - marker.offsetWidth / 2,
      ),
    )
    root.style.setProperty('--rp-drag-x', x + 'px')
  }
  function end(event: ReactPointerEvent<HTMLFieldSetElement>) {
    if (drag.current?.moving) {
      const root = event.currentTarget
      if (event.type === 'pointerup') {
        const input = optionAt(root, event.clientX)?.querySelector('input')
        if (input) {
          onChange(input.value as T)
          input.focus({ preventScroll: true })
        }
        suppressClick.current = true
      }
      delete root.dataset.dragging
      root.style.removeProperty('--rp-drag-x')
    }
    drag.current = null
  }
  return (
    <fieldset
      className="rp-choices"
      data-appearance={appearance}
      onPointerDown={(e) => {
        suppressClick.current = false
        if (
          appearance === 'segments' &&
          e.button === 0 &&
          e.isPrimary &&
          (e.target as HTMLElement).closest('.rp-choice')
        )
          drag.current = { x: e.clientX, y: e.clientY, moving: false }
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={(e) => {
        delete e.currentTarget.dataset.dragging
        drag.current = null
      }}
      onClickCapture={(e) => {
        if (suppressClick.current && e.detail !== 0) {
          suppressClick.current = false
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    >
      <legend className="rp-sr-only">{label}</legend>
      <SelectionIndicator selector=".rp-choice[data-current]" selection={value} />
      {choices.map((choice) => (
        <label
          key={choice.value}
          className="rp-choice"
          data-current={choice.value === value ? '' : undefined}
        >
          <input
            type="radio"
            name={name}
            value={choice.value}
            checked={value === choice.value}
            disabled={choice.disabled}
            onChange={() => onChange(choice.value)}
          />
          <span className="rp-choice-content">
            <span className="rp-choice-title">
              {appearance === 'tiles' && (
                <span className="rp-choice-tick" aria-hidden="true">
                  <Check size={13} />
                </span>
              )}
              {choice.label}
            </span>
            {choice.visual}
          </span>
        </label>
      ))}
    </fieldset>
  )
}

export function CheckField({
  label,
  appearance = 'checkbox',
  hideLabel = false,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: string
  appearance?: 'switch' | 'checkbox'
  hideLabel?: boolean
}) {
  return (
    <label className="rp-check" data-appearance={appearance}>
      <input {...props} type="checkbox" role={appearance === 'switch' ? 'switch' : undefined} />
      <span className="rp-check-glyph" aria-hidden="true">
        {appearance === 'checkbox' && <Check size={13} />}
      </span>
      <span className={hideLabel ? 'rp-sr-only' : undefined}>{label}</span>
    </label>
  )
}
