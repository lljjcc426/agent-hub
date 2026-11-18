/** Display only recognized operations. In particular, arbitrary shell arguments, search queries,
 * tool payloads, browser form values and connector responses never become transcript metadata. */
export interface ToolTrace {
  kind: 'read' | 'resource' | 'search' | 'command'
  label?: string
}
const fileName = /^[\p{L}\p{N}_+-][\p{L}\p{N}_.+-]{0,95}$/u
function leaf(path: string | undefined) {
  const name = path?.split('/').pop()
  return name && fileName.test(name) ? name : undefined
}
export function toolTrace(name: string, args: unknown): ToolTrace | undefined {
  if (!args || typeof args !== 'object') return
  const input = args as Record<string, unknown>
  if (name === 'superagent_read' || name === 'router_read') {
    const resource = String(input.resource ?? '')
    return /^(files|image)\//.test(resource) ? { kind: 'read', label: leaf(resource) } : { kind: 'resource' }
  }
  if (name !== 'superagent_shell' || typeof input.command !== 'string') return
  const words = input.command.trim().split(/\s+/),
    program = words[0]
  const single = !/[;&|<>\n$\x60]/.test(input.command)
  if (single && program === 'cat' && words.length === 2) return { kind: 'read', label: leaf(words[1]) }
  if (
    single &&
    program === 'sed' &&
    words.length === 4 &&
    words[1] === '-n' &&
    /^'?\d+(,\d+)?p'?$/.test(words[2]!)
  )
    return { kind: 'read', label: leaf(words[3]) }
  if (single && ['rg', 'grep', 'find'].includes(program!)) {
    // A file is public metadata only when it follows the pattern as a separate positional argument.
    const match = /^(?:rg|grep)(?:\s+-[inwFHSl]+)*\s+(?:'[^']*'|"[^"]*"|[^\s'"-][^\s'"]*)\s+([^\s'"-][^\s'"]*)$/.exec(input.command.trim())
    const target = leaf(match?.[1])
    return target?.includes('.') ? { kind: 'search', label: target } : { kind: 'search' }
  }
  const literal =
    single &&
    /^(pwd|git (status( --short)?|diff --stat)|(?:npm|pnpm|yarn) (?:test|run (?:build|test|check|lint|typecheck)))$/.test(
      input.command.trim()
    )
  const label = literal
    ? input.command.trim()
    : [
          'git',
          'ls',
          'node',
          'npm',
          'pnpm',
          'npx',
          'python3',
          'python',
          'bash',
          'sh',
          'sed',
          'cat',
          'rg',
          'printf',
          'make',
          'cargo',
          'go',
          'tsc',
          'pytest',
        ].includes(program!)
      ? program
      : undefined
  return { kind: 'command', label }
}
