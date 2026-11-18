import {createHash} from 'node:crypto'
import type {ToolContent} from './model.ts'

/** Bytes are UTF-8 serialized host protocol, not a tokenizer estimate. */
export interface ContextBudget {maxBytes:number;outputReserveBytes:number;toolReserveBytes:number}
export interface BudgetReceipt {basis:'api-wire'|'native-protocol';phase:string;bytes:number;maxBytes:number;reservedBytes:number;status:'within_budget'|'exceeded'}
export class ContextBudgetExceeded extends Error {
 readonly code='context_budget_exceeded'
 constructor(readonly receipt:BudgetReceipt){super('Context budget exceeded at '+receipt.phase+'; retain pending inputs and completed effects, then explicitly rebuild context')}
}
export const protocolBytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value)??'null')
export function scopeBudget(maxBytes:number):ContextBudget {return {maxBytes,outputReserveBytes:Math.min(64*1024,Math.floor(maxBytes/8)),toolReserveBytes:Math.min(1024*1024,Math.floor(maxBytes/8))}}
export function checkBudget(value:unknown,budget:ContextBudget|undefined,basis:BudgetReceipt['basis'],phase:string,onReceipt?:(r:BudgetReceipt)=>void,reserveTool=false){
 if(!budget)return
 const bytes=protocolBytes(value),reservedBytes=budget.outputReserveBytes+(reserveTool?budget.toolReserveBytes:0)
 const receipt:BudgetReceipt={basis,phase,bytes,maxBytes:budget.maxBytes,reservedBytes,status:bytes+reservedBytes<=budget.maxBytes?'within_budget':'exceeded'}
 onReceipt?.(receipt)
 if(receipt.status==='exceeded')throw new ContextBudgetExceeded(receipt)
}
/** A complete tool receipt reference, never a substring of JSON or a half tool pair. */
export function receiptReference(value:unknown,id:string,reader='superagent_read'){const success=(value as any)?.success===true;return {success,contentItems:[{type:'inputText' as const,text:JSON.stringify({status:'retained',resultSuccess:success,receiptId:id,resource:'model-tool-receipt/'+id,bytes:protocolBytes(value),sha256:createHash('sha256').update(JSON.stringify(value)).digest('hex'),notice:'Full tool result retained by host. Do not repeat its effects. Read this resource with '+reader+' and follow nextOffset until it is null; only the owning context or operator can read it.'})}]}}

function endsInsideSurrogatePair(text:string,end:number){
 return end>0 && end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)
}

/** Offsets count UTF-16 units, as in String.slice. Even a one-unit request can read a whole character. */
export function textPage(text:string,offset:number,limit:number){
 let end=Math.min(text.length,offset+limit)
 if(endsInsideSurrogatePair(text,end))end+=end===offset+1?1:-1
 return {text:text.slice(offset,end),characters:text.length,offset,nextOffset:end<text.length?end:null}
}

type ReadResult = {success:boolean; contentItems:ToolContent[]}

/** A receipt page that would itself become a receipt must advance the original cursor. */
export function fitResourcePage(result:ReadResult, byteLimit:number):ReadResult {
 if(!result.success || result.contentItems.length!==1 || result.contentItems[0]?.type!=='inputText' || protocolBytes(result)<=byteLimit)return result
 let page
 try{page=JSON.parse(result.contentItems[0].text??'')}catch{return result}
 if(typeof page?.text!=='string'||!Number.isSafeInteger(page.offset)||!Number.isSafeInteger(page.characters))return result
 const content:string=page.text
 const whole=(end:number)=>endsInsideSurrogatePair(content,end)?end-1:end
 const portion=(count:number):ReadResult=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify({...page,text:content.slice(0,count),nextOffset:page.offset+count})}]})
 let low=0,high=content.length
 while(low<high){
  const mid=Math.ceil((low+high)/2)
  if(protocolBytes(portion(whole(mid)))<=byteLimit)low=mid
  else high=mid-1
 }
 low=whole(low)
 if(!low)return {success:false,contentItems:[{type:'inputText',text:'This scope has too little inline tool space for a resource page.'}]}
 return portion(low)
}
