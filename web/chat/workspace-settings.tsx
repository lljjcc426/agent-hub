import {
  ArchiveRestore,
  ArrowDownToLine,
  ChevronRight,
  Code2,
  GitMerge,
  Globe,
  MessagesSquare,
  Monitor,
  ShieldCheck,
} from 'lucide-react';

type Labels = (english: string, chinese: string) => string;
export function workspaceGroups(L: Labels) {
  return [
    {
      label: L('Workspace', '工作环境'),
      items: [
        { route: 'host', name: L('Host status', '主机状态'), Icon: Monitor },
        { route: 'chat', name: L('Chat preferences', '对话设置'), Icon: MessagesSquare },
        { route: 'browser', name: L('Browser', '浏览器'), Icon: Globe },
      ],
    },
    {
      label: L('Task handling', '任务处理'),
      items: [
        { route: 'intake', name: L('Intake rules', '接收规则'), Icon: ArrowDownToLine },
        { route: 'runtime', name: L('Run limits and isolation', '运行限制与隔离'), Icon: ShieldCheck },
        { route: 'delivery', name: L('Publishing and merging', '发布与合并'), Icon: GitMerge },
      ],
    },
    {
      label: L('Configuration', '配置管理'),
      items: [
        { route: 'json', name: L('Configuration editor', '配置编辑器'), Icon: Code2 },
        { route: 'revisions', name: L('Version history', '版本记录'), Icon: ArchiveRestore },
      ],
    },
  ];
}

export function WorkspaceSettings({ L }: { L: Labels }) {
  return (
    <div className="general-scroll">
      <article className="settings-directory">
        <h1>{L('Workspace settings', '工作区设置')}</h1>
        {workspaceGroups(L).map((group) => (
          <section className="settings-group" key={group.items[0]!.route}>
            <h2>{group.label}</h2>
            <div className="settings-links">
              {group.items.map(({ route, name, Icon }) => (
                <a key={route} href={'/configure#advanced/' + route}>
                  <span className="settings-glyph">
                    <Icon size={19} />
                  </span>
                  <span>{name}</span>
                  <ChevronRight size={17} />
                </a>
              ))}
            </div>
          </section>
        ))}
      </article>
    </div>
  );
}
