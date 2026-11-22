import {useEffect, useId, useRef, type ReactNode, type KeyboardEventHandler} from 'react'
import {Inbox, X} from 'lucide-react'
import type {Localize} from '../chat/composer-commands.tsx'
import '../chat/pending-tray.css'
import {getMotionPreference} from './motion.ts'

export function ChatTray({id, heading, icon, navigation, closeLabel, close, children, onKeyDownCapture}: {
  id: string; heading: string; icon: ReactNode; navigation?: ReactNode; closeLabel: string; close: () => void;
  children: ReactNode; onKeyDownCapture?: KeyboardEventHandler<HTMLElement>
}) {
  const title = useId()
  return <aside id={id} tabIndex={-1} className="pending-tray roppo-ui" aria-labelledby={title} onKeyDownCapture={onKeyDownCapture}>
    <header className="pending-heading">
      <h2 id={title}>{icon}{heading}</h2>
      {navigation}
      <button type="button" className="icon-button" aria-label={closeLabel} onClick={close}><X size={16} aria-hidden="true"/></button>
    </header>
    {children}
  </aside>
}

export function PendingRequests({items, loading, close, L, selectedId, heading, navigation, children, id = 'pending-tray'}: {
  heading?: string; navigation?:ReactNode; children?:ReactNode
  items: {id: string; content: ReactNode}[]; loading: boolean
  close: () => void; L: Localize; id?: string; selectedId?: string
}) {
  const focused = useRef<HTMLLIElement>(null)
  const found = items.some(item=>item.id===selectedId)
  useEffect(()=>{
    if(!selectedId||loading||!found)return
    focused.current?.scrollIntoView({block:'nearest',behavior:getMotionPreference().matches?'instant':'smooth'})
    focused.current?.focus({preventScroll:true})
  },[selectedId,loading,found])
  return <ChatTray id={id} heading={heading??L('Pending requests', '待处理事项')} icon={<Inbox size={17} aria-hidden="true"/>}
    navigation={navigation} closeLabel={L('Hide pending requests','隐藏待处理事项')} close={close}
    onKeyDownCapture={event=>{
      if(event.key==='Escape' && event.target instanceof Element && event.target.closest('.rp-approval,.chat-approval-card')){
        event.preventDefault();event.stopPropagation();close()
      }
    }}>
    {children ?? <>
    {selectedId && !loading && !found && <p role="status" className="pending-empty">{L('This item is no longer pending.', '这个事项已处理或已失效。')}</p>}
    {items.length ? <ol className="pending-list">{items.map(({id, content}) => <li key={id} ref={id===selectedId?focused:undefined} tabIndex={-1} data-targeted={id===selectedId||undefined} data-pending-id={id}>
      {content}
    </li>)}</ol> : selectedId && !loading ? null : <p className="pending-empty" role="status">{loading ? L('Loading…','加载中…') : L('You’re all caught up.','暂无待处理事项')}</p>}
    </>}
  </ChatTray>
}
