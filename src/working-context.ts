import {protocolBytes,scopeBudget} from './context-budget.ts'

/** Reserve space for the tool catalog, instructions, results and the answer.
 * The actual serialized request is also checked by the provider transport. */
export function workingInputBudget(scopeBytes:number,fixedBytes=0){
 const {outputReserveBytes,toolReserveBytes}=scopeBudget(scopeBytes)
 const available=scopeBytes-outputReserveBytes-toolReserveBytes
 return Math.max(0,Math.floor(Math.min(available/2,available-fixedBytes)))
}

export function previewText(value:string,characters:number){
 if(value.length<=characters)return value
 if(characters<2)return ''
 const half=Math.floor(characters/2)
 return value.slice(0,half).replace(/[\uD800-\uDBFF]$/u,'')+'\n[…]\n'+value.slice(-half).replace(/^[\uDC00-\uDFFF]/u,'')
}

/** Only used when the original is retained and its reader is available. */
export function projectWorkingInput(input:Record<string,unknown>,resource:string,budget:number,reader:string,current:string){
 const projection:Record<string,unknown>={original:{resource,reader,notice:'Paged original of this activation. Read omitted material before relying on it. For a full review follow nextOffset to the end.'}}
 const trigger=input.trigger
 const triggerId=trigger&&typeof trigger==='object'&&'id' in trigger&&typeof trigger.id==='string'?trigger.id:undefined
 for(const key of ['kind','currentGoalId','replyLocale'])if(typeof input[key]==='string'&&input[key].length<=200)projection[key]=input[key]
 let size=Math.min(current.length,Math.floor(budget/3))
 do{
  const text=previewText(current,size)
  if(triggerId)projection.trigger={id:triggerId,text}
  else projection.currentRequest=text
  if(protocolBytes(projection)<=budget)break
  size=Math.floor(size/2)
 }while(size>0)
 for(const key of ['hostCommand','schedule','selectedSkill','mandate','sourceContext','handoff','quotedMessage','messages','inputs','tasks','goals','chatFiles']){
  if(input[key]!==undefined&&protocolBytes({...projection,[key]:input[key]})<=budget)projection[key]=input[key]
 }
 return projection
}
