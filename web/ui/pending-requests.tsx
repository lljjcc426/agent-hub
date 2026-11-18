import {useEffect, useId, useRef, type ReactNode} from 'react'
import {Inbox, LocateFixed, X} from 'lucide-react'
import type {Localize} from '../chat/composer-commands.tsx'
import '../chat/pending-tray.css'

export function PendingRequests({items, loading, close, L, selectedId, heading, navigation, children, id = 'pending-tray'}: {
  heading?: string; navigation?:ReactNode; children?:ReactNode
  items: {id: string; content: ReactNode; locate: () => void}[]; loading: boolean
  close: () => void; L: Localize; id?: string; selectedId?: string
}) {
  const title = useId()
  const focused = useRef<HTMLLIElement>(null)
  const found = items.some(item=>item.id===selectedId)
  useEffect(()=>{
    if(!selectedId||loading||!found)return
    focused.current?.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'})
    focused.current?.focus({preventScroll:true})
  },[selectedId,loading,found])
  return <aside id={id} tabIndex={-1} className="pending-tray roppo-ui" aria-labelledby={title}
    onKeyDownCapture={event=>{
      if(event.key==='Escape' && event.target instanceof Element && event.target.closest('.rp-approval,.permission-review')){
        event.preventDefault();event.stopPropagation();close()
      }
    }}>
    <header className="pending-heading">
      <h2 id={title}><Inbox size={17}/>{heading??L('Pending requests', '待处理事项')}</h2>
      {navigation}
      <button type="button" className="icon-button" aria-label={L('Hide pending requests','隐藏待处理事项')} onClick={close}><X size={16}/></button>
    </header>
    {children ?? <>
    {selectedId && !loading && !found && <p role="status" className="pending-empty">{L('This item is no longer pending.', '这个事项已处理或已失效。')}</p>}
    {items.length ? <ol className="pending-list">{items.map(({id, content, locate}) => <li key={id} ref={id===selectedId?focused:undefined} tabIndex={-1} data-targeted={id===selectedId||undefined} data-pending-id={id} onClick={event => {
      if (event.target instanceof Element && !event.target.closest('button, a, input, textarea, select, label, details, summary, [contenteditable=true]') && window.getSelection()?.isCollapsed !== false) locate()
    }}>
      <div className="pending-card-content">{content}</div>
      <button type="button" className="pending-locate icon-button" aria-label={L('Go to original message','定位到原消息')}
        title={L('Go to original message','定位到原消息')} onClick={locate}><LocateFixed size={15}/></button>
    </li>)}</ol> : selectedId && !loading ? null : <p className="pending-empty" role="status">{loading ? L('Loading…','加载中…') : L('You’re all caught up.','暂无待处理事项')}</p>}
    </>}
  </aside>
}
