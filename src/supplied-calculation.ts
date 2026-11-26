/** Exact work on complete, supplied integer tables and identifier lists. Never executes model code. */
export interface SuppliedRows {heading:string; rows:string[]}
export interface CheckedCalculation {
  note:string
  /** Totals constrain the reader's proposed identifiers and values. */
  winner?:{key:string;total:number}
  count?:number
  complement?:number
}
const identifier=/^[\p{L}\d][\p{L}\d_-]{0,47}$/u
const integer=/^-?(?:0|[1-9]\d{0,8})$/u
const normalized=(value:string)=>value.trim()
function idList(source:SuppliedRows){
  const tokens=source.rows.flatMap(row=>normalized(row).replace(/[.。]$/u,'').split(/\s*[,;、，；]\s*/u))
  if(!tokens.length||tokens.some(t=>!identifier.test(t)))return
  return tokens
}
function rowPair(row:string):{key:string;value:number;unit:string}|undefined {
  const m=/^([\p{L}][\p{L}\d_-]{0,47})\s*(?:[=:]\s*|\s+)(-?(?:0|[1-9]\d{0,8}))(?:\s*([\p{L}%]{1,20}))?$/u.exec(row.trim())
  if(m)return {key:m[1]!,value:Number(m[2]),unit:m[3]??''}
}
function observations(source:SuppliedRows){
  const rows=source.rows.map(normalized),values=new Map<string,number>(),units=new Set<string>()
  if(rows.length>128||!rows.length)return
  let columns:string[]|undefined
  const split=(line:string)=>line.replace(/^\||\|$/gu,'').split(/\s*\|\s*|\t/u).map(s=>s.trim())
  if(/[|\t]/u.test(rows[0]!)){
    const header=split(rows[0]!)
    if(header.length!==2||header.some(x=>!identifier.test(x))||integer.test(header[1]!))return
    columns=header;rows.shift()
  }
  for(const raw of rows){
    const line=raw.replace(/[.。]$/u,'').trim()
    if(columns){
      if(/^\s*\|?[\s:|-]+\|?\s*$/u.test(line))continue
      const cells=split(line)
      if(cells.length!==2||!identifier.test(cells[0]!)||!integer.test(cells[1]!)||values.has(cells[0]!))return
      values.set(cells[0]!,Number(cells[1]));units.add(columns[1]!)
    }else{
      // Period labels locate a measurement, but are never identifiers or values.
      const entries=line.replace(/^第[一二三四五六七八九十\d]+[天轮期组次周班]\s*[:：]?\s*/u,'').split(/[,;，；、]/u)
      for(const entry of entries){
        const parsed=rowPair(entry)
        if(!parsed||values.has(parsed.key))return
        values.set(parsed.key,parsed.value);units.add(parsed.unit)
      }
    }
  }
  if(!values.size||units.size!==1)return
  return {values,unit:[...units][0]}
}
function threshold(question:string){
  if(/\d[.,]\d/u.test(question))return
  const patterns:[RegExp,(n:number,t:number)=>boolean][]=[
    [/(?:\bat least\b|\bno less than\b|>=|至少|不低于|不少于)\s*(-?\d+)(?![\d.])/iu,(n,t)=>n>=t],
    [/(?:\bat most\b|\bno more than\b|<=|至多|最多|不超过)\s*(-?\d+)(?![\d.])/iu,(n,t)=>n<=t],
    [/(?:(?<!no )\b(?:strictly )?(?:exceeds?|greater than|more than)\b|(?<![=])>(?!=)|(?<!不)超过|大于)\s*(-?\d+)(?![\d.])/iu,(n,t)=>n>t],
    [/(?:(?<!no )\b(?:strictly )?(?:below|less than)\b|(?<![=])<(?!=)|(?<!不)低于|小于)\s*(-?\d+)(?![\d.])/iu,(n,t)=>n<t],
  ]
  const found=patterns.flatMap(([pattern,accept])=>[...question.matchAll(new RegExp(pattern,'giu'))].map(m=>({number:Number(m[1]),accept})))
  return found.length===1?found[0]:undefined
}
// Resolve a complement only for a named band in a single, complete rounded distribution.
// Distinct tables, missing bins, rates of change and overlapping descriptions stay with the reader.
function percentageComplement(question:string,sources:SuppliedRows[]):CheckedCalculation|undefined{
  const band=/^\s*(?:how many percent|what percentage)(?: of (?:the )?(?:population|people|residents))? (?:were|was|are|is) (?:not (?:from |aged )?|outside (?:the range )?)(\d{1,3}) (?:to|through) (\d{1,3})\?/iu.exec(question)
  if(!band||Number(band[1])>=Number(band[2]))return
  const tail=question.slice(band[0].length).trim()
  if(tail&&!tail.split(/(?<=[.!])\s+/u).every(s=>/^(?:(?:give|return|reply with|answer with) (?:only )?(?:the |a )?(?:short answer|number)(?: only)?(?: from the passage)?[.!]?|if (?:several|multiple) spans are required, separate them with a (?:semicolon|comma)[.]?)$/iu.test(s)))return
  const distributions=sources.flatMap(s=>s.rows).filter(row=>row.includes('%'))
  if(distributions.length!==1)return
  const row=distributions[0]!,matches=[...row.matchAll(/(?<![-+\d.])(\d+(?:\.\d+)?)%\s+(under (?:the age of )?\d+|from \d+ (?:to|through) \d+|(?:who (?:were |are )?|aged )?\d+ (?:years (?:of age )?)?(?:or |and )?(?:older|over|above))(?=,|\.|;|$)/giu)]
  if(matches.length<3||matches.length!==row.split('%').length-1)return
  const intervals=matches.map(m=>{
    const limits=m[2]!.match(/\d+/gu)!.map(Number)
    return /^under /iu.test(m[2]!)?[0,limits[0]!-1]:limits.length===2?limits:[limits[0]!,Infinity]
  }).sort((a,b)=>a[0]!-b[0]!)
  if(intervals[0]![0]!==0||intervals.at(-1)![1]!==Infinity||intervals.some(([lo,hi],i)=>lo!>hi!||i>0&&lo!==intervals[i-1]![1]!+1))return
  const parts=matches.map(m=>Number(m[1])),tolerance=matches.reduce((sum,m)=>sum+0.5*10**-(m[1]!.split('.')[1]?.length??0),0)
  if(parts.some(x=>x>100)||Math.abs(parts.reduce((x,y)=>x+y,0)-100)>tolerance+1e-9)return
  const selected=matches.filter(m=>new RegExp('^from '+band[1]+' (?:to|through) '+band[2]+'$','i').test(m[2]!))
  if(selected.length!==1)return
  const label=selected[0]![1]!,value=Number((100-Number(label)).toFixed(Math.min(label.split('.')[1]?.length??0,12)))
  return {complement:value,note:'Requested complement: 100% - '+label+'% = '+value+'%.'}
}
/** The caller supplies only complete sources readable in this activation. No fuzzy entity joins. */
export function checkedCalculation(question:string,sources:SuppliedRows[]):CheckedCalculation|undefined{
  if(sources.length<1||sources.length>12)return
  const complement=percentageComplement(question,sources)
  if(complement)return complement
  const intent=question.split(/\bRESULT\s+[A-Za-z_][\w-]*=</u)[0]!
  if(/\b(?:except|missing|unknown|cancelled|adjusted|active|eligible|excluding|only if|per person|percentage|discount|average|weighted|withdrawn|signed|ignore case|case.insensitive|occur(?:s)? (?:exactly |only )?once|appear(?:s)? (?:exactly |only )?once)\b|缺失|缺测|加权|排除|折扣|忽略大小写/iu.test(intent))return
  if(/\b(?:distinct|unique)\b|去重|不重复/iu.test(intent)&&/\b(?:how many|count|number of)\b|数目|数量|多少/iu.test(intent)){
    const lists=sources.map(idList)
    if(!lists.every((s):s is string[]=>!!s))return
    const inBoth=/\bin (?:both|each|all) (?:lists|registers|sets|manifests)\b|\bcommon to\b|交集/iu.test(intent)
    const union=/\bacross\b|\bcombined\b|\bin total\b|并集|合计/iu.test(intent)
    if(inBoth===union)return
    const unique=[...new Set(lists.flat())],items=inBoth?unique.filter(id=>lists.every(s=>s.includes(id))):unique
    return {count:items.length,note:'Exact distinct '+(inBoth?'intersection':'union')+' = '+items.length}
  }
  if(!/\b(?:sum|summed|totals?|added)\b|相加|总和|合计|总计|总分/iu.test(intent)||/\b(?:minus|less fees|difference|divide|balance|including tax)\b|减去|相减/iu.test(intent))return
  const tables=sources.map(observations)
  if(!tables.every((t):t is NonNullable<typeof t>=>!!t))return
  const first=tables[0]!,keys=[...first.values.keys()]
  if(keys.length>24)return
  if(!tables.every(t=>t.unit===first.unit&&t.values.size===keys.length&&keys.every(k=>t.values.has(k))))return
  const totals=keys.map(key=>({key,total:tables.reduce((n,t)=>n+t.values.get(key)!,0)}))
  const bound=threshold(intent)
  const min=/\b(?:smallest|lowest|lower|least|fewest|minimum)\b|最低|最少|最小/iu.test(intent)
  const max=/\b(?:largest|highest|higher|most|greatest|maximum)\b|最高|最多|最大/iu.test(intent)
  let qualified=totals
  const compare=/\b(?:at (?:least|most)|(?:more|less|greater) than|exceeds?|below)\b|[<>]|至少|至多|超过|大于|低于|小于|不少于|不低于/u.test(intent.toLowerCase())
  if(bound)qualified=totals.filter(x=>bound.accept(x.total,bound.number))
  else if(!compare&&min!==max){const extreme=(min?Math.min:Math.max)(...totals.map(x=>x.total));qualified=totals.filter(x=>x.total===extreme)}
  const winner=(bound||(!compare&&min!==max))&&qualified.length===1?qualified[0]:undefined
  return {winner,note:'Checked sums: '+totals.map(x=>x.key+'='+x.total).join(', ')+(winner?'. Qualifying key: '+winner.key:'')}
}
