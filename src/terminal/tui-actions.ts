import { byName } from './list-order.ts'
import {configureConnection,SetupCancelled} from './setup.ts'
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
import type { HostSettings } from './host-settings.ts'
import type { ModelCapabilities } from '../reasoning-effort.ts'
import type { memoryWorkspace } from '../memory-workspace.ts'

export const personalCommands = () => byName([
  { name: '/connect', label: ui('Model connections', '模型连接'), detail: ui('API keys, account sign-in and connection checks', 'API 密钥、账号登录与连接检测') },
  { name: '/workers', label: ui('Workers', 'Worker 管理'), detail: ui('Create, copy, pause, resume or remove', '新增、复制、启停和删除') },
  { name: '/plugins', label: ui('Plugins', '插件'), detail: ui('Installed plugins', '已安装插件列表') },
  { name: '/skills', label: ui('Skills', '技能'), detail: ui('Available skills', '已有技能列表') },
  { name: '/mcp', label: 'MCP', detail: ui('Configured MCP servers', '已配置 MCP 服务列表') },
  { name: '/model', label: ui('Models', '模型'), detail: ui('Choose Router or Worker model · F2', '选择 Router 或 Worker 模型 · F2') },
  { name: '/effort', label: ui('Reasoning effort', '思考强度'), detail: ui('Model reasoning level', '模型思考级别') },
  { name: '/plan', label: ui('Plan mode', '计划模式'), detail: ui('Clarify requirements, then make a detailed plan', '先反问澄清需求，再给详细计划') },
  { name: '/compact', label: ui('Compact context', '压缩上下文'), detail: ui('Summarize now or configure automatic compaction', '主动压缩或设置自动压缩') },
  { name: '/clear', label: ui('Clear conversation', '清理会话'), detail: ui('Confirm first; keep memory and schedules', '确认后清理，保留记忆和计划事项') },
  { name: '/rename', label: ui('Rename a Worker', '重命名 Worker'), detail: ui('Choose a Worker and edit its name', '选择 Worker 并修改名称') },
  { name: '/diff', label: ui('Worker changes', 'Worker 改动'), detail: ui('Choose a Worker and inspect its task changes', '选择 Worker 查看任务改动') },
  { name: '/files', label: ui('Files', '文件'), detail: ui('View and save conversation files', '查看和保存对话文件') },
  { name: '/memory', label: ui('Memory', '记忆'), detail: ui('Review and edit personal memory', '查看和编辑个人记忆') },
  { name: '/schedules', label: ui('Scheduled actions', '计划事项'), detail: ui('Reminders and routines', '提醒和定时事项') },
  { name: '/approvals', label: ui('Pending requests', '待处理请求'), detail: ui('Permissions and questions · ctrl+y', '授权和提问 · ctrl+y') },
  { name: '/permissions', label: ui('Permissions', '权限'), detail: ui('Shared account access', '账号共享权限') },
  { name: '/animation', label: ui('Companion animation', '顶部动效'), detail: ui('Toggle the web-style companion on or off', '开关网页版同款角色动效') },
  { name: '/settings', label: ui('Settings', '设置'), detail: ui('Appearance and interaction', '外观和交互') },
  { name: '/history', label: ui('Search conversation', '搜索对话'), detail: ui('Find a message · ctrl+k', '查找消息 · ctrl+k') },
  { name: '/tools', label: ui('Capabilities', '能力'), detail: ui('Tools, skills and MCP servers', '工具、技能和 MCP 服务') },
  { name: '/open', label: ui('Open in browser', '在浏览器打开'), detail: ui('Continue the same conversation', '继续同一段对话') },
  { name: '/status', label: ui('Connection status', '连接状态'), detail: ui('Local service and model', '本机服务和模型') },
  { name: '/context', label: ui('Context usage', '上下文用量'), detail: ui('Measured usage', '实测用量') },
  { name: '/tasks', label: ui('Execution details', '执行详情'), detail: ui('Inspect internal collaboration', '查看内部协作') },
  { name: '/help', label: ui('Help', '帮助'), detail: ui('Keys and commands', '按键和命令') },
  { name: '/exit', label: ui('Exit', '退出'), detail: ui('Keep the local service running', '保持本机服务运行') }
], command => command.name)

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
    return byName(entries.filter(e => !e.name.startsWith('.') && e.name.toLowerCase().includes(term) && (e.isFile() || e.isDirectory())), entry => entry.name).map(entry => {
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
    if (name === '/model' || name === '/effort') { await this.agentSetting(name === '/model' ? 'model' : 'effort'); return }
    if (input === '/compact') { await this.compact(); return }
    if (name === '/connect') { await this.connect(); return }
    if (name === '/workers') { await this.workers(); return }
    if (['/plugins', '/skills', '/mcp'].includes(name!)) { await this.capabilities(name as '/plugins' | '/skills' | '/mcp'); return }
    if (name === '/rename') { await this.renameWorker(); return }
    if (name === '/diff') { this.workerDiff(); return }
    if (name === '/clear') { this.clearConversation(); return }
    if (name === '/plan') { this.planMode(); return }
    if (['/new', '/resume'].includes(name!)) { this.screen.notice(ui('Roppo uses one personal conversation. Use /history to search it.', 'Roppo 使用一段个人对话，可用 /history 搜索。')); return }
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
      if (name === '/animation') { this.screen.notice(control.text!); return }
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
  private async compact() {
    const state = await this.client.request<{settings:{automatic:boolean;threshold:number};last:{at:number;beforeBytes:number;afterBytes:number}|null;running:boolean}>(this.path('compact'))
    const settings = async (value: typeof state.settings) => { await this.client.request(this.path('compact'), {action:'settings',settings:value}); await this.compact() }
    this.screen.menu({title:ui('Context compaction', '上下文压缩'), detail:ui('Keeps the transcript, memory and tasks. Summarizes older context; recent turns remain intact.', '保留聊天记录、记忆和任务，概括较早上下文，保留最近几轮原文。'), items:[
      {label:ui('Compact now', '立即压缩'), detail:state.running?ui('In progress', '正在进行'):state.last?ui('Last compacted: ', '上次压缩：')+new Date(state.last.at).toLocaleString():'',run:async()=>{
        this.screen.setLoading(true);this.screen.notice(ui('Summarizing context…', '正在整理上下文…'))
        try{const result=await this.client.request<{status:string;last:{beforeBytes:number;afterBytes:number}|null}>(this.path('compact'),{action:'compact'},{timeoutMs:310_000});await this.refresh();this.screen.notice(result.status==='unchanged'?ui('Not enough older context to compact yet.', '较早上下文还很少，暂时无需压缩。'):ui('Context compacted. Original messages are still available.', '上下文已压缩，原始消息仍可查看。'))}finally{this.screen.setLoading(false)}
      }},
      {label:ui('Automatic compaction', '自动压缩')+' · '+(state.settings.automatic?'on':'off'),run:()=>settings({...state.settings,automatic:!state.settings.automatic})},
      {label:ui('Trigger threshold', '触发阈值')+' · '+Math.round(state.settings.threshold*100)+'%',run:()=>this.screen.menu({title:ui('Compact before the next turn when usage reaches…', '用量达到此比例时，在下一轮前压缩……'),items:[0.6,0.7,0.8,0.9].map(threshold=>({label:Math.round(threshold*100)+'%'+(threshold===0.8?' · default':''),run:()=>settings({...state.settings,threshold})}))})}
    ]})
  }
  private async connect() {
    let detail = ''
    try {
      await configureConnection(this.client, {
        note: text => { detail = text; this.screen.notice(text) },
        choose: (title, choices) => new Promise((resolve, reject) => {
          this.screen.menu({ title, detail, cancel: () => reject(new SetupCancelled()), items: choices.map((label, i) => ({ label, run: () => resolve(i) })) }); detail = ''
        }),
        text: (title, options = {}) => new Promise((resolve, reject) => this.screen.prompt(title, options.initial ?? '', async value => { resolve(value) }, false, options.secret, { allowEmpty: true, cancel: () => reject(new SetupCancelled()) }))
      })
      await this.refresh()
    } catch (error) { if (!(error instanceof SetupCancelled)) throw error; this.screen.notice(error.message) }
  }
  private async workers() {
    const data = await this.client.request<Pick<ReturnType<import('../worker-manager.ts').WorkerManager['list']>, 'revision' | 'workers' | 'canCreate' | 'connections'>>('/api/terminal/workers')
    const change = async (body: object) => { await this.client.request('/api/terminal/workers', { ...body, revision: data.revision, requestId: randomUUID() }); await this.refresh(); await this.workers() }
    this.screen.menu({ title: ui('Workers', 'Worker 管理'), detail: ui('Shared with the web. Router can also manage Workers when authorized.', '与网页共享，Router 也可在授权范围内管理 Worker。'), items: [
      ...(data.canCreate ? [{ label: ui('Add a Worker', '新增 Worker'), run: () => this.screen.prompt(ui('Worker name', 'Worker 名称'), '', async label => {
        this.screen.menu({ title: ui('Model connection', '模型连接'), items: data.connections.map(connection => ({ label: connection.label ?? connection.id, run: () => change({ action: 'create', profile: { id: 'worker-' + randomUUID().slice(0, 8), label, backend: connection.id } }) })) })
      }) }] : []),
      ...data.workers.map(worker => ({ label: worker.label ?? worker.id, detail: worker.status + ' · ' + (worker.model ?? worker.backend), run: () => this.screen.menu({ title: worker.label ?? worker.id, items: [
        { label: ui('Rename', '重命名'), run: () => this.screen.prompt(ui('Worker name', 'Worker 名称'), worker.label ?? worker.id, async label => { await this.client.request('/api/terminal/settings', { action: 'rename', worker: worker.id, label, revision: data.revision }); await this.refresh(); await this.workers() }) },
        ...(data.canCreate ? [{ label: ui('Duplicate', '复制'), run: () => this.screen.prompt(ui('Copy name', '副本名称'), (worker.label ?? worker.id) + ' copy', label => change({ action: 'clone', from: worker.id, id: 'worker-' + randomUUID().slice(0, 8), patch: { label } })) }] : []),
        { label: worker.state === 'paused' ? ui('Enable', '启用') : ui('Pause new assignments', '暂停接收新任务'), run: () => change({ action: worker.state === 'paused' ? 'resume' : 'pause', id: worker.id }) },
        { label: ui('Remove Worker…', '删除 Worker…'), run: () => this.screen.menu({ title: ui('Remove this Worker?', '删除此 Worker？'), detail: ui('History is retained. Finish or cancel its active tasks first.', '保留历史记录，需先完成或取消其活动任务。'), items: [
          { label: ui('Cancel', '取消'), run: () => {} }, { label: ui('Remove', '删除'), run: () => change({ action: 'destroy', id: worker.id, cancelRunning: false }) }
        ] }) }
      ] }) }))
    ] })
  }
  private async capabilities(name: '/plugins' | '/skills' | '/mcp') {
    const kind = name === '/plugins' ? 'plugin' : name === '/skills' ? 'skill' : 'mcp'
    const library = await this.client.request<import('../capability-types.ts').CapabilitySnapshot>('/api/capability-library')
    const items = library.items.filter(item => item.kind === kind && item.status !== 'candidate')
    this.screen.menu({ title: name, detail: ui('Installed/configured items. Ask Router to install, update or remove capabilities.', '已有条目；安装、更新或删除可在对话中交给 Router 处理。'), items: [
      { label: ui('Ask Router to manage…', '让 Router 管理…'), run: () => this.screen.setDraft(ui('Help me manage ', '帮我管理 ') + name.slice(1) + ': ') },
      ...items.map(item => ({ label: item.name, detail: [item.status, item.version, item.sourceGroup ?? item.source].filter(Boolean).join(' · '), run: () => this.screen.document(item.name, [item.description, ...(item.facts ?? []), ...byName(item.tools ?? [], tool => tool.name).map(tool => tool.name + (tool.description ? ' · ' + tool.description : ''))].filter(Boolean).join('\n'), [
        { label: ui('Ask Router about this item', '让 Router 处理此项'), run: () => this.screen.setDraft(ui('Help me manage ', '帮我管理 ') + kind + ' “' + item.name + '” (' + item.source + '): ') }
      ]) }))
    ] })
  }
  private async agentSetting(action: 'model' | 'effort') {
    const settings = await this.client.request<HostSettings>('/api/terminal/settings')
    const choose = async (worker?: HostSettings['workers'][number]) => {
      const selected = worker ?? settings, label = worker?.label ?? 'Router'
      const save = async (value: object) => {
        await this.client.request('/api/terminal/settings', { action, revision: settings.revision, ...(worker ? { worker: worker.id } : {}), ...value })
        await this.refresh(); this.screen.notice(ui('Updated: ', '已更新：') + label)
      }
      if (action === 'effort') {
        const catalog = await this.client.request<ModelCapabilities>('/api/terminal/models?' + new URLSearchParams({ backend: selected.backend, ...(selected.model ? { model: selected.model } : {}) }))
        this.screen.menu({ title: label + ' · ' + ui('Reasoning effort', '思考强度'), items: [
          { label: 'default', run: () => save({ effort: null }) },
          ...catalog.reasoning.efforts.map(effort => ({ label: effort, detail: selected.effort === effort ? '✓' : '', run: () => save({ effort }) }))
        ] }); return
      }
      this.screen.menu({ title: label + ' · ' + ui('Model connection', '模型连接'), items: settings.connections.map(connection => ({
        label: connection.label, detail: connection.id === selected.backend ? '✓' : connection.kind, run: async () => {
          const catalog = await this.client.request<ModelCapabilities>('/api/terminal/models?' + new URLSearchParams({ backend: connection.id }))
          this.screen.menu({ title: label + ' · ' + connection.label, items: [
            { label: ui('Connection default', '连接默认模型'), run: () => save({ backend: connection.id }) },
            ...catalog.models.map(model => ({ label: model, detail: model === selected.model && selected.backend === connection.id ? '✓' : '', run: () => save({ backend: connection.id, model }) })),
            { label: ui('Enter model ID…', '输入模型 ID…'), run: () => this.screen.prompt('Model ID', '', model => save({ backend: connection.id, model })) }
          ] })
        }
      })) })
    }
    this.screen.menu({ title: ui('Configure which agent?', '配置哪个 Agent？'), items: [
      { label: 'Router', detail: settings.model ?? settings.backend, run: () => choose() },
      { label: 'Worker', detail: ui('Choose a specific Worker', '选择具体 Worker'), run: () => this.screen.menu({ title: ui('Choose a Worker', '选择 Worker'), items: settings.workers.map(w => ({ label: w.label, detail: (w.model ?? w.backend) + ' · ' + w.state, run: () => choose(w) })) }) }
    ] })
  }
  private async renameWorker() {
    const settings = await this.client.request<HostSettings>('/api/terminal/settings')
    this.screen.menu({ title: ui('Rename which Worker?', '重命名哪个 Worker？'), items: settings.workers.map(w => ({
      label: w.label, detail: w.model ?? w.backend, run: () => this.screen.prompt(ui('Worker name', 'Worker 名称'), w.label, async label => {
        await this.client.request('/api/terminal/settings', { action: 'rename', worker: w.id, revision: settings.revision, label })
        await this.refresh(); this.screen.notice(ui('Renamed: ', '已重命名：') + label)
      })
    })) })
  }
  private workerDiff() {
    const view = this.view()
    this.screen.menu({ title: ui('Choose a Worker', '选择 Worker'), items: view.workers.map(w => ({
      label: w.label, run: () => {
        const tasks = view.tasks.filter(t => t.workerId === w.id).sort((a, b) => b.updatedAt - a.updatedAt)
        this.screen.menu({ title: w.label + ' · ' + ui('Changes', '改动'), detail: tasks.length ? undefined : ui('This Worker has no tasks in this conversation.', '此 Worker 在当前对话中还没有任务。'), items: tasks.map(t => ({
          label: t.title, detail: t.state, run: async () => {
            const diff = await command(this.client, this.conversation.id, '/diff ' + t.id)
            this.screen.document(w.label + ' · ' + t.title, diff)
          }
        })) })
      }
    })) })
  }
  private clearConversation() {
    const expectedSequence = this.view().conversation.sequence
    this.screen.menu({ title: ui('Clear this conversation?', '确认清理此对话？'), detail: ui('Clears messages and working context, after the current request has finished. Long-term memory and scheduled actions are kept. This cannot be undone.', '清理消息和工作上下文，当前任务需先结束。保留长期记忆和计划事项。此操作无法撤销。'), items: [
      { label: ui('Cancel', '取消'), run: () => {} },
      { label: ui('Confirm clear', '确认清理'), run: async () => {
        await this.client.request('/api/terminal/clear', { conversation: this.conversation.id, expectedSequence, operationId: randomUUID() })
        await this.refresh(); this.screen.setDraft(''); this.screen.notice(ui('Conversation cleared. Memory and schedules kept.', '对话已清理，记忆和计划事项已保留。'))
      } }
    ] })
  }
  private planMode() {
    const active = this.view().conversation.mode === 'plan'
    this.screen.menu({ title: ui('Conversation mode', '对话模式'), detail: ui('Plan: clarify requirements first, then produce a detailed plan. No Worker execution. Switching back does not start work automatically.', '计划模式：先反问澄清需求，再形成详细计划，不执行 Worker 任务。切回执行模式不会自动开始任务。'), items: [
      { label: ui('Plan · clarify and design', '计划 · 澄清与设计'), detail: active ? '✓' : '', run: () => this.change('/api/terminal/mode', { conversation: this.conversation.id, mode: 'plan' }) },
      { label: ui('Act · normal conversation', '执行 · 正常对话'), detail: active ? '' : '✓', run: () => this.change('/api/terminal/mode', { conversation: this.conversation.id, mode: 'act' }) }
    ] })
  }
  private settings() {
    const save = (key: string, value: string) => {
      const { patch } = saveTerminalSetting(this.options.cwd, key, value)
      Object.assign(this.options.preferences, patch)
      if (patch.language) configureLanguage(patch.language)
      this.screen.preferences(this.options.preferences); this.settings()
    }
    this.screen.menu({ title: ui('Settings', '设置'), detail: ui('Appearance is local. Agent settings are shared with the web.', '外观仅影响此终端；Agent 设置与网页共享。'), items: [
      { label: ui('Color mode', '配色'), detail: this.options.preferences.theme ?? 'system', run: () => this.screen.menu({ title: ui('Color mode', '配色'), items: ['system', 'dark', 'light', 'mono'].map(theme => ({ label: theme, run: () => save('theme', theme) })) }) },
      { label: ui('Top companion', '顶部角色动效'), detail: this.options.preferences.animation === false ? 'off' : 'on', run: () => this.execute('/animation') },
      { label: ui('Animations', '动效'), detail: this.options.preferences.motion === 'reduced' ? 'off' : 'on', run: () => save('motion', this.options.preferences.motion === 'reduced' ? 'full' : 'reduced') },
      { label: ui('Interface language', '界面语言'), detail: this.options.preferences.language ?? 'en', run: () => this.screen.menu({ title: ui('Interface language', '界面语言'), items: [
        { label: 'English', run: () => save('language', 'en') }, { label: '中文', run: () => save('language', 'zh') }
      ] }) },
      { label: ui('Model connections', '模型连接'), run: () => this.execute('/connect') },
      { label: ui('Workers', 'Worker 管理'), run: () => this.execute('/workers') },
      { label: ui('Models', '模型'), detail: 'Router / Worker', run: () => this.execute('/model') },
      { label: ui('Reasoning effort', '思考强度'), detail: 'Router / Worker', run: () => this.execute('/effort') },
      { label: ui('Rename a Worker', '重命名 Worker'), run: () => this.execute('/rename') },
      { label: ui('Permissions', '权限'), run: () => this.execute('/permissions') },
      { label: ui('Context compaction', '上下文压缩'), run: () => this.execute('/compact') },
      { label: ui('Connection details', '连接详情'), run: () => this.execute('/status') }
    ] })
  }
  private history() {
    this.screen.menu({ title: ui('Search this conversation', '搜索此对话'), order: 'source', items: [
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
