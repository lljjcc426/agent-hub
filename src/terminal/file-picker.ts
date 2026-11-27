import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { ui } from './language.ts'

/** null means this platform needs the in-terminal browser; [] means cancelled. */
export async function pickNativeFiles(directory: string): Promise<string[] | null> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null
  const mac = process.platform === 'darwin'
  const script = fileURLToPath(new URL(mac ? './file-picker-macos.js' : './file-picker-windows.ps1', import.meta.url))
  const args = mac ? ['-l', 'JavaScript', script, directory, ui('Attach files to Roppo', '为 Roppo 添加附件')]
    : ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script]
  const { stdout } = await promisify(execFile)(mac ? '/usr/bin/osascript' : 'powershell.exe', args, {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ROPPO_PICKER_DIRECTORY: directory, ROPPO_PICKER_TITLE: ui('Attach files to Roppo', '为 Roppo 添加附件') }
  })
  return JSON.parse(stdout.trim()) as string[]
}
