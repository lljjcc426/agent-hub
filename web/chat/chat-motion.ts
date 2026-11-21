import {useCallback,useEffect,useLayoutEffect,useRef,useState,type RefObject} from 'react'
import {getMotionPreference} from '../ui/motion.ts'

/** Follow new output only while the reader is at the end. No competing smooth-scroll queues. */
export function useChatMotion(root:RefObject<HTMLDivElement|null>,key:string,history:boolean,lastId?:string){
  const [atBottom,setAtBottom]=useState(true),[unread,setUnread]=useState(false)
  const follow=useRef(!history),frame=useRef(0),moving=useRef(false),initialized=useRef(false),previous=useRef(lastId)
  const reduced=useRef(getMotionPreference().matches)
  const stop=useCallback(()=>{cancelAnimationFrame(frame.current);frame.current=0;moving.current=false;follow.current=false},[])
  const latest=useCallback((instant=false)=>{
    const viewport=root.current?.querySelector<HTMLElement>('.transcript');if(!viewport)return
    follow.current=true;setUnread(false);setAtBottom(true)
    if(frame.current)return
    moving.current=true
    let last=performance.now()
    const step=(now:number)=>{
      const delta=viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop
      if(instant||reduced.current||Math.abs(delta)<.7){viewport.scrollTop=viewport.scrollHeight;frame.current=0;moving.current=false;return}
      viewport.scrollTop+=delta*(1-Math.exp(-Math.min(64,now-last)/58));last=now
      frame.current=requestAnimationFrame(step)
    }
    frame.current=requestAnimationFrame(step)
  },[root])
  useLayoutEffect(()=>{
    stop();follow.current=!history;initialized.current=false;previous.current=undefined;setUnread(false)
    const viewport=root.current?.querySelector<HTMLElement>('.transcript'),content=viewport?.querySelector<HTMLElement>('.transcript-inner');if(!viewport||!content)return
    const scroll=()=>{if(moving.current)return;const bottom=viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop<32;follow.current=bottom;setAtBottom(bottom);if(bottom)setUnread(false)}
    const wheel=(event:WheelEvent)=>{if(event.deltaY<0)stop()}
    const pointer=(event:PointerEvent)=>{if(event.pointerType==='touch'||event.target===viewport||event.target instanceof Element&&event.target.closest('summary'))stop()}
    const keys=(event:KeyboardEvent)=>{if(['ArrowUp','PageUp','Home','PageDown','End'].includes(event.key)&&!(event.target instanceof HTMLInputElement)&&!(event.target instanceof HTMLTextAreaElement))stop()}
    const observer=new ResizeObserver(()=>{if(!follow.current)return;const first=!initialized.current&&!!content.querySelector('.message');if(first)initialized.current=true;latest(first)})
    observer.observe(viewport);observer.observe(content)
    viewport.addEventListener('scroll',scroll,{passive:true});viewport.addEventListener('wheel',wheel,{passive:true});viewport.addEventListener('pointerdown',pointer);viewport.addEventListener('keydown',keys)
    const media=getMotionPreference(),change=()=>{reduced.current=media.matches}
    media.addEventListener('change',change)
    return()=>{stop();observer.disconnect();media.removeEventListener('change',change);viewport.removeEventListener('scroll',scroll);viewport.removeEventListener('wheel',wheel);viewport.removeEventListener('pointerdown',pointer);viewport.removeEventListener('keydown',keys)}
  },[key,root,history,latest,stop])
  useEffect(()=>{
    if(lastId&&previous.current&&lastId!==previous.current&&!follow.current)setUnread(true)
    previous.current=lastId
  },[lastId])
  const highlight=useRef<{node:HTMLElement;timer:ReturnType<typeof setTimeout>}|null>(null)
  const clearHighlight=useCallback(()=>{
    if(!highlight.current)return
    clearTimeout(highlight.current.timer)
    delete highlight.current.node.dataset.located
    highlight.current=null
  },[])
  useEffect(()=>clearHighlight,[key,clearHighlight])
  const locate=useCallback((messageId:string)=>{
    const message=root.current?.querySelector<HTMLElement>('.transcript .message[data-message-id="'+CSS.escape(messageId)+'"]')
    if(!message)return false
    stop();clearHighlight();setAtBottom(false)
    // Land first so the whole pulse is visible even after fetching a distant page.
    const card=!!message.querySelector('.workflow-card')
    message.scrollIntoView({behavior:reduced.current||card?'instant':'smooth',block:'center'})
    message.tabIndex=-1;message.focus({preventScroll:true})
    void message.offsetWidth
    message.dataset.located='true'
    highlight.current={node:message,timer:setTimeout(clearHighlight,1800)}
    return true
  },[root,stop,clearHighlight])
  return {atBottom,unread,latest,locate,stop}
}
