import {MarkdownTextPrimitive} from '@assistant-ui/react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import {normalizeMath,remarkDisplayMath} from './math.ts'
import {CopyButton} from './copy-button.tsx'
import 'katex/dist/katex.min.css'

export default function Markdown({L}:{L:(en:string,zh:string)=>string}){
  return <MarkdownTextPrimitive smooth={false} defer preprocess={normalizeMath}
    remarkPlugins={[remarkGfm,remarkMath,remarkDisplayMath]}
    rehypePlugins={[[rehypeKatex,{trust:false,strict:'ignore',maxExpand:1000}]]}
    components={{img:({alt})=><span>{alt}</span>,CodeHeader:({language,code})=><div className="code-header"><span>{language}</span><CopyButton value={code} L={L} label={L('Copy code','复制代码')}/></div>}}/>
}
