import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Check, ChevronRight, LoaderCircle, Search } from 'lucide-react'
import { renderSVG } from 'uqr'
import { Button, CheckField, ChoiceGroup, Dialog, TextField } from '../ui'
import type { FeishuPairingView } from '../../src/feishu-pairing.ts'
import { AppBrand } from './app-brand.tsx'
import './connectors.css'

type Language = 'en' | 'zh-CN'
type Translate = (en: string, zh: string) => string
type Tab = 'available' | 'connected'
type Definition = { kind: string; label: string; pluginId?: string; setupAvailable: boolean }
type Connection = { id: string; kind: string; label: string; enabled: boolean; scopeCount: number }
type Inventory = { definitions: Definition[]; instances: Connection[] }
type Connected = Extract<FeishuPairingView, { stage: 'connected' }>
const setup = '/api/connectors/feishu/setup'
const entryKinds = ['feishu', 'github', 'wecom']
const appNames: Record<string, [string, string]> = {
  feishu: ['Feishu', '飞书'], wecom: ['WeCom', '企业微信'], webhook: ['Event automations', '事件自动化'],
}

const nameFor = (kind: string, fallback: string, L: Translate) => appNames[kind] ? L(...appNames[kind]) : fallback
const prettyLabel = (source: Connection, L: Translate) => source.label === 'Feishu / 飞书' ? L('Feishu', '飞书') : source.label

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
  const [notice, setNotice] = useState<Connected>()
  useEffect(() => {
    const controller = new AbortController()
    setFailed(false)
    void request<Inventory>('/api/connectors', undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setData(value) })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [version])

  const definitions = data?.definitions ?? []
  const providers = [
    ...entryKinds.flatMap(kind => definitions.filter(item => item.kind === kind)),
    ...definitions.filter(item => !entryKinds.includes(item.kind) && item.pluginId && item.setupAvailable),
  ]
  const term = query.trim().toLocaleLowerCase()
  const matches = (...values: string[]) => values.some(value => value.toLocaleLowerCase().includes(term))
  const instances = data?.instances ?? []
  const available = providers.filter(item => matches(item.kind, item.label, nameFor(item.kind, item.label, L)))
  const connected = instances.filter(item => matches(item.kind, item.label, nameFor(item.kind, item.label, L)))
  const startFeishu = () => { setNotice(undefined); setPairing(true) }
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
      </p> : (tab === 'available' ? available : connected).length === 0 ? <p className="connector-empty" role="status">
        {term ? L('No matching connectors', '没有找到匹配的连接器') : L('No connectors connected', '还没有连接的应用')}
      </p> : tab === 'available' ? <ul className="connector-list">
        {available.map(item => {
          const name = nameFor(item.kind, item.label, L)
          const related = instances.filter(source => source.kind === item.kind && source.enabled)
          return <li className="connector-row" key={item.kind}>
            <ConnectorMark kind={item.kind} />
            <div className="connector-identity">
              <strong>{name}</strong>
              {related.length > 0 && <span>{L('Added', '已添加')}</span>}
            </div>
            {item.kind === 'feishu'
              ? <Button aria-label={L('Connect Feishu', '连接飞书')} onClick={startFeishu}>{related.length ? L('Add', '添加') : L('Connect', '连接')}</Button>
              : <a className="rp-button connector-link" data-tone="secondary" href={manageLink(item.kind, related[0]?.id, item.pluginId)}
                aria-label={(related.length ? L('Manage ', '管理') : L('Connect ', '连接')) + name}>{related.length ? L('Manage', '管理') : L('Connect', '连接')}</a>}
          </li>
        })}
      </ul> : <ul className="connector-list">
        {connected.map(item => {
          const name = prettyLabel(item, L)
          const definition = data.definitions.find(value => value.kind === item.kind)
          return <li className="connector-row" key={item.id}>
            <ConnectorMark kind={item.kind} />
            <div className="connector-identity"><strong>{name}</strong>
              <span>{!item.enabled ? L('Paused', '已停用') : item.scopeCount > 0 && ['feishu', 'wecom', 'slack'].includes(item.kind)
                ? groupCount(item.scopeCount) : L('Enabled', '已启用')}</span>
            </div>
            <a className="rp-button connector-link" data-tone="quiet" href={manageLink(item.kind, item.id, definition?.pluginId)}
              aria-label={L('Manage ', '管理') + name}>{L('Manage', '管理')}<ChevronRight size={16} /></a>
          </li>
        })}
      </ul>}
    </section>
    <FeishuDialog open={pairing} L={L} close={() => setPairing(false)} finish={finishFeishu} />
  </div>
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
