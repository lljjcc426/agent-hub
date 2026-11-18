import {
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'

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
  return (
    <fieldset className="rp-choices" data-appearance={appearance}>
      <legend className="rp-sr-only">{label}</legend>
      {choices.map((choice) => (
        <label key={choice.value} className="rp-choice">
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
