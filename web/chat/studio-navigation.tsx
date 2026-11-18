import { InputControl } from '../ui/controls.tsx'
import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Boxes,
  Brain,
  Cable,
  ChevronRight,
  FileSliders,
  Layers,
  LayoutGrid,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Search,
  Server,
  Settings,
  SlidersHorizontal,
  Users,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Brand, ChoiceGroup, IconButton, NavLink, SelectionIndicator, SwitchView } from '../ui';
import { AgentAvatar } from './agent-avatar.tsx';
import { SidebarSeparator } from './sidebar-separator.tsx';
import { workspaceGroups } from './workspace-settings.tsx';
import { spaceRequest } from './chat-settings.tsx';

type L = (en: string, zh: string) => string;
type Agent = { id: string; label: string; kind: 'worker' | 'router' };
type Entry = { key: string; name: string; icon: LucideIcon; match?: (path: string) => boolean };
function sections(L: L, views: { id: string; label: string }[], query: string) {
  const row = (key: string, name: string, icon: LucideIcon, match?: Entry['match']): Entry => ({
    key,
    name,
    icon,
    match,
  });
  return [
    { name: L('Preferences', '偏好'), rows: [row('general', L('General', '通用'), SlidersHorizontal)] },
    {
      name: L('Team', '团队'),
      rows: [
        row('team', L('Agent team', 'Agent 团队'), Users, (h) => h === 'team' || h.startsWith('execution')),
        row('models', L('Model connections', '模型连接'), Boxes),
        row('prompts', L('Behavior rules', '行为规则'), FileSliders),
        row('advanced/memory', L('Memory', '记忆'), Brain),
      ],
    },
    {
      name: L('Connections', '连接'),
      rows: [
        row('integrations/library', L('Tools & MCP', '工具与 MCP'), Plug, (h) => h.startsWith('integrations')),
        row('connections', L('Conversation entries', '会话入口'), Cable),
        row('automations', L('Automations', '自动化'), Workflow),
      ],
    },
    {
      name: L('Workspace', '工作区'),
      rows: [
        row(
          'tasks/history',
          L('Activity', '运行记录'),
          Activity,
          (h) => h === 'attention' || h.startsWith('tasks'),
        ),
        row('deployments', L('Deployments', '部署'), Layers),
        row(
          'workspace',
          L('Workspace settings', '工作区设置'),
          Server,
          (h) => h === 'workspace' || (h.startsWith('advanced') && h !== 'advanced/memory'),
        ),
        ...(query ? workspaceGroups(L).flatMap(group => group.items.map(item => row('advanced/' + item.route, item.name, item.Icon))) : []),
        ...views.map((v) => row('plugin/' + v.id, v.label, LayoutGrid)),
        row('usage', L('User guide', '使用指引'), BookOpen),
      ],
    },
  ];
}
export function StudioRail({
  L,
  configuring,
  hash,
  expanded,
  expand,
  mobile,
  open,
  close,
  participants,
  selected,
  select,
  display,
  views,
  user,
}: {
  L: L;
  configuring: boolean;
  hash: string;
  expanded: boolean;
  expand: (value: boolean) => void;
  mobile: boolean;
  open: boolean;
  close: () => void;
  participants: Agent[];
  selected: string;
  select: (id: string) => void;
  display: 'group' | 'agents';
  views: { id: string; label: string }[];
  user: string;
}) {
  const [search, setSearch] = useState('');
  useEffect(() => {
    setSearch('');
  }, [configuring]);
  const query = search.trim().toLowerCase();
  const groups = configuring ? sections(L, views, query)
    .map(group => ({...group, rows: group.rows.filter(item => item.name.toLowerCase().includes(query))}))
    .filter(group => group.rows.length) : [];
  const router = participants.find((p) => p.kind === 'router');
  function choose(id: string) {
    select(id);
    if (mobile) close();
  }
  return (
    <aside
      id="function-navigation"
      className="studio-rail roppo-ui"
      inert={mobile && !open}
      aria-label={configuring ? L('Settings navigation', '设置导航') : L('Chat navigation', '对话导航')}
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
        <div className="rail-body" key={configuring ? 'settings' : 'chat'}>
          {configuring ? (
            <>
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
            </>
          ) : (
            <>
              <h2 className="rail-title">{L('Chats', '对话')}</h2>
              {router && (
                <button
                  className="chat-destination"
                  aria-pressed={selected === router.id}
                  onClick={() => choose(router.id)}
                  title={L('Workspace chat', '工作区对话')}
                >
                  <span className="chat-destination-icon">
                    <MessagesSquare size={21} />
                  </span>
                  <span>
                    <strong>{L('Workspace chat', '工作区对话')}</strong>
                    <span>{router.label}</span>
                  </span>
                </button>
              )}
              {display === 'agents' && (
                <section className="members">
                  <h3>{L('Collaboration', '协作记录')}</h3>
                  {participants
                    .filter((p) => p.kind === 'worker')
                    .map((p) => (
                      <button
                        key={p.id}
                        title={p.label}
                        aria-label={p.label}
                        className="member"
                        aria-pressed={selected === p.id}
                        onClick={() => choose(p.id)}
                      >
                        <AgentAvatar id={p.id} kind="worker" size={30} />
                        <span>{p.label}</span>
                      </button>
                    ))}
                </section>
              )}
            </>
          )}
        </div>
      </SwitchView>
      <footer className="studio-footer">
        {!configuring && (
          <a className="footer-settings" href="/configure#general" aria-label={L('Settings', '设置')}>
            <Settings size={18} />
            <span>{L('Settings', '设置')}</span>
            <ChevronRight size={15} />
          </a>
        )}
        {configuring && (
          <a href="/account" className="account-link" title={L('Account', '账户')}>
            <span className="account-initial">{Array.from(user)[0]?.toUpperCase() || 'R'}</span>
            <span>{user}</span>
          </a>
        )}
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
function MiniWindow({ type }: { type: 'light' | 'dark' | 'group' | 'agents' }) {
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
  dark,
  setDark,
  lang,
  setLang,
  display,
  L,
  onDisplayChange,
  openWorkspaces,
}: {
  onDisplayChange: (value: 'group' | 'agents') => void;
  openWorkspaces: () => void;
  dark: boolean;
  setDark: (dark: boolean) => void;
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
        <section>
          <h2>{L('Appearance', '外观')}</h2>
          <ChoiceGroup
            appearance="tiles"
            label={L('Appearance', '外观')}
            value={dark ? 'dark' : 'light'}
            onChange={(v) => setDark(v === 'dark')}
            choices={[
              { value: 'light', label: L('Light', '浅色'), visual: <MiniWindow type="light" /> },
              { value: 'dark', label: L('Dark', '深色'), visual: <MiniWindow type="dark" /> },
            ]}
          />
        </section>
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

export function TeamSettings({ members, L }: { members: (Agent & { model?: string })[]; L: L }) {
  return (
    <div className="general-scroll roppo-ui">
      <article className="general studio-team">
        <header className="studio-page-title">
          <h1>{L('Agent team', 'Agent 团队')}</h1>
          <a className="studio-primary" href="/configure#execution/configuration">
            <Users size={17} />
            {L('Manage team', '管理团队')}
          </a>
        </header>
        {(['router', 'worker'] as const).map((kind) => (
          <section key={kind}>
            <h2>{kind === 'router' ? 'Router' : 'Worker'}</h2>
            {members
              .filter((m) => m.kind === kind)
              .map((m) => (
                <a
                  className="studio-person"
                  key={m.id}
                  href={
                    '/configure#execution/configuration/' +
                    encodeURIComponent(kind === 'router' ? 'router' : m.id)
                  }
                  aria-label={L('Configure ', '配置 ') + m.label}
                >
                  <AgentAvatar id={m.id} kind={m.kind} size={44} />
                  <strong>{m.label}</strong>
                  <span>{m.model || L('Connection default', '连接默认模型')}</span>
                  <ChevronRight size={17} />
                </a>
              ))}
            {!members.some((m) => m.kind === kind) && <p>{L('No members', '暂无成员')}</p>}
          </section>
        ))}
      </article>
    </div>
  );
}
