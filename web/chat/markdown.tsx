import {defaultUrlTransform} from 'react-markdown'
import type {ChatDelivery} from '../../src/chat-deliveries.ts'
import {deliveryHref} from './delivery-links.ts'
import {MarkdownTextPrimitive, type SyntaxHighlighterProps} from '@assistant-ui/react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import {normalizeMath,remarkDisplayMath} from './math.ts'
import {CopyButton} from './copy-button.tsx'
import 'katex/dist/katex.min.css'

function DiffCode({code, components: {Pre, Code}}: SyntaxHighlighterProps) {
  const lines = code.replace(/\n$/, '').split('\n')
  return <Pre className="appearance-diff"><Code>{lines.map((line, index) => {
    const change = line.startsWith('+') && !/^\+\+\+\s/.test(line) ? 'add' : line.startsWith('-') && !/^---\s/.test(line) ? 'remove' : null
    return <span key={index} className={'appearance-diff-line' + (change ? ' appearance-diff-' + change : '')}>{change ? <><span className="appearance-diff-marker">{line[0]}</span>{line.slice(1)}</> : line}</span>
  })}</Code></Pre>
}

export default function Markdown({L,files}:{L:(en:string,zh:string)=>string;files?:ChatDelivery[]}){
  return <MarkdownTextPrimitive smooth={false} defer preprocess={normalizeMath}
    componentsByLanguage={{diff: {SyntaxHighlighter: DiffCode}}}
    remarkPlugins={[remarkGfm,remarkMath,remarkDisplayMath]}
    rehypePlugins={[[rehypeKatex,{trust:false,strict:'ignore',maxExpand:1000}]]}
    urlTransform={url=>defaultUrlTransform(files?deliveryHref(url,files):url)}
    components={{a:({href,children})=>href?<a href={href}>{children}</a>:<span>{children}</span>,img:({alt})=><span>{alt}</span>,CodeHeader:({language,code})=><div className="code-header"><span>{language}</span><CopyButton value={code} L={L} label={L('Copy code','复制代码')}/></div>}}/>
}
