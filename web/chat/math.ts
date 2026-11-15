import {unified} from 'unified'
import remarkParse from 'remark-parse'
import type {Root,RootContent} from 'mdast'

const parser=unified().use(remarkParse)
/** Normalize ChatGPT-style delimiters, preserving Markdown code and destinations. */
export function normalizeMath(text:string){
  if(!/\\[([]/.test(text))return text
  const protectedRanges:{start:number;end:number}[]=[]
  function walk(node:Root|RootContent){
    if(['code','inlineCode','html','link','image','definition'].includes(node.type)){
      if(node.position)protectedRanges.push({start:node.position.start.offset!,end:node.position.end.offset!})
    }else if('children' in node)for(const child of node.children)walk(child as RootContent)
  }
  walk(parser.parse(text))
  return text.replace(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g,(match,inline,block,offset:number)=>{
    if(text[offset-1]==='\\'||protectedRanges.some(r=>offset<r.end&&offset+match.length>r.start))return match
    return inline!==undefined?'$'+inline+'$':'$$'+block+'$$'
  })
}
/** Double-dollar inline expressions are display math, even when sent on one line. */
export function remarkDisplayMath(){
  return (tree:Root,file:{value:unknown})=>{
    const text=String(file.value)
    function walk(node:any){
      if(node.type==='inlineMath'&&text.slice(node.position.start.offset,node.position.start.offset+2)==='$$')node.data.hProperties.className=['language-math','math-display']
      if(node.children)for(const child of node.children)walk(child)
    }
    walk(tree)
  }
}
