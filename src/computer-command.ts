import {accessSync, constants, statSync} from 'node:fs'
import {homedir} from 'node:os'
import {delimiter, join} from 'node:path'

export function computerCommand(configured: string | undefined, name: string, platformPaths: string[] = []) {
  const path = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const candidates = configured ? [configured] : [
    ...platformPaths,
    ...[join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', ...path].map(directory => join(directory, name)),
  ]
  return candidates.find(candidate => {
    try {
      accessSync(candidate, constants.X_OK)
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}
