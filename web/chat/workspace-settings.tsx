import {
  ArchiveRestore,
  ArrowDownToLine,
  BookOpen,
  ChevronRight,
  Code2,
  GitMerge,
  Globe,
  Layers,
  Monitor,
  ShieldCheck,
} from 'lucide-react';

type Labels = (english: string, chinese: string) => string;
export function workspaceGroups(L: Labels) {
  return [
    {
      label: L('Workspace', '工作环境'),
      items: [
        { hash: 'advanced/browser', name: L('Browser', '浏览器'), Icon: Globe },
      ],
    },
    {
      label: L('Task handling', '任务处理'),
      items: [
        { hash: 'advanced/intake', name: L('Follow-up rules', '跟进规则'), Icon: ArrowDownToLine },
        { hash: 'advanced/runtime', name: L('Run limits and isolation', '运行限制与隔离'), Icon: ShieldCheck },
        { hash: 'advanced/delivery', name: L('Publishing and merging', '发布与合并'), Icon: GitMerge },
      ],
    },
    {
      label: L('Maintenance', '维护'),
      items: [
        { hash: 'advanced/host', name: L('Host status', '主机状态'), Icon: Monitor },
        { hash: 'deployments', name: L('Deployments', '部署'), Icon: Layers },
        { hash: 'advanced/json', name: L('Raw configuration', '原始配置'), Icon: Code2 },
        { hash: 'advanced/revisions', name: L('Version history', '版本记录'), Icon: ArchiveRestore },
        { hash: 'usage', name: L('User guide', '使用指引'), Icon: BookOpen },
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
          <section className="settings-group" key={group.items[0]!.hash}>
            <h2>{group.label}</h2>
            <div className="settings-links">
              {group.items.map(({ hash, name, Icon }) => (
                <a key={hash} href={'/configure#' + hash}>
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
