import { Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

// Apple Terminal prints parts of unsupported DCS/APC and capability queries.
// Filter the renderer's output before it reaches the TTY, including queries
// split across native output chunks. Keep text, colors, mouse and cursor control.
export class AppleTerminalOutput extends Writable {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private cursorReply = ''
  private origin?: { row: number; column: number }
  private initialRows: number
  private initialColumns: number
  constructor(private target: NodeJS.WriteStream) {
    super()
    this.initialRows = target.rows
    this.initialColumns = target.columns
  }
  get columns() { return this.target.columns }
  get rows() { return this.target.rows }
  get isTTY() { return this.target.isTTY }

  // The first CPR answers OpenTUI's existing query on the shell screen.
  // Observe it without consuming input or sending a second query.
  rememberCursor = (chunk: Buffer) => {
    if (this.origin) return
    this.cursorReply += chunk.toString('utf8')
    const match = /\x1b\[(\d+);(\d+)R/.exec(this.cursorReply)
    if (match) {
      this.origin = { row: Number(match[1]), column: Number(match[2]) }
      this.cursorReply = ''
    } else this.cursorReply = this.cursorReply.slice(-32)
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    const input = this.pending + this.decoder.write(chunk)
    this.pending = ''
    let output = '', offset = 0
    while (offset < input.length) {
      const start = input.indexOf('\x1b', offset)
      if (start < 0) { output += input.slice(offset); break }
      output += input.slice(offset, start)
      const type = input[start + 1]
      let end = start + 2
      if (type === '[') {
        while (end < input.length && !/[\x40-\x7e]/.test(input[end]!)) end++
        end++
      } else if (type === ']' || type === 'P' || type === '_' || type === '^') {
        while (end < input.length && input[end] !== '\x07' && input.slice(end, end + 2) !== '\x1b\\') end++
        end += input[end] === '\x07' ? 1 : 2
      }
      if (end > input.length) { this.pending = input.slice(start); break }
      const sequence = input.slice(start, end)
      const unsupported = type === 'P' || type === '_' ||
        /^\x1b\[(?:\?[\d;]*\$p|\?u|>[\d;]*q)$/.test(sequence) ||
        sequence.startsWith('\x1b]66;')
      if (!unsupported) output += sequence
      // Restore the shell's measured position within the resized viewport.
      if (sequence === '\x1b[?1049l' && this.origin &&
        (this.rows !== this.initialRows || this.columns !== this.initialColumns)) {
        const row = Math.min(this.origin.row, this.rows)
        const column = Math.min(this.origin.column, this.columns)
        output += `\x1b[${row};${column}H`
      }
      offset = end
    }
    if (output) this.target.write(output, done)
    else done()
  }
}
