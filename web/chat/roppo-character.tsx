import {useCallback,useContext,useEffect,useLayoutEffect,useRef,useState} from 'react';
import body from '../../src/ui/assets/agents/roppo-body.webp';
import type {CompanionPhase} from './companion-state.ts';
import {RoppoAppearanceContext,roppoSkin,workerColorIndex} from './agent-avatar.tsx';
import './companion.css';

const spiralEye=Array.from({length:65},(_,i)=>{
 const angle=i/64*Math.PI*3.5,radius=.4+i/64*9;
 return `${i?'L':'M'}${(12+radius*Math.cos(angle)).toFixed(2)} ${(12+radius*Math.sin(angle)).toFixed(2)}`;
}).join(' ');

export function RoppoCharacter({phase,paused=false,workerId,greeting}:{phase:CompanionPhase;paused?:boolean;workerId?:string;greeting?:number}){
 const appearance=useContext(RoppoAppearanceContext);
 const [visualPhase,setVisualPhase]=useState(phase);
 const characterRef=useRef<HTMLSpanElement>(null);
 const poseRef=useRef<HTMLSpanElement>(null);
 const waveHand=useRef<HTMLSpanElement>(null);
 const gesture=useRef<Animation[]>([]);
 const bodyRef=useRef<HTMLSpanElement>(null);
 const previousPose=useRef<string|null>(null);
 const bridge=useRef<Animation|null>(null);
 const stopGreeting=useCallback(()=>{
  for(const animation of gesture.current)animation.cancel();
  gesture.current=[];
  if(characterRef.current)delete characterRef.current.dataset.greeting;
 },[]);
 useLayoutEffect(()=>{
  const character=characterRef.current,pose=poseRef.current,hand=waveHand.current;
  if(!greeting||!character||!pose||!hand||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const liftFrom=getComputedStyle(pose).transform;
  const handStyle=getComputedStyle(hand);
  const handFrom={transform:handStyle.transform,opacity:Number(handStyle.opacity)};
  stopGreeting();
  character.dataset.greeting='true';
  const duration=1180;
  const lift=pose.animate([
   {transform:liftFrom,offset:0},
   {transform:'translateY(-3px)',offset:.19},
   {transform:'translateY(-3px)',offset:.76},
   {transform:'none',offset:1},
  ],{duration,easing:'ease-in-out'});
  const wave=hand.animate([
   {...handFrom,offset:0,easing:'ease-out'},
   {transform:'rotate(-37deg)',opacity:1,offset:.18,easing:'ease-in-out'},
   {transform:'rotate(-59deg)',opacity:1,offset:.37,easing:'ease-in-out'},
   {transform:'rotate(-28deg)',opacity:1,offset:.57,easing:'ease-in-out'},
   {transform:'rotate(-54deg)',opacity:1,offset:.76,easing:'ease-in-out'},
   {transform:'rotate(32deg)',opacity:0,offset:1},
  ],{duration});
  gesture.current=[lift,wave];
  wave.onfinish=()=>{
   if(!gesture.current.includes(wave))return;
   gesture.current=[];
   delete character.dataset.greeting;
  };
 },[greeting,stopGreeting]);
 // Read the displayed pose before changing the CSS animation, including any
 // unfinished transition. Rapid status changes then continue from this pose.
 useLayoutEffect(()=>{
  if(phase===visualPhase)return;
  previousPose.current=bodyRef.current&&!paused&&!matchMedia('(prefers-reduced-motion: reduce)').matches
   ?getComputedStyle(bodyRef.current).transform:null;
  bridge.current?.cancel();bridge.current=null;
  setVisualPhase(phase);
 },[phase,visualPhase,paused]);
 useLayoutEffect(()=>{
  const element=bodyRef.current,from=previousPose.current;
  previousPose.current=null;
  if(!element||!from)return;
  const next=new DOMMatrix(getComputedStyle(element).transform);
  const offset=next.inverse().multiply(new DOMMatrix(from));
  // Add a decaying offset to the new CSS motion instead of replacing it.
  const animation=element.animate([{transform:offset.toString()},{transform:'matrix(1,0,0,1,0,0)'}],{
   duration:260,easing:'cubic-bezier(.2,.7,.3,1)',composite:'add',
  });
  bridge.current=animation;
  animation.onfinish=()=>{if(bridge.current===animation)bridge.current=null};
 },[visualPhase]);
 useLayoutEffect(()=>{
  if(paused)bridge.current?.pause();
  else if(bridge.current?.playState==='paused')bridge.current.play();
 },[paused]);
 useEffect(()=>{
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const stop=()=>{if(reduced.matches){bridge.current?.cancel();bridge.current=null;stopGreeting()}};
  reduced.addEventListener('change',stop);
  return ()=>{reduced.removeEventListener('change',stop);bridge.current?.cancel();stopGreeting()};
 },[stopGreeting]);
 return <span ref={characterRef} className="roppo-character" data-phase={visualPhase} data-skin={workerId ? workerColorIndex(workerId) : roppoSkin[appearance]} data-paused={paused||undefined} aria-hidden="true">
  <span className="roppo-pose" ref={poseRef}><span className="roppo-body" ref={bodyRef}>
   <img src={body} width="512" height="512" alt="" draggable={false}/>
   <span className="roppo-eyes">
    <span className="roppo-eye-layer roppo-eyes-open"><i/><i/></span>
    <span className="roppo-eye-layer roppo-eyes-happy">{[0,1].map(eye=><svg key={eye} viewBox="0 0 24 24"><path d="M3 14 Q12 2 21 14"/></svg>)}</span>
    <span className="roppo-eye-layer roppo-eyes-spiral">{[0,1].map(eye=><svg key={eye} className="roppo-spiral" viewBox="0 0 24 24"><path d={spiralEye}/></svg>)}</span>
   </span>
   <span className="roppo-arm roppo-arm-left"/><span className="roppo-arm roppo-arm-right"/>
  </span>
   {greeting!==undefined&&<span className="roppo-greeting-hand" ref={waveHand}/>}
  </span>
  <span className="roppo-laptop"><span className="roppo-laptop-screen"><i/></span><span className="roppo-laptop-base"/></span>
  <span className="roppo-review"><span/><span/><span/><i/></span>
  <span className="roppo-signal"><i/><i/><i/></span>
 </span>;
}
