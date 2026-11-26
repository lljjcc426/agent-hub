import type {Runtime} from './runtime.ts'
import type {ChatRun,ChatMessage} from './chat.ts'
import type {WorkerProfile} from './backend-config.ts'
import type {ContextManifest} from './router-memory.ts'
import {currentReview,type ChatResultReview} from './chat-result-review.ts'
import type {ScopeContext} from './router-scope.ts'
import {buildAnswerPacket,checkAnswer,repairPacket,sourceTitle,type AnswerPacket} from './supplied-answer.ts'
import type {ModelResult} from './model.ts'
import {stableDigest} from './sources.ts'
import {intakeRoute,intakeSchema,objectSchema,passagePacket,selectionSchema,selectedLines,suppliedRecord} from './supplied-passage.ts'

/** Only a new private Chat with an explicit read-only request can start this opt-in path. */
export interface EvidenceGroup { digest:string; workers:string[]; tickets:Record<string,string>; fold?:boolean; interpreted?:boolean; labels?:Record<string,string>; ordinary?:true; briefs?:Record<string,string> }
export const participantGroup=(run?:ChatRun)=>run?.namedParticipants??run?.suppliedEvidence
export interface Section { heading:string; rows:string[] }
export interface EvidencePlan { question:string; direction:string; workers:string[]; sections:Section[]; digest:string; labels:Record<string,string>; interpreted?:true; sharedPassage?:true }

const direct=/^(?:answer directly[.!]?|直接(?:回答|作答)[。！]?|respond directly[.!]?)$/iu
const delegation=/^(?:please (?:have|ask)\b|use\b|have\b|ask\b|assign\b|let\b|请|让|交给|由)/iu
const inspection=/\b(?:check|review|read|compare|verify|inspect|extract|reconcile|evaluate|audit|assess|summari[sz]e|analyse|analyze)\b|核对|检查|比对|核查|查阅|核验|梳理|评估|审阅|对照|提取|分析/iu
const requireOrdinary=/\b(?:independent (?:review|verification|approval|assessment)|independently (?:review|verify|assess)|each separately|separate reports|purchase|publish|delete|upload|download|install|execute|browse|search the web|send (?:it|an? email)|previous conversation|earlier chat|today|yesterday|tomorrow)\b|独立验收|分别签字|删除|购买|上传|安装|执行命令|浏览器|联网|上次对话|昨天|今天|明天/iu
const negative=/\b(?:do not|don.t|never|instead of|except|without|ignore|only if|unless)\b|不要|别让|不让|除非|除了|不用|禁止/iu
const escaped=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
function named(text:string,word:string){
  return new RegExp('(?<![a-z0-9_-])'+escaped(word)+'(?![a-z0-9_-])','iu').test(text)
}
const explicitDirect=/\b(?:answer directly|based (?:solely|only) on (?:this|these)|using only (?:this|these))\b|请?直接(?:告诉我|回答|给出)|仅根据(?:这些|上述|以下)/iu
const offMessage=/https?:\/\/|(?:^|\s)[/~][\w.-]+\/|[<>]|[\x60“”"]|\b(?:files?|logs?|website|internet|latest online|browser|database|run a command|open the|call the|send|email|schedule (?:a|an)|edit|create|post|approve|modify|update the|contact|privately|confidential|separately|simulate|pretend|hypothetically)\b|私下|保密|单独|分别|仅限|只给\s*@|代发|发送|预约|查询系统|日志|本机|文件|联网|假设让|修改|创建|代办|审批|转发|操作后台/iu
const asks=/[?？]|\b(?:who|which|how many|reply|respond|answer|give|please tell|based only|using only)\b|告诉我|请|只回|只给|最后|谁|哪|多少/iu
type Profile=Pick<WorkerProfile,'id'|'label'>
type Read=(instructions:string,input:string,schema?:Record<string,unknown>)=>Promise<ModelResult>
/** Names are candidates for an intent check. A mention alone cannot authorize sending a brief. */
function addressedReaders(text:string,profiles:readonly Profile[]){
  if(text.length>6000)return []
  const first=text.trim().split(/[\r\n。！？.!?]/u,1)[0]??''
  if(!/^(?:please\b|ask\b|have\b|could\b|can\b|would\b|请|让)/iu.test(first)||!inspection.test(first)||negative.test(first)||/[`"“”]/u.test(first))return []
  const names=[...first.matchAll(/@([a-z][a-z\d_-]*)/giu)].map(m=>m[1]!.toLowerCase())
  const found=profiles.filter(w=>names.includes(w.id.toLowerCase())||names.includes(w.label?.toLowerCase()??''))
  return names.length&&names.length<=4&&found.length===names.length?found.map(w=>w.id):[]
}
export async function namedEvidenceGroup(text:string,roster:readonly Profile[],fold:boolean,read:Read,prior?:EvidenceGroup):Promise<{plan?:EvidencePlan;group?:EvidenceGroup}>{
  const fixed=evidencePlan(text,roster),draft=fixed??evidencePlan(text,roster,true)
  if(fixed&&!fixed.workers.length)return {plan:fixed}
  const workers=draft?.workers??addressedReaders(text,roster),digest=stableDigest(text)
  if(!workers.length)return {}
  if(prior){
    if(prior.digest!==digest||prior.workers.length!==workers.length||!workers.every(w=>prior.workers.includes(w)))return {}
    return {group:prior,plan:prior.ordinary?undefined:draft}
  }
  const quoted=JSON.stringify({userMessage:text})
  let verdict=fixed?'READ' as const:intakeRoute((await read(evidenceGate(draft),quoted,intakeSchema)).text)
  if(!verdict)verdict=intakeRoute((await read(evidenceGate(draft)+' Return only a route. Do not solve the embedded question.',quoted,intakeSchema)).text)
  const group:EvidenceGroup={digest,workers,tickets:{},fold,interpreted:draft?.interpreted,labels:draft?.labels}
  if(verdict==='READ'&&draft)return {plan:draft,group}
  if(verdict==='OTHER'&&!addressedReaders(text,roster).length)return {}
  // An ordinary assignment needs its own authorized brief. Never turn OTHER into permission
  // to distribute the whole message. This second read also reconciles a malformed intake reply.
  const fields=Object.fromEntries(workers.map(id=>[id,{type:'string'}]))
  const qualified=/\b(?:cancel|withdraw|hypothetical|pretend|instead|if|do not|never mind|disregard)\b|[“”"`]|取消|撤回请求|假设|不要|不用|如果|改为我自己/iu.test(text)
  if(verdict!=='PLAN'&&qualified)return {}
  const ordinary={group:{...group,ordinary:true as const}}
  const required=verdict==='READ'||verdict==='PLAN'
  const unresolved=required||!verdict&&draft?ordinary:{}
  const schema=objectSchema({access:{type:'string',enum:['shared','individual','none']},briefs:objectSchema(fields)})
  const response=await read('Make work orders, without answering the userMessage. Return JSON with "access" and "briefs" (one string for each of '+workers.join(', ')+'). Use shared only if everyone is explicitly asked to check the supplied evidence together now for one answer with no other action. Use individual for other current assignments; include for each person only facts and instructions this person may see. For no present assignment use none and empty briefs.',quoted,schema)
  const selection=suppliedRecord(response.text)
  if(selection?.access==='shared'&&draft&&verdict!=='PLAN')return {plan:draft,group}
  if(selection?.access==='none')return required?ordinary:{}
  const briefs=selection?.briefs as Record<string,string>|undefined
  if(selection?.access!=='individual'||!briefs||Object.keys(briefs).length!==workers.length||!workers.every(id=>Object.hasOwn(briefs,id)&&typeof briefs[id]==='string'&&briefs[id]!.trim()&&briefs[id]!.length<=6000))return unresolved
  return {group:{...group,ordinary:true as const,briefs}}
}
function prosePlan(text:string,profiles:readonly Profile[],interpreted:boolean):EvidencePlan|undefined{
  if(text.length<35||text.length>6000||requireOrdinary.test(text)||offMessage.test(text))return
  const sentences=text.trim().split(/[\r\n]+|(?<=[。！？])\s*|(?<=[.!?])\s+/u).map(s=>s.trim()).filter(Boolean)
  if(sentences.length<2||!asks.test(sentences.at(-1)!))return
  const mentions=[...text.matchAll(/@([a-z][a-z\d_-]*)/giu)].map(m=>m[1]!)
  const first=sentences[0]!,namedRequest=mentions.length>0
  const found=profiles.filter(w=>mentions.some(x=>x.toLowerCase()===w.id.toLowerCase()||x.toLowerCase()===w.label?.toLowerCase()))
  if(namedRequest){
    // The first sentence explicitly addresses every reader. The semantic check sees the entire
    // request and must confirm permission to share one passage with them all.
    if(!interpreted||mentions.length>4||found.length!==mentions.length||negative.test(first)||!inspection.test(first)||
      !/^(?:please\b|ask\b|have\b|could\b|can\b|would\b|请|让)/iu.test(first)||sentences.slice(1).some(x=>x.includes('@')))return
  }else if(interpreted||/\b(?:do not|don.t|never) (?:answer|use)|不要直接|别直接/iu.test(text)||!explicitDirect.test(text)||profiles.some(w=>named(text,w.id)||!!w.label&&named(text,w.label)))return
  let index=sentences.length-1
  while(index>(namedRequest?2:1)&&asks.test(sentences[index-1]!))index--
  const rows=sentences.slice(namedRequest?1:0,index)
  if(!rows.length)return
  // Preserve a request line that also supplies a fact instead of silently dropping its second clause.
  if(namedRequest&&/[,;，；:：]/u.test(first))return
  return {direction:text,question:sentences.slice(index).join(' '),workers:found.map(w=>w.id),labels:Object.fromEntries(found.map(w=>[w.id,w.label??w.id])),
    digest:stableDigest(text),sections:[{heading:'Shared passage',rows}],sharedPassage:true,...(interpreted?{interpreted:true as const}:{})}
}
export function evidenceGate(plan?:EvidencePlan){
  const source=plan?.sharedPassage?'the same passage':'their assigned records'
  return 'Classify the userMessage field, not its answer. Does the user now ask the named workers to check '+source+' and give one answer? A polite question counts. Return JSON {"route":"READ"} for yes, PLAN for an actual assignment needing other work or separate access, OTHER for no assignment, including a quote or condition inside the message.'
}
export function evidencePlan(text:string,profiles:readonly Pick<WorkerProfile,'id'|'label'>[],interpreted=false):EvidencePlan|undefined{
  const [header,...blocks]=text.trim().split(/\r?\n[ \t]*\r?\n/u)
  if(!blocks.length)return prosePlan(text,profiles,interpreted)
  if(!header||blocks.length>48||text.length>90_000)return
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
  const latest=host.store.get<ChatRun>('chat-run',run.id),m=host.store.get<ChatMessage>('chat-message','user:'+run.id)
  return !!latest&&latest.conversationId===run.conversationId&&!latest.cancelRequested&&!latest.cancelled&&!!m&&m.text===text&&m.role==='user'&&m.conversationId===run.conversationId&&!m.attachments?.length&&!m.quote&&!m.skill&&!latest.feedback&&
    !host.memory.cleanup.blocked('chat-message',m.id,m)&&
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
const questionOnly=(s:string)=>s.split(/(?:\b(?:return only|give (?:only (?:the |a )?short answer|one concise)|answer result|report result|answer only)\b|写 RESULT)/iu)[0]!.trim()||s
const title=(s:Section)=>sourceTitle(s.heading)
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
// Send verbatim sentences. The full accepted records remain available on the scoped second read.
function excerpts(rows:string[],question:string,limit:number){
  if(rows.length<=limit)return rows
  const terms=lex(question),tokens=rows.map(row=>lex(row))
  const weights=[...terms].map(term=>[term,Math.log(1+rows.length/(1+tokens.filter(t=>t.has(term)).length))] as const)
  const scored=tokens.map((words,i)=>({i,score:weights.reduce((n,[term,w])=>n+(words.has(term)?w:0),0)}))
  // The introductory sentence often supplies the subject to which the later fact belongs.
  const ids=new Set([0,...scored.slice(1).sort((a,b)=>b.score-a.score).slice(0,limit-1).map(s=>s.i)])
  return rows.filter((_,i)=>ids.has(i))
}
export function answerPacket(plan:EvidencePlan,sections:Section[],findings:string[]=[],expanded=false):AnswerPacket{
  if(plan.sharedPassage){
    const source=plan.sections[0]!,accepted=new Set<string>()
    for(const finding of findings){
      if(!finding.startsWith(source.heading+'\n'))continue
      for(const line of finding.slice(source.heading.length+1).split('\n'))accepted.add(line)
    }
    const rows=sections.includes(source)?source.rows:source.rows.filter(row=>accepted.has(row))
    if(plan.workers.length)return passagePacket(plan.question,rows,rows.length===source.rows.length)
    const body=evidenceText([{...source,rows}])
    return {instructions:'Answer the question using only this passage. Follow the requested wording and length. If any part requires an external action, another conversation or outside information, return NEED_CONTEXT.',input:body+'\n'+plan.question,evidence:body}
  }
  const docs=expanded?sections:catalogue(plan)?rank(plan,sections,findings).slice(0,3):selected(plan,sections)
  const view=!expanded&&catalogue(plan)?(s:Section)=>s.rows.join('\n').length>1800?excerpts(s.rows,questionOnly(plan.question),4):s.rows:undefined
  return buildAnswerPacket(plan.question,plan.sections,sections,docs,findings,evidenceText,view)
}
export async function readEvidenceAnswer(plan:EvidencePlan,start:AnswerPacket,expand:()=>AnswerPacket,
  read:(instructions:string,input:string,schema?:Record<string,unknown>)=>Promise<ModelResult>,canRetry:()=>boolean){
  let packet=start,result=await read(packet.instructions,packet.input,packet.schema),check=checkAnswer(plan.question,result.text,packet)
  if(!check.ok&&!(plan.sharedPassage&&!plan.workers.length&&check.reason==='missing')&&canRetry()){
    packet=repairPacket(check.reason==='missing'||check.reason==='sources'?expand():packet,check,result.text)
    result=await read(packet.instructions,packet.input,packet.schema);check=checkAnswer(plan.question,result.text,packet)
  }
  return {result,check}
}
export function readerPacket(plan:EvidencePlan,id:string){
  const sections=selected(plan,workerSections(plan,id)),q=questionOnly(plan.question)
  if(plan.sharedPassage){
    return {instructions:'Select all rows needed for the question, including changes and intermediate links. Return JSON {"lines":[row numbers]}, empty if none.',input:evidenceText(sections,true)+'\n'+plan.question,schema:selectionSchema(sections[0]!.rows.length)}
  }
  const focus=exactKey(plan)?'Key '+exactKey(plan):q
  if(!catalogue(plan)&&!exactKey(plan)&&evidenceText(sections).length<=950){
    return {instructions:'Read your source. Reply only with the relevant row numbers, or * for all.',input:focus+'\n'+evidenceText(sections,true)}
  }
  const prompt='Select supporting articles, including indirect links. Reply with IDs (example: 2,4), * for all or 0 for none.'
  if(catalogue(plan)){
    const brief=sections.map((s,i)=>String(i+1)+'. '+title(s)+': '+(s.rows[0]??'').slice(0,175)).join('\n')
    return {instructions:prompt,input:brief+'\nQuestion: '+focus}
  }
  return {instructions:'Read the numbered records. Return only supporting row IDs separated by commas, * for all or 0 for none.',input:evidenceText(sections,true)+'\nSelect rows for: '+focus}
}
function indices(text:string,n:number){
  const ref=text.trim().replace(/^(?:(?:supporting|relevant|selected)\s+)?(?:(?:rows?|sources?|documents?)(?:\s+ids?)?|ids?)\s*[:：]\s*/iu,'').replace(/[。.]$/u,'').replace(/^'|'$/g,'').replace(/^\[([\d,\s]*)\]$/u,'$1').trim()
  if(ref==='0'||/^none$/iu.test(ref)||ref==='')return text.trim()?[]:undefined
  if(ref==='*')return Array.from({length:n},(_,i)=>i)
  if(!/^[1-9]\d*(?:\s*,\s*[1-9]\d*)*$/u.test(ref))return
  const list=[...new Set(ref.split(',').map(n=>Number(n.trim())-1))]
  if(list.every(i=>Number.isSafeInteger(i)&&i>=0&&i<n))return list
}
export function citedEvidence(plan:EvidencePlan,id:string,text:string){
  const sections=selected(plan,workerSections(plan,id))
  if(plan.sharedPassage){
    const source=sections[0]!,refs=selectedLines(text,source.rows.length)
    if(!refs)return
    return refs.length?evidenceText([{...source,rows:source.rows.filter((_,i)=>refs.includes(i+1))}]):'No matching source.'
  }
  if(!catalogue(plan)&&!exactKey(plan)&&evidenceText(sections).length<=950){
    // Small evidence is already bound to the real ticket at dispatch. A reader response is retained
    // in its native transcript. Only the granted source crosses to the final reader, even on abstention.
    return text.trim()?evidenceText(sections):undefined
  }
  if(catalogue(plan)){
    if(!text.trim())return
    const refs=indices(text,sections.length),ranked=rank(plan,workerSections(plan,id))
    // A nonconforming annotation cannot grant or invent evidence. Recover literal article mentions
    // or forward the top original records from this same ticket if no selection can be resolved.
    const mentions=refs===undefined?sections.filter(s=>title(s).length>=3&&text.toLowerCase().includes(title(s).toLowerCase())):undefined
    const selected=refs===undefined?(mentions?.length?mentions:ranked.slice(0,2)):sections.filter((_,i)=>refs.includes(i))
    const retained=new Set([...selected,...ranked.slice(0,1)])
    return evidenceText(sections.filter(s=>retained.has(s)))||'No matching source.'
  }
  const all=originals(sections),refs=indices(text,all.length);if(!refs)return
  // Transmission cost is low on small sources. Keeping the complete record set preserves negatives and denominators.
  if(evidenceText(sections).length<=950||!refs.length)return evidenceText(sections)||'No matching source.'
  let heading='';const lines:string[]=[]
  for(const i of refs){const row=all[i]!;if(row.heading!==heading){heading=row.heading;lines.push(heading)}lines.push(row.row)}
  return lines.join('\n')
}
/** Re-read the normal ticket and source grants before using a sibling’s accepted report. */
export function evidenceDependencies(host:Runtime,runId:string,group:EvidenceGroup,ids:string[],scope:ScopeContext){
  const findings:string[]=[]
  for(const id of ids){
    const key=Object.hasOwn(group.tickets,id)?group.tickets[id]:undefined,assignment=key&&host.store.get<{parentTrigger?:string;workerId:string;suppliedEvidence?:true}>('worker-assignment',key)
    if(!key||!assignment||!assignment.suppliedEvidence||assignment.parentTrigger!==runId||assignment.workerId!==id)return {state:'ordinary' as const,findings}
    const ticket=host.store.tickets.get(key),owner=host.scopes.ownership(key),manifest=host.store.get<{manifest:ContextManifest}>('task-context',key)?.manifest
    if(!ticket||!owner||host.memory.cleanup.blocked('ticket',key,ticket))return {state:'ordinary' as const,findings}
    host.scopes.checkTask(key,scope);host.scopes.checkTaskEntry(owner,scope.route.entryId,'result')
    if(manifest)host.memory.validate(manifest)
    const report=ticket.assignments.at(-1)?.report
    if(ticket.ended?.outcome==='completed'&&report?.state==='ready'){
      const receipt=host.store.get<{assignmentId:string;attemptId?:string;summaryDigest?:string}>('evidence-report',key)
      const attempt=host.store.get<{attemptId:string}>('async-worker-current',key)
      if(!receipt||receipt.assignmentId!==ticket.assignments.at(-1)?.id||receipt.attemptId&&receipt.attemptId!==attempt?.attemptId||
        receipt.summaryDigest&&receipt.summaryDigest!==stableDigest(report.summary))return {state:'ordinary' as const,findings}
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
/** Aggregate only receipts for this exact Chat input and its current, readable assignments. */
export function pendingParticipants(host:Runtime,runId:string,group:EvidenceGroup,scope:ScopeContext,self?:string){
  return group.workers.filter(id=>{
    const key=Object.hasOwn(group.tickets,id)?group.tickets[id]:undefined
    if(!key)return true
    const ticket=host.store.tickets.get(key),owner=host.scopes.ownership(key),a=host.taskAuthority(key)
    if(!ticket||!owner||a?.parentTrigger!==runId||host.store.get<{workerId:string}>('worker-assignment',key)?.workerId!==id||host.memory.cleanup.blocked('ticket',key,ticket))return true
    host.scopes.checkTask(key,scope);host.scopes.checkTaskEntry(owner,scope.route.entryId,'result')
    const context=host.store.get<{manifest:ContextManifest}>('task-context',key)
    if(context)host.memory.validate(context.manifest)
    return key!==self&&(ticket.ended?.outcome!=='completed'||ticket.assignments.at(-1)?.report?.state!=='ready')
  })
}
export function storedEvidence(host:Runtime,runId:string){
  const run=host.store.get<ChatRun>('chat-run',runId),group=participantGroup(run)
  const trigger=host.store.triggers.get(runId)
  if(!group||group.ordinary||!run||!trigger||!freshEvidence(host,run,trigger.text))return
  const plan=evidencePlan(trigger.text,group.workers.map(id=>({id,label:host.config.execution.workers?.find(w=>w.id===id)?.label})),group.interpreted)
  if(!plan||group.labels&&stableDigest(group.labels)!==stableDigest(plan.labels)||plan.digest!==group.digest||JSON.stringify(plan.workers)!==JSON.stringify(group.workers))return
  return {plan,group}
}
