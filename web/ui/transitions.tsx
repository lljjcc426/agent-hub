import {
  ViewTransition,
  addTransitionType,
  startTransition,
  useLayoutEffect,
  useRef,
  type ReactElement,
} from 'react'
import { getMotionPreference } from './motion.ts'

export type SwitchScope = 'page' | 'panel' | 'filter'

/** Keep the outgoing pixels during the swap without keeping a second set of live controls. */
export function switchView(scope: SwitchScope, update: () => void) {
  if (getMotionPreference().matches) {
    update()
    return
  }
  startTransition(() => {
    addTransitionType('rp-switch-' + scope)
    update()
  })
}

export function SwitchView({ scope = 'panel', children }: { scope?: SwitchScope; children: ReactElement }) {
  const transition = { ['rp-switch-' + scope]: scope === 'page' ? 'rp-page' : 'rp-panel', default: 'none' }
  return (
    <ViewTransition default="none" update={transition}>
      {children}
    </ViewTransition>
  )
}

/** One moving surface behind differently sized items, including keyboard and external selection changes. */
export function SelectionIndicator({ selector, selection }: { selector: string; selection: unknown }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const marker = ref.current!
    const parent = marker.parentElement!
    const item = parent.querySelector<HTMLElement>(selector)
    if (!item) {
      marker.removeAttribute('data-ready')
      return
    }
    function place() {
      if (!item || !item.offsetWidth || !item.offsetHeight) return
      marker.style.width = item.offsetWidth + 'px'
      marker.style.height = item.offsetHeight + 'px'
      marker.style.transform = 'translate3d(' + item.offsetLeft + 'px,' + item.offsetTop + 'px,0)'
      if (!marker.hasAttribute('data-ready')) {
        marker.getBoundingClientRect()
        marker.dataset.ready = ''
      }
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(parent)
    observer.observe(item)
    return () => observer.disconnect()
  }, [selector, selection])
  return <span className="rp-selection-indicator" ref={ref} aria-hidden="true" />
}

export function useOrderedListMotion(order: readonly unknown[]) {
  const ref = useRef<HTMLOListElement>(null)
  const positions = useRef(new Map<string, number>())
  const animations = useRef(new Map<HTMLElement, Animation>())
  useLayoutEffect(() => {
    const list = ref.current!
    const next = new Map<string, number>()
    const reduce = getMotionPreference().matches
    for (const [row, a] of animations.current) {
      if (row.parentElement !== list) {
        a.cancel()
        animations.current.delete(row)
      }
    }
    for (const row of Array.from(list.children) as HTMLElement[]) {
      const id = row.dataset.item!,
        y = row.offsetTop,
        last = positions.current.get(id)
      next.set(id, y)
      if (last === undefined || last === y || reduce) continue
      const previous = animations.current.get(row)
      const transform = previous ? getComputedStyle(row).transform : 'none'
      const offset = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42
      previous?.cancel()
      const motion = row.animate(
        [{ transform: 'translateY(' + (last + offset - y) + 'px)' }, { transform: 'none' }],
        { duration: 320, easing: 'cubic-bezier(.22,.83,.24,1)' },
      )
      animations.current.set(row, motion)
      motion.onfinish = () => animations.current.delete(row)
    }
    positions.current = next
  }, [order])
  useLayoutEffect(() => {
    const running = animations.current
    return () => {
      for (const a of running.values()) a.cancel()
      running.clear()
    }
  }, [])
  return ref
}
