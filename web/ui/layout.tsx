import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import mark from '../../src/ui/assets/roppo-mark.png'
import { SelectionIndicator } from './transitions.tsx'

export function Brand() {
  return (
    <span className="rp-brand">
      <img src={mark} width="27" height="27" alt="" />
      Roppo
    </span>
  )
}

export function Sidebar({
  brand,
  label,
  children,
  footer,
}: {
  brand: ReactNode
  label: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <aside className="rp-sidebar">
      <div className="rp-sidebar-brand">{brand}</div>
      <nav aria-label={label} className="rp-sidebar-nav">
        <SelectionIndicator selector=".rp-nav-link[aria-current]" selection={children} />
        {children}
      </nav>
      {footer && <div className="rp-sidebar-footer">{footer}</div>}
    </aside>
  )
}

export function NavLink({
  icon,
  children,
  current,
  className = '',
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { icon: ReactNode; current?: boolean }) {
  return (
    <a {...props} className={'rp-nav-link ' + className} aria-current={current ? 'page' : undefined}>
      <span aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </a>
  )
}

export function Breadcrumb({
  items,
  label,
}: {
  items: readonly { label: string; href?: string }[]
  label: string
}) {
  return (
    <nav aria-label={label} className="rp-breadcrumb">
      <ol>
        {items.map((item, i) => (
          <li key={i}>
            {i > 0 && <ChevronRight size={13} aria-hidden="true" />}
            {item.href ? (
              <a href={item.href}>{item.label}</a>
            ) : (
              <span aria-current={i === items.length - 1 ? 'page' : undefined}>{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

export function Topbar({ start, center, end }: { start: ReactNode; center?: ReactNode; end?: ReactNode }) {
  return (
    <header className="rp-topbar">
      <div>{start}</div>
      <div>{center}</div>
      <div>{end}</div>
    </header>
  )
}
