import {execFile} from 'node:child_process'
import {mkdir, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {promisify} from 'node:util'
import {BrowserError, type BrowserFrame} from './browser-contract.ts'
import {computerCommand} from './computer-command.ts'
import {evidenceBytes} from './goal-artifacts.ts'

const exec = promisify(execFile)
export const captureLimit = 32 * 1024 * 1024
const frameBudget = 128 * 1024 * 1024

type Frame = Omit<BrowserFrame, 'seq'>
export interface PageVideo {
  bytes: Buffer
  durationMs: number
  frameCount: number
  partial: boolean
}

export class PageRecording {
  private readonly controller = new AbortController()
  readonly done: Promise<PageVideo>

  private constructor(command: string, directory: string, initial: Frame, capture: (signal: AbortSignal) => Promise<Frame>, durationMs: number) {
    this.done = this.record(command, directory, initial, capture, durationMs)
  }

  static async start(commandPath: string | undefined, directory: string, capture: (signal: AbortSignal) => Promise<Frame>, durationMs: number, signal: AbortSignal) {
    const command = computerCommand(commandPath, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    if (!command) throw new BrowserError('browser_encoder_missing', 'Install FFmpeg or set browser.ffmpegCommand to record an Ego Lite tab.', 503)
    const initial = await capture(signal)
    return new PageRecording(command, directory, initial, capture, durationMs)
  }

  stop() {
    this.controller.abort()
    return this.done
  }

  private async record(command: string, directory: string, initial: Frame, capture: (signal: AbortSignal) => Promise<Frame>, durationMs: number): Promise<PageVideo> {
    const signal = this.controller.signal
    const frames: {file: string; at: number}[] = []
    let totalBytes = 0
    const append = async (frame: Frame) => {
      const bytes = Buffer.from(frame.data, 'base64')
      if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.length + totalBytes > frameBudget)
        throw new BrowserError('browser_recording_frame', 'The tab recording reached its frame limit or a frame could not be read.')
      const file = 'frame-' + frames.length + '.jpg'
      await writeFile(join(directory, file), bytes, {mode: 0o600, flag: 'wx'})
      totalBytes += bytes.length
      frames.push({file, at: frame.at})
    }
    await mkdir(directory, {recursive: true, mode: 0o700})
    try {
      await append(initial)
      const deadline = initial.at + durationMs
      let partial = false
      try {
        while (!signal.aborted && Date.now() + 250 < deadline) {
          await delay(250, undefined, {signal})
          const frame = await capture(AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]))
          if (!signal.aborted && frame.at <= deadline) await append(frame)
        }
      } catch {
        partial = !signal.aborted && Date.now() < deadline
      }
      const end = Math.min(Date.now(), deadline)
      const manifest = frames.map(({file, at}, index) =>
        "file '" + file + "'\nduration " + Math.max(0.05, ((frames[index + 1]?.at ?? end) - at) / 1000),
      ).join('\n') + "\nfile '" + frames.at(-1)!.file + "'\n"
      await writeFile(join(directory, 'frames.txt'), manifest, {mode: 0o600, flag: 'wx'})
      await exec(command, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '1', '-i', 'frames.txt',
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
        '-an', '-r', '20', '-c:v', 'libx264', '-preset', 'fast', '-crf', '25', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', 'recording.mp4',
      ], {cwd: directory, timeout: 45_000, maxBuffer: 256_000}).catch(() => {
        throw new BrowserError('browser_recording_encode', 'FFmpeg could not finalize the Ego Lite tab recording.')
      })
      const bytes = evidenceBytes(directory, 'recording.mp4', captureLimit)
      if (!bytes) throw new BrowserError('browser_recording_missing', 'No MP4 was produced for this tab recording.')
      return {bytes, durationMs: Math.max(50, end - initial.at), frameCount: frames.length, partial}
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  }
}
