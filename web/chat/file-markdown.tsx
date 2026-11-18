import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { normalizeMath, remarkDisplayMath } from './math.ts'
import 'katex/dist/katex.min.css'

export default function FileMarkdown({ text }: { text: string }) {
  return (
    <div className="delivery-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, remarkDisplayMath]}
        rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000 }]]}
        components={{
          img: ({ alt }) => <span>{alt}</span>,
          a: ({ href, children }) => href && /^https?:\/\//i.test(href)
            ? <a href={href} target="_blank" rel="noreferrer">{children}</a>
            : <span>{children}</span>,
        }}>
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  )
}
