import {useEffect,useState} from 'react'
import {ArrowUpRight} from 'lucide-react'
import type {ChatSessions} from '../../src/chat.ts'
import {AgentCrew} from '../ui/agent-team.tsx'
import {RoppoCharacter} from './companion.tsx'
import {companionStatus} from './companion-state.ts'
import {teamName} from './agent-avatar.tsx'

type View=ReturnType<ChatSessions['view']>
type Readings=ReturnType<ChatSessions['teamContext']>
type L=(en:string,zh:string)=>string
export type LoadTeamContext=(id:string,signal:AbortSignal)=>Promise<Readings>
const currentTask=(state:string)=>state==='running'||state==='queued'||state==='waiting'

export function TeamContext({snapshot,participants,readiness,select,load,L,lang,connected}:{snapshot:View|null;participants:View['participants'];readiness?:View['readiness']|null;select:(id:string)=>void;load:LoadTeamContext;L:L;lang:string;connected:boolean}){
  const id=snapshot?.conversation.id
  const [selected,setSelected]=useState(snapshot?.routerId??participants[0]?.id??'router')
  const [tasks,setTasks]=useState<Record<string,string>>({})
  const [sessions,setSessions]=useState<Record<string,string>>({})
  const [readings,setReadings]=useState<Readings>([])
  const [retry,setRetry]=useState(0),[failed,setFailed]=useState(false)
  const changing=snapshot?.calls.filter(c=>c.kind==='worker'||c.kind==='router').map(c=>[c.id,c.state,c.usageRevision??0].join(':')).join(',')
  const active=!!snapshot?.reply||snapshot?.tasks.some(t=>['queued','running'].includes(t.state))
  useEffect(()=>{
    if(!id)return
    const conversationId=id
    const controller=new AbortController()
    let timer:ReturnType<typeof setTimeout>|undefined
    async function update(){
      try{
        const next=await load(conversationId,controller.signal)
        if(!controller.signal.aborted){setReadings(next);setFailed(false)}
      }catch{if(!controller.signal.aborted)setFailed(true)}
      if(active&&!controller.signal.aborted)timer=setTimeout(update,15000)
    }
    void update()
    return ()=>{controller.abort();clearTimeout(timer)}
  },[id,load,active,changing,retry,connected])
  const people=participants.map(p=>{
    const isWorker=p.kind==='worker'
    const owned=readings.filter(r=>isWorker?r.workerId===p.id:r.role==='router')
    const tickets:Pick<View['tasks'][number],'id'|'title'|'state'|'updatedAt'>[]=snapshot?.tasks.filter(t=>isWorker&&t.workerId===p.id)??[]
    const known=new Set(tickets.map(t=>t.id))
    for(const r of owned){
      if(!isWorker||!r.ticketId||known.has(r.ticketId))continue
      known.add(r.ticketId)
      tickets.push({id:r.ticketId,title:L('Task ','任务 ')+r.ticketId.slice(0,8),state:'archived',updatedAt:r.startedAt})
    }
    tickets.sort((a,b)=>Number(currentTask(b.state))-Number(currentTask(a.state))||b.updatedAt-a.updatedAt)
    const ticket=tickets.find(t=>t.id===tasks[p.id])??tickets[0]
    const list=owned.filter(r=>!isWorker||r.ticketId===ticket?.id)
    const sessionKey=JSON.stringify([p.id,ticket?.id])
    const reading=list.find(r=>(r.session??r.activity)===sessions[sessionKey])??list[0]
    const status=companionStatus(snapshot,L,{connected,participantId:isWorker?p.id:undefined})
    const usageFallback=reading?.inputTokens!=null?L('Capacity unreported','容量未上报'):
      (reading?.state==='running'||!reading&&ticket&&['queued','running'].includes(ticket.state))?L('Awaiting usage','等待读数'):L('No reading','暂无读数')
    const worker=(snapshot?.workers??readiness?.workers??[]).find(w=>w.id===p.id)
    return {id:p.id,kind:p.kind,name:isWorker?p.label:teamName(p.label),model:reading?(reading.model??L('Model unreported','型号未上报')):((isWorker?worker?.model:readiness?.model)??'—'),
      task:ticket?.title||status.label,working:['thinking','working','reviewing'].includes(status.phase),statusLabel:status.label,
      tokens:reading?.inputTokens??null,capacity:reading?.capacity??null,tools:[],usageFallback,
      portrait:<span className="crew-pet"><RoppoCharacter phase={status.phase} workerId={isWorker?p.id:undefined}/></span>,
      reading,tickets,ticket,list,sessionKey}
  })
  const lead=people.find(p=>p.kind==='router')
  if(!lead)return null
  const member=people.find(p=>p.id===selected)??lead
  const {reading,ticket,list}=member
  const percent=member.tokens!==null&&member.capacity?Math.round(100*member.tokens/member.capacity):null
  return <section className="roppo-ui live-crew">
    <header><h3>{L('Agent team','Agents 团队')}</h3><span>{people.length} {L('members','位成员')}</span></header>
    <AgentCrew lead={lead} workers={people.filter(p=>p.kind==='worker')} selected={member.id} onSelect={setSelected}/>
    <section className="crew-window">
      <header><h3>{L('Context window','上下文窗口')}</h3><span>{member.name}</span></header>
      {failed&&<button onClick={()=>setRetry(n=>n+1)}>{L('Refresh failed · Retry','刷新失败 · 重试')}</button>}
      <div className="crew-percent">{percent??'—'}<small>{percent!==null?'%':member.usageFallback}</small></div>
      {percent!==null&&<meter aria-label={L('Context used','上下文占用')} min={0} max={100} value={Math.min(100,percent)}/>}
      {member.tokens!==null&&<p>{member.tokens.toLocaleString(lang)}{member.capacity?' / '+member.capacity.toLocaleString(lang):''} tokens</p>}
      <dl>{ticket&&<div><dt>{L('Task','任务')}</dt><dd>{member.tickets.length===1?ticket.title:
        <select aria-label={L('Context task','上下文任务')} value={ticket.id} onChange={e=>setTasks({...tasks,[member.id]:e.target.value})}>
          {member.tickets.map(t=><option key={t.id} value={t.id}>{t.title||t.id}</option>)}</select>}</dd></div>}
        {list.length>1&&<div><dt>{L('Session','模型会话')}</dt><dd><select aria-label={L('Model session','模型会话')} value={reading?.session??reading?.activity} onChange={e=>setSessions({...sessions,[member.sessionKey]:e.target.value})}>
          {list.map(r=><option value={r.session??r.activity} key={r.activity}>{r.model??r.backend??'—'}{r.session?'':' · '+L('Call','调用记录')} · {new Date(r.startedAt).toLocaleString(lang)}</option>)}</select></dd></div>}
        <div><dt>{L('Model','模型')}</dt><dd>{member.model}</dd></div>
        <div><dt>{L('Last report','最近回报')}</dt><dd>{reading?.reportedAt?new Date(reading.reportedAt).toLocaleString(lang):reading?.inputTokens!=null?L('Time unavailable','时间未记录'):L('Not reported','尚未回报')}</dd></div>
      </dl>
      <button className="crew-open" disabled={!id} onClick={()=>select(member.id)}>{L('Open conversation','查看对话')} <ArrowUpRight size={14}/></button>
    </section>
  </section>
}
