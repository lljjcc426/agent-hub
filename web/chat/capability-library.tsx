import {lazy,Suspense,useEffect,useMemo,useRef,useState} from 'react'
import {ArrowLeft,BookOpen,Boxes,Cable,Check,ChevronRight,Link2,LoaderCircle,Package,Plug,RefreshCw,Search,Wrench,X} from 'lucide-react'
import {capabilityKinds,type Capability,type CapabilityKind,type CapabilitySnapshot,type CapabilityStatus} from '../../src/capability-types.ts'
import {AppBrand} from './app-brand.tsx'
import './capability-library.css'

const Markdown=lazy(()=>import('./markdown.tsx').then(m=>({default:m.FileMarkdown})))
type Language='en'|'zh-CN'
type Filter=CapabilityKind|'all'
type Detail=Capability&{body?:string}
const icons={mcp:Cable,skill:BookOpen,plugin:Package,app:Plug,tool:Wrench}
const labels={all:['All','全部'],mcp:['MCP servers','MCP 服务'],skill:['Skills','Skills'],plugin:['Plugins','插件'],app:['App connections','应用连接'],tool:['Tools','工具']} as const
const states:Record<CapabilityStatus,[string,string]>={builtin:['Built in','内置'],configured:['Configured','已配置'],cli:['CLI profile','CLI 配置'],connected:['Reported by server','服务已响应'],disabled:['Disabled','未启用'],conditional:['Task dependent','按任务启用'],unavailable:['Unavailable','暂不可用'],candidate:['Candidate','候选'],installed:['Installed','已安装'],declared:['Declared by plugin','插件声明'],cached:['Last seen','上次读取']}
const base='/configure#integrations/library'
const sectionLinks=[['market','Marketplace','市场'],['installed','Installed','已安装'],['updates','Updates','更新'],['tools','Tool connections','工具连接'],['library','Capability library','能力库']] as const
export function MarketNavigation({tab,language,updates=0}:{tab:string;language:Language;updates?:number}){
  return <nav className="market-tabs" aria-label={language==='en'?'Plugin sections':'插件页面'}>{sectionLinks.map(([id,en,zh])=><a key={id} href={'/configure#integrations/'+id} aria-current={tab===id?'page':undefined}>{language==='en'?en:zh}{id==='updates'&&updates>0?<span>{updates}</span>:null}</a>)}</nav>
}
async function get<T>(query:string,signal:AbortSignal):Promise<T>{
  const response=await fetch('/api/capability-library'+query,{signal})
  if(!response.ok)throw Error(String(response.status))
  return response.json()
}
function Icon({item,size}:{item:Capability;size:number}){
  const brand=[item.name,...(item.facts??[])].map(s=>s.toLowerCase()).find(s=>['linear','slack','github','feishu','wecom'].includes(s))
  const Symbol=icons[item.kind]
  return <span className="cap-icon">{brand?<AppBrand category="source" kind={brand} size={size}/>:<Symbol size={size} strokeWidth={1.6}/>}</span>
}
export function CapabilityLibrary({language,route}:{language:Language;route:string}){
  const i=language==='en'?0:1,L=(en:string,zh:string)=>i===0?en:zh
  const [, , segment,deepId]=route.split('/')
  const filter:Filter=capabilityKinds.includes(segment as CapabilityKind)?segment as CapabilityKind:'all'
  const id=segment==='item'?deepId:undefined
  const [query,setQuery]=useState(''),[data,setData]=useState<CapabilitySnapshot>(),[failed,setFailed]=useState(false),[refresh,setRefresh]=useState(0)
  const [detail,setDetail]=useState<Detail>(),[detailError,setDetailError]=useState(false),[inspect,setInspect]=useState(''),[copied,setCopied]=useState(false)
  const [menuFilter,setMenuFilter]=useState<Filter>(filter),[toolLimit,setToolLimit]=useState(30)
  const activeFilter=id?menuFilter:filter,search=useRef<HTMLInputElement>(null),heading=useRef<HTMLHeadingElement>(null),list=useRef<HTMLElement>(null)
  const [listReady,setListReady]=useState(0)
  useEffect(()=>{
    const ctrl=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined
    const load=async(force=false)=>{try{
      const next=await get<CapabilitySnapshot>(force?'?refresh=1':'',ctrl.signal)
      if(ctrl.signal.aborted)return
      setData(next);setFailed(false)
      if(next.refreshing)timer=setTimeout(()=>void load(),2200)
      else setListReady(v=>v+1)
    }catch{if(!ctrl.signal.aborted)setFailed(true)}}
    void load(refresh>0)
    return()=>{ctrl.abort();clearTimeout(timer)}
  },[refresh])
  useEffect(()=>{
    const shortcut=(e:KeyboardEvent)=>{if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!['INPUT','TEXTAREA','SELECT'].includes((e.target as HTMLElement)?.tagName)&&!(e.target as HTMLElement)?.isContentEditable){e.preventDefault();search.current?.focus()}}
    window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut)
  },[])
  useEffect(()=>{if(!id)setMenuFilter(filter)},[id,filter])
  const all=data?.items??[],term=query.trim().toLocaleLowerCase()
  const matches=useMemo(()=>(data?.items??[]).filter(r=>!term||[r.name,r.source,...(r.facts??[]),...(r.tools??[]).map(t=>t.name)].some(s=>s.toLocaleLowerCase().includes(term))).sort((a,b)=>Number(b.source==='Roppo')-Number(a.source==='Roppo')||a.name.localeCompare(b.name)),[data,term])
  const visible=matches.filter(r=>activeFilter==='all'||r.kind===activeFilter)
  const selected=id?all.find(r=>r.id===id):capabilityKinds.flatMap(k=>visible.find(v=>v.kind===k)??[])[0]
  const selectedId=selected?.id
  useEffect(()=>{
    setDetail(undefined);setDetailError(false);setCopied(false);setToolLimit(30)
    if(!selectedId)return
    const ctrl=new AbortController()
    void get<Detail>('?id='+encodeURIComponent(selectedId)+(inspect===selectedId?'&inspect=1':''),ctrl.signal).then(d=>{if(!ctrl.signal.aborted)setDetail(d)}).catch(()=>{if(!ctrl.signal.aborted)setDetailError(true)})
    return()=>ctrl.abort()
  },[selectedId,listReady,inspect])
  const select=(v:Capability)=>{setMenuFilter(activeFilter);setInspect('');location.hash='integrations/library/item/'+v.id;if(matchMedia('(max-width:680px)').matches)requestAnimationFrame(()=>heading.current?.focus())}
  const filterTo=(k:Filter)=>{setMenuFilter(k);setInspect('');location.hash='integrations/library'+(k==='all'?'':'/'+k)}
  const changeQuery=(v:string)=>{setQuery(v);if(id)filterTo(activeFilter)}
  const current=detail?.id===selectedId?detail:undefined
  const shown=current??selected
  const toolMatches=current?.tools?.filter(t=>!term||t.name.toLocaleLowerCase().includes(term))
  const tools=toolMatches?.length?toolMatches:current?.tools
  const copy=async()=>{if(!selectedId)return;try{await navigator.clipboard.writeText(location.origin+base+'/item/'+selectedId);setCopied(true)}catch{select(selected!)}}
  return <section className="market-page cap-page" aria-label={L('Capability library','能力库')}>
    <header className="market-heading"><h1>{L('Capability library','能力库')}</h1>
      <div className="cap-actions"><label className="market-search"><Search size={16}/><input ref={search} aria-label={L('Search capabilities or tool names','搜索能力或工具名')} placeholder={L('Search capabilities or tool names','搜索能力或工具名')} value={query} onChange={e=>changeQuery(e.target.value)}/>{query?<button aria-label={L('Clear search','清空搜索')} onClick={()=>changeQuery('')}><X size={14}/></button>:<kbd>/</kbd>}</label>
      <button aria-label={L('Refresh library','刷新能力库')} title={L('Refresh library','刷新能力库')} onClick={()=>setRefresh(v=>v+1)}><RefreshCw size={16}/></button></div></header>
    <MarketNavigation tab="library" language={language}/>
    <nav className="cap-filters" aria-label={L('Capability types','能力类型')}>{(['all',...capabilityKinds] as const).map(k=><button key={k} aria-pressed={k===activeFilter} onClick={()=>filterTo(k)}>{labels[k][i]} <span>{k==='all'?all.length:all.filter(r=>r.kind===k).length}</span></button>)}</nav>
    {failed?<div role="alert" className="cap-notice">{L('Could not load the library.','未能读取能力库。')} <button onClick={()=>setRefresh(v=>v+1)}>{L('Retry','重试')}</button></div>:null}
    {data?.warnings.length?<div className="cap-notice" role="status">{L('Some sources could not be fully read','部分来源未能完整读取')} · {data.warnings.join('、')}</div>:null}
    {data?.refreshing?<div className="cap-notice" role="status"><LoaderCircle className="spin" size={14}/>{L('Reading CLI catalogs…','正在读取 CLI 目录…')}</div>:null}
    <div className={'cap-workspace'+(id?' is-reading':'')}>
      <nav className="cap-list" ref={list} aria-label={L('Workspace capabilities','工作区能力列表')}>
        {capabilityKinds.map(k=>{const group=visible.filter(r=>r.kind===k);return group.length?<section key={k}><h3>{labels[k][i]} <span>{group.length}</span></h3>{group.map(v=><button key={v.id} aria-current={v.id===selectedId?'true':undefined} onClick={()=>select(v)}><Icon item={v} size={18}/><span><strong>{v.name}</strong><small>{v.source}</small></span><ChevronRight className="cap-arrow" size={14}/></button>)}</section>:null})}
        {!visible.length?<p className="cap-placeholder">{data?L('No matching capabilities','没有匹配的能力'):L('Loading…','正在加载…')}</p>:null}
      </nav>
      <article className="cap-detail" aria-label={L('Capability details','能力详情')} key={selectedId??id}>
        <button className="cap-back" onClick={()=>{filterTo(activeFilter);requestAnimationFrame(()=>list.current?.querySelector<HTMLButtonElement>('[aria-current]')?.focus())}}><ArrowLeft size={16}/>{L('Back to list','返回列表')}</button>
        {shown?<><div className="cap-detail-head"><Icon item={shown} size={27}/><div><p>{labels[shown.kind][i]}</p><h2 ref={heading} tabIndex={-1}>{shown.name}</h2></div><button aria-label={L('Copy link','复制条目链接')} title={copied?L('Copied','已复制'):L('Copy link','复制条目链接')} onClick={()=>void copy()}>{copied?<Check size={17}/>:<Link2 size={17}/>}</button></div>
          {shown.description?<p className="cap-intro">{shown.description}</p>:null}
          <dl className="cap-facts"><div><dt>{L('Source','来源')}</dt><dd>{shown.source}</dd></div>
            <div><dt>{L('Status','状态')}</dt><dd><span className={'cap-status state-'+shown.status}>{states[shown.status][i]}</span></dd></div>
            {shown.roles?<div><dt>{L('Roles','适用角色')}</dt><dd>{shown.roles.join(' · ')||L('No role assigned','未分配角色')}</dd></div>:null}
            {shown.version?<div><dt>{L('Version','版本')}</dt><dd>{shown.version}</dd></div>:null}
            {shown.facts?.length?<div><dt>{L('Details','条目信息')}</dt><dd>{shown.facts.join(' · ')}</dd></div>:null}</dl>
          {detailError?<p role="alert">{L('Could not read details.','暂时无法读取详情。')}</p>:null}
          {tools?.length||shown.kind==='mcp'?<section className="cap-section"><h3>{L('Tools','工具清单')} <span>{tools?.length??0}</span>{shown.inspectable?<button onClick={()=>setInspect(selectedId??'')} disabled={inspect===selectedId&&!detailError}>{L('Read server catalog','读取服务目录')}</button>:null}</h3>
            {tools?.slice(0,toolLimit).map(t=><details key={t.name}><summary><Wrench size={15}/><strong>{t.name}</strong><ChevronRight size={15}/></summary><div className="cap-tool-body">{t.description?<p>{t.description}</p>:null}{t.inputs?.length?t.inputs.map(p=><div className="cap-param" key={p.name}><code>{p.name}</code><span>{p.type}</span><span>{p.required?L('Required','必填'):L('Optional','可选')}</span></div>):<p>{t.inputs?L('No named parameters.','无命名参数。'):L('No parameter details reported.','来源未提供参数详情。')}</p>}</div></details>)}
            {!tools?.length?<p>{current?L('This source has not reported a tool list.','来源尚未提供工具清单。'):L('Reading tools…','正在读取工具…')}</p>:null}
            {tools&&tools.length>toolLimit?<button onClick={()=>setToolLimit(v=>v+50)}>{L('Show more tools','显示更多工具')}</button>:null}
          </section>:null}
          {current?.body&&current.body!==shown.description?<section className="cap-section"><h3>{L('Skill instructions','技能正文')}</h3><Suspense fallback={<p>{L('Loading…','正在加载…')}</p>}><Markdown text={current.body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'')}/></Suspense></section>:null}
          {([['steps','Steps','执行步骤'],['inputs','Inputs','所需输入'],['criteria','Acceptance criteria','交付标准']] as const).map(([key,en,zh])=>current?.[key]?.length?<section key={key} className="cap-section"><h3>{L(en,zh)}</h3><ol>{current[key]!.map((s,i)=><li key={i}>{s}</li>)}</ol></section>:null)}
        </>:<div className="cap-placeholder"><Boxes size={24}/><p>{id?(data?.refreshing?L('Looking up capability…','正在查找条目…'):L('Capability unavailable','条目不可用')):data?L('No matching capabilities','没有匹配的能力'):L('Loading…','正在加载…')}</p>{query?<button onClick={()=>changeQuery('')}>{L('Clear search','清空搜索')}</button>:null}</div>}
      </article>
    </div>
  </section>
}
