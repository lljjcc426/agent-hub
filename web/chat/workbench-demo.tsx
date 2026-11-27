import {useEffect,useRef,useState} from 'react'
import {Play,RotateCcw,StepForward} from 'lucide-react'
import type {Localize} from './composer-commands.tsx'

export function WorkbenchDemo({conversation,refresh,L}:{conversation:string;refresh:()=>Promise<void>;L:Localize}){
  const [stage,setStage]=useState<number>(),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false)
  const lock=useRef(false)
  const url='/api/chat/conversations/'+encodeURIComponent(conversation)+'/workbench/demo'
  useEffect(()=>{
    const ctrl=new AbortController()
    setStage(undefined);setFailed(false)
    fetch(url,{signal:ctrl.signal}).then(async res=>{if(res.ok){const data=await res.json();if(!ctrl.signal.aborted)setStage(data.stage)}}).catch(()=>{})
    return ()=>ctrl.abort()
  },[url])
  async function play(action:'next'|'think'|'restart'){
    if(lock.current)return
    lock.current=true;setBusy(true);setFailed(false)
    try{
      const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,stage})})
      if(!res.ok)throw Error()
      const data=await res.json()
      if(data.chatId!==conversation){location.hash='conversation/'+data.chatId;return}
      setStage(data.stage);await refresh()
    }catch{setFailed(true)}finally{lock.current=false;setBusy(false)}
  }
  if(stage===undefined)return null
  const end=stage>=3
  return <div className="bench-demo" aria-label={L('Preview controls','预览演示控制')}>
    <span>{failed?L('Please retry','请重试'):L('Demo','演示')}</span>
    <button disabled={busy} onClick={()=>void play('think')}><Play size={12}/>{L('Replay thinking','重播思考')}</button>
    <button disabled={busy} onClick={()=>void play(end?'restart':'next')}>{end?<RotateCcw size={12}/>:<StepForward size={12}/>}
      {stage===1?L('Append developer changes','追加开发改动'):stage===2?L('Switch to test worker','交给测试 Worker'):L('Restart demo','重播示例')}</button>
  </div>
}
