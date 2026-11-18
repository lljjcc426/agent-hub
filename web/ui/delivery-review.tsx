import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { FileReview } from '../../src/chat.ts'
import { ApprovalCard } from './agent-decisions.tsx'
import { DisclosureRoot, DisclosureSummary } from './overlays.tsx'
import './delivery.css'

type Localize = (en: string, zh: string) => string

function DraftText({ readDraft, L }: { readDraft: () => Promise<string>; L: Localize }) {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  async function load() {
    if (text !== null) return
    setFailed(false)
    try {
      setText(await readDraft())
    } catch {
      setFailed(true)
    }
  }
  return (
    <DisclosureRoot className="workflow-draft" onToggle={event => { if (event.currentTarget.open) void load() }}>
      <DisclosureSummary>
        {L('Read draft', '查看原文')}<ChevronDown size={13} aria-hidden="true" />
      </DisclosureSummary>
      {text === null
        ? <span role="status">{failed ? L('Could not load. Reopen to retry.', '读取失败，请重新展开。') : L('Loading…', '读取中…')}</span>
        : <pre tabIndex={0}>{text}</pre>}
    </DisclosureRoot>
  )
}

export function DeliveryReviewCard({ name, state, readDraft, onDecision, disabled, L }: {
  name: string
  state: FileReview['state']
  readDraft: () => Promise<string>
  onDecision: (state: 'approved' | 'denied') => void
  disabled?: boolean
  L: Localize
}) {
  const closed = state === 'superseded' || state === 'cancelled'
  return (
    <div className="rp-file-review">
      <ApprovalCard L={L} title={name} risk={L('File delivery', '文件交付')} details={[]}
        state={closed ? 'resolved' : state}
        statusLabel={closed ? (state === 'superseded' ? L('Replaced', '已替换') : L('Cancelled', '已取消')) : undefined}
        actionLabels={{ approve: L('Deliver file', '确认交付'), deny: L('Decline', '拒绝交付') }}
        disabled={disabled} onDecision={onDecision}>
        {state === 'pending' && <DraftText readDraft={readDraft} L={L} />}
      </ApprovalCard>
    </div>
  )
}
