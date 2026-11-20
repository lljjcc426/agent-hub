import { InputControl } from '../ui/controls.tsx'
import { useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Boxes,
  Brain,
  Cable,
  ChartColumn,
  ChevronRight,
  FileSliders,
  Gauge,
  LayoutGrid,
  Link2,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Search,
  Server,
  SlidersHorizontal,
  Sun,
  Users,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Brand, ChoiceGroup, IconButton, NavLink, Popover, SelectionIndicator, SwitchView } from '../ui';
import { AgentAvatar } from './agent-avatar.tsx';
import { SidebarSeparator } from './sidebar-separator.tsx';
import { workspaceGroups } from './workspace-settings.tsx';
import { spaceRequest } from './chat-settings.tsx';

type L = (en: string, zh: string) => string;
type Agent = { id: string; label: string; kind: 'worker' | 'router' };
type Entry = { key: string; name: string; icon: LucideIcon; match?: (path: string) => boolean; keywords?: string };
function sections(L: L, views: { id: string; label: string }[], query: string) {
  const row = (key: string, name: string, icon: LucideIcon, match?: Entry['match'], keywords?: string): Entry => ({
    key,
    name,
    icon,
    match,
    keywords,
  });
  const workspaceItems = workspaceGroups(L).flatMap(group => group.items);
  return [
    { name: L('Preferences', '偏好'), rows: [
      row('general', L('General', '通用'), SlidersHorizontal, hash => hash === 'general' || hash === 'advanced/chat'),
      row('appearance', L('Appearance', '外观'), Sun, undefined, L('Theme colors fonts motion', '主题 颜色 字体 动效')),
      row('advanced/memory', L('Memory', '记忆'), Brain),
      ...(query ? [row('advanced/chat', L('Conversations and context', '对话与上下文'), MessagesSquare, undefined,
        L('Chat preferences reset', '对话设置 清空'))] : []),
    ] },
    {
      name: L('Team', '团队'),
      rows: [
        row('team', L('Agent team', 'Agent 团队'), Users, h => h === 'team' || h.startsWith('team/') || h.startsWith('execution/configuration')),
        row('models', L('Model connections', '模型连接'), Boxes),
        row('prompts', L('Behavior rules', '行为规则'), FileSliders),
        row('advanced/configuration', L('Run settings', '运行配置'), Gauge, undefined,
          L('Configuration editor decision layer Jev routing', '配置编辑器 决策层 消息前置判断 Jev 思考强度 执行者上限')),
      ],
    },
    {
      name: L('Connections', '连接'),
      rows: [
        row('connectors', L('Connectors', '连接器'), Link2),
        row('integrations/library', L('Tools & MCP', '工具与 MCP'), Plug, (h) => h.startsWith('integrations')),
        row('connections', L('Conversation entries', '会话入口'), Cable),
      ],
    },
    {
      name: L('Workspace', '工作区'),
      rows: [
        row('automations', L('Automations', '自动化'), Workflow),
        row(
          'tasks/history',
          L('Activity', '运行记录'),
          Activity,
          (h) => h === 'attention' || h === 'execution' || (h.startsWith('tasks') && h !== 'tasks/statistics'),
        ),
        row('tasks/statistics', L('Usage statistics', '使用统计'), ChartColumn, undefined,
          L('Tokens usage charts model calls', 'Token 用量 趋势 模型调用')),
        row(
          'workspace',
          L('Workspace settings', '工作区设置'),
          Server,
          h => h === 'workspace' || h === 'advanced' || workspaceItems.some(item => item.hash === h),
        ),
        ...(query ? workspaceItems.map(item => row(item.hash, item.name, item.Icon, undefined,
          item.hash === 'advanced/intake' ? L('Find tasks in messages', '从消息中发现任务') : undefined)) : []),
        ...views.map((v) => row('plugin/' + v.id, v.label, LayoutGrid)),
      ],
    },
  ];
}
export function ChatMemberPicker({ L, participants, selected, select }: {
  L: L;
  participants: Agent[];
  selected: string;
  select: (id: string) => void;
}) {
  return <Popover label={L('Switch conversation', '切换对话')} trigger={<Users size={19} />}>
    {dismiss => <div className="members">
      <h3>{L('Conversations', '对话')}</h3>
      {participants.map(person => (
        <button type="button" className="member" key={person.id} title={person.label}
          aria-label={person.label} aria-pressed={selected === person.id}
          onClick={() => { dismiss(); select(person.id); }}>
          <AgentAvatar id={person.id} kind={person.kind} size={28} />
          <span>{person.label}</span>
        </button>
      ))}
    </div>}
  </Popover>;
}

export function StudioRail({
  L,
  hash,
  expanded,
  expand,
  mobile,
  open,
  close,
  views,
  user,
}: {
  L: L;
  hash: string;
  expanded: boolean;
  expand: (value: boolean) => void;
  mobile: boolean;
  open: boolean;
  close: () => void;
  views: { id: string; label: string }[];
  user: string;
}) {
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const groups = sections(L, views, query)
    .map(group => ({...group, rows: group.rows.filter(item => (item.name + ' ' + (item.keywords ?? '')).toLowerCase().includes(query))}))
    .filter(group => group.rows.length);
  return (
    <aside
      id="function-navigation"
      className="studio-rail roppo-ui"
      inert={mobile && !open}
      aria-label={L('Settings navigation', '设置导航')}
    >
      <div className="studio-brandbar">
        <a href="/chat" aria-label="Roppo">
          <Brand />
        </a>
        <IconButton
          label={
            mobile
              ? L('Close navigation', '关闭导航')
              : expanded
                ? L('Collapse sidebar', '收起边栏')
                : L('Expand sidebar', '展开边栏')
          }
          onClick={() => (mobile ? close() : expand(!expanded))}
        >
          {mobile ? <X /> : expanded ? <PanelLeftClose /> : <PanelLeftOpen />}
        </IconButton>
      </div>
      <SwitchView scope="panel">
        <div className="rail-body">
          <a className="return-chat" href="/chat">
            <ArrowLeft size={17} />
            <span>{L('Back to chat', '返回对话')}</span>
          </a>
          <h2 className="rail-title">{L('Settings', '设置')}</h2>
          <label className="settings-find">
            <Search size={16} />
            <InputControl
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={L('Find settings', '查找设置')}
              aria-label={L('Find settings', '查找设置')}
            />
          </label>
          <nav className="studio-settings-links" aria-label={L('Settings', '设置')}>
            {groups.map((group) => (
                <section key={group.name}>
                  <h3>{group.name}</h3>
                  <div className="nav-track">
                    <SelectionIndicator selector="a[aria-current]" selection={hash + search} />
                    {group.rows.map(({ key, name, icon: Icon, match }) => (
                      <NavLink
                        key={key}
                        href={'/configure#' + key}
                        onClick={() => {
                          if (mobile) close();
                        }}
                        icon={<Icon size={17} />}
                        title={name}
                        aria-label={name}
                        current={match ? match(hash) : hash === key || hash.startsWith(key + '/')}
                      >
                        {name}
                      </NavLink>
                    ))}
                  </div>
                </section>
              ))}
            {query && !groups.length && <p role="status">{L('No matches', '没有匹配的设置')}</p>}
          </nav>
        </div>
      </SwitchView>
      <footer className="studio-footer">
        <a href="/account" className="account-link" title={L('Account', '账户')}>
          <span className="account-initial">{Array.from(user)[0]?.toUpperCase() || 'R'}</span>
          <span>{user}</span>
        </a>
      </footer>
      <SidebarSeparator
        pane="navigation"
        controls="function-navigation"
        label={L('Sidebar', '边栏')}
        expandNavigation={() => expand(true)}
      />
    </aside>
  );
}
function MiniWindow({ type }: { type: 'group' | 'agents' }) {
  return (
    <div aria-hidden="true" className={'mini-window mini-' + type}>
      <i className="mini-menu">
        <b />
        <b />
        <b />
      </i>
      <i className="mini-work">
        <b />
        <b />
        <em />
      </i>
    </div>
  );
}
export function General({
  lang,
  setLang,
  display,
  L,
  onDisplayChange,
  openWorkspaces,
}: {
  onDisplayChange: (value: 'group' | 'agents') => void;
  openWorkspaces: () => void;
  lang: string;
  setLang: (lang: 'en' | 'zh-CN') => void;
  display: 'group' | 'agents';
  L: L;
}) {
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  async function changeDisplay(value: 'group' | 'agents') {
    if (saving || display === value) return;
    const previous = display;
    setSaving(true);
    setError('');
    onDisplayChange(value);
    try {
      await spaceRequest({ display: value }, 'PATCH');
      window.dispatchEvent(new Event('roppo:chat-space'));
    } catch {
      onDisplayChange(previous);
      setError(L('Could not save the layout. Try again.', '未能保存布局，请重试。'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="general-scroll roppo-ui">
      <article className="general">
        <h1>{L('General', '通用')}</h1>
        <section className="language-row">
          <h2>{L('Language', '语言')}</h2>
          <ChoiceGroup
            label={L('Language', '语言')}
            value={lang}
            onChange={(v) => setLang(v === 'en' ? 'en' : 'zh-CN')}
            choices={[
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en', label: 'English' },
            ]}
          />
        </section>
        <section>
          <h2>{L('Chat layout', '对话布局')}</h2>
          <ChoiceGroup
            appearance="tiles"
            label={L('Chat layout', '对话布局')}
            value={display}
            onChange={changeDisplay}
            choices={[
              {
                value: 'agents',
                label: L('Agent list', 'Agent 列表'),
                visual: <MiniWindow type="agents" />,
                disabled: saving,
              },
              {
                value: 'group',
                label: L('Group chat', '群聊'),
                visual: <MiniWindow type="group" />,
                disabled: saving,
              },
            ]}
          />
        </section>
        <section className="language-row">
          <h2>{L('Conversations and context', '对话与上下文')}</h2>
          <a className="workspace-choose" href="/configure#advanced/chat">
            {L('Manage data', '数据管理')}<ChevronRight size={16} aria-hidden="true" />
          </a>
        </section>
        <section className="language-row">
          <h2>{L('Workspace', '工作区')}</h2>
          <button className="workspace-choose" onClick={openWorkspaces}>
            {L('Choose workspace', '选择工作区')}
            <ChevronRight size={16} />
          </button>
        </section>
        {error && <p role="alert">{error}</p>}
      </article>
    </div>
  );
}
