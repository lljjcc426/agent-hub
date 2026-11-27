import { stat } from 'node:fs/promises'
import { basename, resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { chatUploadLimits } from '../execution-limits.ts'
import { ui } from './language.ts'

export interface DraftAttachment { path: string; name: string; bytes: number }

export function attachmentPath(input: string, cwd: string) {
  let path = input.trim()
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1)
  else path = path.replace(/\\([ \\"'()\[\]&;])/g, '$1')
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(cwd, path)
}

export async function readAttachment(path: string): Promise<DraftAttachment> {
  path = resolve(path)
  const info = await stat(path)
  if (!info.isFile()) throw Error(ui('Choose a file, not a folder: ', '请选择文件：') + basename(path))
  if (info.size > chatUploadLimits.maxBytes) throw Error(ui('File exceeds 100 MiB: ', '文件超过 100 MiB：') + basename(path))
  return { path, name: basename(path), bytes: info.size }
}

export function attachmentSize(bytes: number) {
  return bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? Math.ceil(bytes / 1024) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB'
}
