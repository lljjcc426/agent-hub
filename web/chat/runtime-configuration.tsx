import { useId, useState } from 'react';
import { ArchiveRestore, Code2, Ellipsis } from 'lucide-react';
import { workerPoolDefault } from '../../src/execution-limits.ts';
import { AgentAvatar, CheckField, InputControl, Popover, SelectField } from '../ui';
import { DecisionConfiguration } from './decision-configuration.tsx';
import { effortLabel, useModelCapabilities } from './model-capabilities.ts';
import type { RouterMode, SettingsLabels, StructuredSettings } from './structured-settings.ts';
import './runtime-configuration.css';

function LimitControl({ id, label, defaultLabel, value, buffer, start, unit, error, step, disabled, change, L }: {
  id: string; label: string; defaultLabel: string; value?: number; buffer?: string; start: number; unit: string;
  error?: string; step: '1' | 'any'; disabled: boolean; change: (value?: string) => void; L: SettingsLabels;
}) {
  const [manual, setManual] = useState(false);
  const custom = manual || value !== undefined || buffer !== undefined;
  return (
    <div>
      <SelectField id={id} value={custom ? 'custom' : 'inherit'} disabled={disabled} onChange={event => {
        const enabled = event.target.value === 'custom';
        setManual(enabled);
        change(enabled ? String(start) : undefined);
      }}>
        <option value="inherit">{defaultLabel}</option>
        <option value="custom">{L('Set manually', '手动设置')}</option>
      </SelectField>
      <div className="run-config-reveal" data-open={custom} inert={!custom} aria-hidden={!custom}>
        <div>
          <div className="run-config-limit-entry">
            <div className="run-config-measure">
              <InputControl type="number" step={step} inputMode={step === '1' ? 'numeric' : 'decimal'}
                aria-label={label + ' (' + unit + ')'} aria-invalid={!!error || undefined}
                aria-describedby={error ? id + '-error' : undefined} disabled={disabled || !custom}
                value={buffer ?? String(value ?? start)} onChange={event => change(event.target.value)} />
              <span aria-hidden="true">{unit}</span>
            </div>
            {error && <p id={id + '-error'} className="run-config-error" role="alert">{error}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function RuntimeConfiguration({ settings, blocked, L }: {
  settings: StructuredSettings; blocked: boolean; L: SettingsLabels;
}) {
  const prefix = useId();
  const [selection, setSelection] = useState('router');
  const index = settings.workers.findIndex(worker => 'worker:' + worker.id === selection);
  const member = settings.workers[index] ?? settings.router;
  const memberId = member.kind === 'router' ? null : member.id;
  const memberPath = memberId === null ? 'execution.router' : 'execution.workers.' + index;
  const timePath = memberPath + '.timeoutMs';
  const workerPath = 'execution.management.maxWorkers';
  const clientRouter = memberId === null && settings.routerMode === 'client';
  const capability = useModelCapabilities(clientRouter ? '' : member.backend, member.displayModel, settings.loadModelCapabilities, settings.scope);
  const effort = capability.efforts.find(value => value === member.effort) ?? '';
  const disabled = blocked || !settings.canEditTeam;
  const modes: { value: RouterMode; label: string; description: string }[] = [
    { value: 'host', label: L('Coordinate continuously', '持续协作'),
      description: L('Router handles the conversation and follows up on assigned work.', 'Router 在对话中分派任务并跟进进度。') },
    { value: 'assessment', label: L('Review incoming messages', '仅受理任务'),
      description: L('Router reviews messages one at a time to decide whether to start work.', 'Router 逐条判断消息是否需要建立任务。') },
    { value: 'client', label: L('Use a connected client', '交给已连接的客户端'),
      description: L('Assign and follow up on work from the connected client.', '从已连接的客户端分派任务并跟进。') },
  ];
  return (
    <form className="settings-directory run-config-page roppo-ui" onSubmit={event => event.preventDefault()}>
      <header className="run-config-header">
        <h1 id="page-title" tabIndex={-1}>{L('Run settings', '运行配置')}</h1>
        <Popover label={L('Configuration maintenance', '配置维护')} trigger={<Ellipsis size={21} />}>
          {dismiss => <div className="run-config-menu">
            <a href="/configure#advanced/json" onClick={dismiss}><Code2 size={17} aria-hidden="true" />{L('Edit raw JSON', '编辑原始 JSON')}</a>
            <a href="/configure#advanced/revisions" onClick={dismiss}><ArchiveRestore size={17} aria-hidden="true" />{L('Version history', '版本记录')}</a>
          </div>}
        </Popover>
      </header>
      <section className="settings-group run-config-section-action" aria-labelledby={prefix + '-member-heading'}>
        <h2 id={prefix + '-member-heading'}>{L('Member settings', '成员运行')}</h2>
        <div className="run-config-member">
          <AgentAvatar id={member.id} kind={member.kind} size={23} />
          <SelectField label={L('Member', '选择成员')} value={index >= 0 ? selection : 'router'}
            onChange={event => setSelection(event.target.value)}>
            <option value="router">{settings.router.name + ' · Router' +
              (settings.problems['execution.router.timeoutMs'] ? L(' · Check time limit', ' · 请修正时限') : '')}</option>
            {settings.workers.map((worker, row) => <option key={worker.id} value={'worker:' + worker.id}>
              {worker.name + (settings.problems['execution.workers.' + row + '.timeoutMs']
                ? L(' · Check time limit', ' · 请修正时限') : '')}
            </option>)}
          </SelectField>
        </div>
        <div className="run-config-panel">
          {clientRouter && !settings.problems[timePath]
            ? <div className="run-config-client">
                {L('This Router uses the model settings of your connected client.', '这位 Router 沿用客户端里的模型设置。')}
                <a href="/configure#connections">{L('Conversation entries', '会话入口')}</a>
              </div>
            : <div key={memberPath}>
                {!clientRouter && <div className="run-config-row" aria-busy={capability.pending}>
                  <label htmlFor={prefix + '-effort'}>{L('Reasoning effort', '思考强度')}</label>
                  <SelectField id={prefix + '-effort'} value={effort} disabled={disabled || !capability.efforts.length}
                    onChange={event => settings.setEffort(memberId, capability.efforts.find(level => level === event.target.value) ?? null)}>
                    <option value="">{effortLabel(null, L)}</option>
                    {capability.efforts.map(value => <option key={value} value={value}>{effortLabel(value, L)}</option>)}
                  </SelectField>
                </div>}
                <div className="run-config-row">
                  <label htmlFor={prefix + '-timeout'}>{L('Time limit per turn', '单轮运行时限')}</label>
                  <LimitControl id={prefix + '-timeout'} label={L('Time limit per turn', '单轮运行时限')} step="any" disabled={disabled}
                    defaultLabel={L('Use default', '沿用默认')} start={30} unit={L('min', '分钟')}
                    value={member.timeoutMs === undefined ? undefined : Number((member.timeoutMs / 60_000).toFixed(8))}
                    buffer={settings.buffers[timePath]} error={settings.problems[timePath]}
                    change={minutes => settings.setTimeout(memberId, minutes)} L={L} />
                </div>
              </div>}
        </div>
      </section>
      <section className="settings-group" aria-labelledby={prefix + '-team-heading'}>
        <h2 id={prefix + '-team-heading'}>{L('Team coordination', '团队调度')}</h2>
        <div className="run-config-panel">
          <div className="run-config-row">
            <div className="run-config-label">
              <label htmlFor={prefix + '-router'}>{L('How Router works', 'Router 工作方式')}</label>
              <p id={prefix + '-router-help'}>{modes.find(choice => choice.value === settings.routerMode)?.description}</p>
            </div>
            <SelectField id={prefix + '-router'} aria-describedby={prefix + '-router-help'} value={settings.routerMode} disabled={disabled}
              onChange={event => settings.setRouterMode(event.target.value as RouterMode)}>
              {modes.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </SelectField>
          </div>
          <div className="run-config-row">
            <label htmlFor={prefix + '-workers'}>{L('Worker limit', '执行者数量上限')}</label>
            <LimitControl id={prefix + '-workers'} label={L('Worker limit', '执行者数量上限')} step="1" disabled={disabled}
              defaultLabel={L('Default (' + workerPoolDefault + ')', '默认（' + workerPoolDefault + ' 位）')}
              value={settings.workerLimit === workerPoolDefault ? undefined : settings.workerLimit}
              buffer={settings.buffers[workerPath]} error={settings.problems[workerPath]} start={workerPoolDefault} unit={L('workers', '位')}
              change={value => settings.setWorkerLimit(value)} L={L} />
          </div>
          <div className="run-config-switch">
            <CheckField label={L('Allow Router to manage workers', '允许 Router 管理执行者')} appearance="switch"
              checked={settings.routerManagesWorkers} disabled={disabled}
              onChange={event => settings.setRouterManagesWorkers(event.target.checked)} />
          </div>
        </div>
      </section>
      <DecisionConfiguration settings={settings} blocked={blocked} L={L} />
    </form>
  );
}

export function BrowserAgentAccess({ settings, blocked, L }: {
  settings: StructuredSettings; blocked: boolean; L: SettingsLabels;
}) {
  const prefix = useId();
  if (!settings.workers.length) return null;
  return (
    <section className="settings-group browser-agent-access roppo-ui" aria-labelledby={prefix}>
      <h2 id={prefix}>{L('Worker browser access', '执行者浏览器权限')}</h2>
      <div className="run-config-panel">
        {settings.workers.map((worker, index) => <div className="run-config-row" key={worker.id}>
          <label htmlFor={prefix + '-' + index}>{worker.name}</label>
          <SelectField id={prefix + '-' + index} disabled={blocked || !settings.canEditTeam}
            value={worker.browserAccess === undefined ? 'inherit' : String(worker.browserAccess)}
            onChange={event => settings.setBrowserAccess(worker.id, event.target.value === 'inherit' ? undefined : event.target.value === 'true')}>
            <option value="inherit">{L('Use default', '沿用默认')}</option>
            <option value="true">{L('Allow', '允许')}</option>
            <option value="false">{L('Block', '禁止')}</option>
          </SelectField>
        </div>)}
      </div>
    </section>
  );
}
