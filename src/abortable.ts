/** Stop awaiting on abort while observing the operation's eventual settlement. */
export function abortable<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T>{
  if(!signal)return promise
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason)
    const dispose=()=>signal.removeEventListener('abort',abort)
    promise.then(value=>{dispose();resolve(value)},error=>{dispose();reject(error)})
    if(signal.aborted)abort()
    else signal.addEventListener('abort',abort,{once:true})
  })
}
