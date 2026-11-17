import {createContext,useContext,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react'
import {createPortal} from 'react-dom'
import {MoreHorizontal,Reply,Search,Smile,X} from 'lucide-react'
import type {ChatQuote,ChatQuoteView,AgentReaction} from '../../src/chat-interactions.ts'
import {CopyButton} from './copy-button.tsx'

type L=(en:string,zh:string)=>string
export type DraftQuote=ChatQuoteView&ChatQuote
type Message={id:string;text:string;role:'user'|'assistant';speaker?:{id:string;label:string};quote?:ChatQuoteView;reactions?:string[];agentReactions?:AgentReaction[];attachments?:{name:string}[]}
const Context=createContext({L:((en:string)=>en) as L,messages:[] as Message[],reply:(_quote:DraftQuote)=>{},react:(_id:string,_emoji:string)=>{},locate:(_id:string)=>{}})
export const useInteractions=()=>useContext(Context)
const quick=[['👍','赞 认可 thumbs up'],['❤️','爱 喜欢 heart'],['😂','笑 laugh'],['🎉','庆祝 party'],['🤔','思考 thinking'],['👀','关注 eyes']]
const emojis=[...quick,['✨','闪光 sparkles'],['🔥','火 fire'],['👏','鼓掌 clap'],['🙌','太棒了 hands'],['✅','完成 check'],['💡','灵感 idea'],['🥹','感动 happy'],['😊','微笑 smile'],['😮','惊讶 wow'],['🚀','火箭 rocket'],['💯','满分 hundred'],['🙏','感谢 thanks'],['😅','汗 sweat'],['😎','酷 cool'],['🤝','合作 handshake'],['🫡','收到 salute'],['🌱','成长 plant'],['☕','咖啡 coffee']]
const row=(id:string)=>Array.from(document.querySelectorAll<HTMLElement>('.message[data-message-id]')).find(el=>el.dataset.messageId===id)
function plainFragment(copy:HTMLElement|DocumentFragment){
  copy.querySelectorAll('.katex').forEach(el=>el.replaceWith(el.querySelector('annotation')?.textContent??el.textContent??''))
  copy.querySelectorAll('button,.code-header,.katex-html,[aria-hidden="true"]').forEach(el=>el.remove())
  copy.querySelectorAll('img').forEach(el=>el.replaceWith(el.alt))
  // A detached fragment has no layout. Keep the rendered block boundaries explicitly.
  copy.querySelectorAll('p,li,pre,blockquote,tr,h1,h2,h3,h4,br').forEach(el=>el.append('\n'))
  copy.querySelectorAll('td,th').forEach(el=>el.append('\t'))
  return (copy.textContent??'').replace(/\n{3,}/g,'\n\n').trim()
}
export function renderedText(id:string){
  const source=row(id)?.querySelector<HTMLElement>('[data-message-body]')
  return source?plainFragment(source.cloneNode(true) as HTMLElement):''
}
function selectedText(range:Range){
  const copy=range.cloneRange(),element=(node:Node)=>node instanceof Element?node:node.parentElement
  const startMath=element(copy.startContainer)?.closest('.katex'),endMath=element(copy.endContainer)?.closest('.katex')
  // A rendered formula is quoted as one mathematical expression, including its TeX source.
  if(startMath)copy.setStartBefore(startMath)
  if(endMath)copy.setEndAfter(endMath)
  return plainFragment(copy.cloneContents())
}
const bodyText=(message:Message)=>renderedText(message.id)||message.text||message.attachments?.map(a=>a.name).join(' · ')||''
function toQuote(message:Message,excerpt?:string):DraftQuote{
  return {messageId:message.id,role:message.role,label:message.speaker?.label??'',speakerId:message.speaker?.id,text:excerpt??bodyText(message),...(excerpt?{excerpt}:{})}
}

export function InteractionProvider({children,...value}:React.ComponentProps<typeof Context.Provider>['value']&{children:ReactNode}){
  return <Context.Provider value={value}>{children}<SelectionReply/></Context.Provider>
}

export function MessageActions({id}:{id:string}){
  const {L,messages,reply,react}=useInteractions(),message=messages.find(m=>m.id===id)!
  const [panel,setPanel]=useState<'emoji'|'more'|null>(null),[expanded,setExpanded]=useState(false),[search,setSearch]=useState('')
  const popover=useRef<HTMLDivElement>(null),anchor=useRef<HTMLButtonElement|null>(null),last=useRef(panel),keyboard=useRef(false)
  if(panel)last.current=panel
  const shown=panel??last.current
  useLayoutEffect(()=>{
    const node=popover.current;if(!node)return
    if(!panel){if(node.matches(':popover-open'))node.hidePopover();return}
    node.showPopover()
    if(keyboard.current){Array.from(node.querySelectorAll<HTMLElement>('input,button')).find(el=>el.getClientRects().length)?.focus({preventScroll:true});keyboard.current=false}
    const rect=anchor.current!.getBoundingClientRect(),box=node.getBoundingClientRect(),above=rect.top-box.height-8
    node.style.left=Math.max(10,Math.min(innerWidth-box.width-10,rect.left-8))+'px'
    node.style.top=Math.max(10,above>10?above:Math.min(innerHeight-box.height-10,rect.bottom+8))+'px'
    node.style.transformOrigin=above>10?'24px bottom':'24px top'
  },[panel,expanded,search])
  useEffect(()=>{const close=()=>setPanel(null);window.addEventListener('resize',close);return()=>window.removeEventListener('resize',close)},[])
  const open=(kind:'emoji'|'more',event:React.MouseEvent<HTMLButtonElement>)=>{anchor.current=event.currentTarget;keyboard.current=event.detail===0;setSearch('');setExpanded(false);setPanel(p=>p===kind?null:kind)}
  const quote=()=>{setPanel(null);reply(toQuote(message))}
  const choose=(emoji:string)=>{setPanel(null);react(id,emoji);anchor.current?.focus({preventScroll:true})}
  const hits=search?emojis.filter(([emoji,keywords])=>(emoji+' '+keywords).toLowerCase().includes(search.toLowerCase())):emojis
  return <div className="message-actions" aria-label={L('Message actions','消息操作')} data-open={!!panel}>
    <button type="button" className="icon-button primary-action" title={L('Quote reply','引用回复')} aria-label={L('Quote reply','引用回复')} onClick={quote}><Reply size={15}/></button>
    <button type="button" className="icon-button primary-action" title={L('React','表情回应')} aria-label={L('React','表情回应')} aria-expanded={panel==='emoji'} onClick={e=>open('emoji',e)}><Smile size={15}/></button>
    <CopyButton value={()=>bodyText(message)} L={L} label={L('Copy message','复制消息')}/>
    <button type="button" className="icon-button more-action" title={L('More actions','更多操作')} aria-label={L('More actions','更多操作')} aria-expanded={panel==='more'} onClick={e=>open('more',e)}><MoreHorizontal size={16}/></button>
    {createPortal(<div ref={popover} popover="auto" role="dialog" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setPanel(null);anchor.current?.focus({preventScroll:true})}}} className={'message-popover '+(shown==='emoji'?'emoji-popover':'message-menu')} aria-label={shown==='emoji'?L('Choose a reaction','选择表情'):L('Message actions','消息操作')} onToggle={event=>{if(event.newState==='closed')setPanel(null)}}>
      {shown==='emoji'?<>
        <div className="quick-reactions">{quick.map(([emoji,keywords])=><button type="button" key={emoji} aria-label={emoji} title={keywords} aria-pressed={message.reactions?.includes(emoji!)} onClick={()=>choose(emoji!)}>{emoji}</button>)}<button type="button" aria-label={L('More emoji','更多表情')} aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}><Smile size={19}/></button></div>
        {expanded?<div className="emoji-search-panel"><label className="emoji-search"><Search size={15}/><input autoFocus value={search} onChange={e=>setSearch(e.target.value)} aria-label={L('Search emoji','搜索表情')} placeholder={L('Search emoji','搜索表情')}/></label><div className="emoji-grid">{hits.map(([emoji,keywords])=><button type="button" key={emoji} aria-label={emoji} title={keywords} aria-pressed={message.reactions?.includes(emoji!)} onClick={()=>choose(emoji!)}>{emoji}</button>)}</div>{!hits.length?<span role="status">{L('No matching emoji','没有匹配的表情')}</span>:null}</div>:null}
      </>:shown==='more'?<>
        <button type="button" className="mobile-only-action" onClick={quote}><Reply size={15}/>{L('Quote reply','引用回复')}</button>
        <button type="button" className="mobile-only-action" onClick={()=>{keyboard.current=true;setPanel('emoji');setExpanded(true)}}><Smile size={15}/>{L('React','表情回应')}</button>
        <CopyButton value={message.text} L={L} label={L('Copy Markdown','复制 Markdown')} menu/>
      </>:null}
    </div>,document.body)}
  </div>
}

export function Reactions({id}:{id:string}){
  const {messages,react,L}=useInteractions(),message=messages.find(m=>m.id===id),own=message?.reactions??[],agents=message?.agentReactions??[]
  const reactions=[...new Set([...own,...agents.map(r=>r.emoji)])]
  const [rendered,setRendered]=useState(reactions)
  useLayoutEffect(()=>{
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){setRendered(reactions);return}
    setRendered(old=>[...new Set([...old,...reactions])]);const timer=setTimeout(()=>setRendered(reactions),280);return()=>clearTimeout(timer)
  },[reactions.join('')])
  return <div className="reaction-reveal" data-open={!!reactions.length}><div><div className="message-reactions" aria-label={L('Reactions','表情回应')}>{rendered.map(emoji=>{
    const active=reactions.includes(emoji),selected=own.includes(emoji),authors=[...(selected?[L('You','你')]:[]),...agents.filter(r=>r.emoji===emoji).map(r=>r.actor.label)]
    return <span className="reaction-slot" key={emoji} data-active={active} aria-hidden={!active}><button type="button" className="reaction-pill" title={authors.join(' · ')} aria-label={(selected?L('Remove ','移除 '):L('React with ','回应 '))+emoji+' · '+authors.join(' · ')} aria-pressed={selected} tabIndex={active?0:-1} onClick={()=>react(id,emoji)}>{emoji}<span>{authors.length||1}</span></button></span>
  })}</div></div></div>
}

export function QuotePreview({quote,onClear,L}:{quote:DraftQuote|null;onClear:()=>void;L:L}){
  const last=useRef(quote);if(quote)last.current=quote
  const shown=quote??last.current
  return <div className="composer-quote-reveal" data-open={!!quote} inert={!quote} aria-hidden={!quote}><div>{shown?<div className="composer-quote"><Reply size={16}/><div><strong>{L('Reply to ','回复 ')+(shown.role==='user'?L('you','你'):shown.label)}</strong><p>{shown.text}</p></div><button type="button" className="icon-button" aria-label={L('Cancel quote','取消引用')} onClick={onClear}><X size={15}/></button></div>:null}</div></div>
}
export function QuotedMessage({quote}:{quote?:ChatQuoteView}){
  const {L,locate}=useInteractions();if(!quote)return null
  return <button type="button" className="quoted-message" disabled={quote.unavailable} onClick={()=>locate(quote.messageId)} title={quote.unavailable?undefined:L('Show original message','查看原消息')}><span><Reply size={12}/>{L('You replied to ','你回复了 ')+(quote.role==='user'?L('yourself','自己'):quote.label)}</span><span className="quoted-text">{quote.unavailable?L('Original message unavailable','原消息已不可用'):quote.text}</span></button>
}

function SelectionReply(){
  const {messages,reply,L}=useInteractions(),[selection,setSelection]=useState<{quote:DraftQuote;x:number;y:number}|null>(null)
  useEffect(()=>{
    const update=()=>{
      const selected=window.getSelection();if(!selected||selected.isCollapsed||!selected.rangeCount){setSelection(null);return}
      const range=selected.getRangeAt(0),ancestor=range.commonAncestorContainer,element=ancestor instanceof Element?ancestor:ancestor.parentElement,body=element?.closest('[data-message-body]'),root=body?.closest<HTMLElement>('.message[data-message-id]'),message=messages.find(m=>m.id===root?.dataset.messageId)
      if(!message||!body||!body.contains(range.startContainer)||!body.contains(range.endContainer)){setSelection(null);return}
      const rect=range.getBoundingClientRect(),text=selectedText(range)
      if(!text||text.length>8000){setSelection(null);return}
      setSelection({quote:toQuote(message,text),x:Math.max(10,Math.min(innerWidth-150,rect.left+rect.width/2-65)),y:Math.max(10,rect.top-42)})
    }
    const clear=()=>setSelection(null),key=(e:KeyboardEvent)=>{if(e.key==='Escape')clear();else if(e.shiftKey)update()}
    document.addEventListener('selectionchange',update);document.addEventListener('keyup',key);window.addEventListener('resize',clear);document.addEventListener('scroll',clear,true)
    return()=>{document.removeEventListener('selectionchange',update);document.removeEventListener('keyup',key);window.removeEventListener('resize',clear);document.removeEventListener('scroll',clear,true)}
  },[messages])
  return selection?createPortal(<button type="button" className="selection-reply" style={{left:selection.x,top:selection.y}} onPointerDown={e=>e.preventDefault()} onClick={()=>{reply(selection.quote);setSelection(null);window.getSelection()?.removeAllRanges()}}><Reply size={14}/>{L('Quote selection','引用选中内容')}</button>,document.body):null
}
