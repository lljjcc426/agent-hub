import {useEffect,useRef,useState} from 'react';
import body from '../../src/ui/assets/agents/roppo-body.webp';
import type {CompanionPhase,CompanionStatus} from './companion-state.ts';
import './companion.css';

export function RoppoCharacter({phase,paused=false}:{phase:CompanionPhase;paused?:boolean}){
 return <span className="roppo-character" data-phase={phase} data-paused={paused||undefined} aria-hidden="true">
  <span className="roppo-pose"><span className="roppo-body">
   <img src={body} width="512" height="512" alt="" draggable={false}/>
   <span className="roppo-eyes"><i/><i/></span>
   <span className="roppo-arm roppo-arm-left"/><span className="roppo-arm roppo-arm-right"/>
  </span></span>
  <span className="roppo-laptop"><span className="roppo-laptop-screen"><i/></span><span className="roppo-laptop-base"/></span>
  <span className="roppo-review"><span/><span/><span/><i/></span>
  <span className="roppo-signal"><i/><i/><i/></span>
 </span>;
}

export function ChatCompanion({status:current,onOpen,L}:{status:CompanionStatus;onOpen:()=>void;L:(en:string,zh:string)=>string}){
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
 return <button type="button" className="chat-companion" onClick={onOpen}
   data-phase={status.phase} title={status.label} aria-label={L('View current activity','查看当前任务进展')}>
   <RoppoCharacter phase={phase} paused={hidden}/>
   <span className="companion-copy"><strong>Roppo</strong><span className="companion-label" role="status" aria-live="polite" aria-atomic="true">{status.label}</span></span>
 </button>;
}
