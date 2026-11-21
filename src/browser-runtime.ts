import {execFile} from 'node:child_process'
import {accessSync,constants} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {promisify} from 'node:util'
import {chromium} from 'playwright-core'
import {BrowserError} from './browser-contract.ts'
import {computerCommand} from './computer-command.ts'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
let installing: Promise<void> | undefined
let encoderInstalling: Promise<void> | undefined

function executable(path: string) {
  try { accessSync(path,constants.X_OK); return true }
  catch { return false }
}

function install(...binaries: string[]) {
  const cli=join(dirname(require.resolve('playwright-core/package.json')),'cli.js')
  return exec(process.execPath,[cli,'install','--no-remove','--no-progress',...binaries],{
    timeout:240_000,
    maxBuffer:1024*1024,
    env:{...process.env,CI:'1'},
  }).then(()=>{})
}

/** Chromium and the screencast encoder come from the version pinned in the Roppo lockfile. */
export async function prepareChromium(configured?: string) {
  const packaged = configured ?? process.env.ROPPO_BUNDLED_CHROMIUM;
  if(packaged){
    if(!executable(packaged))throw new BrowserError('browser_unavailable','The packaged Chromium executable is unavailable.',503)
    return packaged
  }
  const path=chromium.executablePath()
  if(!executable(path)){
    installing ??= install('chromium','--no-shell').finally(()=>{installing=undefined})
    await installing.catch(()=>{throw new BrowserError('browser_install_failed','Roppo could not prepare Chromium. Check the host connection and retry.',503)})
  }
  if(!executable(path))throw new BrowserError('browser_unavailable','Roppo Chromium is unavailable.',503)
  return path
}

export async function prepareScreencastEncoder() {
  // "install ffmpeg" is idempotent: Playwright checks its bundled binary before downloading.
  encoderInstalling ??= install('ffmpeg').catch(()=>{
    encoderInstalling=undefined
    throw new BrowserError('browser_encoder_missing','Roppo could not prepare its recording encoder. Retry after checking the host connection.',503)
  })
  await encoderInstalling
}

export function bundledFfmpeg(configured?: string) {
  if(configured){
    const command=computerCommand(configured,'ffmpeg')
    if(command)return command
  }else{
    try {
      const {path}=require('@ffmpeg-installer/ffmpeg') as {path:string}
      if(executable(path))return path
    } catch { /* The product image can also supply the OS executable on unsupported package architectures. */ }
    const command=computerCommand(undefined,process.platform==='win32'?'ffmpeg.exe':'ffmpeg')
    if(command)return command
  }
  throw new BrowserError('browser_encoder_missing','The Roppo recording encoder is unavailable on this host.',503)
}
