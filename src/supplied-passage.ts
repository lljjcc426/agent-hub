import type {AnswerCheck,AnswerPacket} from './supplied-answer.ts'

export const objectSchema=(properties:Record<string,unknown>)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false})
export const intakeSchema=objectSchema({route:{type:'string',enum:['READ','PLAN','OTHER']}})
export function intakeRoute(text:string){
  const route=suppliedRecord(text)?.route
  return route==='READ'||route==='PLAN'||route==='OTHER'?route:undefined
}
export function suppliedRecord(text:string):Record<string,unknown>|undefined{
  try{
    const bare=/^`{3}(?:json)?\s*([\s\S]+?)\s*`{3}$/iu.exec(text.trim())?.[1]??text
    const value:unknown=JSON.parse(bare)
    if(value&&typeof value==='object'&&!Array.isArray(value))return value as Record<string,unknown>
  }catch{}
}
export function selectionSchema(n:number){
  return objectSchema({lines:{type:'array',items:{type:'integer',minimum:1,maximum:n}}})
}
export function selectedLines(text:string,n:number){
  const lines=suppliedRecord(text)?.lines
  if(Array.isArray(lines)&&lines.length<=n&&lines.every(i=>Number.isSafeInteger(i)&&i>=1&&i<=n)&&new Set(lines).size===lines.length)return lines as number[]
}

const statuses=['use','old','draft','conflict','other'] as const
type Status=typeof statuses[number]
const statusSet=new Set<unknown>(statuses)
const statusCodes:Record<string,Status>={U:'use',S:'old',P:'draft',C:'conflict',X:'other'}
const answerSchema=objectSchema({rows:{type:'string'},value:{type:'string'}})
export interface PassageBasis {rows:string[];complete:boolean}

/** Every status in the model reply addresses an original row visible to this recipient. */
export function passagePacket(question:string,rows:string[],complete:boolean):AnswerPacket{
  const evidence=rows.map((row,i)=>(i+1)+' '+row).join('\n')
  // Individually addressed fields prevent a prompt-only connection from collapsing multiple
  // rows into a single status. Long passages keep a bounded provider schema.
  const ids=rows.length<=12?rows.map((_,i)=>'r'+(i+1)):[]
  const shape=ids.length?objectSchema({...Object.fromEntries(ids.map(id=>[id,{type:'string',enum:Object.keys(statusCodes)}])),value:{type:'string'}}):answerSchema
  const template=Object.fromEntries([...ids.map(id=>[id,'<letter>']),['value','<answer>']])
  const statusFields=ids.length?'Use this flat JSON shape: '+JSON.stringify(template)+'.':'In "rows", write one letter per numbered row ('+rows.length+' letters).'
  return {evidence,input:evidence+'\n'+question,schema:shape,passage:{rows,complete},
    instructions:statusFields+' U=used fact or link, S=superseded, P=proposal, C=unresolved conflict, X=other. Apply effective changes even within one row. Order alone gives no precedence. In "value" return only the requested answer, including specified uncertainty. Outside work: NEED_CONTEXT. Return one JSON object.'}
}
const codes=(line:string)=>new Set((line.match(/(?<![A-Za-z\d_-])(?=[A-Za-z\d_-]*\d)[A-Za-z][A-Za-z\d_-]*\d[A-Za-z\d_-]*(?![A-Za-z\d_-])/gu)??[]).map(k=>k.toLowerCase()))
const includesValue=(line:string,value:string)=>{
  const literal=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
  return new RegExp((/^[\da-z]/iu.test(value)?'(?<![a-z\\d_-])':'')+literal+(/[a-z\d]$/iu.test(value)?'(?![a-z\\d_-])':''),'iu').test(line)
}
// When the query gives one record key and requests a literal value, retain the source path to it.
function linkedValue(rows:string[],key:string,value:string){
  const reached=new Set([key]),records=rows.map(line=>({line,keys:codes(line)}))
  for(let i=0;i<records.length;i++){
    const size=reached.size
    for(const r of records){
      if([...r.keys].some(k=>reached.has(k))){
        if(includesValue(r.line,value))return true
        for(const k of r.keys)reached.add(k)
      }
    }
    if(reached.size===size)break
  }
  return false
}
export function checkPassage(question:string,raw:string,basis:PassageBasis):AnswerCheck{
  if(!basis.complete)return {ok:false,reason:'sources',detail:'Read the complete authorized passage before checking the answer.'}
  const record=suppliedRecord(raw),value=typeof record?.value==='string'?record.value.trim():typeof record?.value==='number'&&Number.isFinite(record.value)?String(record.value):''
  // Prompt-only protocols sometimes return explicit row addresses. Accept them only when
  // every address agrees with the numbered source, under the same checks as the native schema.
  const named=record&&Object.keys(record).filter(key=>/^r\d+$/u.test(key))
  let marks
  if(named?.length===basis.rows.length&&record)marks=basis.rows.map((_,i)=>statusCodes[String(record['r'+(i+1)])])
  else if(!named?.length&&typeof record?.rows==='string')marks=[...record.rows].map(c=>statusCodes[c])
  else if(!named?.length&&Array.isArray(record?.rows))marks=record.rows.map((mark,i)=>mark&&typeof mark==='object'&&mark.row===i+1?mark.status:mark)
  if(!Array.isArray(marks)||marks.length!==basis.rows.length||!marks.every(x=>statusSet.has(x)))
    return {ok:false,reason:'sources',detail:'Return one valid status for every visible row, in order.'}
  if(!value||value==='?'||/\bNEED_CONTEXT\b/u.test(value))return {ok:false,reason:'missing',detail:'Recheck every source needed for the requested answer.'}
  const relevant=basis.rows.filter((_,i)=>(marks[i] as Status)==='use')
  const alternative=/\bor\s+["']?([\w-]+)["']?\s+if\b/iu.exec(question)?.[1]
  const uncertain=/^(?:unknown|undetermined|indeterminate|inconclusive|cannot (?:tell|determine)|不确定|未知|无法确定)$/iu.test(value)||value===alternative
  if(!relevant.length&&!(uncertain&&marks.includes('conflict')))return {ok:false,reason:'sources',detail:'Identify the applicable evidence, or an unresolved conflict.'}
  if(/\b(?:answer|reply|respond) (?:only )?(?:with )?yes or no[.?!]?\s*$/iu.test(question)){
    const binary=/^(yes|no)[.]?$/iu.exec(value)
    return binary?{ok:true,text:binary[1]!,rows:marks}:{ok:false,reason:'format',detail:'Return yes or no as the value.'}
  }
  const literal=/\b(?:just|only) (?:with )?(?:the |a )?(?:[\w-]+ )?(?:name|code|letter|identifier)\b|只(?:给|回|写|答|返回).{0,32}(?:名|编号|代码)/iu.test(question)||
    /^[A-Za-z]+\d+[A-Za-z\d-]*$/u.test(value)&&/只(?:给|回|写|答)|\b(?:just|only)\b/iu.test(question)
  if(literal&&!uncertain){
    if(!relevant.some(row=>includesValue(row,value)))return {ok:false,reason:'values',detail:'Give the exact value from the effective records.'}
    const ids=[...codes(question)]
    if(ids.length===1&&basis.rows.some(row=>codes(row).has(ids[0]!))&&!linkedValue(relevant,ids[0]!,value))
      return {ok:false,reason:'sources',detail:'Include the applicable row for every link from the requested key to the value.'}
  }
  return {ok:true,text:value,rows:marks as Status[]}
}
