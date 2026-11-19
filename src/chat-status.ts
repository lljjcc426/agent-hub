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

export const firstReplySchema={
 type:'object',additionalProperties:false,required:['reply','opening'],
 properties:{reply:{type:'string'},opening:{type:'string'}},
}

export const chatOpeningSchema=z.object({
  text:z.string().trim().min(1).max(320).refine(value=>!/[\r\n\x00-\x1f]/.test(value),'Use one short line'),
}).strict()

export const chatOpeningTool={
  type:'function',name:'chat_opening',
  description:'Publish the one model-authored Chat opening before starting substantive work. Write one short first-person sentence in the user language that names the concrete next step. Include this call first in the same tool batch as independent reads. For a direct answer without tools, reply normally.',
  inputSchema:{type:'object',additionalProperties:false,required:['text'],properties:{text:{type:'string',minLength:1,maxLength:320}}},
} satisfies ToolSpec
export const firstReplyInstructions=[
 'Speak to the user in your usual voice and reply language. This is your first turn for this message. No tools or execution are available yet.',
 'When you can fully answer from the conversation and your knowledge, put the answer in reply and leave opening empty. This includes greetings and clarifying questions.',
 'When the request needs a lookup, files, a tool, delegation, or verification of current state, leave reply empty. Write a short, original opening in the first person. Name what you will actually check or do first and, where it matters, how you will verify the result. Respect the exact scope the user gave you.',
 'The opening is shown verbatim to the user before you receive tools. Go straight to the concrete step. Omit stock acknowledgements, private reasoning, and claims that you already did the work.',
].join(' ')
