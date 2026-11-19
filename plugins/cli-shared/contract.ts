import type {ModelRequest} from '../backend-sdk.ts'
export interface CliConfig {
 command:string;args?:string[];cliVersion:string;model?:string;authDirectory?:string
 apiProtocol?:'openai-responses'|'openai-chat'|'anthropic'
 baseUrl?:string;provider?:string;authMode?:'credentials'|'anonymous'
}
export interface NativeEvent {session?:string;model?:string;text?:string;final?:string;done?:boolean;error?:string;tool?:string;callId?:string;toolError?:boolean;usage?:import('../../src/model-usage.ts').ModelUsage}
export interface LaunchContext {
 config:CliConfig;root:string;cwd:string;nativeId?:string;newId:string
 guardPlugin?:string;request:ModelRequest;mcp:{url:string;token:string};prompt:string
}
export interface CliDriver {
 workspaceTools?(mode:ModelRequest['harnessWorkspace']):string[]
 nativeTools?(request:ModelRequest):string[]
 workspaceGuard?(root:string,request:ModelRequest,turnId:string):{url:string;ready:()=>boolean;operations:()=>{tool:string;path?:string;id:string}[]}
 taskListTool:string
 id:string;version:string;credentialEnvs:string[]
 upstream(config:CliConfig,model?:string):string
 credentialKeys?(config:CliConfig):string[]
 anonymous?(config:CliConfig):boolean
 prepare(context:LaunchContext):{args:string[];env:Record<string,string>;stdin:string}
 event(value:any):NativeEvent
 toolName(native:string):string|undefined
 discoverSession?(root:string):string|undefined
 auth?(directory:string,config:CliConfig):{identity:string;files:{source:string;target:string}[]}|undefined
}
