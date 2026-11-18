import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readdirSync } from 'node:fs'

const defaultDirectory = () => join(homedir(), '.roppo', 'terminal')
export const terminalProfileDirectory = () => resolve(process.env.ROPPO_CLI_HOME || defaultDirectory())

export function terminalCredentialFiles() {
  const paths: string[] = []
  for (const dir of new Set([defaultDirectory(), terminalProfileDirectory()])) {
    try {
      for (const file of readdirSync(dir)) {
        if (/^[a-f0-9]{64}\.json$/.test(file)) paths.push(join(dir, file))
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return paths
}
