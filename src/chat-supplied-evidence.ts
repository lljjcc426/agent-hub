import type {Runtime} from './runtime.ts'
import type {ChatRun,ChatMessage} from './chat.ts'
import type {WorkerProfile} from './backend-config.ts'
import type {ContextManifest} from './router-memory.ts'
import {currentReview,type ChatResultReview} from './chat-result-review.ts'
import type {ScopeContext} from './router-scope.ts'
import {stableDigest} from './sources.ts'

/** Only a new private Chat with an explicit read-only request can start this opt-in path. */
export interface EvidenceGroup { digest:string; workers:string[]; tickets:Record<string,string>; fold?:boolean; interpreted?:boolean; labels?:Record<string,string> }
export interface Section { heading:string; rows:string[] }
export interface EvidencePlan { question:string; direction:string; workers:string[]; sections:Section[]; digest:string; labels:Record<string,string>; interpreted?:true }

const direct=/^(?:answer directly[.!]?|直接(?:回答|作答)[。！]?|respond directly[.!]?)$/iu
const delegation=/^(?:please (?:have|ask)\b|use\b|have\b|ask\b|assign\b|let\b|请|让|交给|由)/iu
const inspection=/\b(?:check|review|read|compare|verify|inspect|extract|reconcile|evaluate|audit|assess|summari[sz]e|analyse|analyze)\b|核对|检查|比对|核查|查阅|核验|梳理|评估|审阅|对照|提取|分析/iu
const requireOrdinary=/\b(?:independent (?:review|verification|approval|assessment)|independently (?:review|verify|assess)|each separately|separate reports|purchase|publish|delete|upload|download|install|execute|browse|search the web|send (?:it|an? email)|previous conversation|earlier chat|today|yesterday|tomorrow)\b|独立验收|分别签字|删除|购买|上传|安装|执行命令|浏览器|联网|上次对话|昨天|今天|明天/iu
const negative=/\b(?:do not|don.t|never|instead of|except|without|ignore|only if|unless)\b|不要|别让|不让|除非|除了|不用|禁止/iu
const escaped=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
function named(text:string,word:string){
  return new RegExp('(?<![a-z0-9_-])'+escaped(word)+'(?![a-z0-9_-])','iu').test(text)
}
export function evidencePlan(text:string,profiles:readonly Pick<WorkerProfile,'id'|'label'>[],interpreted=false):EvidencePlan|undefined{
  const [header,...blocks]=text.trim().split(/\r?\n[ \t]*\r?\n/u)
  if(!header||!blocks.length||blocks.length>48||text.length>90_000)return
  const [first,...rest]=header.includes('\n')?header.split(/\r?\n/):header.split(/(?<=[.!?。！？])\s+(?=\S)/u)
  const direction=interpreted?header:first
  const question=interpreted?header:rest.join('\n').trim()
  if(!direction||!question||requireOrdinary.test(header))return
  const found=profiles.filter(w=>named(direction,w.id)||!!w.label&&named(direction,w.label))
  const workers=found.map(w=>w.id)
  const mentions=[...direction.matchAll(/@([a-z][a-z\d_-]*)/giu)].map(m=>m[1]!.toLowerCase())
  if(mentions.some(name=>!found.some(p=>p.id.toLowerCase()===name||p.label?.toLowerCase()===name)))return
  if(interpreted){
    if(!mentions.length||mentions.length!==new Set(mentions).size||negative.test(header)||workers.length!==mentions.length)return
  }else if(!direct.test(direction.trim())&&(!delegation.test(direction)||!inspection.test(direction)||negative.test(direction)||/\b(?:first .+ then (?:ask|have|let|assign)|in sequence|separately|individually)\b|逐个独立|依次审阅/iu.test(direction)||!workers.length))return
  if(direct.test(direction.trim())&&workers.length||workers.length>4)return
  const labels=Object.fromEntries(found.map(w=>[w.id,w.label??w.id]))
  const sections:Section[]=[]
  for(const part of blocks){
    const lines=part.split(/\r?\n/)
    if(lines.length<2||lines[0]!.length>160)return
    const tag=/^@([a-z][a-z\d_-]*)(?=\s|$)/iu.exec(lines[0]!)?.[1]
    if(workers.length&&tag&&!found.some(w=>w.id.toLowerCase()===tag.toLowerCase()||w.label?.toLowerCase()===tag.toLowerCase()))return
    sections.push({heading:lines[0]!,rows:lines.slice(1)})
  }
  return {question,direction,sections,workers,labels,digest:stableDigest(text),...(interpreted?{interpreted:true as const}:{})}
}
export function freshEvidence(host:Runtime,run:ChatRun,text:string){
  const m=host.store.get<ChatMessage>('chat-message','user:'+run.id)
  return !!m&&m.text===text&&m.role==='user'&&m.conversationId===run.conversationId&&!m.attachments?.length&&!m.quote&&!m.skill&&!run.feedback&&
    !run.cancelRequested&&!run.cancelled&&!host.memory.cleanup.blocked('chat-message',m.id,m)&&
    !host.store.db.prepare("SELECT 1 FROM records WHERE kind='chat-message' AND json_extract(body,'$.conversationId')=? AND json_extract(body,'$.role')='user' AND id<>? LIMIT 1").get(run.conversationId,m.id)
}
export function workerSections(plan:EvidencePlan,id:string){
  if(plan.workers.length<=1)return plan.sections
  // An explicit label is a source boundary. Unlabelled sources stay available to every reader.
  const owns=(s:Section,w:string)=>named(s.heading,w)||named(s.heading,plan.labels[w]??w)
  return plan.sections.filter(s=>owns(s,id)||!plan.workers.some(w=>owns(s,w)))
}
function originals(sections:Section[]){return sections.flatMap(s=>s.rows.map(row=>({heading:s.heading,row})))}
/** Factor constant column prefixes while preserving every value, row and its order. */
function display(section:Section){
  const cells=section.rows.map(row=>row.split(' | '))
  const width=cells[0]?.length??0
  if(width<2||cells.length<5||cells.some(r=>r.length!==width))return {heading:section.heading,rows:section.rows}
  const names=cells[0]!.map((_,i)=>{
    const m=/^([\p{L}_][\p{L}\d_-]*) ([^ ].*)$/u.exec(cells[0]![i]!)
    return m&&cells.every(r=>r[i]!.startsWith(m[1]+' '))?m[1]+' ':''
  })
  const heading=section.heading+' ['+names.map((n,i)=>n.trim()||String(i+1)).join('|')+']'
  const rows=cells.map(r=>r.map((v,i)=>v.slice(names[i]!.length)).join('|'))
  return heading.length+rows.join('\n').length<section.heading.length+section.rows.join('\n').length?{heading,rows}:{heading:section.heading,rows:section.rows}
}
export function evidenceText(sections:Section[],numbered=false){
  let ix=0
  return sections.map(s=>{const view=display(s);return view.heading+'\n'+view.rows.map(r=>(numbered?String(++ix)+' ':'')+r).join('\n')}).join('\n')
}
export const answerInstructions='Use all relevant records. Copy names and identifiers exactly; compare all alternatives and compute requested values. Return only the requested answer. If insufficient return NEED_CONTEXT.'
// Only explicit exact-key restrictions permit projecting a homogeneous keyed relation.
// Keep every version of the key, including contradictory, superseded and missing records.
function exactKey(plan:EvidencePlan){
  if(!/\b(?:for exactly this|for exact (?:commit|key|id)|only (?:rows|records) (?:for|with))\b/iu.test(plan.question)||/\b(?:median|average|all (?:sites|keys|accounts)|across|baseline|versus|relative to|compare (?:with|to))\b/iu.test(plan.question))return
  const ids=[...new Set(plan.question.match(/\b(?:[a-z][a-z\d]*[-_/][a-z\d-]*\d[a-z\d-]*|[\da-f]{12,64})\b/gi)??[])]
  if(ids.length===1)return ids[0]
}
function selected(plan:EvidencePlan,sections:Section[]){
  const key=exactKey(plan)
  if(!key)return sections
  const shape=(s:string)=>s.replace(/\d/g,'0').replace(/[a-f0-9]{12,64}/gi,'<hash>')
  return sections.map(s=>{
    const parsed=s.rows.map(row=>({key:/^(\S+)\s/.exec(row)?.[1],row}))
    if(!parsed.some(r=>r.key===key)||!parsed.every(r=>r.key&&shape(r.key)===shape(key)))return s
    return {...s,rows:parsed.filter(r=>r.key===key).map(r=>r.row)}
  })
}
const questionOnly=(s:string)=>s.split(/(?:\b(?:return only|give one concise|answer result|report result|answer only)\b|写 RESULT)/iu)[0]!.trim()||s
function title(s:Section){return s.heading.replace(/^@[\w-]+\s*\/\s*/u,'')}
function lex(s:string){return new Set(s.toLowerCase().normalize('NFKC').match(/[a-z\d]+|[\p{Script=Han}]/gu)??[])}
function catalogue(plan:EvidencePlan){return plan.sections.length>=5&&plan.sections.reduce((n,s)=>n+s.rows.join(' ').length,0)>1800}
/** Rank only this reader's supplied sources. Include title links from other documents as a bridge signal. */
function rank(plan:EvidencePlan,sections:Section[],hints:string[]=[]){
  const words=lex(questionOnly(plan.question)),all=plan.sections.map(s=>({s,name:title(s).toLowerCase(),tokens:lex(title(s)+' '+s.rows.join(' ')),text:s.rows.join(' ').toLowerCase()}))
  const q=questionOnly(plan.question).toLowerCase(),hint=hints.join(' ').toLowerCase()
  const weight=(w:string)=>Math.log(1+all.length/(1+all.filter(x=>x.tokens.has(w)).length))
  const base=all.map(doc=>{
    const t=lex(doc.name);let score=0
    for(const w of words)if(doc.tokens.has(w))score+=weight(w)*(t.has(w)?3:1)
    const name=doc.name.replace(/\s*\([^)]*\)$/u,'')
    return score+(name.length>=4&&q.includes(name)?20:0)
  })
  return all.map((doc,i)=>{
    const name=doc.name.replace(/\s*\([^)]*\)$/u,'')
    const links=all.map((other,j)=>i!==j&&name.length>=4&&other.text.includes(name)?base[j]!*0.45:0)
    return {s:doc.s,score:base[i]!+Math.max(0,...links)+(name.length>=4&&hint.includes(name)?14:0)}
  }).filter(x=>sections.includes(x.s)).sort((a,b)=>b.score-a.score).map(x=>x.s)
}
export function answerPacket(plan:EvidencePlan,sections:Section[],findings:string[]=[],expanded=false){
  const docs=expanded?sections:catalogue(plan)?rank(plan,sections,findings).slice(0,3):selected(plan,sections)
  const instructions=/\bJSON\b/iu.test(plan.question)?'Use the sources. Reply as bare JSON. Give the shortest exact answer and original titles supporting every step. If evidence is missing return NEED_CONTEXT.':answerInstructions
  const evidence=[...findings,evidenceText(docs)].filter(Boolean).join('\n\n')
  return {instructions,input:/\bJSON\b/iu.test(plan.question)?evidence+'\n\n'+plan.question:plan.question+'\n\n'+evidence}
}
export function readerPacket(plan:EvidencePlan,id:string){
  const sections=selected(plan,workerSections(plan,id)),q=questionOnly(plan.question)
  const focus=exactKey(plan)?'Key '+exactKey(plan):q
  if(!catalogue(plan)&&!exactKey(plan)&&evidenceText(sections).length<=950){
    return {instructions:'Read your assigned records. Give one brief factual finding that can help another reader. Copy names and numbers exactly.',input:focus+'\n'+evidenceText(sections)}
  }
  const prompt='Select source IDs needed for this question, including indirect links. Reply only with IDs separated by commas, * for all or 0 for none.'
  if(catalogue(plan)){
    const brief=sections.map((s,i)=>String(i+1)+'. '+title(s)+': '+(s.rows[0]??'').slice(0,230)).join('\n')
    return {instructions:prompt,input:brief+'\nQuestion: '+focus}
  }
  return {instructions:'Read the numbered records. Return only supporting row IDs separated by commas, * for all or 0 for none.',input:evidenceText(sections,true)+'\nSelect rows for: '+focus}
}
function indices(text:string,n:number){
  let ref=text.trim().replace(/^(?:rows?|sources?|ids?)\s*:\s*/iu,'').replace(/[。.]$/u,'').replace(/^'|'$/g,'').replace(/^\[([\d,\s]*)\]$/u,'$1').trim()
  if(ref==='0'||/^none$/iu.test(ref)||ref==='')return text.trim()?[]:undefined
  if(ref==='*')return Array.from({length:n},(_,i)=>i)
  if(!/^[1-9]\d*(?:\s*,\s*[1-9]\d*)*$/u.test(ref))return
  const list=[...new Set(ref.split(',').map(n=>Number(n.trim())-1))]
  if(list.every(i=>Number.isSafeInteger(i)&&i>=0&&i<n))return list
}
export function citedEvidence(plan:EvidencePlan,id:string,text:string){
  const sections=selected(plan,workerSections(plan,id))
  if(!catalogue(plan)&&!exactKey(plan)&&evidenceText(sections).length<=950){
    const note=text.trim()
    if(!note||note==='NEED_CONTEXT')return
    // A short source travels verbatim. The untrusted note is only an annotation of that source.
    return evidenceText(sections)+(note.length<=280?'\nReader '+id+': '+note:'')
  }
  if(catalogue(plan)){
    const refs=indices(text,sections.length);if(!refs)return
    // Keep explicit choices and add the best independently ranked source from the original supplied packet.
    const top=rank(plan,workerSections(plan,id))[0],docs=sections.filter((s,i)=>refs.includes(i)||s.heading===top?.heading)
    return evidenceText(docs)||'No matching source.'
  }
  const all=originals(sections),refs=indices(text,all.length);if(!refs)return
  // Transmission cost is low on small sources. Keeping the complete record set preserves negatives and denominators.
  if(evidenceText(sections).length<=950||!refs.length)return evidenceText(sections)||'No matching source.'
  let heading='';const lines:string[]=[]
  for(const i of refs){const row=all[i]!;if(row.heading!==heading){heading=row.heading;lines.push(heading)}lines.push(row.row)}
  return lines.join('\n')
}
export function cleanEvidenceAnswer(plan:EvidencePlan,text:string){
  const reply=text.trim()
  if(!/\bJSON\b/iu.test(plan.question)){
    const fields=fieldsRequested(plan.question)
    if(fields.length){
      const lines=reply.split(/\r?\n/u).map(l=>l.trim().replace(/^\*\*(.*?)\*\*$/u,'$1')).filter(l=>/^RESULT\s/u.test(l))
      if(lines.length===1&&fields.every(key=>new RegExp('(?:^|\\s)'+escaped(key)+'=').test(lines[0]!)))return lines[0]!
    }
    return reply
  }
  const m=/^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(reply)
  if(m){try{JSON.parse(m[1]!);return m[1]!.trim()}catch{}}
  return reply
}
function fieldsRequested(q:string){
  const pos=q.lastIndexOf('RESULT ')
  if(pos<0)return []
  return [...q.slice(pos).matchAll(/(?:^|\s)([a-zA-Z][a-zA-Z0-9_-]*)=</gu)].map(m=>m[1]!)
}
export function answerNeedsReview(plan:EvidencePlan,text:string,rawSources:string){
  if(/\bNEED_CONTEXT\b/u.test(text))return true
  const result=cleanEvidenceAnswer(plan,text)
  if(/\bJSON\b/iu.test(plan.question)){try{JSON.parse(result);return false}catch{return true}}
  const fields=fieldsRequested(plan.question)
  if(!fields.length)return false
  const pairs=[...result.matchAll(/(?:^|\s)([A-Za-z][\w-]*)=([^=]+?)(?=\s+[A-Za-z][\w-]*=|$)/gu)]
  if(!result.startsWith('RESULT ')||fields.join('|')!==pairs.map(m=>m[1]).join('|'))return true
  const corpus=(rawSources+' '+plan.question).toLowerCase()
  // A new numeric quantity may be calculated. A novel textual value deserves one recheck with the same grant.
  return pairs.some(m=>{const v=m[2]!.trim().replace(/[.。]$/u,'');return /[\p{L}]/u.test(v)&&!corpus.includes(v.toLowerCase())})
}
/** Re-read the normal ticket and source grants before using a sibling’s accepted report. */
export function evidenceDependencies(host:Runtime,runId:string,group:EvidenceGroup,ids:string[],scope:ScopeContext){
  const findings:string[]=[]
  for(const id of ids){
    const key=group.tickets[id],assignment=key&&host.store.get<{parentTrigger?:string;workerId:string;suppliedEvidence?:true}>('worker-assignment',key)
    if(!key||!assignment||!assignment.suppliedEvidence||assignment.parentTrigger!==runId||assignment.workerId!==id)return {state:'ordinary' as const,findings}
    const ticket=host.store.tickets.get(key),owner=host.scopes.ownership(key),manifest=host.store.get<{manifest:ContextManifest}>('task-context',key)?.manifest
    if(!ticket||!owner||host.memory.cleanup.blocked('ticket',key,ticket))return {state:'ordinary' as const,findings}
    host.scopes.checkTask(key,scope);host.scopes.checkTaskEntry(owner,scope.route.entryId,'result')
    if(manifest)host.memory.validate(manifest)
    const report=ticket.assignments.at(-1)?.report
    if(ticket.ended?.outcome==='completed'&&report?.state==='ready'){
      const receipt=host.store.get<{assignmentId:string}>('evidence-report',key)
      if(receipt?.assignmentId!==ticket.assignments.at(-1)?.id)return {state:'ordinary' as const,findings}
      findings.push(report.summary);continue
    }
    if(report?.state==='waiting'&&!ticket.ended&&!ticket.attention){
      const row=host.store.db.prepare("SELECT body FROM records WHERE kind='chat-result-review' AND json_extract(body,'$.ticketId')=? AND json_extract(body,'$.assignmentId')=? AND json_extract(body,'$.decision') IS NULL ORDER BY rowid DESC LIMIT 1").get(key,ticket.assignments.at(-1)!.id) as {body:string}|undefined
      if(row&&currentReview(host,JSON.parse(row.body) as ChatResultReview))return {state:'pending' as const,findings}
    }
    if(ticket.ended||ticket.attention||report&&['blocked','failed','waiting'].includes(report.state))return {state:'ordinary' as const,findings}
    return {state:'pending' as const,findings}
  }
  return {state:'ready' as const,findings}
}
export function storedEvidence(host:Runtime,runId:string){
  const run=host.store.get<ChatRun>('chat-run',runId),group=run?.suppliedEvidence
  const trigger=host.store.triggers.get(runId)
  if(!group||!run||!trigger||!freshEvidence(host,run,trigger.text))return
  const plan=evidencePlan(trigger.text,group.workers.map(id=>({id,label:host.config.execution.workers?.find(w=>w.id===id)?.label})),group.interpreted)
  if(!plan||group.labels&&stableDigest(group.labels)!==stableDigest(plan.labels)||plan.digest!==group.digest||JSON.stringify(plan.workers)!==JSON.stringify(group.workers))return
  return {plan,group}
}
