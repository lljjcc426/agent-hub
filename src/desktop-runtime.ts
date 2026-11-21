import {execFile, spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream, createWriteStream, existsSync} from 'node:fs'
import {copyFile, mkdir, mkdtemp, rename, rm, stat} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {pipeline} from 'node:stream/promises'
import {promisify} from 'node:util'
import {BrowserError} from './browser-contract.ts'
import {computerCommand} from './computer-command.ts'

const exec = promisify(execFile)
const version = '0.56.4'
const release = 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v'+version+'/'
const bundle = 'CuaDriver.app'
const binary = 'Contents/MacOS/cua-driver'
const fingerprints: Record<string, string> = {
  'darwin-arm64': '25c711d63f12d70ca08002be7ad7edeaa4c3d63e8819107722637699382d9db8',
  'darwin-x86_64': 'b1288731f5df2278613dbf1e619c6d16fd3dde13b9375758e2fd4f2681980372',
  'linux-arm64': '549cb15743ba85a0c895c6b96bd9410e7435cac1e41f9b358f638a505ac11c67',
  'linux-x86_64': '7a28a873a5309121b6fdade491a1574f75bc6e08a079a60442d9935066f1d376',
}
const platform = process.platform+'-'+(process.arch==='x64'?'x86_64':process.arch)
const packageName = 'cua-driver-rs-'+version+'-'+platform
const archiveName = packageName+'.tar.gz'
const maxArchiveBytes = 180 * 1024 * 1024

async function verifyArchive(path: string) {
  if((await stat(path)).size>maxArchiveBytes)throw Error('Desktop runtime archive is too large')
  const hash=createHash('sha256')
  for await(const bytes of createReadStream(path))hash.update(bytes)
  if(hash.digest('hex')!==fingerprints[platform])throw Error('Desktop runtime checksum mismatch')
}

async function receiveArchive(path: string) {
  const url=release+archiveName
  if(process.platform==='darwin'){
    await exec('/usr/bin/curl',['-q','--fail','--location','--silent','--show-error','--proto','=https','--proto-redir','=https',
      '--retry','2','--retry-all-errors','--retry-max-time','145','--connect-timeout','12',
      '--max-time','150','--max-filesize',String(maxArchiveBytes),'--output',path,url],{timeout:155_000,maxBuffer:32_768})
    return
  }
  const response=await fetch(url,{signal:AbortSignal.timeout(150_000)})
  if(!response.ok||!response.body){await response.body?.cancel();throw Error('Desktop runtime download failed')}
  const reader=response.body.getReader()
  let bytes=0
  await pipeline(async function*(){
    try{
      for(;;){
        const {value,done}=await reader.read()
        if(done)break
        bytes+=value.length
        if(bytes>maxArchiveBytes)throw Error('Desktop runtime archive is too large')
        yield value
      }
    }finally{
      await reader.cancel().catch(()=>{})
      reader.releaseLock()
    }
  }, createWriteStream(path,{flags:'wx',mode:0o600}))
}

// The native release embeds the upstream archive so the app stays vendor-signed.
export async function packageDesktopRuntime(directory: string, releaseArchive?:string) {
  await mkdir(directory,{recursive:true})
  const path=join(directory,archiveName)
  try {
    if(releaseArchive)await copyFile(releaseArchive,path)
    else await receiveArchive(path)
    await verifyArchive(path)
  }
  catch(error){await rm(path,{force:true});throw error}
}

export type DesktopAccess = {
  state: 'unavailable'|'missing'|'preparing'|'permission_required'|'ready'
  accessibility?: boolean
  screenRecording?: boolean
}

export class DesktopRuntime {
  private installing?: Promise<string>
  private guidance?: ReturnType<typeof spawn>
  private readonly runtimeDir: string

  constructor(stateDir: string, private configured?: string, private applicationsDir = '/Applications') {
    this.runtimeDir = join(stateDir,'browser','desktop-runtime')
  }

  private supported() {
    return process.platform==='darwin' || process.platform==='linux' && !!(process.env.DISPLAY||process.env.WAYLAND_DISPLAY)
  }

  private installed() {
    const file=process.platform==='darwin'?join(this.applicationsDir,bundle,binary):join(this.runtimeDir,packageName,'cua-driver')
    return computerCommand(this.configured ?? (existsSync(file)?file:undefined), 'cua-driver')
  }

  async prepare() {
    if(!this.supported())throw new BrowserError('desktop_unavailable','Desktop control requires Roppo in a signed-in desktop session.',503)
    const command=this.installed()
    if(command)return command
    if(this.configured||!fingerprints[platform])
      throw new BrowserError('desktop_install_unavailable','Roppo cannot prepare the desktop runtime on this host.',503)
    this.installing ??= this.install().finally(()=>{this.installing=undefined})
    return this.installing
  }

  async access(): Promise<DesktopAccess> {
    if(!this.supported())return {state:'unavailable'}
    if(this.installing)return {state:'preparing'}
    const command=this.installed()
    if(!command)return {state:'missing'}
    if(process.platform!=='darwin')return {state:'ready'}
    try {
      const {stdout}=await exec(command,['permissions','status','--json'],{timeout:3000,maxBuffer:32_768})
      const permissions=JSON.parse(stdout)
      const accessibility=permissions.accessibility===true, screenRecording=permissions.screen_recording===true
      return {state:accessibility&&screenRecording?'ready':'permission_required',accessibility,screenRecording}
    } catch {
      return {state:'permission_required'}
    }
  }

  async requestAccess(check: ()=>void): Promise<DesktopAccess> {
    check()
    const command=await this.prepare()
    check()
    const access=await this.access()
    check()
    if(process.platform!=='darwin'||access.state==='ready'||this.guidance)return access
    const guide=spawn(command,['permissions','grant'],{stdio:'ignore',detached:true,
      env:{...process.env,CUA_DRIVER_RS_TELEMETRY_ENABLED:'0'}})
    this.guidance=guide
    guide.once('exit',()=>{this.guidance=undefined})
    await new Promise<void>((resolve,reject)=>{
      guide.once('spawn',resolve)
      guide.once('error',()=>{
        this.guidance=undefined
        reject(new BrowserError('desktop_permission_guide','Roppo could not open the macOS permission guide.',503))
      })
    })
    guide.unref()
    return access
  }

  private async install() {
    const mac=process.platform==='darwin'
    const destination=mac?join(this.applicationsDir,bundle):join(this.runtimeDir,packageName)
    if(existsSync(destination))throw new BrowserError('desktop_install_unavailable','The existing desktop runtime could not be opened.',503)
    await mkdir(this.runtimeDir,{recursive:true,mode:0o700})
    // Prepare beside the destination so a completed bundle appears atomically.
    const stage=await mkdtemp(join(mac?this.applicationsDir:this.runtimeDir,'.roppo-desktop-')).catch(()=>{
      throw new BrowserError('desktop_install_unavailable','Roppo cannot write its desktop runtime to the application directory.',503)
    })
    try {
      const archive=join(stage,'runtime.tar.gz')
      const packaged=process.platform==='darwin'&&[this.applicationsDir,join(homedir(),'Applications')]
        .map(dir=>join(dir,'Roppo.app','Contents','Resources','desktop-runtime',archiveName)).find(existsSync)
      if(packaged)await copyFile(packaged,archive)
      else await receiveArchive(archive)
      await verifyArchive(archive)
      await exec('/usr/bin/tar',['-xzf',archive,'-C',stage,...(mac?[packageName+'/'+bundle]:[])],{timeout:30_000})
      const unpacked=join(stage,packageName,...(mac?[bundle]:[]))
      if(mac)await exec('/usr/bin/codesign',['--verify','--deep','--strict','-R=identifier "com.trycua.driver"',unpacked],{timeout:15_000})
      const cmd=join(unpacked,mac?binary:'cua-driver')
      if(!computerCommand(cmd,'cua-driver'))throw Error('Incomplete desktop runtime')
      try {await rename(unpacked,destination)}
      catch(error){if(!this.installed())throw error}
      const installed=this.installed()
      if(!installed)throw Error('Desktop runtime is unavailable')
      return installed
    } catch (error) {
      if(error instanceof BrowserError)throw error
      throw new BrowserError('desktop_install_failed','Roppo could not verify or install the desktop runtime. Retry after checking the host connection.',503)
    } finally {
      await rm(stage,{recursive:true,force:true})
    }
  }

}
