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
export interface PassageBasis {rows:string[];complete:boolean;winningRow?:number;labels?:string[];arithmetic?:string}

// In a short comparison, show exact subtraction only for an explicitly withheld or returned
// quantity. Do not project through percentages, conversions, unknown adjustments or ties.
function netComparison(question:string,rows:string[]){
  if(rows.length<2||rows.length>8)return
  const reserve=/\bunreserved\b|可用/iu.test(question),net=/\bnet\b|净/iu.test(question)
  const most=/\b(?:more|most|larger|greater|largest|greatest)\b|最多|更多/iu.test(question),least=/\b(?:less|fewest|fewer|smallest|least)\b|最少|更少/iu.test(question)
  if(reserve===net||most===least)return
  const adjustment=reserve?/\breserv(?:ed|ation)\b|预留/iu:/\breturn(?:ed|s)?\b|退回/iu
  const none=reserve?/\b(?:none|nothing|no items?) (?:are |were |was )?reserved\b|未预留|没有预留/iu:/\b(?:no returns|none returned|nothing (?:was )?returned)\b|没有退回|未退回/iu
  const amounts:number[]=[],notes:string[]=[],labels:string[]=[],units=new Set<string>()
  for(const row of rows){
    if(/[.%％/\-]\d|\d[.%％/]\d|[%％]|\b(?:per|rate|ratio|about|estimate|not all|dollars?|euros?|hours?|kg)\b|每|大约|汇率|单价|公斤|小时/iu.test(row))return
    const nums=[...row.matchAll(/\d+/gu)]
    if(!nums.length||nums.length>2||nums.some(n=>n[0].length>8||/[A-Za-z_-]/u.test(row[n.index!-1]??'')))return
    for(const n of nums){
      const suffix=row.slice(n.index!+n[0].length).trimStart()
      const unit=/^(items?|crates?|boxes|box|units?|cartons?|packets?|pieces?)\b|^([件箱个包台枚])/iu.exec(suffix)
      if(unit)units.add(unit[0].toLowerCase().replace(/boxes$/u,'box').replace(/s$/u,''))
      else if(suffix&&!/^[,.;，。；]|^(?:are|were|is|was|reserved|returned)\b|^(?:已|被|预留|退回)/iu.test(suffix))return
    }
    if(units.size>1)return
    const base=Number(nums[0]![0])
    const prefix=row.slice(0,nums[0]!.index).trim()
    const label=/^([\p{L}][\p{L}\d -]{0,45}?)\s+(?:has|holds|received|shipped|issued|took)$/iu.exec(prefix)?.[1]??
      /^([\p{Script=Han}A-Za-z\d_-]{1,24}?)(?:领走|领取|持有|拥有|发出|收到|有)$/u.exec(prefix)?.[1]
    if(!label)return
    labels.push(label)
    if(nums.length===1){
      if(adjustment.test(row)&&!none.test(row))return
      amounts.push(base);notes.push(String(base));continue
    }
    const parts=row.split(/[,;，；]|\b(?:but|though|of which)\b|其中|随后/iu).filter(s=>s.trim())
    if(parts.length!==2||!adjustment.test(parts[1]!)||adjustment.test(parts[0]!)||/\b(?:net|available|free|left|remaining|unreserved|excluding)\b|净|已扣除|可用/iu.test(parts[0]!))return
    const deductionText=parts[1]!.trim().replace(/[.。]$/u,'')
    if(!/^(?:\d+\s*(?:(?:items?|crates?|boxes|box|units?|cartons?|packets?|pieces?)\s+)?(?:(?:are|is|were|was)\s+)?(?:reserved|returned)|(?:returned|reserved)\s+\d+(?:\s+(?:items?|crates?|boxes|box|units?|cartons?|packets?|pieces?))?|(?:预留|退回)\s*\d+\s*[件箱个包台枚]?|\d+\s*[件箱个包台枚]?\s*(?:已|被)?(?:预留|退回))$/iu.test(deductionText))return
    const deduction=Number(nums[1]![0]);if(deduction>base)return
    amounts.push(base-deduction);notes.push(base+' - '+deduction+' = '+(base-deduction))
  }
  if(!notes.some(n=>n.includes(' = ')))return
  const extreme=(most?Math.max:Math.min)(...amounts),winner=amounts.indexOf(extreme)
  if(amounts.lastIndexOf(extreme)!==winner||new Set(labels).size!==rows.length)return
  return {winner,labels,
    note:'Net counts in row order: '+notes.join('; ')+'. The requested '+(most?'maximum':'minimum')+' is row '+(winner+1)+'.'}
}

/** Every status in the model reply addresses an original row visible to this recipient. */
export function passagePacket(question:string,rows:string[],complete:boolean):AnswerPacket{
  const evidence=rows.map((row,i)=>(i+1)+' '+row).join('\n')
  // Individually addressed fields prevent a prompt-only connection from collapsing multiple
  // rows into a single status. Long passages keep a bounded provider schema.
  const ids=rows.length<=12?rows.map((_,i)=>'r'+(i+1)):[]
  const shape=ids.length?objectSchema({...Object.fromEntries(ids.map(id=>[id,{type:'string',enum:Object.keys(statusCodes)}])),value:{type:'string'}}):answerSchema
  const template=Object.fromEntries([...ids.map(id=>[id,'<letter>']),['value','<answer>']])
  const statusFields=ids.length?'Use this flat JSON shape: '+JSON.stringify(template)+'.':'In "rows", write one letter per numbered row ('+rows.length+' letters).'
  const numericComparison=rows.some(row=>/\d/u.test(row))&&/\b(?:more|most|fewer|fewest|higher|lower|greater|largest|smallest)\b|最[多少高低大]|[更较][多少高低]/iu.test(question)
  const net=complete?netComparison(question,rows):undefined
  return {evidence,input:[evidence,net?.note,question].filter(Boolean).join('\n'),schema:shape,passage:{rows,complete,winningRow:net?.winner,labels:net?.labels,arithmetic:net?.note},
    instructions:statusFields+' U=used fact or link (even if the row also has unrelated facts), S=superseded, P=proposal, C=unresolved conflict, X=other. Apply effective changes even within one row. Order alone gives no precedence.'+(numericComparison?' Calculate each net quantity from its own figures before comparing.':'')+' In "value" return only the requested answer, including specified uncertainty. Outside work: NEED_CONTEXT. Return one JSON object.'}
}
const codes=(line:string)=>new Set((line.match(/(?<![A-Za-z\d_-])(?=[A-Za-z\d_-]*\d)[A-Za-z][A-Za-z\d_-]*\d[A-Za-z\d_-]*(?![A-Za-z\d_-])/gu)??[]).map(k=>k.toLowerCase()))
const includesValue=(line:string,value:string)=>{
  const literal=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
  return new RegExp((/^[\da-z]/iu.test(value)?'(?<![a-z\\d_-])':'')+literal+(/[a-z\d]$/iu.test(value)?'(?![a-z\\d_-])':''),'iu').test(line)
}
// A second item on the same printed line may concern an unrelated key. Follow only explicit
// lookup clauses, preserving the original row addresses of every hop.
function lookupPath(rows:string[],key:string,value:string,allowed:(i:number)=>boolean){
  const reached=new Map<string,number[]>([[key,[]]])
  const clauses=rows.flatMap((row,i)=>!allowed(i)?[]:row.split(/[,;，；。]|\b(?:whereas|while|but)\b/iu).map(line=>({i,line,keys:[...codes(line)]})))
  for(let pass=0;pass<=clauses.length;pass++){
    const size=reached.size
    for(const {i,line,keys} of clauses){
      const [from,to]=keys,path=from&&reached.get(from)
      if(!path||clauses.some(c=>c.line!==line&&c.keys[0]===from)||!/(?:对应|映射|归|由|保管|存[在放]|换成|\b(?:maps? to|uses?|feeds?|points? to|belongs? to|held by|assigned to|stored (?:in|at))\b)/iu.test(line))continue
      const next=[...new Set([...path,i])]
      if(includesValue(line,value))return next
      if(keys.length===2&&to&&!reached.has(to))reached.set(to,next)
    }
    if(reached.size===size)break
  }
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
    if(basis.labels&&basis.winningRow!==undefined&&marks.every(mark=>mark==='use')){
      // Use the computed winner only when the proposal identifies one of the original subjects
      // and the user explicitly requested its name. Keep the native proposal in the transcript.
      const candidates=basis.labels.filter(label=>label===value||/^[\p{Script=Han}]+$/u.test(value)&&label.startsWith(value))
      if(candidates.length===1)return {ok:true,text:basis.labels[basis.winningRow]!,rows:marks,arithmetic:basis.arithmetic}
    }
    if(basis.winningRow!==undefined&&!includesValue(basis.rows[basis.winningRow]!,value))return {ok:false,reason:'values',detail:'Return the full label in the row with the requested net count.'}
    const ids=[...codes(question)]
    if(ids.length===1&&basis.rows.some(row=>codes(row).has(ids[0]!))&&basis.rows.some(row=>!codes(row).has(ids[0]!)&&includesValue(row,value))){
      const path=lookupPath(basis.rows,ids[0]!,value,i=>marks[i]==='use')
      if(!path){
        // Reconcile a reader's omitted link only in unqualified lookup records. Never use a
        // superseded, proposed or contradictory row to reinstate a value.
        const plain=basis.rows.every(row=>!(/\b(?:old|originally|previous|draft|propos\w*|cancel\w*|withdraw\w*|except|formerly|maybe|not|never|may|if)\b|草案|已撤|曾经|已废|不再|可能|如果|并非/iu.test(row)))
        const restored=plain&&marks.every(m=>m==='use'||m==='other')?lookupPath(basis.rows,ids[0]!,value,()=>true):undefined
        if(restored?.length)return {ok:true,text:value,rows:marks.map((m,i)=>restored.includes(i)?'use':m)}
        return {ok:false,reason:'sources',detail:'Trace the requested key through each applicable clause to the answer. Mark each required row U.'}
      }
    }
    if(!relevant.some(row=>includesValue(row,value)))return {ok:false,reason:'values',detail:'Give the exact value from the effective records.'}
  }
  return {ok:true,text:value,rows:marks as Status[]}
}
