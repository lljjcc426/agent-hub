import {useEffect,useId,useMemo,useRef,useState} from 'react'
import {AlignJustify,ChevronDown,Columns2,ExternalLink,FileCode2,GitCompareArrows,WrapText} from 'lucide-react'
import type {ChatMessage,WorkerFilePatch} from '../../src/chat.ts'
import type {Localize} from './composer-commands.tsx'
import {Dialog} from '../ui/overlays.tsx'
import {useWorkerDiffPreference} from './worker-diff-preference.ts'
import {parseHunks,type PatchHunk} from '../../src/worker-patch.ts'
import './worker-file-diff.css'

type Report={conversationId:string;messageId:string;workerId:string;label:string;files:WorkerFilePatch[]}
export type WorkerReports=Report[]

// A Router reply can cite a particular Worker receipt when the current view hides it.
export function reportsForTranscript(messages:ChatMessage[], visible:ChatMessage[]) {
  const visibleIds=new Set(visible.map(m=>m.id))
  const sources=new Map<string,{report:Report;runId:string}>()
  const reports=new Map<string,WorkerReports>()
  for(const message of messages) {
    if(message.speaker?.kind!=='worker' || !message.fileChanges?.length) continue
    const report={conversationId:message.conversationId,messageId:message.id,workerId:message.speaker.id,label:message.speaker.label,files:message.fileChanges}
    sources.set(message.id,{report,runId:message.runId})
    if(visibleIds.has(message.id)) reports.set(message.id,[report])
  }
  for(const message of visible) {
    if(message.speaker?.kind!=='router' || !message.fileChangeSources) continue
    const cited:Report[]=[]
    for(const id of new Set(message.fileChangeSources)) {
      const source=sources.get(id)
      if(source?.runId===message.runId && !visibleIds.has(id)) cited.push(source.report)
    }
    if(cited.length) reports.set(message.id,cited)
  }
  return reports
}

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
      <button type="button" className="patch-file-link" aria-haspopup="dialog" aria-label={openLabel} title={openLabel} onClick={inspect}>
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
    },{root:more.current.closest('.rp-dialog-body'),rootMargin:'160px'})
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
function DrawerFile({file,conversationId,selected,L}:{file:WorkerFilePatch;conversationId:string;selected:boolean;L:Localize}){
  const [expanded,setExpanded]=useState(selected),[wrap,setWrap]=useState(true),[split,setSplit]=useState(false)
  const [raw,setRaw]=useState<string>(),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0),[openError,setOpenError]=useState(false)
  const bodyId=useId(),row=useRef<HTMLElement>(null)
  const href=file.id?'/api/chat/conversations/'+encodeURIComponent(conversationId)+'/patches/'+encodeURIComponent(file.id):undefined
  const localMac=!!href&&['127.0.0.1','localhost','[::1]'].includes(window.location.hostname)&&/Mac/.test(navigator.platform)
  useEffect(()=>{if(selected)row.current?.scrollIntoView({block:'nearest'})},[selected])
  useEffect(()=>{
    if(!expanded||raw!==undefined)return
    if(!href){setRaw(fallbackPatch(file));return}
    const controller=new AbortController()
    setFailed(false)
    fetch(href,{signal:controller.signal}).then(async res=>{
      if(!res.ok)throw Error()
      const text=await res.text()
      if(!controller.signal.aborted)setRaw(text)
    }).catch(()=>{if(!controller.signal.aborted)setFailed(true)})
    return ()=>controller.abort()
  },[file,href,expanded,retry,raw])
  const openWith=async(action:string)=>{
    setOpenError(false)
    if(action==='textedit'&&href){
      try{if(!(await fetch(href+'/open',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).ok)throw Error()}
      catch{setOpenError(true)}
      return
    }
    const link=document.createElement('a'),url=href??URL.createObjectURL(new Blob([raw??fallbackPatch(file)],{type:'text/plain;charset=utf-8'}))
    link.href=url+(href&&action==='download'?'?download=1':'')
    if(action==='download')link.download=(file.path.split('/').pop()??'changes')+'.patch'
    else {link.target='_blank';link.rel='noopener noreferrer'}
    link.click()
    if(!href)window.setTimeout(()=>URL.revokeObjectURL(url),60_000)
  }
  return <section className="patch-drawer-file" ref={row}>
    <div className="patch-drawer-head">
      <button type="button" className="patch-drawer-title" aria-expanded={expanded} aria-controls={bodyId} onClick={()=>setExpanded(!expanded)}>
        <ChevronDown size={15}/><FileCode2 size={16}/><span dir="ltr">{file.path}</span><Counts file={file} L={L}/></button>
      <div className="patch-controls">
        <label className="patch-open-select"><ExternalLink size={13}/><span>{L('Open with','打开方式')}</span><ChevronDown size={12}/>
          <select aria-label={L('Open with','打开方式')+' · '+file.path} value="" onChange={e=>{void openWith(e.currentTarget.value)}}>
            <option value="" disabled>{L('Open with','打开方式')}</option>
            <option value="browser">{L('Open patch in a new tab','在新标签页打开补丁')}</option>
            {localMac&&<option value="textedit">{L('Open patch in TextEdit','用文本编辑打开补丁')}</option>}
            <option value="download">{L('Download .patch','下载 .patch')}</option>
          </select></label>
        <button className="patch-wrap" type="button" aria-pressed={wrap} onClick={()=>setWrap(!wrap)} title={L('Wrap lines','自动换行')}><WrapText size={14}/>{L('Wrap lines','自动换行')}</button>
        <div className="patch-view" role="group" aria-label={L('Diff view','差异视图')}>
          <button type="button" aria-pressed={!split} onClick={()=>setSplit(false)}><AlignJustify size={13}/>{L('Unified','统一')}</button>
          <button type="button" aria-pressed={split} onClick={()=>setSplit(true)}><Columns2 size={13}/>{L('Split','并排')}</button>
        </div>
      </div>
    </div>
    {openError&&<p className="patch-hint" role="alert">{L('TextEdit could not open the patch.','文本编辑未能打开补丁。')}</p>}
    <div className="patch-fold" data-open={expanded} inert={!expanded} id={bodyId}><div>
      {raw!==undefined?<FullPatch raw={raw} split={split} wrap={wrap} L={L}/>:failed?<p className="patch-hint" role="alert">{L('Diff unavailable','未能读取差异')} <button type="button" onClick={()=>setRetry(n=>n+1)}>{L('Retry','重试')}</button></p>:
        expanded&&<p className="patch-hint" role="status">{L('Loading diff…','正在读取差异…')}</p>}
    </div></div>
  </section>
}

export function WorkerFileDiff({reports,openAgent,L}:{reports:WorkerReports;openAgent:(id:string)=>void;L:Localize}) {
  const enabled=useWorkerDiffPreference(),[selection,setSelection]=useState<{report:Report;file:number}>(),[open,setOpen]=useState(false)
  return <div className="worker-diff-reveal" data-enabled={enabled} inert={!enabled} aria-hidden={!enabled}>
    <div className="worker-diff-clip">
      {reports.map((report,r)=><section key={report.messageId} className="worker-file-diff transcript-card" aria-label={report.label+' · '+L('File changes','文件改动')}>
        <header><GitCompareArrows size={15} aria-hidden="true"/><strong>{L('File changes','文件改动')}</strong>
          <button type="button" className="worker-diff-author" onClick={()=>openAgent(report.workerId)}>{report.label}</button>
          <span>{L(report.files.length+' files',report.files.length+' 个文件')}</span></header>
        {report.files.map((file,i)=><InlineFile key={file.id??file.path} file={file} first={r===0&&i===0} L={L}
          inspect={()=>{setSelection({report,file:i});setOpen(true)}}/>)}
      </section>)}
    </div>
    {selection&&<Dialog open={open&&enabled} onClose={()=>setOpen(false)} onAfterClose={()=>setSelection(undefined)}
      title={L('File changes','文件改动')+' · '+selection.report.label} closeLabel={L('Close diff','关闭差异面板')}
      placement="side" className="patch-drawer" headerContent={<div className="patch-drawer-heading"><GitCompareArrows size={18}/>
        <strong>{L('File changes','文件改动')}</strong><span>{selection.report.label}</span></div>}>
      {selection.report.files.map((file,i)=><DrawerFile key={selection.report.messageId+':'+i} file={file} conversationId={selection.report.conversationId} selected={i===selection.file} L={L}/>)}
    </Dialog>}
  </div>
}
