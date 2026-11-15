import {useEffect,useRef,useState} from 'react'
import {AlertCircle,Check,Copy} from 'lucide-react'

export function CopyButton({value,L,label}:{value:string;L:(en:string,zh:string)=>string;label?:string}){
  const [state,setState]=useState<'idle'|'copied'|'failed'>('idle'),timer=useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(()=>()=>clearTimeout(timer.current),[])
  const caption=state==='copied'?L('Copied','已复制'):state==='failed'?L('Copy failed','复制失败'):label??L('Copy reply','复制回复')
  async function copy(){
    clearTimeout(timer.current)
    try{await navigator.clipboard.writeText(value);setState('copied')}catch{setState('failed')}
    timer.current=setTimeout(()=>setState('idle'),2500)
  }
  return <button type="button" className="icon-button copy-button" data-state={state} aria-label={caption} title={caption} disabled={!value} onClick={()=>void copy()}>
    {state==='copied'?<Check size={15}/>:state==='failed'?<AlertCircle size={15}/>:<Copy size={15}/>}
    <span role="status">{state==='idle'?'':caption}</span>
  </button>
}
