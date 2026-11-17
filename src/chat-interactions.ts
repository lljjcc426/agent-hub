import {unified} from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type {Root,RootContent} from 'mdast'
import {z} from 'zod'
import type {ToolSpec} from './model.ts'

export interface ChatQuote {messageId:string;excerpt?:string}
export interface ChatQuoteView {messageId:string;text:string;role:'user'|'assistant';label:string;speakerId?:string;unavailable?:boolean}
export interface AgentReaction {emoji:string;actor:{id:string;label:string;kind:'router'};at:number}
export const chatReactionSchema=z.object({messageId:z.string().min(1),emoji:z.string().refine(value=>isReaction(value),'Choose a single emoji.'),active:z.boolean().default(true)}).strict()
export const chatReactionSpec:ToolSpec={type:'function',name:'chat_react',description:'Add or remove your own emoji reaction to a message in this built-in Chat. Use exact messageId values from chat.messages or chat.feedback. React selectively when it feels natural; do not react to every message or mirror every user reaction. A reaction can stand alone: return an empty reply when no text is needed. This never changes the user’s reactions.',inputSchema:{type:'object',properties:{messageId:{type:'string'},emoji:{type:'string'},active:{type:'boolean'}},required:['messageId','emoji'],additionalProperties:false}}

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
