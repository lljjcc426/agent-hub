import { latestDue, nextTime } from '../../src/schedule-calendar.ts'
import type { ChatSchedule } from '../../src/chat-schedules.ts'
import { sampleWorkbook } from './delivery.tsx'
import { reply } from './chat.tsx'

export function sampleSchedule(): ChatSchedule<typeof sampleWorkbook & {id:string}> {
  const timing = { kind:'weekly' as const, timezone:'Asia/Shanghai', startAt:'2025-01-01T00:00:00+08:00', time:'09:42', weekdays:[1,2,3,4,5] }
  const now = Date.now(), at = latestDue(timing,nextTime(timing,now-8*86400000)!,now)
  return { id:'release-checklist',name:'发布清单',prompt:'按负责人整理发布检查项，在对话里交付清单。',timing, active:true,revision:1,nextAt:nextTime(timing,now),
    lastRun:{id:'release',at,state:'completed'},lastResult:{at,messageId:'reply',text:reply,files:[{...sampleWorkbook,id:'checklist'}]} }
}
