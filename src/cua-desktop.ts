import {randomUUID} from 'node:crypto'
import {mkdirSync, realpathSync, rmSync} from 'node:fs'
import {join} from 'node:path'
import {z} from 'zod'
import {BrowserError} from './browser-contract.ts'
import {captureLimit} from './browser-recording.ts'
import {DesktopRuntime} from './desktop-runtime.ts'
import type {ToolConnection} from './connector-config.ts'
import {evidenceBytes} from './goal-artifacts.ts'
import {maxInlineImageBytes} from './execution-limits.ts'
import type {Runtime} from './runtime.ts'
import {bodyDigest, stableDigest} from './sources.ts'
import type {ToolResult} from './chat-permissions.ts'
import type {WorkOwner} from './work.ts'

const observations = ['check_permissions', 'list_apps', 'list_windows', 'get_window_state', 'get_desktop_state', 'verify_state', 'zoom'] as const
const interactions = ['launch_app', 'click', 'double_click', 'right_click', 'scroll', 'drag', 'type_text', 'press_key', 'hotkey',
  'set_value', 'run_steps', 'run_script'] as const
const recordings = ['start_recording', 'stop_recording', 'get_recording_state'] as const
const nativeTools = [...observations, ...interactions, ...recordings]
type NativeAction = typeof nativeTools[number]
const actions = ['schema', ...nativeTools] as const
const argumentHelp = 'Roppo supplies the desktop session, output paths and permission settings. A session name cannot select an isolated OS desktop.'
const reserved = new Set(['session','screenshot_out_file','output_dir','prompt','probe_direct_capture'])
function hasHostArgument(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key,item]) => reserved.has(key) || hasHostArgument(item))
}
export function desktopArgumentError(args: Record<string,unknown>) {
  if (JSON.stringify(args).length > 100_000) return 'Desktop arguments exceed the size limit.'
  if (hasHostArgument(args)) return argumentHelp
}
const inputs = z.record(z.string(), z.unknown()).superRefine((args,ctx)=>{
  const message=desktopArgumentError(args)
  if(message)ctx.addIssue({code:'custom',message})
})
const desktopInput = z.object({
  action:z.enum(actions),
  arguments:inputs.optional(),
  requestId:z.string().min(1).max(200),
  durationMs:z.number().int().min(1000).max(180_000).optional(),
  inlineImage:z.boolean().optional(),
}).strict()
type DesktopInput = z.infer<typeof desktopInput>
export function desktopObservation(args:unknown){
 const parsed=desktopInput.safeParse(args)
 if(parsed.success&&observations.some(a=>a===parsed.data.action))return {tool:'superagent_desktop',args}
}
export const desktopNeedsApproval = (action: unknown) => interactions.some(value => value === action) || action === 'start_recording'
export const desktopToolDefinition = {
  name:'superagent_desktop',
  description:'Control native desktop apps using the Roppo desktop runtime. Use superagent_browser for websites. Use schema with arguments.tool to read the installed driver schema first. Omit host-managed fields such as session. A session name does not select a separate OS desktop. Discover apps and windows, then prefer get_window_state with include_screenshot:false for structured observation. For a window PNG set include_screenshot:true; get_desktop_state captures the primary display. Both return a task attachment; set inlineImage only if the model accepts images. Start_recording records the primary display and stops at durationMs (default 60 seconds) or when stopped. Stop_recording returns the finalized MP4 attachment. Verify the visible result after actions. If desktop permissions are missing, direct the user to Settings > Browser > Desktop control. Reuse requestId for identical inputs. Inspect uncertain actions before issuing a new write.',
  validator:desktopInput,
  schema:{type:'object',additionalProperties:false,required:['action','requestId'],properties:{
    action:{type:'string',enum:actions},
    arguments:{type:'object',additionalProperties:true},
    requestId:{type:'string',maxLength:200},
    durationMs:{type:'integer',minimum:1000,maximum:180_000},
    inlineImage:{type:'boolean'},
  }},
} as const

type Recording = {owner:WorkOwner; directory:string; initialized?:Promise<void>; timer?:ReturnType<typeof setTimeout>; ending?:Promise<unknown>}
type Receipt = {fingerprint:string; state:'running'|'complete'|'uncertain'; result?:ToolResult}
const binding = (owner:WorkOwner) => [owner.ticketId,owner.assignmentId,owner.agentId ?? '']
const sessionName = (owner:WorkOwner) => 'roppo-' + bodyDigest(binding(owner)).slice(0,24)
const connectionId = 'cua-driver'
const elapsed = 60_000
const output = (value:unknown,success=true):ToolResult => ({success,contentItems:[{type:'inputText',text:JSON.stringify(value)}]})
export class CuaDesktop {
  private recording?: Recording
  private readonly calls = new Map<string, {fingerprint:string; result:Promise<ToolResult>}>()
  readonly runtime: DesktopRuntime
  constructor(private host: Runtime) {
    this.runtime=new DesktopRuntime(host.config.stateDir,host.config.browser.cuaCommand)
  }

  private async config(): Promise<ToolConnection> {
    const command = await this.runtime.prepare()
    const env=Object.fromEntries((process.platform==='linux'?[
      'DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','XAUTHORITY',
    ]:[]).filter(key=>process.env[key]).map(key=>[key,key]))
    return {enabled:true,transport:{kind:'stdio',command,args:['mcp'],env},allowedTools:[...nativeTools],timeoutMs:elapsed}
  }

  private async native(name: NativeAction, args: Record<string,unknown>, check:()=>void, signal?:AbortSignal) {
    check()
    const config = await this.config()
    check()
    const tools = await this.host.toolConnections.inspectManaged(connectionId,config,{},signal)
    const tool = tools.find(tool => tool.name === name)
    if(!tool)throw new BrowserError('cua_driver_tool_missing','The installed Cua Driver does not advertise '+name+'.',503)
    const call = await this.host.toolConnections.invokeManaged(connectionId,config,{},tool,args,check,signal)
    if('invalid' in call)return {ok:false,images:[],value:{code:'cua_driver_arguments',message:'The action was not sent. Check the installed tool schema.'}}
    const result = call.result
    const content = 'content' in result && Array.isArray(result.content) ? result.content : []
    const structured = result.structuredContent
    const value:Record<string,unknown> = structured && typeof structured==='object' ? {...structured} :
      {message:content.filter(item=>item.type==='text').map(item=>item.text).join('\n')}
    return {value, ok:result.isError !== true && value.ok !== false && value.status !== 'refused',
      images:content.filter(item=>item.type==='image'&&item.mimeType==='image/png')}
  }

  async call(owner: WorkOwner, input: DesktopInput, check:()=>void, signal?:AbortSignal):Promise<ToolResult> {
    check()
    const {action}=input, args=input.arguments ?? {}
    const invalid=desktopArgumentError(args)
    if(invalid)return output({code:'cua_driver_arguments',message:invalid},false)
    if(action==='schema'){
      const config=await this.config()
      check()
      const tools=await this.host.toolConnections.inspectManaged(connectionId,config,{},signal)
      return output({provider:'cua-driver',hostManagedArguments:[...reserved],tools:args.tool ? tools.filter(t=>t.name===args.tool) : tools.map(t=>t.name)})
    }
    if(!desktopNeedsApproval(action))return this.perform(owner,input,check,signal)
    const id=bodyDigest([...binding(owner),input.requestId]),fingerprint=stableDigest(input)
    const pending=this.calls.get(id)
    const saved=this.host.store.get<Receipt>('desktop-receipt',id)
    if(pending&&pending.fingerprint!==fingerprint||saved&&saved.fingerprint!==fingerprint)
      throw new BrowserError('cua_request_reused','requestId was reused with different input.')
    if(pending)return pending.result
    if(saved){
      if(saved.state==='complete')return saved.result!
      throw new BrowserError('cua_uncertain','The previous desktop action has an uncertain result. Inspect the app or recording before retrying.')
    }
    const write=(state:Receipt['state'],result?:ToolResult)=>this.host.store.put('desktop-receipt',id,
      {id,ticketId:owner.ticketId,fingerprint,state,result})
    write('running')
    const result=this.perform(owner,input,check,signal).then(value=>{write('complete',value);return value},
      error=>{write('uncertain');throw error}).finally(()=>this.calls.delete(id))
    this.calls.set(id,{fingerprint,result})
    return result
  }

  private async perform(owner: WorkOwner, input: DesktopInput, check:()=>void, signal?:AbortSignal):Promise<ToolResult> {
    const action=input.action as NativeAction
    const args={...input.arguments,session:sessionName(owner)}
    if(action==='start_recording')return output(await this.startRecording(owner,input.durationMs ?? elapsed,check,signal))
    if(action==='stop_recording'){
      const recording=this.recording
      if(recording&&sessionName(recording.owner)===args.session)return output(await this.stopRecording(recording))
      const previous=this.host.store.get<{assetId:string}>('desktop-recording',args.session)
      const asset=previous&&this.host.store.get('asset',previous.assetId)
      if(asset)return output({provider:'cua-driver',recording:asset})
      throw new BrowserError('cua_recording_owner','This assignment has no desktop recording to stop.')
    }
    if(action==='get_recording_state'){
      const {value}=await this.native(action,args,check,signal)
      return output({recording:value.enabled===true,ownedByThisTask:this.recording&&sessionName(this.recording.owner)===args.session})
    }
    if(action==='check_permissions')Object.assign(args,{prompt:false})
    if(action==='get_window_state')Object.assign(args,{
      include_screenshot:input.arguments?.include_screenshot===true,
      screenshot_format:'png',
    })
    const result=await this.native(action,args,check,signal)
    check()
    const screen=result.images.find(item=>typeof item.data==='string')
    const expectsImage=action==='get_desktop_state'||action==='get_window_state'&&input.arguments?.include_screenshot===true
    if(!result.ok||expectsImage&&!screen){
      return output({provider:'cua-driver',result:result.value,...(!screen&&expectsImage?{
        capture:'Unavailable. Check Cua Driver Screen Recording permission and the target window.'
      }:{})},false)
    }
    const screenshot=screen ? this.host.browser.saveCapture(owner,'image/png',Buffer.from(screen.data,'base64')) : undefined
    const reply=output({provider:'cua-driver',result:result.value,...(screenshot?{screenshot}:{})})
    if(screen&&screenshot&&input.inlineImage&&screenshot.bytes<=maxInlineImageBytes)
      reply.contentItems.push({type:'inputImage',imageUrl:'data:image/png;base64,'+screen.data})
    return reply
  }

  private async startRecording(owner: WorkOwner, durationMs:number, check:()=>void, signal?:AbortSignal) {
    if(this.recording)throw new BrowserError('cua_recording_busy','Another desktop recording is active.')
    const directory=join(this.host.config.stateDir,'browser','cua-recordings',randomUUID())
    mkdirSync(directory,{recursive:true,mode:0o700})
    const recording:Recording={owner,directory:realpathSync(directory)}
    this.recording=recording
    const session=sessionName(owner)
    recording.initialized=(async()=>{
      const {value,ok}=await this.native('get_recording_state',{session},check,signal)
      if(!ok||value.enabled)throw new BrowserError('cua_recording_busy','Cua Driver reports an existing recording.')
      const start=await this.native('start_recording',{session,output_dir:recording.directory,record_video:true,include_accessibility_tree:false},check,signal)
      if(!start.ok||start.value.video_active!==true)
        throw new BrowserError('cua_recording_unavailable','Cua Driver could not start screen video. Check Screen Recording permission and direct capture consent.')
    })()
    try {
      await recording.initialized
      check()
      if(recording.ending)throw new BrowserError('cua_recording_ended','This desktop recording is closing.')
      recording.timer=setTimeout(()=>void this.stopRecording(recording).catch(()=>{}),durationMs)
      recording.timer.unref()
      return {provider:'cua-driver',state:'recording',scope:'primary_display',durationMs}
    } catch(error) {
      await this.stopRecording(recording).catch(()=>{})
      throw error
    }
  }

  private stopRecording(recording: Recording):Promise<unknown> {
    if(recording.ending)return recording.ending
    clearTimeout(recording.timer)
    const session=sessionName(recording.owner)
    recording.ending=(async()=>{
      try {
        await recording.initialized?.catch(()=>{})
        const status=await this.native('get_recording_state',{session},()=>{})
        if(!status.ok)throw new BrowserError('cua_recording_unavailable','Cua Driver recording status is unavailable.')
        if(status.value.enabled&&status.value.output_dir!==recording.directory)
          throw new BrowserError('cua_recording_owner','The current Cua Driver recording belongs to another session.')
        if(status.value.enabled){
          const stopped=await this.native('stop_recording',{session},()=>{})
          if(!stopped.ok||stopped.value.enabled)throw new BrowserError('cua_recording_unavailable','Cua Driver could not finalize the recording.')
        }
        const bytes=evidenceBytes(recording.directory,'recording.mp4',captureLimit)
        if(!bytes)throw new BrowserError('cua_recording_missing','Cua Driver did not produce a recording file.')
        const asset=this.host.browser.saveCapture(recording.owner,'video/mp4',bytes)
        this.host.store.put('desktop-recording',session,{id:session,ticketId:recording.owner.ticketId,assetId:asset.id})
        return {provider:'cua-driver',recording:asset}
      } finally {
        if(this.recording===recording)this.recording=undefined
        rmSync(recording.directory,{recursive:true,force:true})
      }
    })()
    return recording.ending
  }

  endAssignment(ticketId:string,assignmentId:string) {
    const recording=this.recording
    if(recording?.owner.ticketId===ticketId&&recording.owner.assignmentId===assignmentId)
      void this.stopRecording(recording).catch(()=>{})
  }

  async close(){
    if(this.recording)await this.stopRecording(this.recording).catch(()=>{})
    await Promise.allSettled([...this.calls.values()].map(call=>call.result))
  }
}
