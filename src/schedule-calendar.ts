import type {Timing} from './schedule-time.ts'

const formats=new Map<string,Intl.DateTimeFormat>()
function parts(at:number,zone:string){
 let f=formats.get(zone);if(!f){f=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});formats.set(zone,f)}
 return Object.fromEntries(f.formatToParts(at).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)])) as Record<string,number>
}
/** Resolve a local wall time. Gaps have no occurrence; folds use the first instant. */
function wall(year:number,month:number,day:number,hour:number,minute:number,zone:string){
 const nominal=Date.UTC(year,month-1,day,hour,minute),offsets=new Set<number>()
 for(const h of [-36,-12,0,12,36]){const at=nominal+h*3600000,p=parts(at,zone);offsets.add(Date.UTC(p.year!,p.month!-1,p.day!,p.hour!,p.minute!,p.second!)-at)}
 return [...offsets].map(o=>nominal-o).filter(at=>{const p=parts(at,zone);return p.year===year&&p.month===month&&p.day===day&&p.hour===hour&&p.minute===minute}).sort((a,b)=>a-b)[0]
}
/** Browser date fields carry a wall time in the schedule's zone, not the browser's zone. */
export function localDateTime(at:number,zone:string){
 const p=parts(at,zone),pad=(n:number)=>String(n).padStart(2,'0')
 return `${p.year}-${pad(p.month!)}-${pad(p.day!)}T${pad(p.hour!)}:${pad(p.minute!)}:${pad(p.second!)}`
}
export function wallInstant(value:string,zone:string){
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
 if(!match)return undefined
 const [,y,m,d,h,min,sec]=match
 if(Number(sec??0)>59)return undefined
 const at=wall(Number(y),Number(m),Number(d),Number(h),Number(min),zone)
 return at===undefined?undefined:at+Number(sec??0)*1000
}
// Two weekly cycles plus a day for timezone offset changes. A missing wall time
// (or an entire skipped local date) must not exhaust a recurring schedule.
const calendarHorizonDays=15
/** Inclusive lower bound; gaps are skipped and folds execute only once. */
export function nextTime(t:Timing,after:number):number|undefined{
 const start=Date.parse(t.startAt),from=Math.max(start,after),end=t.endAt?Date.parse(t.endAt):Infinity
 let found:number|undefined
 if(t.kind==='once')found=start>=after?start:undefined
 else if(t.kind==='interval')found=start+Math.max(0,Math.ceil((from-start)/(t.intervalSeconds!*1000)))*t.intervalSeconds!*1000
 else{
  const p=parts(from,t.timezone),[h,m]=t.time!.split(':').map(Number)
  for(let n=0;n<=calendarHorizonDays;n++){
   const d=new Date(Date.UTC(p.year!,p.month!-1,p.day!+n))
   if(t.kind==='weekly'&&!t.weekdays!.includes(d.getUTCDay()))continue
   const at=wall(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate(),h!,m!,t.timezone)
   if(at!==undefined&&at>=from){found=at;break}
  }
 }
 return found!==undefined&&found<=end?found:undefined
}
/** Coalesce an offline backlog into the latest due occurrence, never a replay burst. */
export function latestDue(t:Timing,first:number,now:number):number{
 if(t.kind==='once')return first
 if(t.kind==='interval')return first+Math.floor((now-first)/(t.intervalSeconds!*1000))*t.intervalSeconds!*1000
 let candidate=nextTime(t,Math.max(first,now-calendarHorizonDays*86400000)),latest=first
 while(candidate!==undefined&&candidate<=now){latest=candidate;candidate=nextTime(t,candidate+1)}
 return latest
}
