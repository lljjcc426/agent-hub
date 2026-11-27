import type {SourceConfig} from './config.ts'

export const supportsConnectorResourceControls=(kind:string)=>['feishu','slack','wecom'].includes(kind)
export function connectorResourceAccess(source:SourceConfig,capability:'history'|'files'){
 return source.enabled&&source.capabilities.resources&&(!supportsConnectorResourceControls(source.kind)||source.resourceAccess?.[capability]!==false)
}
export function assertConnectorResourceAccess(source:SourceConfig,resource:string){
 if(!source.enabled||!source.capabilities.resources)throw Error('Source does not provide enabled resource reads')
 if(!supportsConnectorResourceControls(source.kind)||resource==='message')return
 const capability=/^(file|image|asset)\//.test(resource)?'files':'history'
 if(!connectorResourceAccess(source,capability))throw Error(capability==='files'?'Connection file access is disabled':'Connection history access is disabled')
}
