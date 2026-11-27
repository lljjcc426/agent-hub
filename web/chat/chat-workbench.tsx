import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react'
import {ChevronRight,FileCode2,FolderOpen,GitCompareArrows,Globe,Maximize2,Minimize2,PanelRightClose,Plus,Search,TerminalSquare,X} from 'lucide-react'
import {BrowserPanel,type BrowserOpenRequest} from './browser.tsx'
import {browserUrl} from './browser-url.ts'
import {DetailedFile,FilePath} from './worker-file-diff.tsx'
import type {DiffTarget,WorkerReports} from './worker-report-groups.ts'
import {FileManager,WorkTerminal,type WorkFile} from './workbench-files.tsx'
import type {Localize} from './composer-commands.tsx'
import './chat-workbench.css'

const icons={home:Plus,files:FolderOpen,terminal:TerminalSquare,diff:GitCompareArrows,browser:Globe}
type Tab=keyof typeof icons
const tools:Tab[]=['files','terminal','diff','browser']
export type BenchRequest={serial:number;kind:'resume'|'diff'|'browser';target?:DiffTarget;browser?:BrowserOpenRequest}
const titles=(L:Localize)=>({home:L('New tab','新标签页'),files:L('Files','文件管理器'),terminal:L('Terminal','终端'),diff:L('Changes','文件改动'),browser:L('Browser','内置浏览器')})

export function ChatWorkbench({request,conversation,reports,overlay,expanded,setExpanded,close,createConversation,L}:{
  request:BenchRequest|null;conversation?:string;reports:WorkerReports;overlay:boolean;expanded:boolean
  setExpanded:(value:boolean)=>void;close:()=>void;createConversation:()=>Promise<void>;L:Localize
}){
  const [tabs,setTabs]=useState<Tab[]>(['home']),[active,setActive]=useState<Tab>('home'),[query,setQuery]=useState('')
  const [path,setPath]=useState<string>(),[focus,setFocus]=useState<{target:DiffTarget;serial:number}>()
  const [browserRequest,setBrowserRequest]=useState<BrowserOpenRequest>()
  const [files,setFiles]=useState<WorkFile[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(false),[reload,setReload]=useState(0)
  const panel=useRef<HTMLElement>(null),search=useRef<HTMLInputElement>(null),serial=useRef(0),tabPrefix=useId()
  const names=titles(L),open=!!request,revision=reports.flatMap(r=>r.files.map(f=>f.versions.at(-1)?.id??f.path)).join(',')
  function activate(tab:Tab,replaceHome=false){
    setTabs(previous=>{
      if(tab==='home')return previous.includes('home')?previous:[...previous,'home']
      const list=replaceHome?previous.filter(t=>t!=='home'):previous
      return list.includes(tab)?list:[...list,tab]
    })
    setActive(tab)
    if(tab==='home')setQuery('')
    requestAnimationFrame(()=>panel.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus({preventScroll:true}))
  }
  function openFile(next:string){setPath(next);activate('files',active==='home')}
  function browse(url?:string,existing?:BrowserOpenRequest){
    if(!conversation){void createConversation();return}
    if(existing?.id)setBrowserRequest(existing)
    else if(url||!tabs.includes('browser'))setBrowserRequest({url:url??(import.meta.env.VITE_WORKBENCH_PREVIEW==='1'?location.origin+'/workbench-example':undefined)})
    activate('browser',active==='home')
  }
  function launch(tab:Tab){if(tab==='browser')browse();else activate(tab,active==='home')}
  function inspect(target:DiffTarget){
    setFocus({target,serial:++serial.current});activate('diff',active==='home')
  }
  function closeTab(tab:Tab){
    const index=tabs.indexOf(tab),next=tabs.filter(t=>t!==tab)
    if(tab==='browser')setBrowserRequest(undefined)
    if(!next.length){setTabs(['home']);setActive('home');setQuery('');return}
    setTabs(next)
    if(active===tab)setActive(next[Math.min(index,next.length-1)]!)
    requestAnimationFrame(()=>panel.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus())
  }
  useLayoutEffect(()=>{
    if(!request)return
    if(request.kind==='diff'&&request.target)inspect(request.target)
    else if(request.kind==='browser')browse(undefined,request.browser)
    else requestAnimationFrame(()=>panel.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus({preventScroll:true}))
  },[request?.serial])
  useEffect(()=>{
    if(!open||!conversation)return
    const ctrl=new AbortController()
    setLoading(true);setError(false)
    fetch('/api/chat/conversations/'+encodeURIComponent(conversation)+'/workbench/files',{signal:ctrl.signal}).then(async res=>{
      if(!res.ok)throw Error()
      const result=await res.json() as {files:WorkFile[]}
      if(!ctrl.signal.aborted)setFiles(result.files)
    }).catch(()=>{if(!ctrl.signal.aborted)setError(true)}).finally(()=>{if(!ctrl.signal.aborted)setLoading(false)})
    return ()=>ctrl.abort()
  },[open,conversation,revision,reload])
  const results=files.filter(f=>f.path.toLowerCase().includes(query.trim().toLowerCase()))
  const exactFile=results.find(f=>[f.path,f.path.split('/').at(-1)].some(name=>name?.toLowerCase()===query.trim().toLowerCase()))
  const url=exactFile?null:browserUrl(query)
  const stateNote=error?<p className="bench-hint" role="alert">{L('Could not read the workspace.','未能读取工作区。')} <button onClick={()=>setReload(n=>n+1)}>{L('Retry','重试')}</button></p>:
    loading&&!files.length?<p className="bench-hint" role="status">{L('Loading files…','读取文件中…')}</p>:null
  const setQueryResult=()=>{if(exactFile)openFile(exactFile.path);else if(url)browse(url);else if(results[0])openFile(results[0].path)}
  return <aside ref={panel} id="chat-workbench" className="chat-workbench" data-open={open} data-expanded={expanded}
    role={overlay&&open?'dialog':undefined} aria-modal={overlay&&open?true:undefined} aria-label={L('Workspace panel','工作区面板')} inert={!open} aria-hidden={!open}
    onKeyDown={e=>{
      if(e.key==='Escape'&&!e.defaultPrevented&&!document.querySelector('dialog[open]')){e.preventDefault();e.stopPropagation();close()}
      else if(e.key==='Tab'&&overlay){
        const items=Array.from(panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')).filter(el=>el.tabIndex>=0&&el.getClientRects().length)
        const from=e.shiftKey?items[0]:items.at(-1),to=e.shiftKey?items.at(-1):items[0]
        if(from&&to&&document.activeElement===from){e.preventDefault();to.focus()}
      }
    }}>
    <div className="bench-inner">
      <header className="bench-header">
        <div className="bench-tabs" role="tablist" aria-label={L('Workspace tabs','工作区标签页')} onKeyDown={e=>{
          if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return
          e.preventDefault()
          const index=e.key==='Home'?0:e.key==='End'?tabs.length-1:(tabs.indexOf(active)+(e.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length
          activate(tabs[index]!)
        }}>{tabs.map(tab=>{const Icon=icons[tab];return <div className="bench-tab" data-active={active===tab||undefined} key={tab}>
          <button role="tab" type="button" id={tabPrefix+tab} aria-controls={tabPrefix+'pane-'+tab} aria-selected={active===tab} tabIndex={active===tab?0:-1} onClick={()=>activate(tab)} title={names[tab]}><Icon size={15}/><span>{names[tab]}</span></button>
          {active===tab&&tab!=='home'&&<button className="bench-close-tab" aria-label={L('Close tab','关闭标签页')+' · '+names[tab]} onClick={()=>closeTab(tab)}><X size={12}/></button>}
        </div>})}</div>
        <button className="bench-icon" title={names.home} aria-label={names.home} onClick={()=>{activate('home');requestAnimationFrame(()=>search.current?.focus())}}><Plus size={17}/></button>
        <div className="bench-window-tools">{!overlay&&<button className="bench-icon" aria-label={expanded?L('Restore width','还原宽度'):L('Expand workspace','展开工作区')} title={expanded?L('Restore width','还原宽度'):L('Expand workspace','展开工作区')} onClick={()=>setExpanded(!expanded)}>{expanded?<Minimize2 size={15}/>:<Maximize2 size={15}/>}</button>}
          <button className="bench-icon" title={L('Close workspace','关闭工作区')} aria-label={L('Close workspace','关闭工作区')} onClick={close}><PanelRightClose size={17}/></button></div>
      </header>
      {tabs.map(tab=><div key={tab} id={tabPrefix+'pane-'+tab} className="bench-pane" role="tabpanel" aria-labelledby={tabPrefix+tab} hidden={tab!==active}>
        {tab==='home'&&<div className="bench-start"><div className="bench-start-content">
          <form className="bench-search" onSubmit={e=>{e.preventDefault();if(query.trim())setQueryResult()}}><Search size={18}/><input ref={search} value={query} onChange={e=>setQuery(e.target.value)} placeholder={L('Search files or enter a URL','搜索文件或输入网址')} aria-label={L('Search files or enter a URL','搜索文件或输入网址')}/></form>
          {query.trim()?<div className="bench-results">{url&&<button onClick={()=>browse(url)}><Globe size={16}/><span>{url}</span><ChevronRight size={14}/></button>}
            {results.map(f=><button key={f.path} onClick={()=>openFile(f.path)}><FileCode2 size={15}/><FilePath path={f.path}/><ChevronRight size={14}/></button>)}
            {!url&&!results.length&&<p className="bench-hint">{L('No matching files','没有匹配的文件')}</p>}</div>:<>
            <div className="bench-launchers">{tools.map(t=>{const Icon=icons[t];return <button key={t} onClick={()=>launch(t)}><Icon size={20}/><span>{names[t]}</span></button>})}</div>
            {!!reports.length&&<section className="bench-recent"><h3>{L('Recently changed','最近改动')}</h3>{reports.slice(-1)[0]!.files.slice(-3).map(f=><button key={f.path} onClick={()=>inspect({group:reports.at(-1)!.messageId,path:f.path})}><FileCode2 size={15}/><FilePath path={f.path}/><ChevronRight size={14}/></button>)}</section>}
          </>}
        </div></div>}
        {tab==='files'&&(stateNote??<FileManager files={files} path={path} select={setPath} reload={()=>setReload(n=>n+1)} L={L}/>)}
        {tab==='terminal'&&(stateNote??<WorkTerminal files={files} L={L}/>)}
        {tab==='diff'&&<div className="bench-diffs">{reports.map((group,index)=><section className="bench-diff-group" key={group.messageId}>
          <div className="bench-diff-summary"><span><GitCompareArrows size={15}/>{group.label}</span><small>{L(group.files.length+' files',group.files.length+' 个文件')}</small></div>
          {group.files.map((change,i)=><DetailedFile key={change.path} change={change} conversationId={group.conversationId}
            initial={focus?focus.target.group===group.messageId&&focus.target.path===change.path:index===0&&i===0}
            focus={focus?.target.group===group.messageId&&focus.target.path===change.path?focus.serial:undefined} openFile={openFile} L={L}/>)}
        </section>)}{!reports.length&&<div className="bench-reader-idle"><GitCompareArrows size={25}/><span>{L('No file changes yet','暂时没有文件改动')}</span></div>}</div>}
        {tab==='browser'&&active==='browser'&&open&&<BrowserPanel embedded L={L} conversationId={conversation} requestedSession={browserRequest} onRequestHandled={()=>setBrowserRequest(undefined)}/>}
      </div>)}
    </div>
  </aside>
}
