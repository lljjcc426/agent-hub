import {z} from 'zod'
import {desktopObservation} from './cua-desktop.ts'
import {deliverChatArtifactInput,findChatArtifactInput} from './chat-retained-artifacts.ts'

const prerequisite=z.object({id:z.string().min(1)}).strict()
/** Only observation tools. Desktop typing, scripts and other inputs may contain credentials. */
export function observationRequest(name:string,args:unknown){
 const schema=name==='chat_artifact_find'?findChatArtifactInput:name==='chat_artifact_open'?deliverChatArtifactInput:
  name==='superagent_artifact_read'?prerequisite:undefined
 if(name==='superagent_desktop')return desktopObservation(args)
 if(schema?.safeParse(args).success)return {tool:name,args}
}
