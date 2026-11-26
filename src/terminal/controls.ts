import { TerminalClient, CliError, type Conversation } from './client.ts'
import type { HostSettings } from './host-settings.ts'
import type { ModelCapabilities } from '../reasoning-effort.ts'
import type { Choice } from './suggestions.ts'
import { saveTerminalSetting, type TerminalSettings } from './settings.ts'
import { ui } from './language.ts'
import { isApprovalPending } from '../chat-workflow.ts'

export interface ControlResult {
  text?: string
  menu?: { title: string; items: Choice[] }
  next?: Conversation
  preferences?: TerminalSettings
}
const shared = () => ui('Shared with web · applies to future Router turns', '与网页共享 · 对后续 Router 轮次生效')
export async function controlCommand(client: TerminalClient, conversation: Conversation, input: string,
  cwd: string, preferences: TerminalSettings, sources: string[]): Promise<ControlResult | undefined> {
  const [name, ...args] = input.trim().split(/\s+/)
  if (name === '/config' || name === '/theme') {
    if (name === '/theme' && args[0]) args[0] = 'theme=' + args[0]
    if (args.length) {
      const [assignment, scope = 'user', ...extra] = args
      const match = /^([a-zA-Z]+)=(.+)$/.exec(assignment!)
      if (!match || extra.length || !['user', 'project', 'local'].includes(scope))
        throw new CliError(ui('Use /config key=value [user|project|local].', '用法：/config key=value [user|project|local]。'))
      const saved = saveTerminalSetting(cwd, match[1]!, match[2]!, scope as 'user' | 'project' | 'local')
      if (!sources.includes(saved.path)) sources.push(saved.path)
      return { preferences: saved.patch, text: ui('Saved: ', '已保存：') + saved.path }
    }
    const title = name === '/theme' ? ui('Theme', '主题') : ui('Terminal settings · user defaults', '终端设置 · 用户默认值')
    const items: Choice[] = (['dark', 'light', 'mono'] as const).map(value => ({ label: 'theme = ' + value,
      detail: preferences.theme === value ? '✓' : '', value: '/config theme=' + value }))
    if (name === '/config') items.push(
      { label: 'verbose = ' + !preferences.verbose, detail: ui('Execution details', '内部执行详情'), value: '/config verbose=' + !preferences.verbose },
      { label: 'motion = ' + (preferences.motion === 'reduced' ? 'full' : 'reduced'), detail: ui('Activity animations', '活动动效'), value: '/config motion=' + (preferences.motion === 'reduced' ? 'full' : 'reduced') },
      ...(['zh', 'en'] as const).map(value => ({ label: 'language = ' + value, detail: ui('Interface language', '界面语言'), value: '/config language=' + value })),
      { label: '/model', detail: shared(), value: '/model' },
      { label: '/permissions', detail: ui('Shared account permissions', '账号共享权限'), value: '/permissions' }
    )
    return { menu: { title, items }, text: JSON.stringify(preferences, null, 2) + '\n' + sources.join('\n') }
  }
  if (name === '/status') {
    const [settings, view] = await Promise.all([client.request<HostSettings>('/api/terminal/settings'), client.view(conversation.id)])
    return { text: [
      'Roppo · ' + client.base,
      ui('Session: ', '会话：') + conversation.id,
      ...(conversation.project ? [ui('Project: ', '项目：') + conversation.project] : [ui('Personal conversation · shared with web', '个人对话 · 与网页同步')]),
      ui('Router: ', 'Router：') + settings.backend + ' / ' + (settings.model ?? 'default'),
      ui('Permissions: ', '权限：') + settings.approvalMode + ui(' (shared account)', '（账号共享）'),
      ui('Readiness: ', '就绪状态：') + view.readiness.code,
      ui('Terminal settings: ', '终端设置：') + (sources.join(', ') || ui('defaults', '默认值'))
    ].join('\n') }
  }
  if (name === '/approvals' && args.length <= 1) {
    const view = await client.view(conversation.id)
    const pending = view.approvals.filter(a => isApprovalPending(a))
    if (!pending.length && !args.length) return { text: ui('No pending requests.', '没有待授权的操作。') }
    if (!args.length) return { menu: {
      title: ui('Actions awaiting your permission', '需要你授权的操作'),
      items: pending.map(a => ({
        label: a.facts.command ?? a.questions[0]?.question ?? a.facts.reason ?? ui('Review permission', '查看授权请求'),
        detail: a.facts.cwd ?? '', value: '/approvals ' + a.id
      }))
    } }
    const request = pending.find(a => a.id === args[0])
    if (!request) return undefined // Preserve explicit task-level diagnostic commands.
    if (request.method === 'item/tool/requestUserInput') return { text:
      request.questions.map(q => q.question).join('\n') + '\n' + ui('Open the conversation to answer: ', '打开对话回答：') + client.link(conversation.id) }
    return { text: Object.entries(request.facts).map(([key, value]) => key + ': ' + value).join('\n'),
      menu: { title: request.facts.command ?? request.facts.reason ?? ui('Allow this action?', '允许此操作？'), items: [
      { label: ui('Allow', '允许'), detail: request.facts.cwd ?? '', value: '/approve ' + request.ticketId + ' ' + request.id },
      { label: ui('Decline', '拒绝'), detail: '', value: '/decline ' + request.ticketId + ' ' + request.id }
    ] } }
  }
  if (name === '/context') {
    const context = await client.request<{ inputTokens: number | null; capacity: number | null; model: string | null; previous: boolean; budget: {bytes: number; maxBytes: number} | null }>('/api/chat/conversations/' + conversation.id + '/context')
    return { text: [context.model ?? 'Router',
      context.inputTokens === null ? ui('No token measurement yet.', '暂时没有 token 测量数据。') : ui('Input tokens: ', '输入 token：') + context.inputTokens + (context.capacity ? ' / ' + context.capacity : ''),
      context.budget ? ui('Context bytes: ', '上下文字节：') + context.budget.bytes + ' / ' + context.budget.maxBytes : '',
      context.previous ? ui('Showing the previous measured turn.', '显示上次有测量数据的轮次。') : ''
    ].filter(Boolean).join('\n') }
  }
  if (name === '/model' || name === '/effort' || name === '/permissions') {
    const settings = await client.request<HostSettings>('/api/terminal/settings')
    if (name === '/permissions') {
      if (!args.length) return { menu: { title: ui('Permissions · shared with web and all account sessions', '权限 · 与网页及账号全部会话共享'), items: [
        { label: ui('Ask before restricted actions', '受限操作先询问'), detail: settings.approvalMode === 'ask' ? '✓' : '', value: '/permissions ask' },
        { label: ui('Full access', '完全访问'), detail: ui('Automatically allow host-managed actions; source sandbox still applies', '自动允许宿主管理的操作；仍受来源沙箱约束'), value: '/permissions full' }
      ] } }
      if (args.length !== 1 || !['ask', 'full'].includes(args[0]!)) throw new CliError('Use /permissions ask|full')
      await client.request('/api/terminal/settings', { action: 'permissions', mode: args[0] })
      return { text: ui('Account permissions: ', '账号权限：') + args[0] + ' · ' + shared() }
    }
    if (name === '/effort') {
      if (args.length) {
        if (args.length !== 1) throw new CliError('Use /effort LEVEL|default')
        await client.request('/api/terminal/settings', { action: 'effort', revision: settings.revision, effort: args[0] === 'default' ? null : args[0] })
        return { text: ui('Reasoning effort: ', '思考强度：') + args[0] + ' · ' + shared() }
      }
      const query = new URLSearchParams({ backend: settings.backend, ...(settings.model ? { model: settings.model } : {}) })
      const catalog = await client.request<ModelCapabilities>('/api/terminal/models?' + query)
      return { menu: { title: ui('Reasoning effort · ', '思考强度 · ') + shared(), items: [
        { label: 'default', detail: ui('Let the model choose', '使用模型默认值'), value: '/effort default' },
        ...catalog.reasoning.efforts.map(level => ({ label: level, detail: settings.effort === level ? '✓' : '', value: '/effort ' + level }))
      ] } }
    }
    if (!args.length) return { menu: { title: ui('Model connection · ', '模型连接 · ') + shared(), items: settings.connections.map(c => ({
      label: c.label, detail: [c.id === settings.backend ? '✓' : '', c.kind, c.model].filter(Boolean).join(' · '), value: '/model ' + c.id
    })) } }
    const [backend, model, ...extra] = args
    if (!settings.connections.some(c => c.id === backend) || extra.length) throw new CliError('Use /model CONNECTION [MODEL|--default]')
    if (!model) {
      const catalog = await client.request<ModelCapabilities>('/api/terminal/models?' + new URLSearchParams({ backend: backend! }))
      return { menu: { title: backend + ' · ' + shared(), items: [
        { label: ui('Connection default', '连接默认模型'), detail: '', value: '/model ' + backend + ' --default' },
        ...catalog.models.map(id => ({ label: id, detail: backend === settings.backend && id === settings.model ? '✓' : '', value: '/model ' + backend + ' ' + id }))
      ] }, text: catalog.catalogUnavailable ? ui('Model catalog unavailable. You can enter /model CONNECTION MODEL directly.', '暂时无法获取模型列表，可直接输入 /model 连接 模型。') : undefined }
    }
    await client.request('/api/terminal/settings', { action: 'model', revision: settings.revision, backend, ...(model === '--default' ? {} : { model }) })
    return { text: backend + ' / ' + model + ' · ' + shared() }
  }
  if (name === '/rename') {
    const title = args.join(' ')
    if (!title || title.length > 100) throw new CliError(ui('Use /rename TITLE (up to 100 characters).', '用法：/rename 标题（最多 100 字符）。'))
    await client.request('/api/chat/conversations/' + conversation.id, { title }, { method: 'PATCH' })
    return { text: ui('Renamed: ', '已重命名：') + title }
  }
  if (name === '/clear' || name === '/new') {
    if (args.length) throw new CliError('Use /clear without arguments')
    const next = conversation.project ? await client.create(conversation.project) : await client.request<Conversation>('/api/chat/conversations', {})
    await client.request('/api/terminal/session', { id: next.id })
    return { next }
  }
  if (name === '/resume') {
    const { conversations } = await client.request<{conversations: Conversation[]}>('/api/chat/conversations')
    const list = conversations.filter(c => c.project === conversation.project)
    if (!args.length) return { menu: { title: ui('Resume conversation', '继续会话'), items: list.map(c => ({
      label: c.title || ui('New conversation', '新会话'), detail: c.id, value: '/resume ' + c.id
    })) } }
    const next = args.length === 1 && list.find(c => c.id === args[0])
    if (!next) throw new CliError(ui('Conversation not found in this workspace.', '当前工作区找不到该会话。'))
    await client.request('/api/terminal/session', { id: next.id })
    return { next }
  }
}
