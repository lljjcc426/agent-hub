import ReactMarkdown,{defaultUrlTransform} from 'react-markdown'
import type {ChatDelivery} from '../../src/chat-deliveries.ts'
import {deliveryHref} from './delivery-links.ts'
import {MarkdownTextPrimitive} from '@assistant-ui/react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import {normalizeMath,remarkDisplayMath} from './math.ts'
import {CopyButton} from './copy-button.tsx'
import 'katex/dist/katex.min.css'

export default function Markdown({L,files}:{L:(en:string,zh:string)=>string;files?:ChatDelivery[]}){
  return <MarkdownTextPrimitive smooth={false} defer preprocess={normalizeMath}
    remarkPlugins={[remarkGfm,remarkMath,remarkDisplayMath]}
    rehypePlugins={[[rehypeKatex,{trust:false,strict:'ignore',maxExpand:1000}]]}
    urlTransform={url=>defaultUrlTransform(files?deliveryHref(url,files):url)}
    components={{a:({href,children})=>href?<a href={href}>{children}</a>:<span>{children}</span>,img:({alt})=><span>{alt}</span>,CodeHeader:({language,code})=><div className="code-header"><span>{language}</span><CopyButton value={code} L={L} label={L('Copy code','复制代码')}/></div>}}/>
}

export function FileMarkdown({text}:{text:string}){
  return <div className="delivery-markdown"><ReactMarkdown remarkPlugins={[remarkGfm,remarkMath,remarkDisplayMath]} rehypePlugins={[[rehypeKatex,{trust:false,strict:'ignore',maxExpand:1000}]]}
    components={{img:({alt})=><span>{alt}</span>,a:({href,children})=>href&&/^https?:\/\//i.test(href)?<a href={href} target="_blank" rel="noreferrer">{children}</a>:<span>{children}</span>}}>{normalizeMath(text)}</ReactMarkdown></div>
}
