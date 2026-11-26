import {checkedCalculation,type CheckedCalculation,type SuppliedRows} from './supplied-calculation.ts'
import {checkPassage,type PassageBasis} from './supplied-passage.ts'

export type AnswerCheck={ok:true;text:string;rows?:string[]}|{ok:false;reason:'format'|'sources'|'values'|'missing';detail:string}
export interface AnswerPacket {
  instructions:string
  input:string
  schema?:Record<string,unknown>
  passage?:PassageBasis
  /** Addresses refer only to sources presented in this activation. */
  references?:{id:number;title:string}[]
  addressesShown?:true
  shortUnit?:string
  fields?:{key:string;spec:string}[]
  calculation?:CheckedCalculation
  evidence:string
}
const missing:AnswerCheck={ok:false,reason:'missing',detail:'Check whether the supplied sources contain the missing fact.'}
const bad=(reason:'format'|'sources'|'values',detail:string):AnswerCheck=>({ok:false,reason,detail})
const yes=(text:string):AnswerCheck=>({ok:true,text})
const escaped=(s:string)=>s.replace(/[.*+?^$()|[\]\\{}]/g,'\\$&')
export const sourceTitle=(heading:string)=>heading.replace(/^@[\w-]+\s*\/\s*/u,'')
function unquote(text:string){return text.trim().replace(/^"(.*)"$/u,'$1')}
function unFence(text:string){return /^\x60{3}(?:json|text)?\s*([\s\S]*?)\s*\x60{3}$/iu.exec(text.trim())?.[1]?.trim()??text.trim()}
function titleKey(s:string){
  const names:Record<string,string>={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '}
  return s.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/giu,(raw:string,entity:string)=>{
    if(entity[0]!=='#')return names[entity.toLowerCase()]??raw
    const n=entity[1]?.toLowerCase()==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1))
    return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):raw
  }).normalize('NFC').replace(/\s+/gu,' ').trim()
}
// Translate the transport format only for these two explicitly requested output keys.
const titleRequest=/\b(?:return|output|give|reply(?: in)?|respond(?: in)?)\s+(?:only\s+)?JSON\s+(?:with|containing)\s+(?:keys?\s+)?["']?answer["']?(?:\s*\([^()\n]*\))?\s*(?:,\s*(?:and\s+)?|\s+and\s+)["']?titles["']?(?:\s*\([^()\n]*\))?\s*[.!。]?\s*$/iu
function requestedFields(q:string){
  const i=q.lastIndexOf('RESULT ');if(i<0||/\bone (?:line|row|record) (?:per|for (?:each|every))\b|\b(?:multiple|several) (?:rows|records)\b|每[人项条个].{0,6}一[行条]/iu.test(q.slice(0,i)))return
  const pattern=/\s*([a-zA-Z][\w-]*)=<([^<>\r\n]{1,100})>/gy,tail=q.slice(i+7),fields:{key:string;spec:string}[]=[]
  let end=0
  for(let m=pattern.exec(tail);m;m=pattern.exec(tail)){fields.push({key:m[1]!,spec:m[2]!});end=pattern.lastIndex}
  if(fields.length&&/^[\s.!。]*$/u.test(tail.slice(end))&&fields.length<=12&&new Set(fields.map(f=>f.key)).size===fields.length)return fields
}
/** Parse only whole, host-rendered sections from an accepted ticket. A line inside a document cannot grant another source ID. */
function returnedSections(text:string,all:SuppliedRows[],blocks:string[]){
  const matched:SuppliedRows[]=[]
  while(text){
    const hits=all.filter((_,i)=>text===blocks[i]||text.startsWith(blocks[i]+'\n'))
    if(hits.length!==1)return
    const section=hits[0]!,block=blocks[all.indexOf(section)]!
    matched.push(section);text=text.slice(block.length).replace(/^\n+/u,'')
  }
  return matched
}
// For an expressly short numeric reply, a unit already fixed by the question can be omitted.
function requestedUnit(q:string){
  if(!/\b(?:only (?:the |a )?short answer|short answer only|number only)\b/iu.test(q)||/\b(?:include|with) (?:the )?units?\b/iu.test(q))return
  if(/\b(?:respectively|each of|include both|list both|separately)\b/iu.test(q))return
  const match=/\bhow many (years?|days?|months?|weeks?|hours?|minutes?|seconds?|points?|yards?|miles?|kilometers?|kilometres?|percent(?:age points?)?)\b/iu.exec(q)
  return match?.[1]?.toLowerCase().replace(/s$/u,'')
}
export function buildAnswerPacket(question:string,all:SuppliedRows[],own:SuppliedRows[],displayed:SuppliedRows[],findings:string[],render:(s:SuppliedRows[])=>string,view?:(s:SuppliedRows)=>string[]):AnswerPacket{
  const original=[...findings,render(displayed)].filter(Boolean).join('\n\n')
  const titles=titleRequest.exec(question),blocks=all.map(s=>render([s]))
  const returned=findings.map(text=>returnedSections(text,all,blocks))
  if(titles){
    const refs=new Map<number,{id:number;title:string}>()
    const citeSource=(s:SuppliedRows)=>{
      const i=all.indexOf(s);if(i<0)return render([s])
      const ref={id:i+1,title:sourceTitle(s.heading)};refs.set(ref.id,ref)
      return render([{heading:s.heading,rows:view?view(s):s.rows}])
    }
    const quoted=[...findings.map((text,i)=>returned[i]?.map(citeSource).join('\n')??text),...displayed.map(citeSource)].filter(Boolean).join('\n\n')
    const wantsShort=/\b(?:short(?:est)?|concise|span)\b|简短|最短/iu.test(question)
    if(refs.size)return {references:[...refs.values()],evidence:original,
      instructions:wantsShort?'Use the sources. Reply as bare JSON. Give the shortest exact answer and original titles supporting every step. If evidence is missing return NEED_CONTEXT.':'Use the sources. Reply as bare JSON, in the requested detail, with the original supporting article titles. If evidence is missing return NEED_CONTEXT.',
      input:quoted+'\n\n'+question}
  }
  const fields=requestedFields(question),allReturned=new Set(returned.flatMap(s=>s??[]))
  const full=all.every(s=>own.includes(s)||allReturned.has(s))?all:undefined
  const calculation=full?checkedCalculation(question,full):undefined
  const evidence=original+(calculation?'\n'+calculation.note:'')
  const short=/\b(?:short answer|exact span|number only)\b|只给(?:出)?答案/iu.test(question)
  const unit=requestedUnit(question)
  const instructions=unit?'Give one number answering the question, without units or intermediate figures. Use ? if the evidence is insufficient.':fields?'Return one requested record. Copy identifiers exactly. Use checked arithmetic when provided. No explanation.':short?'Answer the question at the end using the evidence. Return only the value or span, with no explanation. Omit units already specified in the question. Use ? for missing evidence.':'Use the supplied records. Give the requested answer concisely. If the answer is absent say NEED_CONTEXT.'
  return {input:short&&!fields?evidence+'\n\n'+question:question+'\n\n'+evidence,instructions,evidence,fields,calculation,shortUnit:unit}
}
function resolveId(ref:string|number,references:NonNullable<AnswerPacket['references']>,numeric:boolean){
  const value=String(ref).trim()
  const exact=references.filter(r=>r.title===value)
  if(numeric&&/^(?:\d+|\[\d+\])$/u.test(value)){
    const n=Number(value.replace(/[\[\]]/gu,'')),byId=references.find(r=>r.id===n)
    if(exact.length)return exact.length===1&&(!byId||byId===exact[0])?exact[0]:undefined
    return byId
  }
  if(exact.length===1)return exact[0]
  const matches=references.filter(r=>titleKey(r.title)===titleKey(value));return matches.length===1?matches[0]:undefined
}
function checkedCitations(text:string,packet:AnswerPacket):AnswerCheck{
  let answer:unknown,refs:unknown
  if(text.startsWith('{')){
    try{const record=JSON.parse(text);answer=record.answer;refs=record.titles}catch{return bad('format','Return one answer and source IDs, separated by |.')}
  }else{
    const pos=text.lastIndexOf('|')
    if(pos<0)return bad('format','Return the short answer followed by | and its supporting source IDs.')
    answer=text.slice(0,pos).trim()
    refs=text.slice(pos+1).trim().replace(/^\[([\d,\s]+)\]$/u,'$1').split(/\s*,\s*/u)
  }
  if(typeof answer==='number'&&Number.isFinite(answer))answer=String(answer)
  if(typeof answer!=='string'||!answer.trim()||answer.trim()==='?')return missing
  if(!Array.isArray(refs)||!refs.length||refs.length>48)return bad('sources','Choose a visible supporting source.')
  const titles:string[]=[]
  for(const r of refs){
    if(typeof r!=='string'&&typeof r!=='number')return bad('sources','Use visible source IDs.')
    const resolved=resolveId(r,packet.references!,!!packet.addressesShown)
    if(!resolved)return bad('sources','A cited source is missing or ambiguous. Use only the bracketed IDs you can see.')
    if(!titles.includes(resolved.title))titles.push(resolved.title)
  }
  return yes(JSON.stringify({answer:unquote(answer),titles}))
}
function fieldValues(text:string,fields:NonNullable<AnswerPacket['fields']>){
  const lines=text.split(/\r?\n/u).map(line=>line.trim().replace(/^\*\*(.*?)\*\*$/u,'$1')).filter(line=>/^RESULT\s/iu.test(line))
  if(lines.length>1)return
  if(lines.length===1){
    const pattern='^RESULT\\s+'+fields.map(f=>escaped(f.key)+'=(.+?)').join('\\s+')+'[。.]?$'
    const m=new RegExp(pattern,'iu').exec(lines[0]!);if(!m)return
    const values=m.slice(1).map(s=>s.trim())
    if(values.some(s=>/\s[\w-]+=/u.test(s)||s.includes('|')))return
    return values
  }
  const values=text.split(/\s*\|\s*/u).map(unquote)
  if(values.length===fields.length&&values.every(s=>!!s&&!s.includes('\n')&&!s.includes('=')))return values
}
const numericField=(f:{key:string;spec:string})=>/\b(?:number|integer|count|duration|amount|minutes|numeric)\b|数值|整数|分数|数字|数量/iu.test(f.spec)||/^(?:total|sum|count)$/iu.test(f.key)
export function checkAnswer(question:string,raw:string,packet:AnswerPacket):AnswerCheck{
  const text=unFence(raw);if(!text||text==='?'||/\bNEED_CONTEXT\b/u.test(text))return missing
  if(packet.passage)return checkPassage(question,text,packet.passage)
  if(packet.references)return checkedCitations(text,packet)
  if(packet.calculation?.complement!==undefined){
    const number=/^(\d+(?:\.\d+)?)\s*(?:%|percent)?[.]?$/iu.exec(text)
    if(!number||Number(number[1])!==packet.calculation.complement)return bad('values',packet.calculation.note)
    return yes(packet.shortUnit?number[1]!:text)
  }
  const fields=packet.fields
  if(!fields){
    if(packet.shortUnit){
      const units=packet.shortUnit==='percent'?'(?:percent|%)':escaped(packet.shortUnit)+'s?'
      const m=new RegExp('^(-?\\d+(?:\\.\\d+)?)\\s*'+units+'[.]?$','iu').exec(text)
      if(m)return yes(m[1]!)
      if(/[;；=]|\n\s*\d/u.test(text))return bad('format','Give the requested quantity only. Preserve ranges or qualifying units when needed.')
    }
    if(/\bJSON\b/iu.test(question)){try{JSON.parse(text)}catch{return bad('format','Return the requested JSON object without additional text.')}}
    return yes(text)
  }
  const values=fieldValues(text,fields)
  if(!values)return bad('format','Return exactly one record with these fields in order: '+fields.map(f=>f.key).join(', ')+'. Do not list alternatives.')
  const corpus=packet.evidence+'\n'+question
  for(const [i,value] of values.entries()){
    if(!value||value.length>240)return bad('format','Return a compact value for '+fields[i]!.key+'.')
    const literal=/\b(?:id|identifier|name|person|code|owner|site|location|receipt|label|commit)\b|编号|姓名|名字|拼音|名称|代码/iu.test(fields[i]!.spec+' '+fields[i]!.key)
    if(literal&&/[\p{L}]/u.test(value)&&!new RegExp('(?<![a-z\\d_-])'+escaped(value)+'(?![a-z\\d_-])','iu').test(corpus))return bad('values','Recheck '+fields[i]!.key+' against the source records.')
  }
  const calc=packet.calculation,nums=fields.map(numericField)
  if(calc?.count!==undefined&&fields.length===1&&nums[0]&&Number(values[0])!==calc.count)return bad('values',calc.note)
  if(calc?.winner&&fields.length===2&&nums.filter(Boolean).length===1){
    const n=nums.indexOf(true),key=values[1-n]!
    const totalField=/^(?:total|sum)$/iu.test(fields[n]!.key)||/\b(?:sum|total)\b|总数|总和|总分/iu.test(fields[n]!.spec)
    if(key!==calc.winner.key||totalField&&Number(values[n])!==calc.winner.total)return bad('values',calc.note+'. Return only the qualifying record.')
  }
  return yes('RESULT '+fields.map((f,i)=>f.key+'='+values[i]).join(' '))
}
export function repairPacket(packet:AnswerPacket,issue:Extract<AnswerCheck,{ok:false}>,previous:string){
  const index=packet.references?.map(r=>'['+r.id+'] '+r.title).join('\n')
  return {...packet,...(index?{addressesShown:true as const}:{}),instructions:packet.instructions+' '+issue.detail,input:packet.input+(index?'\nSource IDs for correction:\n'+index:'')+'\nPrevious proposal to check: '+previous.trim().slice(0,400)}
}
