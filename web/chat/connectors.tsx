import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Check, ChevronRight, LoaderCircle, Search } from 'lucide-react'
import { renderSVG } from 'uqr'
import { Button, CheckField, ChoiceGroup, Dialog, TextField } from '../ui'
import type { FeishuPairingView } from '../../src/feishu-pairing.ts'
import type { OfficePairingView } from '../../src/office-bot-pairing.ts'
import type { OfficeBotKind } from '../../src/office-bot-registration.ts'
import type { OfficeAppKind, OfficeAppView } from '../../src/office-mcp.ts'
import { AppBrand } from './app-brand.tsx'
import './connectors.css'

type Language = 'en' | 'zh-CN'
type Translate = (en: string, zh: string) => string
type Tab = 'available' | 'connected'
type Definition = { kind: string; label: string; pluginId?: string; setupAvailable: boolean }
type Connection = { id: string; kind: string; label: string; enabled: boolean; scopeCount: number; officeManaged?: boolean; liveStatus?: string; observedGroups?: number }
type GithubAccess = { status: string; account?: string; tools?: string[] }
type OfficeApp = { kind: OfficeAppKind; label: string } & OfficeAppView
type Inventory = { definitions: Definition[]; instances: Connection[]; github?: GithubAccess; officeApps?: OfficeApp[] }
type OfficeBotDialogInput = { kind: OfficeBotKind; sourceId?: string }
type OfficeAppDialogInput = { app: OfficeApp; redirect?: { popup: Window | null } }
type Connected = Extract<FeishuPairingView, { stage: 'connected' }>
const setup = '/api/connectors/feishu/setup'
const githubSetup = '/api/connectors/github/setup'
const entryKinds = ['feishu', 'dingtalk', 'wecom', 'github']
const botKind = (kind: string): kind is OfficeBotKind => kind === 'dingtalk' || kind === 'wecom'
const appNames: Record<string, [string, string]> = {
  feishu: ['Feishu', '飞书'], wecom: ['WeCom', '企业微信'], dingtalk: ['DingTalk', '钉钉'], webhook: ['Event automations', '事件自动化'],
}

const nameFor = (kind: string, fallback: string, L: Translate) => appNames[kind] ? L(...appNames[kind]) : fallback
const prettyLabel = (source: Connection, L: Translate) => source.label === 'Feishu / 飞书' || source.officeManaged ? nameFor(source.kind, source.label, L) : source.label

async function request<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal,
    ...(body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}))
    throw Error(typeof problem.code === 'string' ? problem.code : 'feishu_request_failed')
  }
  return response.json()
}

function manageLink(kind: string, id?: string, pluginId?: string) {
  if (entryKinds.includes(kind)) return '/configure#connections/' + (id ? kind + '/' + encodeURIComponent(id) : 'new/' + kind)
  if (kind === 'webhook') return '/configure#automations'
  return pluginId ? '/configure#integrations/installed' : '/configure#deployments'
}

function ConnectorMark({ kind }: { kind: string }) {
  return <span className="connector-mark"><AppBrand kind={kind} category="source" size={23} /></span>
}

export function ConnectorsWorkspace({ language }: { language: Language }) {
  const L: Translate = (en, zh) => language === 'en' ? en : zh
  const [data, setData] = useState<Inventory>()
  const [failed, setFailed] = useState(false)
  const [version, setVersion] = useState(0)
  const [tab, setTab] = useState<Tab>('available')
  const [query, setQuery] = useState('')
  const [pairing, setPairing] = useState(false)
  const [githubDialog, setGithubDialog] = useState(false)
  const [officeBot, setOfficeBot] = useState<OfficeBotDialogInput>()
  const [officeApp, setOfficeApp] = useState<OfficeAppDialogInput>()
  const [notice, setNotice] = useState<Connected>()
  const [officeNotice, setOfficeNotice] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setFailed(false)
    async function read(initial: boolean) {
      try {
        const value = await request<Inventory>('/api/connectors', undefined, controller.signal)
        if (controller.signal.aborted) return
        setData(value)
        if (tab === 'connected' && value.instances.some(item => item.officeManaged && item.enabled))
          timer = setTimeout(() => void read(false), 4000)
      } catch {
        if (controller.signal.aborted) return
        if (initial) setFailed(true)
        else timer = setTimeout(() => void read(false), 4000)
      }
    }
    void read(true)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [tab, version])

  const definitions = data?.definitions ?? []
  const providers = [
    ...entryKinds.flatMap(kind => definitions.filter(item => item.kind === kind)),
    ...definitions.filter(item => !entryKinds.includes(item.kind) && item.pluginId && item.setupAvailable),
  ]
  const term = query.trim().toLocaleLowerCase()
  const matches = (...values: string[]) => values.some(value => value.toLocaleLowerCase().includes(term))
  const instances = data?.instances ?? []
  const available = providers.filter(item => matches(item.kind, item.label, nameFor(item.kind, item.label, L)))
  const apps = (data?.officeApps ?? []).filter(app => matches(app.kind, app.label))
  const connectedApps = apps.filter(app => app.status === 'connected' || app.status === 'auth_required')
  const connected = instances.filter(item => matches(item.kind, item.label, nameFor(item.kind, item.label, L)))
  const github = data?.github
  const githubConnected = !!github?.account
  const showGithub = githubConnected && matches('GitHub', github.account ?? '')
  const startFeishu = () => { setOfficeNotice(''); setNotice(undefined); setPairing(true) }
  const openBot = (kind: OfficeBotKind, sourceId?: string) => {
    setOfficeNotice('')
    setNotice(undefined)
    setOfficeBot({ kind, sourceId })
  }
  const refreshList = (next: Tab) => {
    setQuery('')
    setTab(next)
    setVersion(value => value + 1)
  }
  const finishFeishu = (result: Connected) => {
    setPairing(false)
    setNotice(result)
    setQuery('')
    setTab('connected')
    setVersion(value => value + 1)
  }
  const groupCount = (n: number) => L(n + (n === 1 ? ' group' : ' groups'), n + ' 个群')

  return <div className="connectors-scroll roppo-ui">
    <section className="connectors-page" aria-labelledby="connectors-title">
      <header className="connectors-heading">
        <h1 id="connectors-title">{L('Connectors', '连接器')}</h1>
        <TextField type="search" icon={<Search size={18} />} label={L('Search connectors', '搜索连接器')}
          placeholder={L('Search connectors', '搜索连接器')} value={query} onChange={event => setQuery(event.target.value)} />
      </header>
      <div className="connectors-filter">
        <ChoiceGroup label={L('Show connectors', '筛选连接器')} value={tab} onChange={setTab} choices={[
          { value: 'available', label: L('Available', '可用') },
          { value: 'connected', label: L('Connected', '已连接') },
        ]} />
      </div>
      {officeNotice && <p className="connector-notice" role="status"><Check size={19} />{officeNotice}</p>}
      {notice && <p className="connector-notice" role="status"><Check size={19} />
        {notice.memberRequired
          ? L('Groups connected. Confirm who can send requests in Manage.', '群已连接。请在「管理」里确认谁可以交代任务。')
          : L('Feishu connected · ', '飞书已连接 · ') + groupCount(notice.groupCount)}
      </p>}
      {failed ? <div className="connector-empty" role="alert">
        <span>{L('Couldn’t load connectors.', '未能读取连接器。')}</span>
        <Button onClick={() => setVersion(value => value + 1)}>{L('Retry', '重试')}</Button>
      </div> : !data ? <p className="connector-empty" role="status"><LoaderCircle size={18} className="rp-spin" />
        {L('Loading connectors…', '正在读取连接器…')}
      </p> : (tab === 'available' ? !available.length && !apps.length : !connected.length && !showGithub && !connectedApps.length) ? <p className="connector-empty" role="status">
        {term ? L('No matching connectors', '没有找到匹配的连接器') : L('No connectors connected', '还没有连接的应用')}
      </p> : tab === 'available' ? <ul className="connector-list">
        {available.map(item => {
          const name = nameFor(item.kind, item.label, L)
          const related = instances.filter(source => source.kind === item.kind && source.enabled)
          const managed = related.find(source => source.officeManaged)
          const kind = item.kind
          return <li className="connector-row" key={item.kind}>
            <ConnectorMark kind={item.kind} />
            <div className="connector-identity">
              <strong>{name}</strong>
              {item.kind === 'github'
                ? <span>{L('Repository access', '仓库读写')}</span>
                : related.length > 0 && <span>{L('Added', '已添加')}</span>}
            </div>
            {item.kind === 'feishu'
              ? <Button aria-label={L('Connect Feishu', '连接飞书')} onClick={startFeishu}>{related.length ? L('Add', '添加') : L('Connect', '连接')}</Button>
              : item.kind === 'github' ? <Button aria-label={githubConnected ? L('Manage GitHub', '管理 GitHub') : L('Connect GitHub', '连接 GitHub')}
                onClick={() => setGithubDialog(true)}>{githubConnected ? L('Manage', '管理') : L('Connect', '连接')}</Button>
              : botKind(kind) ? <Button aria-label={(managed ? L('Manage ', '管理') : L('Connect ', '连接')) + name}
                onClick={() => openBot(kind, managed?.id)}>{managed ? L('Manage', '管理') : L('Connect', '连接')}</Button>
              : <a className="rp-button connector-link" data-tone="secondary" href={manageLink(item.kind, related[0]?.id, item.pluginId)}
                aria-label={(related.length ? L('Manage ', '管理') : L('Connect ', '连接')) + name}>{related.length ? L('Manage', '管理') : L('Connect', '连接')}</a>}
          </li>
        })}
        {apps.map(app => <OfficeAppRow key={app.kind} app={app} L={L} open={setOfficeApp} />)}
      </ul> : <ul className="connector-list">
        {connectedApps.map(app => <OfficeAppRow key={app.kind} app={app} L={L} open={setOfficeApp} quiet />)}
        {showGithub && <li className="connector-row">
          <ConnectorMark kind="github" />
          <div className="connector-identity">
            <strong>GitHub</strong>
            <span>{github.status === 'connected' ? '@' + github.account
              : L('Reconnect required', '需要重新连接')}</span>
          </div>
          <Button tone="quiet" aria-label={L('Manage GitHub connection', '管理 GitHub 连接')}
            onClick={() => setGithubDialog(true)}>{L('Manage', '管理')}<ChevronRight size={16} /></Button>
        </li>}
        {connected.map(item => {
          const name = prettyLabel(item, L)
          const definition = data.definitions.find(value => value.kind === item.kind)
          return <li className="connector-row" key={item.id}>
            <ConnectorMark kind={item.kind} />
            <div className="connector-identity"><strong>{name}</strong>
              <span>{!item.enabled ? L('Paused', '已停用') : item.scopeCount > 0 && ['feishu', 'wecom', 'dingtalk', 'slack'].includes(item.kind)
                ? groupCount(item.scopeCount) + (item.officeManaged
                  ? item.observedGroups ? L(' · Group messages received', ' · 收到过普通消息')
                    : item.liveStatus === 'ready' ? L(' · @mentions', ' · @ 对话') : L(' · Connecting', ' · 等待机器人连接')
                  : '') : L('Enabled', '已启用')}</span>
            </div>
            {item.officeManaged && item.enabled && botKind(item.kind)
              ? <Button tone="quiet" aria-label={L('Manage ', '管理') + name} onClick={() => openBot(item.kind as OfficeBotKind, item.id)}>
                {L('Manage', '管理')}<ChevronRight size={16} /></Button>
              : <a className="rp-button connector-link" data-tone="quiet" href={manageLink(item.kind, item.id, definition?.pluginId)}
                aria-label={L('Manage ', '管理') + name}>{L('Manage', '管理')}<ChevronRight size={16} /></a>}
          </li>
        })}
      </ul>}
    </section>
    {officeBot && <OfficeBotDialog input={officeBot} L={L} close={() => setOfficeBot(undefined)} finish={count => {
      setOfficeBot(undefined)
      setOfficeNotice(nameFor(officeBot.kind, '', L) + ' · ' + groupCount(count))
      refreshList('connected')
    }} />}
    {officeApp && <OfficeAppDialog input={officeApp} L={L} close={() => setOfficeApp(undefined)} finish={connected => {
      setOfficeApp(undefined)
      setNotice(undefined)
      setOfficeNotice(connected ? officeApp.app.label + L(' connected', ' 已连接') : '')
      refreshList(connected ? 'connected' : 'available')
    }} />}
    <FeishuDialog open={pairing} L={L} close={() => setPairing(false)} finish={finishFeishu} />
    {githubDialog && <GithubDialog github={github} L={L} close={() => setGithubDialog(false)} finish={result => {
      setGithubDialog(false)
      setData(value => value && {...value, github:result})
      setQuery('')
      setTab(result.status === 'disconnected' ? 'available' : 'connected')
      setVersion(value => value + 1)
    }} />}
  </div>
}

function GithubDialog({ github, L, close, finish }: { github?: GithubAccess; L: Translate; close: () => void; finish: (result: GithubAccess) => void }) {
  const tokenId = useId()
  const tokenLabel = L('GitHub access token', 'GitHub 访问令牌')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (disconnect = false) => {
    setBusy(true)
    setError('')
    try {
      const result = await request<GithubAccess>(disconnect ? '/api/connectors/github/disconnect' : githubSetup,
        disconnect ? {} : { token: token.trim() })
      setToken('')
      finish(result)
    } catch (problem) {
      const code = problem instanceof Error ? problem.message : ''
      setError(githubSetupError(code, L))
    } finally { setBusy(false) }
  }
  return <Dialog open title={github?.account ? L('GitHub connection', 'GitHub 连接') : L('Connect GitHub', '连接 GitHub')}
    closeLabel={L('Close', '关闭')} onClose={() => { if (!busy) close() }}
    footer={<>
      {github?.account && <Button tone="quiet" disabled={busy} onClick={() => void save(true)}>{L('Disconnect', '断开连接')}</Button>}
      <Button tone="primary" busy={busy} disabled={!token.trim()}
        onClick={() => void save()}>{github?.account ? L('Update connection', '更新连接') : L('Verify and connect', '验证并连接')}</Button>
    </>}>
    <div className="connector-github-fields">
      {github?.account && <p>{L('Connected as ', '当前账号 ')}<strong>@{github.account}</strong></p>}
      <div className="connector-github-field">
        <label htmlFor={tokenId}>{tokenLabel}</label>
        <TextField id={tokenId} label={tokenLabel} type="password" value={token}
          autoComplete="off" disabled={busy} onChange={event => setToken(event.target.value)} />
      </div>
      <p>{L('GitHub uses the token to determine repository access and operation permissions.',
        '仓库访问和操作权限由 GitHub 根据令牌决定。')}</p>
      <p><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
        {L('Create a GitHub token', '创建 GitHub 令牌')}<ArrowUpRight size={14} />
      </a><a href={manageLink('github')}>{L('Configure GitHub events', '配置 GitHub 事件')}</a></p>
      {error && <p className="connector-pairing-error" role="alert">{error}</p>}
    </div>
  </Dialog>
}

function githubSetupError(code: string, L: Translate) {
  switch (code) {
    case 'auth_required': return L('GitHub rejected the token. Check that it is active.', 'GitHub 拒绝了这个令牌，请确认令牌仍有效。')
    case 'access_denied': case 'not_found': return L('GitHub could not verify this connection. Check the token permissions.', 'GitHub 无法验证此连接，请检查令牌权限。')
    case 'unsupported': return L('GitHub did not expose write tools for this credential.', 'GitHub 未向这个令牌提供写入工具。')
    case 'conflict': return L('The connection changed. Refresh and try again.', '连接已变化，请刷新后重试。')
    case 'invalid_request': return L('Enter a valid GitHub token.', '请填写有效的 GitHub 令牌。')
    case 'rate_limited': return L('GitHub is rate limiting requests. Try again later.', 'GitHub 正在限流，请稍后重试。')
    case 'preview_restricted': return L('Open your Roppo workspace to connect GitHub.', '请在正式工作区连接 GitHub。')
    default: return L('Couldn’t connect to GitHub. Try again.', 'GitHub 暂未连接，请重试。')
  }
}

function pairingError(code: string, L: Translate) {
  switch (code) {
    case 'feishu_qr_expired': return L('This code has expired.', '二维码已过期。')
    case 'feishu_qr_denied': return L('Setup was not approved in Feishu.', '这次接入未在飞书确认。')
    case 'feishu_qr_unavailable': return L('Couldn’t get a code from Feishu.', '暂时无法获取飞书二维码。')
    case 'feishu_saved_unreadable': return L('Couldn’t read the saved connection.', '无法读取已保存的飞书连接。')
    case 'feishu_bot_unavailable': return L('Feishu hasn’t made the bot available yet. Check it in Feishu and try again.', '飞书机器人暂未就绪，请在飞书确认后重试。')
    case 'feishu_chat_access': return L('The bot can’t read these groups yet. Check its group access in Feishu and try again.', '机器人暂时无法读取群消息。请在飞书确认群消息权限后重试。')
    case 'feishu_group_unavailable': return L('Some groups are no longer available. Refresh and select them again.', '有群已无法访问。请刷新后重新选择。')
    case 'preview_restricted': return L('Open your Roppo workspace to connect Feishu.', '请在正式工作区连接飞书。')
    case 'configuration_busy': case 'configuration_restarting':
      return L('Roppo is busy. Try again in a moment.', 'Roppo 正忙，请稍后重试。')
    default: return L('Couldn’t connect to Feishu. Try again.', '飞书暂未连接，请重试。')
  }
}

function FeishuDialog({ open, close, finish, L }: { open: boolean; close: () => void; finish: (value: Connected) => void; L: Translate }) {
  const [view, setView] = useState<FeishuPairingView>({ stage: 'idle' })
  const [retry, setRetry] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [groupQuery, setGroupQuery] = useState('')
  const [updating, setUpdating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState('')
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const signal = controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    setView({ stage: 'idle' })
    setProblem('')
    setSelected([])
    setGroupQuery('')
    const read = async (opening: boolean) => {
      try {
        let next = await request<FeishuPairingView>(setup, undefined, signal)
        if (opening && (next.stage === 'idle' || next.stage === 'connected' || (retry > 0 && next.stage === 'failed' && !next.saved))) {
          next = await request(setup + '/start', {}, signal)
        }
        if (next.stage === 'saved') next = await request(setup + '/refresh', { id: next.id }, signal)
        if (signal.aborted) return
        setProblem('')
        setView(next)
        if (['preparing', 'scan', 'checking'].includes(next.stage)) timer = setTimeout(() => void read(false), 1000)
      } catch (cause) {
        if (!signal.aborted) setProblem((cause as Error).message)
      }
    }
    void read(true)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [open, retry])

  async function refresh(id: string) {
    setUpdating(true); setProblem('')
    try {
      const next = await request<FeishuPairingView>(setup + '/refresh', { id })
      if (next.stage === 'groups') setSelected(previous => previous.filter(id => next.groups.some(group => group.id === id)))
      setView(next)
    } catch (cause) {
      setProblem((cause as Error).message)
    } finally { setUpdating(false) }
  }

  async function apply(id: string) {
    setSaving(true); setProblem('')
    try {
      const result = await request<Connected>(setup + '/apply', { id, groups: selected })
      finish(result)
    } catch (cause) {
      setProblem((cause as Error).message)
    } finally { setSaving(false) }
  }

  const groups = view.stage === 'groups' ? view : undefined
  const approvalUrl = view.stage === 'scan' ? view.url : undefined
  const qrImage = useMemo(() => approvalUrl
    ? 'data:image/svg+xml,' + encodeURIComponent(renderSVG(approvalUrl, { pixelSize: 4, border: 4 }))
    : undefined, [approvalUrl])
  const matching = groups?.groups.filter(group => group.label.toLocaleLowerCase().includes(groupQuery.trim().toLocaleLowerCase()))
  const message = problem || (view.stage === 'failed' ? view.code : '')
  const dismiss = () => { if (!saving) close() }
  return <Dialog open={open} title={groups ? L('Choose Feishu groups', '选择飞书群') : L('Connect Feishu', '连接飞书')}
    closeLabel={L('Close', '关闭')} onClose={dismiss} footer={groups && <>
      <Button tone="quiet" busy={updating} disabled={saving} onClick={() => void refresh(groups.id)}>{L('Refresh groups', '刷新群列表')}</Button>
      <Button tone="primary" busy={saving} disabled={!selected.length || updating} onClick={() => void apply(groups.id)}>
        {selected.length ? L('Connect ' + selected.length + (selected.length === 1 ? ' group' : ' groups'), '连接 ' + selected.length + ' 个群') : L('Connect groups', '连接群')}
      </Button>
    </>}>
    {view.stage === 'scan' && <div className="connector-scan">
      <img src={qrImage} width={224} height={224} alt={L('Feishu setup QR code', '飞书接入二维码')} />
      <strong>{L('Scan with Feishu and confirm', '用飞书扫码并确认')}</strong>
      <a className="rp-button" data-tone="quiet" href={view.url} target="_blank" rel="noreferrer">
        {L('Open in Feishu', '打开飞书确认')}<ArrowUpRight size={16} />
      </a>
    </div>}
    {groups ? <div className="connector-group-picker">
      {groups.groups.length > 5 && <TextField icon={<Search size={17} />} label={L('Search groups', '搜索群聊')} placeholder={L('Search groups', '搜索群聊')}
        value={groupQuery} onChange={event => setGroupQuery(event.target.value)} />}
      {matching?.length ? <div className="connector-group-options" role="group" aria-label={L('Groups', '群聊')}>
        {matching.map((group, index) => <CheckField key={group.id}
          label={group.label || L('Unnamed group ', '未命名群 ') + String(index + 1)}
          checked={selected.includes(group.id)} disabled={saving || updating || (!selected.includes(group.id) && selected.length >= 50)}
          onChange={event => setSelected(previous => event.target.checked ? [...previous, group.id] : previous.filter(id => id !== group.id))} />)}
      </div> : <p className="connector-group-empty" role="status">{groups.groups.length
        ? L('No matching groups', '没有找到匹配的群')
        : L('Add ' + groups.botName + ' to a group in Feishu, then refresh.', '在飞书把「' + groups.botName + '」拉进群，再刷新。')}</p>}
    </div> : view.stage === 'connected' ? <Button onClick={() => finish(view)}>{L('See connected groups', '查看已连接的群')}</Button> : !message && view.stage !== 'scan' && <p className="connector-progress" role="status">
      <LoaderCircle size={19} className="rp-spin" />
      {view.stage === 'checking' || view.stage === 'saved' ? L('Connecting to Feishu…', '正在连接飞书…') : L('Getting a QR code…', '正在获取二维码…')}
    </p>}
    {message && <div className="connector-pairing-error" role="alert">
      <p>{pairingError(message, L)}</p>
      {!groups && <Button busy={updating} onClick={() => {
        if (view.stage === 'failed' && view.saved) void refresh(view.id)
        else setRetry(value => value + 1)
      }}>{view.stage === 'failed' && !view.saved ? L('Get a new code', '重新扫码') : L('Retry', '重试')}</Button>}
    </div>}
  </Dialog>
}

function officeError(code: string, L: Translate) {
  switch (code) {
    case 'office_scan_expired': return L('The QR code expired.', '二维码已过期。')
    case 'office_scan_denied': return L('Scan approval was cancelled.', '扫码确认已取消。')
    case 'office_groups_expired': return L('The group code expired.', '群聊确认码已过期。')
    case 'office_bot_unavailable': return L('The bot could not connect.', '暂时连不上机器人。')
    case 'office_group_unavailable': return L('Some groups changed. Choose again.', '群列表已更新，请重新选择。')
    case 'configuration_busy': return L('Try saving again after the current work finishes.', '当前任务结束后可以重试保存。')
    case 'office_oauth_denied': return L('Authorization was cancelled.', '授权已取消。')
    case 'office_oauth_expired': return L('Authorization expired.', '授权已过期。')
    case 'preview_restricted': return L('Connection is unavailable in this preview.', '预览中暂时无法连接。')
    default: return L('Couldn’t complete the connection. Try again.', '暂时无法连接，请重试。')
  }
}

function OfficeBotDialog({ input, L, close, finish }: {
  input: OfficeBotDialogInput; L: Translate; close: () => void; finish: (count: number) => void
}) {
  const { kind, sourceId } = input
  const path = '/api/connectors/' + kind + '/setup'
  const name = nameFor(kind, kind, L)
  const [view, setView] = useState<OfficePairingView>({ stage: 'idle' })
  const [selected, setSelected] = useState<string[]>([])
  const [attempt, setAttempt] = useState({ index: 0, reset: false })
  const [problem, setProblem] = useState('')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const controller = new AbortController(), signal = controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let id: string | undefined
    let initialized = false
    setProblem('')
    setView({ stage: 'idle' })
    setSelected([])
    const read = async (start: boolean) => {
      try {
        const next = await request<OfficePairingView>(path + (start ? '/start' : ''), start ? { sourceId, reset: attempt.reset } : undefined, signal)
        if (signal.aborted) return
        if (next.stage === 'idle' || id && next.id !== id) throw Error('office_pairing_missing')
        id = next.id
        setView(next)
        if (next.stage === 'groups') {
          if (!initialized) { setSelected(next.selected); initialized = true }
          else setSelected(previous => previous.filter(value => next.groups.some(group => group.id === value)))
        }
        if (next.stage !== 'failed' && next.stage !== 'connected') timer = setTimeout(() => void read(false), 1000)
      } catch (error) {
        if (signal.aborted) return
        if ((error as Error).message === 'configuration_busy' && id) timer = setTimeout(() => void read(false), 1000)
        else setProblem((error as Error).message)
      }
    }
    void read(true)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [path, sourceId, attempt])
  const restart = (reset = false) => { setCopied(false); setAttempt(value => ({ index: value.index + 1, reset })) }
  const groups = view.stage === 'groups' ? view : undefined
  const qr = view.stage === 'scan' ? view.qrUrl : ''
  const image = useMemo(() => qr ? 'data:image/svg+xml,' + encodeURIComponent(renderSVG(qr, { pixelSize: 4, border: 4 })) : undefined, [qr])
  const error = problem || (view.stage === 'failed' ? view.code : '')
  const save = async () => {
    if (!groups) return
    setSaving(true); setProblem('')
    try {
      const result = await request<Extract<OfficePairingView, { stage: 'connected' }>>(path + '/apply', { id: groups.id, groups: selected })
      finish(result.groupCount)
    } catch (error) { setProblem((error as Error).message) }
    finally { setSaving(false) }
  }
  return <Dialog open title={groups ? L('Choose groups · ', '选择群聊 · ') + name : L('Connect ', '连接') + name}
    closeLabel={L('Close', '关闭')} onClose={() => { if (!saving) close() }}
    footer={groups && <Button tone="primary" busy={saving} disabled={!selected.length} onClick={() => void save()}>
      {sourceId ? L('Save groups', '保存群聊') : L('Connect groups', '连接群聊')}
    </Button>}>
    {view.stage === 'scan' && <div className="connector-scan">
      <img src={image} width={224} height={224} alt={name + L(' setup QR code', '接入二维码')} />
      <strong>{L('Scan with ' + name + ' and confirm', '用' + name + '扫码并确认')}</strong>
      <a className="rp-button" data-tone="quiet" href={view.pageUrl} target="_blank" rel="noreferrer">
        {L('Open authorization', '打开授权页')}<ArrowUpRight size={16} />
      </a>
    </div>}
    {groups && <div className="connector-group-picker">
      <p>{L('Add the bot to each group, @mention it and send this code.', '把机器人加入目标群，@ 它并发送确认码。')}</p>
      <div className="connector-group-code">
        <code>{groups.code}</code>
        <Button tone="quiet" onClick={() => {
          void navigator.clipboard?.writeText(groups.code).then(() => setCopied(true)).catch(() => setCopied(false))
        }}>{copied ? L('Copied', '已复制') : L('Copy code', '复制确认码')}</Button>
      </div>
      {groups.groups.length > 0 && <div className="connector-group-options" role="group" aria-label={L('Groups', '群聊')}>
        {groups.groups.map((group, index) => <CheckField key={group.id} label={group.label || L('Group ', '群聊 ') + String(index + 1)}
          checked={selected.includes(group.id)} disabled={saving || selected.length >= 50 && !selected.includes(group.id)}
          onChange={event => setSelected(previous => event.target.checked ? [...previous, group.id] : previous.filter(id => id !== group.id))} />)}
      </div>}
      <p>{L('Reading messages without an @mention requires group message access.', '接收未 @ 的消息需要额外授权。')}</p>
    </div>}
    {view.stage === 'connected' && <Button onClick={() => finish(view.groupCount)}>{L('View connected groups', '查看已连接的群')}</Button>}
    {!error && !groups && view.stage !== 'scan' && view.stage !== 'connected' && <p className="connector-progress" role="status">
      <LoaderCircle size={19} className="rp-spin" />
      {view.stage === 'starting' || view.stage === 'applying' ? L('Connecting the bot…', '正在连接机器人…') : L('Getting a QR code…', '正在获取二维码…')}
    </p>}
    {error && <div className="connector-pairing-error" role="alert">
      <p>{officeError(error, L)}</p>
      {!groups && <div className="connector-actions">
        <Button onClick={() => restart()}>{L('Retry', '重试')}</Button>
        {!sourceId && error === 'office_bot_unavailable' && <Button tone="quiet" onClick={() => restart(true)}>{L('Scan again', '重新扫码')}</Button>}
      </div>}
    </div>}
  </Dialog>
}

function authWindow() {
  const popup = window.open('about:blank', '_blank')
  if (popup) popup.opener = null
  return { popup }
}

function OfficeAppRow({ app, L, open, quiet }: {
  app: OfficeApp; L: Translate; open: (value: OfficeAppDialogInput) => void; quiet?: boolean
}) {
  const active = app.status === 'connected' || app.status === 'auth_required'
  return <li className="connector-row">
    <ConnectorMark kind={app.kind} />
    <div className="connector-identity"><strong>{app.label}</strong>
      {active && <span>{app.status === 'connected' ? L('Connected', '已连接') : L('Reconnect required', '需要重新连接')}</span>}
    </div>
    <Button tone={quiet ? 'quiet' : 'secondary'} aria-label={(active ? L('Manage ', '管理 ') : L('Connect ', '连接 ')) + app.label}
      onClick={() => open({ app, redirect: active ? undefined : authWindow() })}>
      {active ? L('Manage', '管理') : L('Connect', '连接')}{quiet && <ChevronRight size={16} />}
    </Button>
  </li>
}

function OfficeAppDialog({ input, L, close, finish }: {
  input: OfficeAppDialogInput; L: Translate; close: () => void; finish: (connected: boolean) => void
}) {
  const { app } = input, path = '/api/connectors/' + app.kind + '/setup'
  const [redirect, setRedirect] = useState(input.redirect)
  const [view, setView] = useState<OfficeAppView>(input.redirect ? { status: 'preparing' } : app)
  const [problem, setProblem] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)
  const finishRef = useRef(finish)
  finishRef.current = finish
  useEffect(() => {
    if (!redirect) return
    const controller = new AbortController(), signal = controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let opened = false
    setView({ status: 'preparing' })
    setProblem('')
    async function update(start: boolean) {
      try {
        const result = await request<OfficeAppView>(path + (start ? '/start' : ''), start ? {} : undefined, signal)
        if (signal.aborted) return
        setView(result)
        if (result.status === 'connected') { finishRef.current(true); return }
        if (result.status === 'authorize' && !opened && redirect?.popup && !redirect.popup.closed) {
          opened = true
          redirect.popup.location.href = result.url
        }
        if (['preparing', 'authorize', 'checking'].includes(result.status)) timer = setTimeout(() => void update(false), 1000)
        else if (!opened) redirect?.popup?.close()
      } catch (error) {
        if (signal.aborted) return
        const code = (error as Error).message
        if (code === 'configuration_restarting' || code === 'configuration_busy') {
          timer = setTimeout(() => void update(start), 1000)
          return
        }
        setProblem(code)
        if (!opened) redirect?.popup?.close()
      }
    }
    void update(true)
    return () => { controller.abort(); clearTimeout(timer); if (!opened) redirect.popup?.close() }
  }, [path, redirect])
  const disconnect = async () => {
    setDisconnecting(true); setProblem('')
    try { await request('/api/connectors/' + app.kind + '/disconnect', {}); finish(false) }
    catch (error) { setProblem((error as Error).message) }
    finally { setDisconnecting(false) }
  }
  const error = problem || (view.status === 'failed' ? view.code : '')
  return <Dialog open title={L('Connect ', '连接 ') + app.label} closeLabel={L('Close', '关闭')}
    onClose={() => { if (!disconnecting) close() }}>
    {error && <p role="alert">{officeError(error, L)}</p>}
    {view.status === 'authorize' && <div className="connector-group-picker">
      <p>{L('Confirm access in ' + app.label + '.', '请在 ' + app.label + ' 确认授权。')}</p>
      <a className="rp-button" data-tone="secondary" href={view.url} target="_blank" rel="noreferrer">
        {L('Open authorization', '打开授权页')}<ArrowUpRight size={16} />
      </a>
    </div>}
    {!error && (view.status === 'preparing' || view.status === 'checking') && <p className="connector-progress" role="status">
      <LoaderCircle size={19} className="rp-spin" />{view.status === 'checking' ? L('Checking the connection…', '正在检查连接…') : L('Opening authorization…', '正在打开授权页…')}
    </p>}
    {(view.status === 'connected' || view.status === 'auth_required') && <p role="status">
      {view.status === 'connected' ? L('You can use ' + app.label + ' in Chat.', '可以在 Chat 中使用 ' + app.label + '。') : L('Reconnect required', '需要重新连接')}
    </p>}
    <div className="connector-actions">
      {(error || view.status === 'auth_required' || view.status === 'disconnected') &&
        <Button onClick={() => setRedirect(authWindow())}>{L('Connect', '连接')}</Button>}
      {(app.status === 'connected' || app.status === 'auth_required') && <Button busy={disconnecting} tone="quiet"
        onClick={() => void disconnect()}>{L('Disconnect', '断开连接')}</Button>}
    </div>
  </Dialog>
}
