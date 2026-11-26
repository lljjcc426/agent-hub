import {checkedCalculation,type CheckedCalculation,type SuppliedRows} from './supplied-calculation.ts'

export type AnswerCheck={ok:true;text:string}|{ok:false;reason:'format'|'sources'|'values'|'missing';detail:string}
export interface AnswerPacket {
  instructions:string
  input:string
  /** Addresses refer only to sources presented in this activation. */
  references?:{id:number;title:string}[]
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
export function buildAnswerPacket(question:string,all:SuppliedRows[],own:SuppliedRows[],displayed:SuppliedRows[],findings:string[],render:(s:SuppliedRows[])=>string):AnswerPacket{
  const original=[...findings,render(displayed)].filter(Boolean).join('\n\n')
  const titles=titleRequest.exec(question),blocks=all.map(s=>render([s]))
  const returned=findings.map(text=>returnedSections(text,all,blocks))
  if(titles){
    const refs=new Map<number,{id:number;title:string}>()
    const numberSource=(s:SuppliedRows)=>{
      const i=all.indexOf(s);if(i<0)return render([s])
      const ref={id:i+1,title:sourceTitle(s.heading)};refs.set(ref.id,ref)
      return '['+ref.id+'] '+ref.title+'\n'+s.rows.join('\n')
    }
    const numbered=[...findings.map((text,i)=>returned[i]?.map(numberSource).join('\n')??text),...displayed.map(numberSource)].filter(Boolean).join('\n\n')
    const wantsShort=/\b(?:short(?:est)?|concise|span)\b|简短|最短/iu.test(question)
    if(refs.size)return {references:[...refs.values()],evidence:original,
      instructions:wantsShort?'Shortest exact answer | all supporting source IDs. Omit extra qualifiers unless needed. Use ? if missing.':'Give the requested answer | all supporting source IDs. Use ? if missing.',
      input:numbered+'\n\n'+question.slice(0,titles.index).trim()}
  }
  const fields=requestedFields(question),allReturned=new Set(returned.flatMap(s=>s??[]))
  const full=all.every(s=>own.includes(s)||allReturned.has(s))?all:undefined
  const calculation=full?checkedCalculation(question,full):undefined
  const evidence=original+(calculation?'\n'+calculation.note:'')
  const instructions=fields?'Return one requested record. Copy identifiers exactly. Use checked arithmetic when provided. No explanation.':'Use the supplied records. Give the requested answer concisely. If the answer is absent say NEED_CONTEXT.'
  return {input:question+'\n\n'+evidence,instructions,evidence,fields,calculation}
}
function resolveId(ref:string|number,references:NonNullable<AnswerPacket['references']>,numeric:boolean){
  const value=String(ref).trim()
  if(numeric&&/^(?:\d+|\[\d+\])$/u.test(value)){
    const n=Number(value.replace(/[\[\]]/gu,''));return references.find(r=>r.id===n)
  }
  const exact=references.filter(r=>r.title===value)
  if(exact.length===1)return exact[0]
  const matches=references.filter(r=>titleKey(r.title)===titleKey(value));return matches.length===1?matches[0]:undefined
}
function checkedCitations(text:string,packet:AnswerPacket):AnswerCheck{
  let answer:unknown,refs:unknown,numeric=false
  if(text.startsWith('{')){
    try{const record=JSON.parse(text);answer=record.answer;refs=record.titles}catch{return bad('format','Return one answer and source IDs, separated by |.')}
  }else{
    const pos=text.lastIndexOf('|')
    if(pos<0)return bad('format','Return the short answer followed by | and its supporting source IDs.')
    answer=text.slice(0,pos).trim()
    refs=text.slice(pos+1).trim().replace(/^\[([\d,\s]+)\]$/u,'$1').split(/\s*,\s*/u)
    numeric=true
  }
  if(typeof answer==='number'&&Number.isFinite(answer))answer=String(answer)
  if(typeof answer!=='string'||!answer.trim()||answer.trim()==='?')return missing
  if(!Array.isArray(refs)||!refs.length||refs.length>48)return bad('sources','Choose a visible supporting source.')
  const titles:string[]=[]
  for(const r of refs){
    if(typeof r!=='string'&&typeof r!=='number')return bad('sources','Use visible source IDs.')
    const resolved=resolveId(r,packet.references!,numeric||typeof r==='number')
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
  if(packet.references)return checkedCitations(text,packet)
  const fields=packet.fields
  if(!fields){
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
    if(key!==calc.winner.key||Number(values[n])!==calc.winner.total)return bad('values',calc.note+'. Return only the qualifying record.')
  }
  return yes('RESULT '+fields.map((f,i)=>f.key+'='+values[i]).join(' '))
}
export function repairPacket(packet:AnswerPacket,issue:Extract<AnswerCheck,{ok:false}>,previous:string){
  return {...packet,instructions:packet.instructions+' '+issue.detail,input:packet.input+'\nPrevious proposal to check: '+previous.trim().slice(0,400)}
}
