import {useEffect,useLayoutEffect,useRef,useState} from 'react'
import type {CompanionStatus} from './companion-state.ts'
import {teamName} from './agent-avatar.tsx'
import {CompanionScene} from './companion-scene.tsx'
import type {Handoff,Speaker} from './use-handoff.ts'
export {RoppoCharacter} from './roppo-character.tsx'

export function ChatCompanion({status:current,onOpen,L,actor,event,onFinish}:{
 actor:Speaker; event?:Handoff; onFinish:(id:string)=>void
 status:CompanionStatus; onOpen:()=>void; L:(en:string,zh:string)=>string
}){
 const [displayed,setDisplayed]=useState(current);
 const changedAt=useRef(0);
 const critical=!['thinking','working','reviewing'].includes(current.phase);
 const status=current.runId!==displayed.runId||critical?current:displayed;
 useEffect(()=>{
   const publish=()=>{changedAt.current=Date.now();setDisplayed(current)};
   if(current.runId!==displayed.runId||critical||!changedAt.current){publish();return}
   const timer=setTimeout(publish,Math.max(0,1400-(Date.now()-changedAt.current)));
   return ()=>clearTimeout(timer);
 },[current.phase,current.label,current.runId]);
 const [hidden,setHidden]=useState(()=>document.hidden);
 const [celebrate,setCelebrate]=useState(false);
 const previous=useRef(status);
 useEffect(()=>{
   const update=()=>setHidden(document.hidden);
   document.addEventListener('visibilitychange',update);
   return ()=>document.removeEventListener('visibilitychange',update);
 },[]);
 useEffect(()=>{
   const wasActive=['thinking','working','reviewing','waiting'].includes(previous.current.phase);
   const justCompleted=status.phase==='completed'&&previous.current.runId===status.runId&&wasActive;
   previous.current=status;
   setCelebrate(justCompleted);
   if(justCompleted){const timer=setTimeout(()=>setCelebrate(false),2400);return ()=>clearTimeout(timer)}
 },[status.phase,status.runId]);
 const phase=status.phase==='completed'&&!celebrate?'idle':status.phase;
 const name=(s:Speaker)=>s.kind==='router'?teamName(s.label):s.label
 const caption=event?name(event.from)+L(' hands off to ',' 交给 ')+name(event.to):status.label
 const capsule = useRef<HTMLDivElement>(null)
 const measure = useRef<HTMLSpanElement>(null)
 useLayoutEffect(() => {
   const shell = capsule.current!
   const label = measure.current!
   const resize = () => shell.style.setProperty('--resting-caption', Math.ceil(label.getBoundingClientRect().width) + 'px')
   resize()
   const observer = new ResizeObserver(resize)
   observer.observe(label)
   return () => observer.disconnect()
 }, [])
 return <div ref={capsule} className="chat-float chat-float-center" data-expanded={event ? true : undefined}>
  <button type="button" className="chat-companion" data-handoff={event?.id} onClick={onOpen}
   data-phase={status.phase} title={caption} aria-label={L('View current activity','查看当前任务进展')}>
   <CompanionScene actor={actor} phase={phase} paused={hidden} event={event} onFinish={onFinish}/>
   <span className="companion-copy"><span className="companion-label" role="status" aria-live="polite" aria-atomic="true">{caption}</span></span>
   <span aria-hidden="true" className="companion-ruler"><span ref={measure}>{status.label}</span></span>
  </button>
 </div>;
}
