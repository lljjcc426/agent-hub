import {useEffect,useLayoutEffect,useRef,useState,type RefObject} from 'react'
import {ArrowDownUp,MousePointerClick,Globe,Keyboard,MousePointer2} from 'lucide-react'
import type {BrowserActivity} from '../../src/browser-contract.ts'
import {getMotionPreference} from '../ui/motion.ts'
import {browserImageArea,browserPointerDuration} from './browser-geometry.ts'

type Point={x:number;y:number}
type ImageBounds=Point&{width:number;height:number}
const pointTransform=(point:Point)=>'translate3d('+point.x+'px,'+point.y+'px,0)'
const pointerPosition=(element:HTMLElement)=>{
  const matrix=new DOMMatrixReadOnly(getComputedStyle(element).transform)
  return {x:matrix.m41,y:matrix.m42}
}
const movePointer=(element:HTMLElement,start:Point,target:Point,duration:number)=>element.animate([
  {transform:pointTransform(start)},
  {transform:pointTransform(target)},
],{duration,easing:'cubic-bezier(.36,.04,.28,1)'})
const actions={
  click:['Click','点击'],fill:['Type','输入'],press:['Press key','按键'],scroll:['Scroll','滚动'],
  navigate:['Open page','打开网页'],back:['Go back','后退'],forward:['Go forward','前进'],reload:['Reload','刷新'],
} as const

export function useBrowserImageBounds(
  image:RefObject<HTMLImageElement|null>,
  viewport:RefObject<HTMLDivElement|null>,
  connected:boolean,
) {
  const [bounds,setBounds]=useState<ImageBounds|null>(null)
  useLayoutEffect(()=>{
    const img=image.current,host=viewport.current
    if(!connected||!img||!host){setBounds(null);return}
    let aspect=0
    const measure=()=>{
      aspect=img.naturalWidth/img.naturalHeight
      const area=browserImageArea(img.getBoundingClientRect(),{width:img.naturalWidth,height:img.naturalHeight})
      if(!area){setBounds(null);return}
      const rect=host.getBoundingClientRect()
      const next={x:area.x-rect.x,y:area.y-rect.y,width:area.width,height:area.height}
      setBounds(old=>old&&old.x===next.x&&old.y===next.y&&old.width===next.width&&old.height===next.height?old:next)
    }
    const onLoad=()=>{if(img.naturalWidth/img.naturalHeight!==aspect)measure()}
    const observer=new ResizeObserver(measure)
    observer.observe(host)
    observer.observe(img)
    img.addEventListener('load',onLoad)
    measure()
    return ()=>{observer.disconnect();img.removeEventListener('load',onLoad)}
  },[connected,image,viewport])
  return bounds
}

export function BrowserAgentGlow({bounds,active}:{bounds:ImageBounds|null;active:boolean}) {
  const [visible,setVisible]=useState(()=>!document.hidden)
  useEffect(()=>{
    if(!active)return
    const update=()=>setVisible(!document.hidden)
    update()
    document.addEventListener('visibilitychange',update)
    return ()=>document.removeEventListener('visibilitychange',update)
  },[active])
  if(!bounds)return null
  return <div className="browser-agent-glow" aria-hidden="true" data-active={active||undefined}
    data-moving={active&&visible||undefined}
    style={{left:bounds.x,top:bounds.y,width:bounds.width,height:bounds.height}}>
    <span className="browser-agent-glow-edge"/>
  </div>
}

export function BrowserFeedback({activity,controlled,bounds,L}:{
  activity?:BrowserActivity
  controlled:boolean
  bounds:ImageBounds|null
  L:(en:string,zh:string)=>string
}){
  const root=useRef<HTMLDivElement>(null),pointer=useRef<HTMLSpanElement>(null)
  const motion=useRef<Animation|null>(null)
  const last=useRef<(Point&{tab:string;seq:number})|null>(null)
  const x=activity?.point&&bounds?bounds.x+bounds.width*activity.point.x:undefined
  const y=activity?.point&&bounds?bounds.y+bounds.height*activity.point.y:undefined
  const position=x===undefined||y===undefined?undefined:{x,y}
  useLayoutEffect(()=>{
    const preference=getMotionPreference()
    const settle=()=>{
      if(!preference.matches)return
      motion.current?.cancel()
      root.current?.style.setProperty('--browser-click-delay','0ms')
    }
    preference.addEventListener('change',settle)
    return ()=>{preference.removeEventListener('change',settle);motion.current?.cancel()}
  },[])
  useLayoutEffect(()=>{
    const element=pointer.current
    if(!activity||x===undefined||y===undefined||controlled||!element){
      motion.current?.cancel()
      motion.current=null
      root.current?.style.setProperty('--browser-click-delay','0ms')
      return
    }
    const previous=last.current,sameTab=previous?.tab===activity.tab
    const current=motion.current, moving=current?.playState==='running'
    if(sameTab&&previous.seq===activity.seq){
      if(Math.hypot(previous.x-x,previous.y-y)>=1){
        last.current={...previous,x,y}
        if(moving){
          const remaining=Number(current.effect?.getComputedTiming().endTime??0)-Number(current.currentTime??0)
          const start=pointerPosition(element)
          current.cancel()
          // A detail frame can change the image bounds while the pointer is travelling.
          motion.current=remaining>0?movePointer(element,start,{x,y},remaining):null
        }
      }
      return
    }
    const start=sameTab
      ?moving?pointerPosition(element):previous
      :{x:Math.max(0,x-28),y:Math.max(0,y-16)}
    current?.cancel()
    last.current={x,y,tab:activity.tab,seq:activity.seq}
    const reduce=getMotionPreference().matches
    const duration=reduce?0:browserPointerDuration(start,{x,y})
    root.current?.style.setProperty('--browser-click-delay',duration+'ms')
    motion.current=duration?movePointer(element,start,{x,y},duration):null
  },[activity,x,y,controlled])
  if(!activity)return null
  const {action,seq}=activity
  const [en,zh]=actions[action]
  const Icon=action==='click'?MousePointerClick:action==='fill'||action==='press'?Keyboard:action==='scroll'?ArrowDownUp:Globe
  const caption=<span className="browser-action-label"><Icon size={14}/>{L(en,zh)}</span>
  const transform=position?pointTransform(position):undefined
  const left=position&&bounds&&position.x>bounds.x+bounds.width-148
  const above=position&&bounds&&position.y>bounds.y+bounds.height-52
  return <div ref={root} className="browser-feedback" aria-hidden="true" data-action={action}>
    {position ? <>
      {action==='click'&&<span key={seq} className="browser-click-anchor" style={{transform}}><span className="browser-click-ring"/></span>}
      <span ref={pointer} className="browser-pointer" style={{transform}} data-left={left||undefined} data-above={above||undefined}>
        {!controlled&&<MousePointer2 className="browser-pointer-icon" size={22}/>}
        {caption}
      </span>
    </> : <span className="browser-action-toast">{caption}</span>}
  </div>
}
