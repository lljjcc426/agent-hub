import { randomUUID } from 'node:crypto'
import { readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { TerminalClient, type Conversation, type Snapshot } from './client.ts'
import type { TuiScreen, TuiItem } from './tui-screen.ts'
import { controlCommand } from './controls.ts'
import { command } from './commands.ts'
import { publicMessage } from './conversation.ts'
import { isApprovalPending } from '../chat-workflow.ts'
import { saveTerminalSetting, type TerminalSettings } from './settings.ts'
import { configureLanguage, ui } from './language.ts'
import type { memoryWorkspace } from '../memory-workspace.ts'

export const personalCommands = () => [
  { name: '/model', label: ui('Models', '模型'), detail: ui('Choose the shared Router model · F2', '选择共享 Router 模型 · F2') },
  { name: '/effort', label: ui('Reasoning effort', '思考强度'), detail: ui('Model reasoning level', '模型思考级别') },
  { name: '/files', label: ui('Files', '文件'), detail: ui('View and save conversation files', '查看和保存对话文件') },
  { name: '/memory', label: ui('Memory', '记忆'), detail: ui('Review and edit personal memory', '查看和编辑个人记忆') },
  { name: '/schedules', label: ui('Scheduled actions', '计划事项'), detail: ui('Reminders and routines', '提醒和定时事项') },
  { name: '/approvals', label: ui('Pending requests', '待处理请求'), detail: ui('Permissions and questions · ctrl+y', '授权和提问 · ctrl+y') },
  { name: '/permissions', label: ui('Permissions', '权限'), detail: ui('Shared account access', '账号共享权限') },
  { name: '/settings', label: ui('Settings', '设置'), detail: ui('Appearance and interaction', '外观和交互') },
  { name: '/history', label: ui('Search conversation', '搜索对话'), detail: ui('Find a message · ctrl+k', '查找消息 · ctrl+k') },
  { name: '/tools', label: ui('Capabilities', '能力'), detail: ui('Tools, skills and MCP servers', '工具、技能和 MCP 服务') },
  { name: '/open', label: ui('Open in browser', '在浏览器打开'), detail: ui('Continue the same conversation', '继续同一段对话') },
  { name: '/status', label: ui('Connection status', '连接状态'), detail: ui('Local service and model', '本机服务和模型') },
  { name: '/context', label: ui('Context usage', '上下文用量'), detail: ui('Measured usage', '实测用量') },
  { name: '/tasks', label: ui('Execution details', '执行详情'), detail: ui('Inspect internal collaboration', '查看内部协作') },
  { name: '/help', label: ui('Help', '帮助'), detail: ui('Keys and commands', '按键和命令') },
  { name: '/exit', label: ui('Exit', '退出'), detail: ui('Keep the local service running', '保持本机服务运行') }
]

export class TuiCommands {
  constructor(private client: TerminalClient, private conversation: Conversation, private screen: TuiScreen,
    private options: { cwd: string; preferences: TerminalSettings; settingsSources: string[] },
    private view: () => Snapshot, private refresh: () => Promise<void>,
    private quit: (next?: Conversation) => void, private older: () => Promise<void>) {}
  private path(suffix: string) { return '/api/chat/conversations/' + this.conversation.id + '/' + suffix }
  private async change(path: string, body: unknown, patch = false) {
    await this.client.request(path, body, patch ? { method: 'PATCH' } : {}); await this.refresh()
  }
  async complete(text: string): Promise<TuiItem[]> {
    if (/^\/[\w-]*$/.test(text)) {
      const term = text.slice(1).toLowerCase()
      return personalCommands().filter(c => (c.name + ' ' + c.label + ' ' + c.detail).toLowerCase().includes(term))
        .map(c => ({ label: c.name, detail: c.detail, run: () => { this.screen.setDraft(''); return this.execute(c.name) } }))
    }
    const mention = /(?:^|\s)@(?:"([^"\n]*)|([^\s"@]*))$/.exec(text)
    if (!mention) return []
    const fragment = mention[1] ?? mention[2] ?? '', expanded = fragment.startsWith('~/') ? join(homedir(), fragment.slice(2)) : resolve(this.options.cwd, fragment)
    const directory = fragment.endsWith('/') || !fragment ? expanded : dirname(expanded)
    const term = fragment.endsWith('/') ? '' : basename(fragment).toLowerCase()
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    return entries.filter(e => !e.name.startsWith('.') && e.name.toLowerCase().includes(term) && (e.isFile() || e.isDirectory()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 80).map(entry => {
        const path = join(directory, entry.name), prefix = text.slice(0, text.lastIndexOf('@'))
        return { label: entry.name + (entry.isDirectory() ? '/' : ''), detail: directory,
          run: () => this.screen.setDraft(prefix + '@' + (entry.isDirectory() ? '"' + path + '/' : JSON.stringify(path) + ' ')) }
      })
  }
  async execute(input: string): Promise<void> {
    this.screen.setLoading(true)
    try { await this.dispatch(input) } finally { this.screen.setLoading(false) }
  }
  private async dispatch(input: string): Promise<void> {
    const name = input.split(/\s/)[0]
    if (name === '/exit' || name === '/quit') { this.quit(); return }
    if (name === '/commands' || name === '/') {
      this.screen.menu({ title: ui('Commands', '命令'), items: personalCommands().map(c => ({ label: c.label, detail: c.name + ' · ' + c.detail, run: () => this.execute(c.name) })) }); return
    }
    if (name === '/settings' || input === '/config') { this.settings(); return }
    if (input === '/history') { this.history(); return }
    if (input === '/files') { this.files(); return }
    if (input === '/memory') { await this.memory(); return }
    if (input === '/schedules') { this.schedules(); return }
    if (input === '/approvals' || input === '/choose') { await this.review(); return }
    if (input === '/permissions full') {
      this.screen.menu({ title: ui('Allow host-managed actions automatically?', '自动允许宿主管理的操作？'), detail: ui('Applies to your shared account in web and CLI. Source sandbox limits still apply.', '对网页和 CLI 的共享账号生效，仍受来源沙箱限制。'), items: [
        { label: ui('Keep asking', '继续询问'), run: () => {} },
        { label: ui('Enable full access', '启用完全访问'), run: async () => {
          await this.client.request('/api/terminal/settings', { action: 'permissions', mode: 'full' }); await this.refresh()
        } }
      ] }); return
    }
    if (input === '/help') {
      this.screen.document(ui('Keyboard shortcuts', '快捷键'), [
        'Enter                 Send', 'Shift+Enter / Alt+Enter / Ctrl+J   New line',
        '/                     Commands', '@                     Attach local files',
        'Ctrl+P                Search commands', 'F2                    Models', 'Ctrl+K                Search conversation',
        'Ctrl+Y                Review pending requests', 'PageUp / PageDown     Read history', 'Ctrl+End              Back to latest',
        'Esc                   Close menu / interrupt request', 'Ctrl+D                Exit from an empty prompt',
        'Ctrl+Shift+C          Copy selected text', '', ui('The local service continues working after you exit.', '退出后，本机服务继续工作。')
      ].join('\n')); return
    }
    const control = await controlCommand(this.client, this.conversation, input, this.options.cwd, this.options.preferences, this.options.settingsSources)
    if (control) {
      if (control.next) { this.quit(control.next); return }
      if (control.preferences) {
        Object.assign(this.options.preferences, control.preferences)
        if (control.preferences.language) configureLanguage(control.preferences.language)
        this.screen.preferences(this.options.preferences)
      }
      if (control.menu) this.screen.menu({ title: control.menu.title, detail: control.text, items: control.menu.items.map(item => ({ label: item.label, detail: item.detail,
        run: () => this.execute(item.value) })) })
      else if (control.text) this.screen.document(name ?? 'Roppo', control.text)
      await this.refresh(); return
    }
    if (input === '/tools') {
      const library = await this.client.request<import('../capability-types.ts').CapabilitySnapshot>('/api/capability-library')
      this.screen.menu({ title: ui('Capabilities', '能力'), items: library.items.map(item => ({ label: item.name,
        detail: (item.sourceGroup ?? item.source) + ' · ' + item.kind,
        run: () => this.execute('/tools --inspect ' + encodeURIComponent(item.id)) })) }); return
    }
    const result = await command(this.client, this.conversation.id, input)
    if (result) this.screen.document(name ?? 'Roppo', result)
    await this.refresh()
  }
  private settings() {
    const save = (key: string, value: string) => {
      const { patch } = saveTerminalSetting(this.options.cwd, key, value)
      Object.assign(this.options.preferences, patch)
      if (patch.language) configureLanguage(patch.language)
      this.screen.preferences(this.options.preferences); this.settings()
    }
    this.screen.menu({ title: ui('Settings · this terminal', '设置 · 此终端'), items: [
      { label: ui('Color mode', '配色'), detail: this.options.preferences.theme ?? 'system', run: () => this.screen.menu({ title: ui('Color mode', '配色'), items: ['system', 'dark', 'light', 'mono'].map(theme => ({ label: theme, run: () => save('theme', theme) })) }) },
      { label: ui('Animations', '动效'), detail: this.options.preferences.motion === 'reduced' ? 'off' : 'on', run: () => save('motion', this.options.preferences.motion === 'reduced' ? 'full' : 'reduced') },
      { label: ui('Interface language', '界面语言'), detail: this.options.preferences.language ?? 'en', run: () => this.screen.menu({ title: ui('Interface language', '界面语言'), items: [
        { label: 'English', run: () => save('language', 'en') }, { label: '中文', run: () => save('language', 'zh') }
      ] }) },
      { label: ui('Reasoning effort', '思考强度'), detail: ui('Shared Router setting', '共享 Router 设置'), run: () => this.execute('/effort') },
      { label: ui('Connection details', '连接详情'), run: () => this.execute('/status') }
    ] })
  }
  private history() {
    this.screen.menu({ title: ui('Search this conversation', '搜索此对话'), items: [
      { label: ui('Load earlier messages', '加载更早消息'), run: async () => { await this.older(); this.history() } },
      ...this.view().messages.filter(publicMessage).map(m => ({ label: m.text.replace(/\s+/g, ' ').slice(0, 160),
        search: m.text, detail: m.role === 'user' ? ui('You', '你') : 'Roppo', run: () => this.screen.transcript.scrollChildIntoView('message-' + m.id, { align: 'start' }) }))
    ] })
  }
  private files() {
    const items = this.view().deliveries.map(file => ({ label: file.name, detail: file.mime + ' · ' + Math.ceil(file.size / 1024) + ' KB', run: () => this.file(file) }))
    this.screen.menu({ title: ui('Conversation files', '对话文件'), items, detail: items.length ? ui('Choose a file to preview or save.', '选择文件以预览或保存。') : ui('No files yet. Attach with @ or ask Roppo to create one.', '还没有文件。用 @ 添加附件，或让 Roppo 创建文件。') })
  }
  private async file(file: Snapshot['deliveries'][number]) {
    const path = this.path('deliveries/' + file.id)
    const bytes = await this.client.request<Uint8Array>(path, undefined, { bytes: true })
    const content = file.preview === 'text' ? new TextDecoder().decode(bytes.slice(0, 32000)) + (bytes.length > 32000 ? '\n… [preview truncated]' : '')
      : file.mime + ' · ' + file.size + ui(' bytes. Save to open with your preferred app.', ' 字节。保存后可用本机应用打开。')
    this.screen.document(file.name, content, [{ label: ui('Save file…', '保存文件…'), run: () => {
      this.screen.prompt(ui('Save to path (existing files are kept)', '保存路径（保留已有文件）'), join(homedir(), 'Downloads', basename(file.name)), async value => {
        const destination = value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(this.options.cwd, value)
        await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
        this.screen.notice(ui('Saved: ', '已保存：') + destination)
      })
    } }])
  }
  private schedules() {
    this.screen.menu({ title: ui('Scheduled actions', '计划事项'), items: [
      { label: ui('Create a reminder in chat', '在对话中创建提醒'), run: () => this.screen.setDraft(ui('Remind me to ', '提醒我')) },
      ...this.view().schedules.map(plan => ({ label: plan.name, detail: (plan.active ? 'on' : 'paused') + (plan.nextAt ? ' · ' + new Date(plan.nextAt).toLocaleString() : ''), run: () => {
        this.screen.document(plan.name, plan.prompt + '\n\n' + JSON.stringify(plan.timing, null, 2) + (plan.lastResult ? '\n\n' + plan.lastResult.text : ''), [{
          label: plan.active ? ui('Pause this schedule', '暂停此计划') : ui('Resume this schedule', '恢复此计划'),
          run: async () => { await this.change(this.path('schedules'), { id: plan.id, expectedRevision: plan.revision, operationId: randomUUID(), active: !plan.active }, true); this.schedules() }
        }, { label: ui('Change instructions in chat', '在对话中修改要求'), run: () => this.screen.setDraft(ui('Update my scheduled action ', '修改我的计划事项：') + '“' + plan.name + '” ' ) }])
      } }))
    ], detail: ui('The local service runs these even when the terminal is closed.', '终端关闭后，本机服务仍会执行这些计划。') })
  }
  private async memory() {
    const workspace = await this.client.request<ReturnType<typeof memoryWorkspace>>('/api/chat/memory')
    const contexts = workspace.contexts.filter(c => c.conversationId)
    const items: TuiItem[] = contexts.flatMap(context => context.items.filter(f => !f.archived).map(fact => ({ label: fact.content,
      detail: fact.kind + ' · ' + fact.state, run: () => this.screen.document(ui('Memory', '记忆'), fact.content, [
        { label: ui('Edit memory', '编辑记忆'), run: () => this.screen.prompt(ui('Edit memory', '编辑记忆'), fact.content, async content => {
          await this.client.request('/api/chat/memory', { entryId: context.id, action: 'edit', id: fact.id, revision: fact.revision, content }); await this.memory()
        }, true) },
        { label: ui('Forget this memory…', '忘记此记忆…'), run: () => this.screen.menu({ title: ui('Forget this memory?', '忘记此记忆？'), detail: fact.content, items: [
          { label: ui('Keep it', '保留'), run: () => this.memory() },
          { label: ui('Forget', '忘记'), run: async () => { await this.client.request('/api/chat/memory', { entryId: context.id, action: 'forget', id: fact.id, revision: fact.revision }); await this.memory() } }
        ] }) }
      ]) })))
    this.screen.menu({ title: ui('Personal memory · shared with web', '个人记忆 · 与网页共享'), items,
      detail: items.length ? ui('Choose a memory to review, edit or forget.', '选择记忆以查看、编辑或忘记。') : ui('No personal memories yet. Tell Roppo what you want it to remember.', '还没有个人记忆，可以直接告诉 Roppo 要记住什么。') })
  }
  async review() {
    const view = this.view()
    const items: TuiItem[] = view.approvals.filter(a => isApprovalPending(a)).map(a => ({ label: a.questions[0]?.question ?? a.facts.command ?? a.facts.reason ?? ui('Review action', '查看操作'),
      run: () => this.approval(a) }))
    const cards = [...view.messages, ...(view.earlierCards ?? []).filter(c => !view.messages.some(m => m.id === c.id))]
    for (const m of cards.filter(m => m.decision && !m.decision.closed && !m.decision.replyRunId)) items.push({ label: m.decision!.question, run: () => {
      this.screen.menu({ title: m.decision!.question, items: [
        ...m.decision!.options.map(o => ({ label: o.label, detail: o.detail, run: () => this.change(this.path('decisions'), { messageId: m.id, answer: o.label }) })),
        { label: ui('Write my own reply…', '填写自己的回答…'), run: () => this.screen.prompt(m.decision!.question, '', answer => this.change(this.path('decisions'), { messageId: m.id, answer })) }
      ] })
    } })
    for (const decision of view.decisions ?? []) if (decision.status === 'pending') items.push({ label: decision.question, detail: decision.target.label, run: () => {
      const terms = [decision.summary, decision.question, decision.target.label,
        decision.target.recipient?.label, decision.target.amount ? decision.target.amount.value + ' ' + decision.target.amount.currency : ''].filter(Boolean).join('\n\n')
      this.screen.document(ui('Your decision', '请你决定'), terms, [{ label: ui('Write a reply…', '填写回答…'), run: () => this.screen.prompt(decision.question, '', text =>
        this.change(this.path('decisions'), { action: 'answer', id: decision.id, version: decision.version, requestId: randomUUID(), text })) }])
    } })
    for (const m of cards.filter(m => m.fileReview?.state === 'pending')) items.push({ label: ui('Review file: ', '确认文件：') + ('text' in m ? m.text : ui('Pending delivery', '待交付文件')), run: async () => {
      const file = await this.client.request<{ text: string }>(this.path('file-reviews') + '?message=' + encodeURIComponent(m.id))
      this.screen.document(ui('File delivery', '文件交付'), file.text, ['approved', 'denied'].map(state => ({ label: state === 'approved' ? ui('Approve delivery', '批准交付') : ui('Decline delivery', '拒绝交付'),
        run: () => this.change(this.path('file-reviews'), { messageId: m.id, state }) })))
    } })
    if (items.length === 1) await items[0]!.run()
    else this.screen.menu({ title: ui('Pending requests', '待处理请求'), items, detail: items.length ? undefined : ui('Nothing needs your reply.', '没有待处理请求。') })
  }
  private approval(a: Snapshot['approvals'][number]) {
    if (a.questions.length) {
      const answers: Record<string, { answers: string[] }> = {}
      const next = (index: number) => {
        const question = a.questions[index]
        if (!question) { this.screen.run(this.change(this.path('approvals'), { id: a.id, value: answers })); return }
        const answer = async (text: string) => { answers[question.id] = { answers: [text] }; next(index + 1) }
        this.screen.menu({ title: question.question, items: [
          ...question.options.map(o => ({ label: o.label, detail: o.detail, run: () => answer(o.label) })),
          ...(question.custom ? [{ label: ui('Write a reply…', '填写回答…'), run: () => this.screen.prompt(question.question, '', answer, false, question.secret) }] : [])
        ] })
      }
      next(0); return
    }
    this.screen.document(ui('Permission needed', '需要授权'), Object.entries(a.facts).map(([key, value]) => key + ': ' + value).join('\n\n'), [
      { label: ui('Allow once', '允许一次'), run: () => this.change(this.path('approvals'), { id: a.id, value: 'accept' }) },
      { label: ui('Decline', '拒绝'), run: () => this.change(this.path('approvals'), { id: a.id, value: 'decline' }) }
    ])
  }
}
