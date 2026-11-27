import {z} from 'zod'
import {chatUploadLimits} from './execution-limits.ts'
import type {ToolSpec} from './model.ts'

export function imagePreviewMime(bytes:Uint8Array){
  const header=Buffer.from(bytes.subarray(0,12))
  if(header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png'
  if(header[0]===255&&header[1]===216)return 'image/jpeg'
  if(['GIF87a','GIF89a'].includes(header.subarray(0,6).toString()))return 'image/gif'
  if(header.subarray(0,4).toString()==='RIFF'&&header.subarray(8,12).toString()==='WEBP')return 'image/webp'
}

export const chatSendImagesInput=z.object({
  requestId:z.string().trim().min(1).max(100),
  images:z.array(z.string().trim().min(1).max(1024)).min(1).max(chatUploadLimits.maxFiles),
  caption:z.string().trim().max(4000).optional(),
}).strict()

export const chatSendImagesTool={
  type:'function',name:'chat_send_images',
  description:'Send images directly to the user in the current Chat as one standalone message, with an optional caption in the user language. Call when you want the user to see the images now, then continue work. Use a browser screenshot resource (asset/<id>) from this task or files relative to your current workspace. Keep formal deliverables that need approval or acceptance on the normal delivery path. Reuse requestId only when retrying the same message.',
  inputSchema:{type:'object',additionalProperties:false,properties:{
    requestId:{type:'string',minLength:1,maxLength:100},
    images:{type:'array',minItems:1,maxItems:chatUploadLimits.maxFiles,items:{type:'string',minLength:1,maxLength:1024}},
    caption:{type:'string',maxLength:4000},
  },required:['requestId','images']},
} satisfies ToolSpec
