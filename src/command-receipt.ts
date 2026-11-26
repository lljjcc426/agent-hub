import {stripVTControlCharacters} from 'node:util'
import {z} from 'zod'
import {protocolBytes,textPage} from './context-budget.ts'
import {isTestCommand,reportedTestCounts} from './test-output.ts'
import type {WorkManager} from './work.ts'

export const commandOutputMode=z.enum(['summary','full'])
export type CommandOutputMode=z.infer<typeof commandOutputMode>
const pageCharacters=2048

/** Only the model-facing view changes. The owned job keeps the original log and cursors. */
export function commandReceipt(job:ReturnType<WorkManager['view']>,mode:CommandOutputMode|undefined,
 readTail:(characters:number)=>string){
 if(mode==='full'||job.outputOffset!==0||typeof job.exitCode!=='number'||
   job.outputCharacters<=2*pageCharacters||mode!=='summary'&&!isTestCommand(job.command??''))return job
 const head=textPage(job.output,0,pageCharacters)
 const offset=job.outputCharacters-pageCharacters
 const raw=job.nextOffset===null?job.output.slice(offset):readTail(pageCharacters)
 const split=/^[\uDC00-\uDFFF]/.test(raw)
 const tail=split?raw.slice(1):raw
 const plainTail=stripVTControlCharacters(tail)
 const reportedTests=reportedTestCounts(plainTail)
 const reportedFailures=job.exitCode===0?[]:[...new Set((stripVTControlCharacters(head.text)+'\n'+plainTail).match(/^(?:FAILED [^ (\r\n]|FAIL: |not ok \d+)[^\r\n]*/gm)??[])]
  .slice(0,4).map(line=>textPage(line,0,240).text)
 const preview={...job,output:head.text,nextOffset:head.text.length,outputTail:{offset:offset+Number(split),text:tail},
  ...(reportedTests?{reportedTests}:{}),...(reportedFailures.length?{reportedFailures}:{})}
 return protocolBytes(preview)<protocolBytes(job)?preview:job
}
