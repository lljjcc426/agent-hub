import { useEffect, useRef, useState } from 'react'
import { Globe, Maximize2 } from 'lucide-react'

export function BrowserPreview({ id, title, label, revision, enabled, open }: {
  id: string
  title: string
  label: string
  revision: number
  enabled: boolean
  open: () => void
}) {
  const button = useRef<HTMLButtonElement>(null)
  const [inView, setInView] = useState(false)
  const [image, setImage] = useState('')
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setInView(!!entry?.isIntersecting))
    observer.observe(button.current!)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!enabled || !inView) return
    const source = new EventSource('/api/browser/sessions/' + id + '/stream')
    // Show the cached frame immediately and allow time for a fresh frame without keeping a live stream for each tile.
    let settle: ReturnType<typeof setTimeout> | undefined
    let latest = ''
    const close = () => {
      clearTimeout(deadline)
      clearTimeout(settle)
      source.close()
    }
    const deadline = setTimeout(close, 6000)
    source.addEventListener('frame', event => {
      latest = 'data:image/jpeg;base64,' + JSON.parse((event as MessageEvent).data).data
      if (settle !== undefined) return
      setImage(latest)
      settle = setTimeout(() => {
        setImage(latest)
        close()
      }, 500)
    })
    source.addEventListener('closed', close)
    source.onerror = close
    return close
  }, [id, revision, enabled, inView])
  return (
    <button ref={button} type="button" className="team-browser-preview" onClick={open}
      aria-label={label} aria-haspopup="dialog" title={title}>
      <span className="team-browser-frame">
        {image ? <img src={image} alt="" draggable={false} /> : <Globe size={28} aria-hidden="true" />}
        <span className="team-browser-expand"><Maximize2 size={15} aria-hidden="true" /></span>
      </span>
      <span className="team-browser-title">{title}</span>
    </button>
  )
}
