import {execFile} from 'node:child_process'
import {mkdir, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {promisify} from 'node:util'
import {BrowserError} from './browser-contract.ts'
import {bundledFfmpeg} from './browser-runtime.ts'
import {evidenceBytes} from './goal-artifacts.ts'

const exec = promisify(execFile)
export const captureLimit = 32 * 1024 * 1024

type NativeRecording = (path: string, signal: AbortSignal) => Promise<() => Promise<void>>

export class PageRecording {
  private readonly controller = new AbortController()
  readonly done: Promise<{bytes: Buffer; durationMs: number}>

  private constructor(command: string, directory: string, finish: () => Promise<void>, durationMs: number) {
    this.done = this.record(command, directory, finish, durationMs)
  }

  static async start(commandPath: string | undefined, directory: string, start: NativeRecording, durationMs: number, signal: AbortSignal) {
    const command = bundledFfmpeg(commandPath)
    await mkdir(directory, {recursive: true, mode: 0o700})
    try {
      const finish = await start(join(directory, 'source.webm'), signal)
      return new PageRecording(command, directory, finish, durationMs)
    } catch (error) {
      await rm(directory, {recursive: true, force: true})
      throw error
    }
  }

  stop() {
    this.controller.abort()
    return this.done
  }

  private async record(command: string, directory: string, finish: () => Promise<void>, durationMs: number) {
    const signal = this.controller.signal, started = Date.now()
    try {
      await delay(durationMs, undefined, {signal, ref: false}).catch(error => {
        if (!signal.aborted) throw error
      })
      await finish()
      const elapsed = Date.now() - started
      await exec(command, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'source.webm',
        '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '25', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', 'recording.mp4',
      ], {cwd: directory, timeout: 45_000, maxBuffer: 256_000}).catch(() => {
        throw new BrowserError('browser_recording_encode', 'Roppo could not finalize the tab recording.')
      })
      const bytes = evidenceBytes(directory, 'recording.mp4', captureLimit)
      if (!bytes) throw new BrowserError('browser_recording_missing', 'The tab recording produced no MP4 within the attachment size limit.')
      return {bytes, durationMs: elapsed}
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  }
}
