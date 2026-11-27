import { Writable } from 'node:stream'
import { once } from 'node:events'
import { expect, test } from 'vitest'
import { AppleTerminalOutput } from '../src/terminal/apple-terminal-output.ts'

test('Apple Terminal output removes unsupported probes without altering text or supported controls', async () => {
  const visible = '\x1b[?1049h\x1b[38;5;123m中文 👋\x1b[0m\x1b]11;?\x07\x1b[?1006h\x1b[?1049l'
  const probes = '\x1bP+q4d73\x1b\\\x1b_Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\' +
    '\x1b[?1016$p\x1b[?2026$p\x1b[?u\x1b[>0q\x1b]66;w=1; \x1b\\'
  const bytes = Buffer.from(probes + visible)
  // Native output can split an escape sequence or UTF-8 character at any byte.
  for (const chunkSize of [1, 7, bytes.length]) {
    let output = ''
    const sink = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } })
    const filtered = new AppleTerminalOutput(sink as NodeJS.WriteStream)
    for (let offset = 0; offset < bytes.length; offset += chunkSize) filtered.write(bytes.subarray(offset, offset + chunkSize))
    filtered.end()
    await once(filtered, 'finish')
    expect(output).toBe(visible)
  }
})
