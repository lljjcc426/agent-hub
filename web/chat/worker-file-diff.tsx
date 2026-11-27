import {useEffect,useId,useMemo,useRef,useState} from 'react'
import {AlignJustify,ChevronDown,Columns2,ExternalLink,FolderOpen,History,FileCode2,GitCompareArrows,WrapText} from 'lucide-react'
import type {WorkerFilePatch} from '../../src/chat.ts'
import type {Localize} from './composer-commands.tsx'
import type {ChangedFile,DiffTarget,WorkerReports} from './worker-report-groups.ts'
import {useWorkerDiffPreference} from './worker-diff-preference.ts'
import {parseHunks,type PatchHunk} from '../../src/worker-patch.ts'
import './worker-file-diff.css'

type DiffLine={sign:string;text:string;old?:number;next?:number}
function numbered(hunk:PatchHunk):DiffLine[] {
  let old=hunk.oldStart,next=hunk.newStart
  return hunk.lines.map(line=>{
    const sign=line.charAt(0)
    return {sign,text:line.slice(1),old:sign===' '||sign==='-'?old++:undefined,next:sign===' '||sign==='+'?next++:undefined}
  })
}
type Pair={left?:DiffLine;right?:DiffLine;note?:string}
export function paired(lines:DiffLine[]):Pair[]{
  const rows:Pair[]=[],deleted:DiffLine[]=[],added:DiffLine[]=[]
  const flush=()=>{
    for(let i=0;i<Math.max(deleted.length,added.length);i++)rows.push({left:deleted[i],right:added[i]})
    deleted.length=0;added.length=0
  }
  for(const line of lines){
    if(line.sign==='-')deleted.push(line)
    else if(line.sign==='+')added.push(line)
    else {flush();rows.push(line.sign===' '?{left:line,right:line}:{note:line.text})}
  }
  flush()
  return rows
}
const tint=(sign?:string)=>sign==='+'?' appearance-diff-add':sign==='-'?' appearance-diff-remove':''
function UnifiedLine({line}:{line:DiffLine}){
  return <div className={'worker-patch-line'+tint(line.sign)}><span className="patch-number">{line.old}</span><span className="patch-number">{line.next}</span>
    <span className="patch-sign">{line.sign}</span><code className="patch-code">{line.text}</code></div>
}
function Side({line,side}:{line?:DiffLine;side:'left'|'right'}){
  return <div className={'patch-side'+tint(line?.sign)} data-empty={!line||undefined}>
    <span className="patch-number">{side==='left'?line?.old:line?.next}</span><span className="patch-sign">{line?.sign}</span>
    <code className="patch-code">{line?.text}</code></div>
}
function Counts({file,L}:{file:WorkerFilePatch;L:Localize}){
  const added=file.added??file.hunks.reduce((a,h)=>a+h.lines.filter(l=>l.startsWith('+')).length,0)
  const removed=file.removed??file.hunks.reduce((a,h)=>a+h.lines.filter(l=>l.startsWith('-')).length,0)
  return <span className="worker-patch-count" aria-label={L(added+' added, '+removed+' removed','新增 '+added+' 行，删除 '+removed+' 行')}>
    {added>0&&<span className="patch-added">+{added}</span>}{removed>0&&<span className="patch-removed">−{removed}</span>}</span>
}
function InlineFile({file,first,inspect,L}:{file:WorkerFilePatch;first:boolean;inspect:()=>void;L:Localize}){
  const [expanded,setExpanded]=useState(first),id=useId()
  const preview=file.hunks[0]
  const openLabel=L('Open full diff for ','查看完整差异 · ')+file.path
  return <div className="worker-patch">
    <div className="patch-inline-head">
      <button type="button" className="patch-file-link" aria-label={openLabel} title={openLabel} onClick={inspect}>
        <FileCode2 size={15}/><span className="worker-patch-name" dir="ltr">{file.path}</span><ExternalLink size={12} className="patch-open-icon"/></button>
      <Counts file={file} L={L}/>
      <button type="button" className="patch-disclose" onClick={()=>setExpanded(!expanded)} aria-controls={id} aria-expanded={expanded}
        aria-label={L('Toggle preview of ','展开或收起预览 · ')+file.path}><ChevronDown size={14}/></button>
    </div>
    <div className="patch-fold" data-open={expanded} id={id} inert={!expanded}><div>
      <div className="worker-patch-body" dir="ltr">{preview?numbered(preview).slice(0,7).map((line,i)=><UnifiedLine key={i} line={line}/>):
        <span className="patch-hint">{file.binary?L('Binary file changed','二进制文件有改动'):L('File metadata changed','文件属性有改动')}</span>}
      </div>
    </div></div>
  </div>
}

function fallbackPatch(file:WorkerFilePatch){
  return ['diff --git a/'+file.path+' b/'+file.path,'--- a/'+file.path,'+++ b/'+file.path,...file.hunks.flatMap(h=>{
    const before=h.lines.filter(l=>l.startsWith('-')||l.startsWith(' ')).length,after=h.lines.filter(l=>l.startsWith('+')||l.startsWith(' ')).length
    return [h.header??('@@ -'+h.oldStart+','+before+' +'+h.newStart+','+after+' @@'),...h.lines]
  })].join('\n')+'\n'
}
function FullPatch({raw,split,wrap,L}:{raw:string;split:boolean;wrap:boolean;L:Localize}){
  const [limit,setLimit]=useState(600),more=useRef<HTMLButtonElement>(null)
  const rows=useMemo(()=>{
    const result:({header:string}|{line:DiffLine}|{pair:Pair})[]=[]
    for(const h of parseHunks(raw)){
      result.push({header:h.header!})
      const lines=numbered(h)
      if(split)for(const pair of paired(lines))result.push({pair})
      else for(const line of lines)result.push({line})
    }
    return result
  },[raw,split])
  useEffect(()=>{
    if(!more.current)return
    const observer=new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting))setLimit(n=>n+600)
    },{root:more.current.closest('.bench-diffs'),rootMargin:'160px'})
    observer.observe(more.current)
    return ()=>observer.disconnect()
  },[limit,rows.length])
  if(!rows.length)return <pre className="patch-metadata" dir="ltr" data-wrap={wrap}>{raw}</pre>
  const header=raw.split(/^@@ /m,1)[0]?.split('\n').filter(line=>/^(?:rename |copy |old mode |new mode |new file mode |deleted file mode )/.test(line)).join('\n')
  return <div className="patch-full-body" data-wrap={wrap} data-view={split?'split':'unified'} dir="ltr">
    {header&&<pre className="patch-meta-details">{header}</pre>}
    <div className="patch-code-scroll" tabIndex={0} aria-label={L('Diff lines','差异代码行')}><div className="patch-code-table">
      {rows.slice(0,limit).map((row,i)=>'header' in row?<div className="patch-hunk-title" key={i}>{row.header}</div>:
        'line' in row?<UnifiedLine key={i} line={row.line}/>:row.pair.note!==undefined?<div className="patch-hunk-title" key={i}>{row.pair.note}</div>:
        <div className="patch-pair" key={i}><Side side="left" line={row.pair.left}/><Side side="right" line={row.pair.right}/></div>)}
    </div></div>
    {rows.length>limit&&<button className="patch-more" ref={more} type="button" onClick={()=>setLimit(n=>n+600)}>
      {L('Show more lines','显示更多行')} · {limit} / {rows.length}</button>}
  </div>
}
export function FilePath({path}:{path:string}){
  const end=path.lastIndexOf('/')+1
  return <span className="bench-path" dir="ltr" title={path}>
    {end>0&&<span className="bench-path-dir" dir="rtl"><bdi dir="ltr">{path.slice(0,end)}</bdi></span>}
    <span className="bench-path-name">{path.slice(end)}</span>
  </span>
}

function PatchVersion({file,conversationId,expanded,split,wrap,L}:{
  file:WorkerFilePatch;conversationId:string;expanded:boolean;split:boolean;wrap:boolean;L:Localize
}){
  const [raw,setRaw]=useState<string>(),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0)
  const href=file.id?patchUrl(conversationId,file.id):undefined
  useEffect(()=>{
    if(!expanded||raw!==undefined||!href)return
    const controller=new AbortController()
    setFailed(false)
    fetch(href,{signal:controller.signal}).then(async res=>{
      if(!res.ok)throw Error()
      const value=await res.text()
      if(!controller.signal.aborted)setRaw(value)
    }).catch(()=>{if(!controller.signal.aborted)setFailed(true)})
    return ()=>controller.abort()
  },[expanded,href,retry,raw])
  const value=href?raw:fallbackPatch(file)
  if(value!==undefined)return <FullPatch raw={value} split={split} wrap={wrap} L={L}/>
  return expanded?<p className="patch-hint" role={failed?'alert':'status'}>{failed?<>{L('Diff unavailable','未能读取差异')} <button onClick={()=>setRetry(n=>n+1)}>{L('Retry','重试')}</button></>:L('Loading diff…','正在读取差异…')}</p>:null
}

const patchUrl=(conversation:string,id:string)=>'/api/chat/conversations/'+encodeURIComponent(conversation)+'/patches/'+encodeURIComponent(id)

export function DetailedFile({change,conversationId,initial,focus,openFile,L}:{
  change:ChangedFile;conversationId:string;initial:boolean;focus?:number;openFile:(path:string,patch?:string)=>void;L:Localize
}){
  const [expanded,setExpanded]=useState(initial),[wrap,setWrap]=useState(true),[split,setSplit]=useState(false)
  const [picked,setPicked]=useState<number>(),[error,setError]=useState('')
  const version=Math.min(picked??Infinity,change.versions.length-1),file=change.versions[version]!
  const id=useId(),row=useRef<HTMLElement>(null)
  useEffect(()=>{
    if(focus===undefined)return
    setExpanded(true)
    row.current?.scrollIntoView({block:'nearest'})
  },[focus])
  const openWith=async(action:string)=>{
    setError('')
    if(action==='files'){openFile(file.path,file.id);return}
    const href=file.id?patchUrl(conversationId,file.id):undefined
    if(action==='finder'||action==='textedit'){
      try{
        const url=action==='finder'?'/api/chat/conversations/'+encodeURIComponent(conversationId)+'/workbench/reveal':href+'/open'
        const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action==='finder'?{path:file.path,patch:file.id}:{})})
        if(!res.ok)throw Error()
      }catch{setError(L('Could not open this file.','未能打开此文件。'))}
      return
    }
    const url=href??URL.createObjectURL(new Blob([fallbackPatch(file)],{type:'text/plain;charset=utf-8'}))
    const link=document.createElement('a')
    link.href=url+(href&&action==='download'?'?download=1':'')
    if(action==='download')link.download=(file.path.split('/').pop()??'changes')+'.patch'
    else {link.target='_blank';link.rel='noopener noreferrer'}
    link.click()
    if(!href)window.setTimeout(()=>URL.revokeObjectURL(url),60000)
  }
  const localMac=['localhost','127.0.0.1','[::1]'].includes(location.hostname)&&/Mac/.test(navigator.platform)
  const label=L('Open with','打开方式')
  return <section className="patch-drawer-file" ref={row} data-file={file.path}>
    <div className="patch-drawer-head">
      <button type="button" className="patch-drawer-title" aria-expanded={expanded} aria-controls={id} title={file.path} onClick={()=>setExpanded(!expanded)}>
        <ChevronDown size={13}/><FileCode2 size={15} className="bench-file-icon"/><FilePath path={file.path}/></button>
      <Counts file={file} L={L}/>
      <div className="patch-controls">
        {change.versions.length>1&&<label className="patch-open-select patch-versions" title={L('Change history','改动历史')}>
          <History size={14}/><small>{version+1}/{change.versions.length}</small>
          <select aria-label={L('Change history','改动历史')+' · '+file.path} value={version}
            onChange={e=>setPicked(Number(e.target.value)===change.versions.length-1?undefined:Number(e.target.value))}>
            {change.versions.map((v,i)=><option key={v.id??i} value={i}>{L('Change '+(i+1),'第 '+(i+1)+' 次改动')}</option>)}</select>
        </label>}
        <label className="patch-open-select" title={label}><FolderOpen size={15}/>
          <select aria-label={label+' · '+file.path} value="" onChange={e=>void openWith(e.target.value)}>
            <option disabled value="">{label}</option><option value="files">{L('Show in file manager','在文件管理器中显示')}</option>
            {localMac&&<option value="finder">{L('Reveal in Finder','在 Finder 中显示')}</option>}
            <option value="browser">{L('Open patch in new tab','在新标签页打开补丁')}</option>
            {localMac&&file.id&&<option value="textedit">{L('Open patch in TextEdit','用文本编辑打开补丁')}</option>}
            <option value="download">{L('Download .patch','下载 .patch')}</option>
          </select></label>
        <button type="button" className="patch-wrap" aria-label={L('Wrap lines','自动换行')} aria-pressed={wrap} title={L('Wrap lines','自动换行')} onClick={()=>setWrap(!wrap)}><WrapText size={15}/></button>
        <button type="button" className="patch-view-toggle" aria-label={L('Split diff','并排差异')} aria-pressed={split} title={split?L('Switch to unified diff','切换为统一视图'):L('Switch to split diff','切换为并排视图')} onClick={()=>setSplit(!split)}>
          {split?<Columns2 size={15}/>:<AlignJustify size={15}/>}</button>
      </div>
    </div>
    {error&&<p className="patch-hint" role="alert">{error}</p>}
    <div className="patch-fold" id={id} data-open={expanded} inert={!expanded}><div>
      <PatchVersion key={file.id??version} file={file} conversationId={conversationId} expanded={expanded} split={split} wrap={wrap} L={L}/>
    </div></div>
  </section>
}

export function WorkerFileDiff({reports,openAgent,inspect,L}:{reports:WorkerReports;openAgent:(id:string)=>void;inspect:(target:DiffTarget)=>void;L:Localize}) {
  const enabled=useWorkerDiffPreference()
  return <div className="worker-diff-reveal" data-enabled={enabled} inert={!enabled} aria-hidden={!enabled}>
    <div className="worker-diff-clip">{reports.map(report=><section key={report.messageId} className="worker-file-diff transcript-card" aria-label={report.label+' · '+L('File changes','文件改动')}>
      <header><GitCompareArrows size={15} aria-hidden="true"/><strong>{L('File changes','文件改动')}</strong>
        <button type="button" className="worker-diff-author" onClick={()=>openAgent(report.workerId)}>{report.label}</button>
        <span>{L(report.files.length+' files',report.files.length+' 个文件')}</span></header>
      {report.files.map((change,i)=><InlineFile key={change.path} file={change.versions.at(-1)!} first={i===0} L={L}
        inspect={()=>inspect({group:report.messageId,path:change.path})}/>)}
    </section>)}</div>
  </div>
}
