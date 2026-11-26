import {useSyncExternalStore} from 'react'
import {read,write} from './message-send.ts'

const key='roppo.chat.worker-file-diffs'
const change='roppo:worker-file-diffs'
const current=()=>read(key,'on')!=='off'

function subscribe(notify:()=>void) {
  const external=(event:StorageEvent)=>{ if(event.key===key || event.key===null) notify() }
  window.addEventListener(change,notify)
  window.addEventListener('storage',external)
  return ()=>{window.removeEventListener(change,notify);window.removeEventListener('storage',external)}
}
export const useWorkerDiffPreference=()=>useSyncExternalStore(subscribe,current,current)
export function setWorkerDiffPreference(enabled:boolean) {
  write(key,enabled?'on':'off')
  window.dispatchEvent(new Event(change))
}
