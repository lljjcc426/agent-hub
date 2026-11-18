import {useCallback,useEffect,useLayoutEffect,useRef,useState,type RefObject} from 'react'
import {Pause,Play,RotateCcw,X} from 'lucide-react'
import type {ChatSessions} from '../../src/chat.ts'
import {teamName} from './agent-avatar.tsx'
import {RoppoCharacter} from './companion.tsx'

type View=ReturnType<ChatSessions['view']>
export type Handoff=View['handoffs'][number]
type Localize=(en:string,zh:string)=>string

/** A first read establishes the baseline, including when paginating or reloading old messages. */
export type HandoffCursor=RefObject<{id:string;sequence:number}|null>
export function useHandoffPlayer(cursor:HandoffCursor,id:string|null,view:View|null,watch:boolean,participant?:string){
  const [playback,setPlayback]=useState<{id:string;events:Handoff[];generation:number}|null>(null)
  useEffect(()=>{setPlayback(null)},[id,watch,participant])
  useEffect(()=>{
    if(!id||view?.conversation.id!==id)return
    const seq=view.conversation.sequence
    const previous=cursor.current
    if(previous?.id===id&&seq<previous.sequence)return
    cursor.current={id,sequence:seq}
    if(previous?.id!==id||!watch||document.hidden)return
    const arrived=(view.handoffs??[]).filter(h=>h.sequence>previous.sequence&&
      (!participant||h.from.id===participant||h.to.id===participant))
    if(arrived.length)setPlayback(p=>({id,generation:p?.generation??0,events:[...(p?.id===id?p.events:[]),...arrived]}))
  },[cursor,id,view,watch,participant])
  const finish=useCallback((eventId:string)=>setPlayback(p=>p?.events[0]?.id===eventId?{...p,events:p.events.slice(1)}:p),[])
  return {generation:playback?.generation??0,event:watch&&playback?.id===id?playback?.events[0]:undefined,finish,
    replay:(events:Handoff[])=>{if(id&&events.length)setPlayback(p=>({id,events,generation:(p?.generation??0)+1}))},close:()=>setPlayback(null)}
}

const duration=3200
const smooth=(v:number)=>{const t=Math.max(0,Math.min(1,v));return t*t*(3-2*t)}
const mix=(a:number,b:number,t:number)=>a+(b-a)*t
const label=(s:Handoff['from'])=>s.kind==='router'?(teamName(s.label)):s.label

/** The document is one prop in scene coordinates; its ownership changes only at contact. */
export function HandoffStage({event,taskTitle,finish,close,L}:{event:Handoff;taskTitle?:string;finish:(id:string)=>void;close:()=>void;L:Localize}){
  const scene=useRef<HTMLDivElement>(null),elapsed=useRef(0)
  const [paused,setPaused]=useState(false),[received,setReceived]=useState(false)
  const [cycle,setCycle]=useState(0)
  const forward=event.from.kind!==event.to.kind?event.from.kind==='router':event.from.id<event.to.id
  const subject=event.files.join(' · ')||(event.kind==='assignment'?L('Task brief','任务单'):L('Task result','任务结果'))
  useLayoutEffect(()=>{
    const node=scene.current!
    const [sender,receiver]=node.querySelectorAll<HTMLElement>('.handoff-agent')
    const prop=node.querySelector<HTMLElement>('.handoff-prop')!
    const reduced=matchMedia('(prefers-reduced-motion: reduce)')
    let frame=0,previous:number|undefined,width=node.clientWidth,held=false
    const dir=forward?1:-1
    function draw(){
      const t=elapsed.current/duration
      const walk=smooth((t-.04)/.40),back=smooth((t-.74)/.25),pass=smooth((t-.50)/.18)
      const start=width*(forward?.20:.80),end=width-start
      const contact=end-dir*49
      const pos=mix(mix(start,contact,walk),start,back)
      const stride=t<.5?walk:back
      const wave=Math.sin(stride*8*Math.PI)*Math.sin(stride*Math.PI)
      const reach=smooth((t-.44)/.08)*(1-smooth((t-.67)/.08))
      const got=pass>=.5
      if(got!==held){held=got;setReceived(got)}
      sender!.style.setProperty('--position',(reduced.matches?start:pos)+'px')
      receiver!.style.setProperty('--position',end+'px')
      sender!.style.setProperty('--rock',(reduced.matches?0:wave*8+dir*3*reach)+'deg')
      sender!.style.setProperty('--lift',(reduced.matches?0:-Math.abs(wave)*3)+'px')
      receiver!.style.setProperty('--rock',(reduced.matches?0:-dir*4*reach)+'deg')
      sender!.style.setProperty('--grip',String(Math.max((1-pass)*.7,reach)))
      receiver!.style.setProperty('--grip',String(Math.max(pass*.7,reach)))
      const fileX=reduced.matches?(got?end:start)+16*dir:mix(pos+dir*19,end-dir*19,pass)
      prop.style.transform='translateX('+fileX+'px) translateX(-50%) translateY('+ (reduced.matches?0:-Math.abs(wave)*2*(1-pass)-7*Math.sin(Math.PI*pass)) +'px) rotate('+(reduced.matches?0:mix(-dir*7,dir*4,pass))+'deg)'
    }
    const resize=new ResizeObserver(()=>{width=node.clientWidth;draw()});resize.observe(node)
    function advance(now:number){
      if(!document.hidden&&!paused){
        if(previous!==undefined)elapsed.current+=Math.min(100,now-previous)
        if(elapsed.current>=duration){finish(event.id);return}
      }
      previous=now;draw()
      if(!paused&&!document.hidden)frame=requestAnimationFrame(advance)
    }
    const resume=()=>{cancelAnimationFrame(frame);previous=undefined;draw();if(!paused&&!document.hidden)frame=requestAnimationFrame(advance)}
    reduced.addEventListener('change',draw);document.addEventListener('visibilitychange',resume)
    resume()
    return ()=>{cancelAnimationFrame(frame);resize.disconnect();reduced.removeEventListener('change',draw);document.removeEventListener('visibilitychange',resume)}
  },[event.id,forward,finish,paused,cycle])
  return <section className="live-handoff" aria-label={L('Task handoff','任务交接')} data-event={event.id} data-ticket={event.ticketId}>
    <header><strong>{label(event.from)} {L('hands off to','交给')} {label(event.to)}</strong>
      <button title={paused?L('Resume','继续'):L('Pause','暂停')} aria-label={paused?L('Resume','继续'):L('Pause','暂停')} onClick={()=>setPaused(!paused)}>{paused?<Play size={14}/>:<Pause size={14}/>}</button>
      <button aria-label={L('Replay handoff','重播交接')} onClick={()=>{elapsed.current=0;setReceived(false);setPaused(false);setCycle(n=>n+1)}}><RotateCcw size={14}/></button>
      <button aria-label={L('Close handoff','关闭交接')} onClick={close}><X size={15}/></button></header>
    <div ref={scene} className="handoff-scene" data-received={received}>
      {[event.from,event.to].map((s,i)=><div key={s.id} className="handoff-agent" data-side={(i===0)===forward?'left':'right'}>
        <div className="handoff-pose"><RoppoCharacter phase="idle" paused={paused} workerId={s.kind==='worker'?s.id:undefined}/><i className="handoff-glove"/></div></div>)}
      <div className="handoff-prop"><i/><b/></div>
    </div>
    <footer><span title={taskTitle}>{event.files.length ? subject : [subject,taskTitle].filter(Boolean).join(' · ')}</span><span>{label(received?event.to:event.from)} · {L('Holding','持有')}</span></footer>
  </section>
}
