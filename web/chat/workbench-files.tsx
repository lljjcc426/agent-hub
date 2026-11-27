import {useEffect,useRef,useState} from 'react'
import {ChevronDown,ChevronLeft,ChevronRight,FileCode2,FileText,Folder,FolderOpen,RefreshCw,Search,TerminalSquare} from 'lucide-react'
import type {Localize} from './composer-commands.tsx'
import {FilePath} from './worker-file-diff.tsx'

export type WorkFile={path:string;text?:string;originalPath?:string;patch?:string}
export const displayFilePath=(path:string)=>path.replace(/^\/+/,'')

async function fileText(file:WorkFile,conversation:string,L:Localize,signal?:AbortSignal){
  if(file.text!==undefined)return file.text
  const query=new URLSearchParams({path:file.originalPath??file.path})
  if(file.patch)query.set('patch',file.patch)
  const response=await fetch('/api/chat/conversations/'+encodeURIComponent(conversation)+'/workbench/file?'+query,{signal})
  if(!response.ok)throw Error(L('File unavailable in this workspace','工作区中没有这个文件'))
  const data=await response.json() as {text?:string;truncated?:boolean;binary?:boolean}
  if(data.binary)return L('Binary file · no text preview','二进制文件，无法预览文本')
  if(data.text===undefined)throw Error(L('Could not read this file','未能读取此文件'))
  return data.text+(data.truncated?'\n'+L('Showing the first 512 KiB','仅显示前 512 KiB'):'')
}
const baseName=(path:string)=>path.split('/').at(-1)??path
const join=(a:string,b:string)=>[a,b].filter(Boolean).join('/')

function entries(files:WorkFile[],dir:string){
  const children=new Map<string,boolean>()
  for(const {path} of files){
    if(dir&&!path.startsWith(dir+'/'))continue
    const relative=dir?path.slice(dir.length+1):path
    const [name,...tail]=relative.split('/')
    if(name)children.set(name,tail.length>0)
  }
  return [...children].sort(([a,ad],[b,bd])=>Number(bd)-Number(ad)||a.localeCompare(b))
}

export function FileManager({files,path,patch,conversation,select,reload,reloadToken,L}:{reloadToken:number;files:WorkFile[];path?:string;patch?:string;conversation:string;select:(p?:string)=>void;reload:()=>void;L:Localize}){
  const [query,setQuery]=useState(''),[folded,setFolded]=useState<Set<string>>(new Set())
  const file=files.find(f=>f.path===path)
  const requested=file?.originalPath??file?.path,receipt=patch??file?.patch,inline=file?.text
  const [reading,setReading]=useState<{path:string;receipt?:string;text:string}>()
  useEffect(()=>{
    if(!requested||inline!==undefined)return
    const ctrl=new AbortController()
    const put=(text:string)=>{if(!ctrl.signal.aborted)setReading({path:requested,receipt,text})}
    void fileText({path:requested,patch:receipt},conversation,L,ctrl.signal).then(put).catch(error=>put(String(error.message)))
    return ()=>ctrl.abort()
  },[requested,receipt,inline,conversation,L,reloadToken])
  const text=inline??(reading&&reading.path===requested&&reading.receipt===receipt?reading.text:undefined)
  useEffect(()=>{if(path){setQuery('');setFolded(previous=>new Set([...previous].filter(p=>!path.startsWith(p+'/'))))}},[path])
  function tree(dir='',depth=0):React.ReactNode{
    const result=query?files.filter(f=>f.path.toLowerCase().includes(query.toLowerCase())).map(f=>[f.path,false] as const):entries(files,dir)
    return result.map(([name,folder])=>{
      const item=join(dir,name),collapsed=folded.has(item)
      return <div key={item}><button type="button" className="bench-tree-row" style={{paddingInlineStart:9+depth*13}} data-current={item===path||undefined}
        aria-expanded={folder?!collapsed:undefined} title={item} onClick={()=>folder?setFolded(prev=>{const next=new Set(prev);if(next.has(item))next.delete(item);else next.add(item);return next}):select(item)}>
        {folder?(collapsed?<ChevronRight size={13}/>:<ChevronDown size={13}/>):<span className="bench-tree-indent"/>}
        {folder?(collapsed?<Folder size={15}/>:<FolderOpen size={15}/>):<FileCode2 size={14}/>}<span>{name}</span></button>
        {folder&&!collapsed&&tree(item,depth+1)}</div>
    })
  }
  return <div className="bench-files" data-reading={!!file}>
    <div className="bench-file-list"><div className="bench-searchline"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder={L('Filter files','筛选文件')} aria-label={L('Filter files','筛选文件')}/><button title={L('Refresh files','刷新文件')} aria-label={L('Refresh files','刷新文件')} onClick={reload}><RefreshCw size={14}/></button></div>
      <div className="bench-tree" aria-label={L('Project files','项目文件')}>{tree()}{!files.some(f=>f.path.toLowerCase().includes(query.toLowerCase()))&&<p className="bench-hint">{L('No matching files','没有匹配的文件')}</p>}</div>
    </div>
    <div className="bench-reader">{file?<><header><button className="bench-back-files" onClick={()=>select(undefined)} aria-label={L('Back to files','返回文件列表')}><ChevronLeft size={16}/></button><FileText size={15}/><FilePath path={file.path}/></header>
      <div className="bench-source" tabIndex={0}>{text===undefined?<p className="bench-hint" role="status">{L('Reading file…','正在读取文件…')}</p>:text.replace(/\n$/,'').split('\n').map((text,i)=><div key={i}><span>{i+1}</span><code>{text||' '}</code></div>)}</div></>:
      <div className="bench-reader-idle"><FolderOpen size={25}/><span>{path?L('File unavailable in this workspace','工作区中没有这个文件'):L('Choose a file','选择文件查看内容')}</span></div>}</div>
  </div>
}

function resolvePath(cwd:string,input:string){
  const parts=input.startsWith('/')||input.startsWith('~')?[]:cwd.split('/').filter(Boolean)
  const clean=input.replace(/^~(?:\/|$)/,'').replace(/^\/workspace(?:\/|$)/,'')
  for(const part of clean.split('/')){if(part==='..')parts.pop();else if(part&&part!=='.')parts.push(part)}
  return parts.join('/')
}

export function WorkTerminal({files,conversation,L}:{files:WorkFile[];conversation:string;L:Localize}){
  const [cwd,setCwd]=useState(''),[value,setValue]=useState(''),[history,setHistory]=useState<{command:string;output:string;dir:string}[]>([])
  const [position,setPosition]=useState(0)
  const bottom=useRef<HTMLDivElement>(null)
  useEffect(()=>{bottom.current?.scrollIntoView({block:'nearest'})},[history])
  const prompt=(dir:string)=>'~'+(dir?'/'+dir:'')
  const [running,setRunning]=useState(false)
  async function execute(e:React.FormEvent){
    e.preventDefault()
    const command=value.trim()
    if(!command||running)return
    const words=(command.match(/"[^"]*"|'[^']*'|\S+/g)??[]).map(w=>w.replace(/^(['"])(.*)\1$/,'$2'))
    const [verb,...args]=words,arg=args.join(' '),target=resolvePath(cwd,arg),file=files.find(f=>f.path===target)
    const isDir=!target||files.some(f=>f.path.startsWith(target+'/'))
    let output=''
    if(verb==='clear'){setHistory([]);setValue('');setPosition(0);return}
    if(verb==='pwd')output='/workspace'+(cwd?'/'+cwd:'')
    else if(verb==='help')output='pwd     ls [path]     cd [path]     cat <file>     clear'
    else if(verb==='ls')output=file?baseName(target):isDir?entries(files,target).map(([n,d])=>n+(d?'/':'')).join('    '):L('Path unavailable','路径不存在')
    else if(verb==='cd'){
      if(!arg)setCwd('')
      else if(isDir)setCwd(target)
      else output=L('Directory unavailable','目录不存在')
    }else if(verb==='cat'){
      setRunning(true)
      try{output=file?(await fileText(file,conversation,L)).trimEnd():L('File unavailable','文件不存在')}
      catch{output=L('Could not read this file','未能读取此文件')}
      finally{setRunning(false)}
    }
    else output=L('Unknown command. Type help.','不支持此命令。输入 help 查看可用命令。')
    setHistory([...history,{command,output,dir:cwd}]);setPosition(history.length+1);setValue('')
  }
  return <div className="bench-terminal"><div className="bench-terminal-heading"><TerminalSquare size={15}/><span>{'/workspace'+(cwd?'/'+cwd:'')}</span><small>{L('Read-only','只读')}</small></div>
    <div className="bench-terminal-scroll"><p className="bench-terminal-help">{L('Type help for available commands.','输入 help 查看可用命令。')}</p>
      <div role="log">{history.map((h,i)=><div className="bench-terminal-record" key={i}><div><b>{prompt(h.dir)} ❯</b> {h.command}</div>{h.output&&<pre>{h.output}</pre>}</div>)}</div>
      <form onSubmit={execute}><label htmlFor="bench-terminal-command">{prompt(cwd)} ❯</label><input id="bench-terminal-command" readOnly={running} aria-busy={running} aria-label={L('Terminal command','终端命令')} autoCapitalize="off" autoComplete="off" spellCheck={false} value={value} onChange={e=>setValue(e.target.value)} onKeyDown={e=>{
        if(!['ArrowUp','ArrowDown'].includes(e.key))return
        e.preventDefault()
        const index=Math.max(0,Math.min(history.length,position+(e.key==='ArrowUp'?-1:1)))
        setPosition(index);setValue(history[index]?.command??'')
      }}/></form><div ref={bottom}/></div>
  </div>
}
