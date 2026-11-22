import {useLayoutEffect,useRef,useState,type RefObject} from 'react'
import {ArrowDownUp,MousePointerClick,Globe,Keyboard,MousePointer2} from 'lucide-react'
import type {BrowserActivity} from '../../src/browser-contract.ts'
import {browserImageArea} from './browser-geometry.ts'

const actions={
  click:['Click','点击'],fill:['Type','输入'],press:['Press key','按键'],scroll:['Scroll','滚动'],
  navigate:['Open page','打开网页'],back:['Go back','后退'],forward:['Go forward','前进'],reload:['Reload','刷新'],
} as const

export function BrowserFeedback({activity,controlled,image,viewport,L}:{
  activity?:BrowserActivity
  controlled:boolean
  image:RefObject<HTMLImageElement|null>
  viewport:RefObject<HTMLDivElement|null>
  L:(en:string,zh:string)=>string
}){
  const [place,setPlace]=useState<{x:number;y:number;left:boolean;above:boolean;seq:number}|null>(null)
  const pointer=useRef<HTMLSpanElement>(null)
  const last=useRef<{x:number;y:number;tab:string;seq:number}|undefined>(undefined)
  useLayoutEffect(()=>{
    const img=image.current,host=viewport.current,point=activity?.point
    if(!img||!host||!point||!activity){setPlace(null);return}
    const seq=activity.seq
    const sync=()=>{
      const area=browserImageArea(img.getBoundingClientRect(),{width:img.naturalWidth,height:img.naturalHeight})
      if(!area){setPlace(null);return}
      const bounds=host.getBoundingClientRect()
      const x=area.x-bounds.x+area.width*point.x,y=area.y-bounds.y+area.height*point.y
      const left=x>bounds.width-148,above=y>bounds.height-52
      setPlace(current=>current?.x===x&&current.y===y&&current.left===left&&current.above===above&&current.seq===seq
        ?current:{x,y,left,above,seq})
    }
    sync()
    const observer=new ResizeObserver(sync)
    observer.observe(host)
    img.addEventListener('load',sync)
    return ()=>{observer.disconnect();img.removeEventListener('load',sync)}
  },[activity,image,viewport])
  useLayoutEffect(()=>{
    if(!activity||!place||place.seq!==activity.seq||controlled||!pointer.current)return
    const previous=last.current
    if(previous?.tab===activity.tab&&previous.seq===activity.seq)return
    last.current={x:place.x,y:place.y,tab:activity.tab,seq:activity.seq}
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)return
    const start=previous?.tab===activity.tab?previous:{x:place.x-12,y:place.y-8}
    const animation=pointer.current.animate([
      {transform:`translate3d(${start.x}px,${start.y}px,0)`},
      {transform:`translate3d(${place.x}px,${place.y}px,0)`},
    ],{duration:155,easing:'cubic-bezier(.2,.9,.3,1)'})
    return ()=>animation.cancel()
  },[activity,place,controlled])
  if(!activity)return null
  const {action,seq}=activity
  const [en,zh]=actions[action]
  const label=L(en,zh)
  const Icon=action==='click'?MousePointerClick:action==='fill'||action==='press'?Keyboard:action==='scroll'?ArrowDownUp:Globe
  const transform=place?`translate3d(${place.x}px,${place.y}px,0)`:undefined
  const caption=<span className="browser-action-label"><Icon size={14}/>{label}</span>
  return <div className="browser-feedback" aria-hidden="true" data-action={action}>
    {place ? <>
      {action==='click'&&<span key={seq} className="browser-click-anchor" style={{transform}}><span className="browser-click-ring"/></span>}
      <span ref={pointer} className="browser-pointer" style={{transform}} data-left={place.left||undefined} data-above={place.above||undefined}>
        {!controlled&&<MousePointer2 className="browser-pointer-icon" size={22}/>}
        {caption}
      </span>
    </> : <span className="browser-action-toast">{caption}</span>}
  </div>
}
