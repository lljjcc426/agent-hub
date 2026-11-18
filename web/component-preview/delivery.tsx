import { useRef, useState } from 'react'
import { Check, RotateCcw } from 'lucide-react'
import { Button, DeliveryFileCard, DeliveryFileViewer, DeliveryReviewCard, SwitchView, switchView, type DeliveryFile } from '../ui'
import notes from './release-notes.md?raw'
import href from './release-notes.md?url&no-inline'
import { download, fileName } from './samples.tsx'

export type ExampleReview = 'pending' | 'approved' | 'denied'
const zh = (_en: string, chinese: string) => chinese
const file: DeliveryFile = {
  name: '发布说明.md',
  preview: 'text',
  size: new TextEncoder().encode(notes).length,
  excerpt: notes,
  href,
}
export const sampleWorkbook: DeliveryFile = { name: fileName, preview: null, size: 1552, href: download.href }

export function DeliveredFileExample({ file }: { file: DeliveryFile }) {
  const [open, setOpen] = useState(false)
  return <>
    <DeliveryFileCard file={file} onOpen={() => setOpen(true)} L={zh} />
    {open && <DeliveryFileViewer file={file} onClose={() => setOpen(false)} L={zh} />}
  </>
}

export function DeliveryExample({ state, onChange }: {
  state: ExampleReview
  onChange: (state: ExampleReview) => void
}) {
  const group = useRef<HTMLDivElement>(null)
  function change(next: ExampleReview) {
    group.current?.focus({ preventScroll: true })
    switchView('panel', () => onChange(next))
  }
  return (
    <div className="sample-delivery" role="group" aria-label="文件交付验收" tabIndex={-1} ref={group}>
      <SwitchView>
        <div>
          {state === 'approved'
            ? <DeliveredFileExample file={file} />
            : <DeliveryReviewCard name={file.name} state={state} readDraft={async () => notes} onDecision={change} L={zh} />}
          {state !== 'pending' && (
            <div className="sample-delivery-footer">
              {state === 'approved' && <span role="status"><Check size={14} />已交付</span>}
              <Button tone="quiet" onClick={() => change('pending')}><RotateCcw size={13} />重新演示</Button>
            </div>
          )}
        </div>
      </SwitchView>
    </div>
  )
}
