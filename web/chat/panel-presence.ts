import { useLayoutEffect, useRef, useState } from 'react'
import { finishLayerExit } from '../ui/overlays.tsx'

export function usePanelPresence<T, NodeType extends HTMLElement = HTMLElement>(open: T | null, selector?: string) {
  const [lastOpen, setLastOpen] = useState(open)
  const ref = useRef<NodeType>(null)
  if (open !== null && open !== lastOpen) setLastOpen(open)

  const view = open ?? lastOpen
  const closing = open === null && view !== null
  useLayoutEffect(() => {
    if (!closing) return
    const container = ref.current
    const layer = selector ? container?.querySelector<HTMLElement>(selector) : container
    if (!layer) {
      setLastOpen(null)
      return
    }
    return finishLayerExit(layer, () => setLastOpen(null))
  }, [closing, selector])

  return { ref, view, closing }
}
