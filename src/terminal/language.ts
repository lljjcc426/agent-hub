import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { terminalProfileDirectory } from './profile.ts'

export type Language = 'zh' | 'en'
let language: Language = 'en'
export const ui = (en: string, zh: string) => (language === 'zh' ? zh : en)

export function parseLanguage(value: string): Language {
  if (/^zh(?:[-_].*)?$/i.test(value)) return 'zh'
  if (/^en(?:[-_].*)?$/i.test(value)) return 'en'
  throw Error('Choose zh or en / 请选择 zh 或 en')
}

export function configureLanguage(override?: Language) {
  if (override) {
    language = override
    return
  }
  try {
    language = parseLanguage(
      readFileSync(join(terminalProfileDirectory(), 'language'), 'utf8').trim()
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    language = /^zh/i.test(
      process.env.LC_ALL ||
        process.env.LC_MESSAGES ||
        process.env.LANG ||
        Intl.DateTimeFormat().resolvedOptions().locale
    )
      ? 'zh'
      : 'en'
  }
}

export function saveLanguage(value: Language) {
  const dir = terminalProfileDirectory()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'language'),
    temp = file + '.' + randomUUID()
  try {
    writeFileSync(temp, value + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
  language = value
}
