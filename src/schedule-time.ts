import {z} from 'zod'

const timestamp=z.string().datetime({offset:true})
export const timingInputSchema=z.object({
 kind:z.enum(['once','interval','daily','weekly']), timezone:z.string().optional(),
 startAt:timestamp, endAt:timestamp.optional(), intervalSeconds:z.number().int().min(60).optional(),
 time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), weekdays:z.array(z.number().int().min(0).max(6)).min(1).optional(),
}).strict().superRefine((v,c)=>{
 try{new Intl.DateTimeFormat('en',{timeZone:v.timezone}).format()}catch{c.addIssue({code:'custom',message:'Use an IANA timezone'})}
 if(v.endAt&&Date.parse(v.endAt)<=Date.parse(v.startAt))c.addIssue({code:'custom',message:'endAt must be after startAt'})
 if(v.kind==='interval'&&!v.intervalSeconds)c.addIssue({code:'custom',message:'intervalSeconds required'})
 if(['daily','weekly'].includes(v.kind)&&!v.time)c.addIssue({code:'custom',message:'Local time required'})
 if(v.kind==='weekly'&&!v.weekdays)c.addIssue({code:'custom',message:'weekdays required (Sunday = 0)'})
})
export const timingSchema=timingInputSchema.transform(t=>({...t,timezone:t.timezone??'Asia/Shanghai'}))
export type Timing=z.infer<typeof timingSchema>
export {nextTime,latestDue} from './schedule-calendar.ts'
