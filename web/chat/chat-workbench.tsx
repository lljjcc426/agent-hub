import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from 'react'
import {ChevronRight,FileCode2,FolderOpen,GitCompareArrows,Globe,Maximize2,Minimize2,PanelRightClose,Plus,Search,TerminalSquare,X} from 'lucide-react'
import {BrowserPanel,type BrowserOpenRequest,type BrowserPageControls,type BrowserPageStrip} from './browser.tsx'
import {browserUrl} from './browser-url.ts'
import {DetailedFile,FilePath} from './worker-file-diff.tsx'
import type {DiffTarget,WorkerReports} from './worker-report-groups.ts'
import {FileManager,WorkTerminal,type WorkFile} from './workbench-files.tsx'
import type {Localize} from './composer-commands.tsx'
import './chat-workbench.css'

const icons={home:Plus,files:FolderOpen,terminal:TerminalSquare,diff:GitCompareArrows,browser:Globe}
type Tab=keyof typeof icons
type WebEntry='browser'|`web:${string}`
type Entry=Tab|WebEntry
const isWeb=(key:Entry):key is WebEntry=>key==='browser'||key.startsWith('web:')
const paneFor=(key:Entry):Tab=>isWeb(key)?'browser':key
const webKey=(session:string,page:string):Entry=>`web:${session}/${page}`
const tools:Tab[]=['files','terminal','diff','browser']
export type BenchRequest={serial:number;kind:'resume'|'diff'|'browser';target?:DiffTarget;browser?:BrowserOpenRequest}
const titles=(L:Localize)=>({home:L('New tab','新标签页'),files:L('Files','文件管理器'),terminal:L('Terminal','终端'),diff:L('Changes','文件改动'),browser:L('Browser','内置浏览器')})

export function ChatWorkbench({request,conversation,reports,overlay,expanded,setExpanded,close,createConversation,L}:{
  request:BenchRequest|null;conversation?:string;reports:WorkerReports;overlay:boolean;expanded:boolean
  setExpanded:(value:boolean)=>void;close:()=>void;createConversation:()=>Promise<void>;L:Localize
}){
  const [tabs,setTabs]=useState<Entry[]>(['home']),[active,setActive]=useState<Tab>('home'),[query,setQuery]=useState('')
  const [path,setPath]=useState<string>(),[focus,setFocus]=useState<{target:DiffTarget;serial:number}>()
  const [browserRequest,setBrowserRequest]=useState<BrowserOpenRequest>()
  const [browser,setBrowser]=useState<BrowserPageStrip>()
  const browserControls=useRef<BrowserPageControls>(null)
  const [files,setFiles]=useState<WorkFile[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(false),[reload,setReload]=useState(0)
  const panel=useRef<HTMLElement>(null),search=useRef<HTMLInputElement>(null),serial=useRef(0),tabPrefix=useId()
  const names=titles(L),open=!!request,revision=reports.flatMap(r=>r.files.map(f=>f.versions.at(-1)?.id??f.path)).join(',')
  const hasBrowser=tabs.some(isWeb)
  const pages=new Map(browser?.pages.map(page=>[webKey(browser.id,page.id),page]))
  const currentPage=browser?.pages.find(page=>page.active)??browser?.pages[0]
  const selectedKey=active==='browser'&&browser&&currentPage?webKey(browser.id,currentPage.id):active
  const syncPages=useCallback((strip:BrowserPageStrip)=>{
    setBrowser(strip)
    setTabs(previous=>{
      if(!previous.some(isWeb))return previous
      const keys=strip.pages.map(p=>webKey(strip.id,p.id))
      const keep=new Set<Entry>(keys)
      const fresh=keys.filter(key=>!previous.includes(key))
      const first=previous.findIndex(isWeb)
      const retained=previous.filter(tab=>!isWeb(tab)||keep.has(tab))
      if(retained.some(isWeb))retained.push(...fresh)
      else if(fresh.length)retained.splice(first,0,...fresh)
      else retained.splice(first,0,'browser')
      return retained.length===previous.length&&retained.every((tab,i)=>tab===previous[i])?previous:retained
    })
  },[])
  useLayoutEffect(()=>{
    if(!open)return
    const strip=panel.current?.querySelector<HTMLElement>('.bench-tabs')
    const selected=strip?.querySelector<HTMLElement>('[aria-selected=true]')
    if(!strip||!selected)return
    const item=selected.parentElement!.getBoundingClientRect(),bounds=strip.getBoundingClientRect()
    if(item.right>bounds.right)strip.scrollLeft+=item.right-bounds.right
    else if(item.left<bounds.left)strip.scrollLeft+=item.left-bounds.left
  },[selectedKey,open])
  function activate(tab:Tab,replaceHome=false,focusTab=true){
    setTabs(previous=>{
      if(tab==='home')return previous.includes('home')?previous:[...previous,'home']
      const list=replaceHome?previous.filter(t=>t!=='home'):previous
      return list.includes(tab)||(tab==='browser'&&list.some(isWeb))?list:[...list,tab]
    })
    setActive(tab)
    if(tab==='home')setQuery('')
    if(focusTab)requestAnimationFrame(()=>panel.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus({preventScroll:true}))
  }
  function openFile(next:string){setPath(next);activate('files',active==='home')}
  function browse(url?:string,existing?:BrowserOpenRequest){
    if(!conversation){void createConversation();return}
    if(existing?.id)setBrowserRequest(existing)
    else if(!existing||!hasBrowser)setBrowserRequest({url,newPage:hasBrowser,
      initialUrl:import.meta.env.VITE_WORKBENCH_PREVIEW==='1'?location.origin+'/workbench-example':undefined})
    activate('browser',active==='home')
  }
  function launch(tab:Tab){if(tab==='browser')browse();else activate(tab,active==='home')}
  function inspect(target:DiffTarget){
    setFocus({target,serial:++serial.current});activate('diff',active==='home')
  }
  function selectEntry(entry:Entry){
    const page=pages.get(entry)
    if(page&&!page.active)browserControls.current?.select(page.id)
    activate(paneFor(entry),false,false)
  }
  function closeTab(tab:Tab){
    const index=tabs.findIndex(t=>tab==='browser'?isWeb(t):t===tab),next=tabs.filter(t=>tab==='browser'?!isWeb(t):t!==tab)
    if(tab==='browser'){setBrowserRequest(undefined);setBrowser(undefined)}
    if(!next.length){setTabs(['home']);setActive('home');setQuery('');return}
    setTabs(next)
    if(active===tab)selectEntry(next[Math.max(0,Math.min(index,next.length-1))]!)
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
  const panes:Tab[]=[...tabs.filter((tab):tab is Exclude<Tab,'browser'>=>!isWeb(tab)),...(hasBrowser?['browser' as const]:[])]
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
          const enabled=tabs.filter(tab=>!pages.has(tab)||pages.get(tab)?.active||browser?.editable)
          const index=e.key==='Home'?0:e.key==='End'?enabled.length-1:(enabled.indexOf(selectedKey)+(e.key==='ArrowLeft'?-1:1)+enabled.length)%enabled.length
          if(enabled[index]){selectEntry(enabled[index]);document.getElementById(tabPrefix+enabled[index])?.focus({preventScroll:true})}
        }}>{tabs.map(tab=>{const page=pages.get(tab),pane=paneFor(tab),Icon=icons[pane],selected=selectedKey===tab
          const label=page?(page.url==='about:blank'?L('Blank page','空白页'):page.title||page.url):names[pane]
          return <div className="bench-tab" data-active={selected||undefined} key={tab}>
          <button role="tab" type="button" id={tabPrefix+tab} aria-controls={tabPrefix+'pane-'+pane} aria-selected={selected} tabIndex={selected?0:-1}
            disabled={!!page&&!page.active&&!browser?.editable} onClick={()=>selectEntry(tab)} title={label}><Icon size={15}/><span>{label}</span></button>
          {selected&&tab!=='home'&&<button className="bench-close-tab" aria-label={L('Close tab','关闭标签页')+' · '+label}
            disabled={!!page&&(browser?.busy||(!browser?.editable&&pages.size>1))}
            onClick={()=>page?browserControls.current?.close(page.id):closeTab(pane)}><X size={12}/></button>}
        </div>})}</div>
        <button className="bench-icon" title={names.home} aria-label={names.home} onClick={()=>{activate('home');requestAnimationFrame(()=>search.current?.focus())}}><Plus size={17}/></button>
        <div className="bench-window-tools">{!overlay&&<button className="bench-icon" aria-label={expanded?L('Restore width','还原宽度'):L('Expand workspace','展开工作区')} title={expanded?L('Restore width','还原宽度'):L('Expand workspace','展开工作区')} onClick={()=>setExpanded(!expanded)}>{expanded?<Minimize2 size={15}/>:<Maximize2 size={15}/>}</button>}
          <button className="bench-icon" title={L('Close workspace','关闭工作区')} aria-label={L('Close workspace','关闭工作区')} onClick={close}><PanelRightClose size={17}/></button></div>
      </header>
      {panes.map(tab=><div key={tab} id={tabPrefix+'pane-'+tab} className="bench-pane" role="tabpanel" aria-labelledby={tabPrefix+(tab==='browser'&&browser&&currentPage?webKey(browser.id,currentPage.id):tab)} hidden={tab!==active}>
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
        {tab==='browser'&&open&&<BrowserPanel embedded visible={active==='browser'} L={L} conversationId={conversation}
          pageControls={browserControls} onPages={syncPages} onLastPageClosed={()=>closeTab('browser')}
          requestedSession={browserRequest} onRequestHandled={()=>setBrowserRequest(undefined)}/>}
      </div>)}
    </div>
  </aside>
}
