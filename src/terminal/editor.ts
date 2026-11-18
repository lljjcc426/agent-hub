import {messageCharacters} from '../execution-limits.ts'
import { ui } from './language.ts'
import type { CapabilitySnapshot } from '../capability-types.ts'
import { EventEmitter } from 'node:events'
import { emitKeypressEvents, type Key } from 'node:readline'
import { Readable } from 'node:stream'
import { clean, type Snapshot } from './client.ts'
import { projectFiles, suggestions, type Suggestions } from './suggestions.ts'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export type Menu = Suggestions & { selected: number }

// Own the editable draft independently of asynchronous host updates. Only submitted lines
// enter the queue. A bracketed paste, even one containing /commands, is one editing operation.
export class TerminalEditor extends EventEmitter {
  line = ''
  cursor = 0
  menu?: Menu
  expanded = false
  private library?: CapabilitySnapshot
  private libraryRead?: Promise<void>
  private libraryExpiry = 0
  private libraryRefresh?: NodeJS.Timeout
  private files?: string[]
  private loading?: Promise<void>
  private view?: Snapshot
  private history: string[] = []
  private historyAt = 0
  private scratch = ''
  private paste?: string[]
  private pastedLength = 0
  private closed = false
  private raw: boolean
  private queue = new Readable({ objectMode: true, read() {} })
  constructor(
    private input: NodeJS.ReadStream,
    private output: NodeJS.WriteStream,
    private cwd: string,
    private choices?: (query: string) => Suggestions,
    private readLibrary?: () => Promise<CapabilitySnapshot>
  ) {
    super()
    this.raw = !!input.isRaw
    emitKeypressEvents(input)
    input.setRawMode(true)
    input.on('keypress', this.keypress)
    input.once('end', this.close)
    process.once('SIGTERM', this.close)
    process.once('SIGHUP', this.close)
    process.once('SIGINT', this.close)
    this.output.write('\x1b[?2004h')
    this.updateMenu()
  }
  [Symbol.asyncIterator]() {
    return this.queue[Symbol.asyncIterator]() as AsyncIterableIterator<string>
  }
  setView(view: Snapshot) {
    this.view = view
    if (this.menu && this.menu.kind !== 'commands' && this.menu.kind !== 'files') this.updateMenu()
  }
  restoreDraft(value: string) {
    if (this.closed || this.line || !value) return
    this.edit(value, 0, 0)
    this.menu = undefined
    this.emit('change')
  }
  recall(lines: string[]) {
    this.history = lines.slice(-100)
    this.historyAt = this.history.length
  }
  close = () => {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.libraryRefresh)
    this.input.off('keypress', this.keypress)
    this.input.off('end', this.close)
    process.off('SIGTERM', this.close)
    process.off('SIGHUP', this.close)
    process.off('SIGINT', this.close)
    this.input.setRawMode(this.raw)
    this.output.write('\x1b[?2004l')
    this.queue.push(null)
    this.emit('close')
  }
  private updateMenu() {
    const next = this.choices
      ? this.choices(this.line)
      : suggestions(
          this.line,
          this.cursor,
          this.view?.tasks ?? [],
          this.files,
          this.view,
          this.library
        )
    const previous = this.menu?.items[this.menu.selected]?.value
    this.menu = next
      ? {
          ...next,
          selected: Math.max(
            0,
            next.items.findIndex((c) => c.value === previous)
          )
        }
      : undefined
    if (
      next?.kind === 'capabilities' &&
      !this.libraryRead &&
      Date.now() >= this.libraryExpiry &&
      this.readLibrary
    ) {
      this.libraryRead = this.readLibrary()
        .then(
          (value) => {
            this.library = value
          },
          (error) => {
            this.library = {
              items: [],
              warnings: [clean(String(error.message ?? error))],
              refreshing: false
            }
          }
        )
        .finally(() => {
          this.libraryRead = undefined
          this.libraryExpiry = Date.now() + (this.library?.refreshing ? 1500 : 15000)
          if (!this.closed && this.menu?.kind === 'capabilities') {
            clearTimeout(this.libraryRefresh)
            if (this.library?.refreshing)
              this.libraryRefresh = setTimeout(() => {
                if (this.menu?.kind === 'capabilities') this.updateMenu()
              }, 1600).unref()
            this.updateMenu()
            this.emit('change')
          }
        })
    }
    if (next?.kind === 'files' && !this.loading && !this.files) {
      this.loading = projectFiles(this.cwd).then((files) => {
        this.files = files
        if (!this.closed && this.menu?.kind === 'files') {
          this.updateMenu()
          this.emit('change')
        }
      })
    }
  }
  private edit(value: string, start = this.cursor, end = this.cursor) {
    const room = messageCharacters - (this.line.length - end + start)
    if (value.length > room) {
      this.emit('notice', ui('Draft exceeds 256,000 characters.', '输入内容超过256,000 字符。'))
      return
    }
    this.line = this.line.slice(0, start) + value + this.line.slice(end)
    this.cursor = start + value.length
    this.updateMenu()
  }
  private submit(value: string) {
    if (!this.choices && value && this.history.at(-1) !== value) this.history.push(value)
    if (this.history.length > 100) this.history.shift()
    this.historyAt = this.history.length
    this.scratch = ''
    this.line = ''
    this.cursor = 0
    this.menu = undefined
    this.queue.push(value)
  }
  private vertical(dir: number) {
    if (this.menu?.items.length) {
      this.menu.selected = Math.max(
        0,
        Math.min(this.menu.items.length - 1, this.menu.selected + dir)
      )
      return
    }
    const start = this.line.slice(0, this.cursor).lastIndexOf('\n') + 1,
      column = this.cursor - start
    const end = this.line.indexOf('\n', this.cursor)
    if (dir < 0 && start > 0) {
      const previous = this.line.slice(0, start - 1).lastIndexOf('\n') + 1
      this.cursor = Math.min(start - 1, previous + column)
    } else if (dir > 0 && end >= 0) {
      const next = this.line.indexOf('\n', end + 1)
      this.cursor = Math.min(next < 0 ? this.line.length : next, end + 1 + column)
    } else {
      if (this.historyAt === this.history.length) this.scratch = this.line
      this.historyAt = Math.max(0, Math.min(this.history.length, this.historyAt + dir))
      this.line = this.history[this.historyAt] ?? this.scratch
      this.cursor = this.line.length
    }
    const unit = graphemes.segment(this.line).containing(this.cursor)
    if (unit) this.cursor = unit.index
    this.updateMenu()
  }
  private enter(tab: boolean) {
    const menu = this.menu,
      item = menu?.items[menu.selected]
    if (this.choices) {
      if (item && !tab) this.submit(item.value)
      return
    }
    if (!tab && this.line.endsWith('\\') && this.cursor === this.line.length) {
      this.edit('\n', this.cursor - 1)
      return
    }
    if (menu && item) {
      const typed = this.line.trimEnd()
      if (!tab && menu.kind === 'commands' && item.label === typed && typed === '/stop') {
        this.submit(typed)
      } else if (!tab && item.submit) {
        this.submit(item.value)
      } else {
        this.edit(item.value, menu.start, menu.end)
        if (menu.kind === 'files' || !item.value.endsWith(' ')) this.menu = undefined
      }
    } else if (!tab && menu?.kind !== 'capabilities') this.submit(this.line)
  }
  private keypress = (text: string | undefined, key: Key) => {
    if (this.closed || !key) return
    const seq = key.sequence ?? text ?? ''
    if (this.paste) {
      if (key.name !== 'paste-end') {
        this.pastedLength += seq.length
        if (this.pastedLength <= messageCharacters) this.paste.push(seq)
        return
      }
      const parts = this.paste
      this.paste = undefined
      if (this.pastedLength > messageCharacters)
        this.emit('notice', ui('Paste exceeds 256,000 characters.', '粘贴内容超过256,000 字符。'))
      else this.edit(clean(parts.join('').replace(/\r\n?/g, '\n')).replace(/\t/g, '  '))
      if (!this.choices) this.menu = undefined
    } else if (key.name === 'paste-start') {
      this.paste = []
      this.pastedLength = 0
      return
    } else if (
      seq === '\x1b[13;2u' ||
      seq === '\x1b[27;2;13~' ||
      (key.meta && ['return', 'enter'].includes(key.name ?? ''))
    ) {
      if (!this.choices) this.edit('\n')
    } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      if (this.choices) this.close()
      else if (this.menu && key.name === 'escape') this.menu = undefined
      else if (key.ctrl && this.line) this.edit('', 0, this.line.length)
      else if (key.ctrl) this.close()
      else this.emit('interrupt')
    } else if (key.ctrl && key.name === 'd' && !this.line) this.close()
    else if (key.name === 'pageup' || key.name === 'pagedown')
      this.emit('page', key.name === 'pageup' ? -1 : 1)
    else if (key.ctrl && key.name === 'o') this.expanded = !this.expanded
    else if (key.name === 'return' || key.name === 'enter' || key.name === 'tab')
      this.enter(key.name === 'tab')
    else if (key.name === 'up' || (key.ctrl && key.name === 'p')) this.vertical(-1)
    else if (key.name === 'down' || (key.ctrl && key.name === 'n')) this.vertical(1)
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
      this.cursor = this.line.slice(0, this.cursor).lastIndexOf('\n') + 1
      this.updateMenu()
    } else if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
      const end = this.line.indexOf('\n', this.cursor)
      this.cursor = end < 0 ? this.line.length : end
      this.updateMenu()
    } else if (key.ctrl && key.name === 'u') this.edit('', 0, this.cursor)
    else if (key.ctrl && key.name === 'k') this.edit('', this.cursor, this.line.length)
    else if ((key.ctrl && key.name === 'w') || (key.meta && key.name === 'backspace')) {
      const at = this.line.slice(0, this.cursor).search(/\S+\s*$/u)
      this.edit('', Math.max(0, at), this.cursor)
    } else if (
      key.name === 'left' ||
      key.name === 'right' ||
      key.name === 'backspace' ||
      key.name === 'delete' ||
      (key.ctrl && ['b', 'f', 'd'].includes(key.name ?? ''))
    ) {
      const back = key.name === 'left' || key.name === 'backspace' || key.name === 'b'
      const segment = graphemes.segment(this.line).containing(back ? this.cursor - 1 : this.cursor)
      if (segment) {
        const next = back ? segment.index : segment.index + segment.segment.length
        if (key.name === 'backspace' || key.name === 'delete' || key.name === 'd')
          this.edit('', Math.min(next, this.cursor), Math.max(next, this.cursor))
        else {
          this.cursor = next
          this.updateMenu()
        }
      }
    } else if (!key.ctrl && !key.meta && text && !/[\u0000-\u001f\u007f]/u.test(text))
      this.edit(text)
    if (!this.closed) this.emit('change')
  }
}
