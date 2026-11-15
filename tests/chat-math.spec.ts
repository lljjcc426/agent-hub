import {it,expect} from 'vitest'
import {unified} from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import {normalizeMath,remarkDisplayMath} from '../web/chat/math.ts'

it('normalizes ChatGPT delimiters without rewriting code, links, escaped examples or incomplete streaming math',()=>{
 const source=String.raw`Inline \(x^2\), display \[\frac{1}{2}\], and \(unfinished.

${"`"}\(code\)${"`"}

~~~latex
\[a+b\]
~~~

[link](https://example.com/\(literal\))
\\(escaped\\)`
 const normalized=normalizeMath(source)
 expect(normalized).toContain('Inline $x^2$, display $$\\frac{1}{2}$$, and \\(unfinished.')
 expect(normalized).toContain('~~~latex\n\\[a+b\\]\n~~~')
 expect(normalized).toContain('`\\(code\\)`')
 expect(normalized).toContain('[link](https://example.com/\\(literal\\))')
 expect(normalized).toContain('\\\\(escaped\\\\)')
})

it('distinguishes inline and display math and preserves GFM tables with formulas',()=>{
 const parser=unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkDisplayMath)
 const text=normalizeMath(String.raw`A $x^2$ and \(y^2\).

$$x = \frac{-b\pm\sqrt{b^2-4ac}}{2a}$$

\[
\begin{bmatrix}1&2\\3&4\end{bmatrix}
\]

| Term | Value |
| --- | --- |
| Square | $x^2$ |`)
 const tree=parser.runSync(parser.parse(text),{value:text}),nodes:any[]=[]
 function visit(node:any){nodes.push(node);for(const child of node.children??[])visit(child)}visit(tree)
 expect(nodes.filter(n=>n.type==='inlineMath')).toHaveLength(4)
 expect(nodes.find(n=>n.value?.startsWith('x =')).data.hProperties.className).toContain('math-display')
 expect(nodes.filter(n=>n.type==='math')).toHaveLength(1);expect(nodes.filter(n=>n.type==='table')).toHaveLength(1)
})
