import {z} from 'zod'
import type {ToolSpec} from './model.ts'

export const chatStatusSchema=z.object({
 phase:z.enum(['thinking','working','reviewing']),
 label:z.string().trim().min(1).max(48).refine(value=>!/[\r\n\x00-\x1f]/.test(value),'Use one short line'),
}).strict()
export type ChatStatus= z.infer<typeof chatStatusSchema> & {updatedAt:number}
export const chatStatusTool={
 type:'function',name:'superagent_status',
 description:'Update the short public Chat status for your current work. Use the user language, about 6–12 Chinese characters or 3–7 words, e.g. 正在审查输入组件. Report only an observable task stage, without private reasoning, secrets, or a claim of completion. Call once when starting substantial work and when the stage changes, not for every step. This only updates the interface; it does not send a message or change task state.',
 inputSchema:{type:'object',additionalProperties:false,properties:{phase:{type:'string',enum:['thinking','working','reviewing']},label:{type:'string',minLength:1,maxLength:48}},required:['phase','label']},
} satisfies ToolSpec

export const openingStatusSchema=chatStatusSchema.extend({
 opening:z.string().trim().min(1).max(240).regex(/^[^\r\n\x00-\x1f]+$/).optional(),
})
export const openingStatusTool:ToolSpec={
 ...chatStatusTool,
 description:'Update the public Chat status in the user’s language. Before starting substantial work, include one short opening sentence telling the user the specific first step you intend to take. Chat already acknowledged receipt. Skip greetings, internal reasoning and claims of results. Later calls only need the phase and label.',
 inputSchema:{...chatStatusTool.inputSchema,properties:{...chatStatusTool.inputSchema.properties,opening:{type:'string',maxLength:240}}},
}

// Use only recognized public operations when a model goes straight to its first tool.
export function openingForAction(name:string,args:unknown,locale:'zh-CN'|'en'){
 const action=typeof args==='object'&&args!==null&&'action' in args?args.action:undefined
 const zh=locale==='zh-CN'
 if(name==='worker_manage'){
   if(action==='list')return zh?'我先核对一下团队成员。':'I’ll check who’s on the team.'
   if(action==='assign')return zh?'我先把这项工作交给负责的同事。':'I’ll hand this task to the teammate who will handle it.'
   if(action==='inspect'||action==='result')return zh?'我先查看这项任务的最新记录。':'I’ll check the latest record for this task.'
 }
 if(name==='router_read')return zh?'我先查看相关资料。':'I’ll look through the relevant material.'
 if(name==='workspace_browser')return zh?'我先查看工作区的浏览器。':'I’ll check the workspace browser.'
 if(name==='chat_deliver_file')return zh?'我先准备要交付的文件。':'I’ll prepare the file for you.'
}
