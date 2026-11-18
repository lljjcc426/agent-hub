import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowUpRight, FileText, X } from 'lucide-react'
import type { ChatDelivery } from '../../src/chat-deliveries.ts'
import './delivery.css'

const DeliveryMarkdown = lazy(() => import('../chat/file-markdown.tsx'))
type Localize = (en: string, zh: string) => string
export type DeliveryFile = Pick<ChatDelivery, 'name' | 'size' | 'preview' | 'excerpt'> & {
  href: string
  previewHref?: string
}

function fileSize(bytes: number) {
  return bytes < 1024
    ? bytes + ' B'
    : bytes < 1024 ** 2
      ? Number((bytes / 1024).toFixed(1)) + ' KB'
      : Number((bytes / 1024 ** 2).toFixed(1)) + ' MB'
}
export function DeliveryFileCard({ file, onOpen, L }: {
  file: DeliveryFile
  onOpen: () => void
  L: Localize
}) {
  return (
    <button
      type="button"
      className="team-file"
      onClick={onOpen}
      aria-label={L('Open file ', '打开文件 ') + file.name}
    >
      <span className="file-stamp" aria-hidden="true">
        {file.preview === 'image' ? (
          <img
            loading="lazy"
            alt=""
            src={file.previewHref ?? file.href}
          />
        ) : file.excerpt ? (
          <span className="file-page">
            <b>{file.name.split('.').at(-1)?.toUpperCase()}</b>
            {file.excerpt}
          </span>
        ) : (
          <FileText size={25} strokeWidth={1.4} />
        )}
      </span>
      <span className="team-file-label">
        <strong>{file.name}</strong>
        <small>
          {fileSize(file.size)} · {L('Delivered file', '交付文件')}
        </small>
      </span>
      <ArrowUpRight size={16} />
    </button>
  )
}

function FileContents({ file, L }: { file: DeliveryFile; L: Localize }) {
  const [content, setContent] = useState<string>()
  const [error, setError] = useState(false)
  const url = file.previewHref ?? file.href
  const previewText = file.preview === 'text' && file.size <= 512 * 1024
  useEffect(() => {
    if (!previewText) return
    const controller = new AbortController()
    fetch(url, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw Error('preview_unavailable')
        return response.text()
      })
      .then(setContent)
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [url, previewText])
  if (error) return <p role="alert">{L('Could not load preview', '预览加载失败')}</p>
  if (file.preview === 'image') return <img alt={file.name} src={url} onError={() => setError(true)} />
  if (!previewText) {
    return <div className="delivery-download-only"><FileText size={32} strokeWidth={1.3} aria-hidden="true"/>
      {L('Download to view this file', '下载后查看此文件')}</div>
  }
  if (content === undefined) return <p role="status">{L('Loading…', '正在加载…')}</p>
  if (file.name.toLowerCase().endsWith('.md')) {
    return (
      <Suspense fallback={<pre>{content}</pre>}>
        <DeliveryMarkdown text={content} />
      </Suspense>
    )
  }
  return <pre>{content}</pre>
}

export function DeliveryFileViewer({ file, onClose, L }: {
  file: DeliveryFile
  onClose: () => void
  L: Localize
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  useLayoutEffect(() => {
    const el = dialog.current!
    el.showModal()
    return () => el.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="team-file-dialog"
      onCancel={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.stopPropagation()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      aria-labelledby={heading}
    >
      <section>
        <header>
          <h2 id={heading}>{file.name}</h2>
          <button
            type="button"
            className="rp-icon-button icon-button"
            aria-label={L('Close file', '关闭文件')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="team-file-preview">
          <FileContents key={file.previewHref ?? file.href} file={file} L={L} />
        </div>
        <footer>
          <span>{fileSize(file.size)}</span>
          <a className="delivery-download" href={file.href} download={file.name}>
            <ArrowDownToLine size={16} />
            {L('Download', '下载')}
          </a>
        </footer>
      </section>
    </dialog>
  )
}
