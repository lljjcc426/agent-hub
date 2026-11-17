import {useEffect,useRef,useState} from 'react'
import {AlertCircle,Check,Copy} from 'lucide-react'

export function CopyButton({value,L,label,menu=false}:{value:string|(()=>string);L:(en:string,zh:string)=>string;label?:string;menu?:boolean}){
  const [state,setState]=useState<'idle'|'copied'|'failed'>('idle'),timer=useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(()=>()=>clearTimeout(timer.current),[])
  const caption=state==='copied'?L('Copied','已复制'):state==='failed'?L('Copy failed','复制失败'):label??L('Copy reply','复制回复')
  async function copy(){
    clearTimeout(timer.current)
    try{await navigator.clipboard.writeText(typeof value==='function'?value():value);setState('copied')}catch{setState('failed')}
    timer.current=setTimeout(()=>setState('idle'),2500)
  }
  return <button type="button" className={'icon-button copy-button'+(menu?' menu-copy':'')} data-state={state} aria-label={caption} title={caption} disabled={!value} onClick={()=>void copy()}>
    <span className="copy-glyph"><Copy className="copy-idle" size={15}/><Check className="copy-done" size={15}/><AlertCircle className="copy-failed" size={15}/></span>
    {menu?<span>{state==='idle'?label:caption}</span>:null}
    <span role="status" className="copy-feedback">{state==='idle'?'':caption}</span>
  </button>
}
