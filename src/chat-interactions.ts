import {unified} from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type {Root,RootContent} from 'mdast'

export interface ChatQuote {messageId:string;excerpt?:string}
export interface ChatQuoteView {messageId:string;text:string;role:'user'|'assistant';label:string;speakerId?:string;unavailable?:boolean}

const markdown=unified().use(remarkParse).use(remarkGfm).use(remarkMath)
/** The same text leaves as the chat renderer, without Markdown decoration. */
export function messageText(value:string){
  function text(node:Root|RootContent):string {
    if('value' in node)return node.type==='html'?'':node.value
    if(node.type==='image')return node.alt??''
    if(node.type==='break')return '\n'
    if('children' in node)return node.children.map(child=>text(child as RootContent)).join(['root','list','table','tableRow','listItem','blockquote'].includes(node.type)?'\n':'')
    return ''
  }
  return text(markdown.parse(value)).trim()
}
export const normalizeExcerpt=(text:string)=>text.replace(/\s+/gu,' ').trim()
export const isReaction=(value:string)=>value.length<=32&&[...new Intl.Segmenter('en',{granularity:'grapheme'}).segment(value)].length===1&&/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value)
