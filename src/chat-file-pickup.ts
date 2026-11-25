// A pickup names an existing deliverable. Requests to create or change one still use the normal Router.
const extension=/[\p{L}\d_()[\].+-]+\.(?:zip|dmg|pkg|exe|msi|gz|deb|rpm|appimage|pdf|docx?|xlsx?|pptx?|txt|md|csv|json|log|png|jpe?g|webp|mp[34]|wav)\b/giu
const fileNoun=/(?:文件|原包|安装包|测试包|压缩包|附件|报告|表格|文档|截图|录屏|下载链接|本地链接|交付物|\b(?:file|installer|package|archive|attachment|report|document|spreadsheet|screenshot|zip|pdf|download)\b)/iu
export function existingFileRequest(text:string){
 const value=text.trim()
 if(!value||value.length>500||/(?:不要|不用|别|无需|(?:生成|制作|编写|创建|构建|打包|修复|修改)(?!好?的|过的|后的)|解释|介绍|总结|分析|比较|写一|安装到|发送到|转发|发给(?!我)|\b(?:don't|do not|generate|create|build|rebuild|write|edit|fix|forward|publish|upload|explain|summari[sz]e|compare|analy[sz]e)\b)/iu.test(value))return false
 const file=fileNoun.test(value)||Array.from(value.matchAll(extension)).length>0
 return file&&/(?:给我|发我|我(?:想要|需要)|请提供|给一下|发一下|发来|拿到|取回|取一下|下载|在哪里|在哪[里儿]?|在哪个目录|定位到|\b(?:send|give|attach|show|locate|retrieve|download|where(?:'s| is)|get me|share with me|I (?:need|want|would like)|can I (?:have|get))\b)/iu.test(value)
}

type FileChoice={id:string;name:string;ticketId?:string;kind?:string;sha256?:string}
const categories:[RegExp,RegExp][]=[
 [/安装包|测试包|原包|\b(?:installer|package)\b/iu,/\.(?:zip|dmg|pkg|exe|msi|gz|deb|rpm|appimage)$/i],
 [/压缩包|\barchive\b/iu,/\.(?:zip|gz|tar|7z|rar)$/i],
 [/截图|\bscreenshot\b/iu,/\.(?:png|jpe?g|webp)$/i],
 [/表格|\bspreadsheet\b/iu,/\.(?:xlsx?|csv|tsv|ods)$/i],
 [/报告|文档|\b(?:report|document)\b/iu,/\.(?:pdf|docx?|md|txt|html|pptx?|xlsx?)$/i],
]
const platforms=[/mac(?:os)?|darwin|苹果|麦金塔/i,/windows|\bwin(?:32|64)?\b/i,/linux|ubuntu/i]
export function choosePickup<T extends FileChoice>(items:T[],request:string,context:string){
 const identifiers=(text:string)=>[...text.matchAll(/(?<![a-f0-9])[a-f0-9]{32}(?![a-f0-9])/ig)].map(m=>m[0]!.toLowerCase())
 const requestedTickets=identifiers(request)
 if(requestedTickets.length)items=items.filter(f=>f.ticketId&&requestedTickets.includes(f.ticketId))
 const version=request.match(/\b(?:v)?(\d+\.\d+(?:\.\d+){0,2})\b/i)?.[1]
 const digest=request.match(/(?:sha[- ]?256\s*[:：=]?\s*|\b)([a-f0-9]{8,64})\b/i)?.[1]?.toLowerCase()
 if(version)items=items.filter(f=>f.name.match(/\d+(?:\.\d+){1,3}/g)?.includes(version))
 if(digest)items=items.filter(f=>f.ticketId?.includes(digest)||f.sha256?.startsWith(digest)||f.name.toLowerCase().includes(digest))
 const formats=[...request.matchAll(/\b(zip|pdf|xlsx?|csv|pptx?|docx?|dmg|pkg|exe|msi|png|jpe?g|mp4|json|md|txt)\b/ig)].map(m=>m[1]!.toLowerCase())
 if(formats.length)items=items.filter(f=>formats.includes(f.name.split('.').at(-1)!.toLowerCase()))
 const narrow=(available:T[],text:string)=>{
  const named=available.filter(f=>text.toLowerCase().includes(f.name.toLowerCase()))
  if(named.length)return named
  if(Array.from(text.matchAll(extension)).length)return []
  return available.filter(f=>categories.every(([ask,match])=>!ask.test(text)||match.test(f.name))&&
    platforms.every(platform=>!platform.test(text)||platform.test([f.name,f.kind,/\.(msi|exe)$/i.test(f.name)?'Windows':/\.(dmg|pkg)$/i.test(f.name)?'macOS':/\.(deb|rpm|appimage)$/i.test(f.name)?'Linux':''].join(' '))))
 }
 let matches=narrow(items,request)
 const named=items.some(f=>request.toLowerCase().includes(f.name.toLowerCase()))
 if(!named&&!requestedTickets.length&&!version&&!digest&&context){
  const anchored=identifiers(context)
  const samePlatform=platforms.every(platform=>!platform.test(request)||platform.test(context))
  if(anchored.length&&samePlatform)matches=matches.filter(f=>f.ticketId&&anchored.includes(f.ticketId))
 }
 const explicitTickets=matches.filter(f=>f.ticketId&&request.includes(f.ticketId))
 if(explicitTickets.length)matches=explicitTickets
 if(matches.length>1&&context){
  const focused=matches.filter(f=>f.ticketId&&context.includes(f.ticketId))
  if(focused.length)matches=focused
  const mentioned=matches.filter(f=>context.toLowerCase().includes(f.name.toLowerCase()))
  if(mentioned.length)matches=mentioned
 }
 return matches
}

/** Old Worker reports declared user-facing paths, but only some recorded a version next to the filename. */
export function reportedFileVersions(text:string){
 let report:{state?:unknown;files?:unknown;reply?:unknown}
 try{report=JSON.parse(text)}catch{return []}
 if(!report||report.state!=='ready'||!Array.isArray(report.files)||typeof report.reply!=='string')return []
 const reply=report.reply,files=report.files.filter((p):p is string=>typeof p==='string')
 // A digest belongs to the named file in this entry, never to every path in the report.
 return files.flatMap(path=>{
  const name=path.split('/').at(-1)!
  if(!name||files.filter(p=>p.split('/').at(-1)===name).length!==1)return []
  for(const match of reply.matchAll(/\x60([^\x60\r\n]+)\x60/g)){
   if(match[1]!==name&&match[1]!==path)continue
   const details=reply.slice(match.index!+match[0].length,match.index!+match[0].length+240)
   const version=/^[\s(（:,，：-]*([\d,]+)\s*(?:bytes?\b|字节)[\s)）。.，,;-]*SHA[- ]?256\s*[:：=]?\s*\x60?([a-f\d]{64})(?![a-f\d])/i.exec(details)
   if(!version)continue
   const bytes=Number(version[1]!.replaceAll(',',''))
   if(Number.isSafeInteger(bytes))return [{path,name,bytes,sha256:version[2]!.toLowerCase()}]
  }
  return []
 })
}
