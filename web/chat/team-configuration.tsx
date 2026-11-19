import { useId, useState, type FormEvent } from 'react';
import { ChevronRight, Ellipsis, Plus } from 'lucide-react';
import { AgentAvatar, Button, CheckField, Dialog, InputControl, Popover, SelectField } from '../ui';
import { useModelCapabilities } from './model-capabilities.ts';
import type { MemberEdit, SettingsLabels, SettingsMember, StructuredSettings, WorkerState } from './structured-settings.ts';
import './team-configuration.css';

function MemberRow({ member, edit, arriving, L }: {
  member: SettingsMember; edit: () => void; arriving: boolean; L: SettingsLabels;
}) {
  const isRouter = member.kind === 'router';
  return (
    <button type="button" className="team-config-member" data-kind={member.kind} data-arriving={arriving || undefined}
      aria-haspopup="dialog" aria-label={L('Edit ', '编辑') + member.name} onClick={edit}>
      <span className="team-config-avatar"><AgentAvatar id={member.id} kind={member.kind} size={isRouter ? 54 : 34} /></span>
      <span className="team-config-identity"><strong>{member.name}</strong>{isRouter && <span>Router</span>}</span>
      <span className="team-config-details">
        {member.state === 'paused' && <span className="team-config-paused">{L('Paused', '已暂停')}</span>}
        {member.state === 'retiring' && <span className="team-config-paused">{L('Retiring', '退出中')}</span>}
        <span className="team-config-model">{member.displayModel || L('Connection default', '连接默认模型')}</span>
      </span>
      <ChevronRight className="team-config-chevron" size={17} aria-hidden="true" />
    </button>
  );
}

type Draft = { member?: SettingsMember; copy?: string; label: string; backend: string; model: string; state: WorkerState };
function memberDraft(member: SettingsMember): Draft {
  return { member, label: member.label || '', backend: member.backend, model: member.model || '', state: member.state ?? 'enabled' };
}

export function TeamConfiguration({ settings, memberId, blocked, hasDraft, L }: {
  settings: StructuredSettings; memberId?: string; blocked: boolean; hasDraft: boolean; L: SettingsLabels;
}) {
  const form = useId();
  const initial = memberId === 'router' ? settings.router : settings.workers.find(worker => worker.id === memberId);
  const [draft, setDraft] = useState<Draft | undefined>(() => initial && memberDraft(initial));
  const [open, setOpen] = useState(!!initial);
  const [confirming, setConfirming] = useState(false);
  const [arriving, setArriving] = useState('');
  const member = draft?.member;
  const adding = !member;
  const canEdit = settings.canEditTeam && !blocked;
  const canAdd = canEdit && settings.workers.length < settings.workerLimit;
  const clientRouter = member?.kind === 'router' && settings.routerMode === 'client';
  const connection = settings.connections.find(item => item.id === draft?.backend);
  const catalog = useModelCapabilities(open && !clientRouter ? draft?.backend ?? '' : '', connection?.model,
    settings.loadModelCapabilities, settings.scope);
  const models = new Set([connection?.model, ...catalog.models, settings.router.backend === draft?.backend ? settings.router.model : undefined,
    ...settings.workers.filter(worker => worker.backend === draft?.backend).map(worker => worker.model)]);
  const edit: MemberEdit = {};
  if (member && draft) {
    if (draft.label.trim() !== (member.label ?? '')) edit.label = draft.label;
    if (!clientRouter && draft.backend !== member.backend) edit.backend = draft.backend;
    if (!clientRouter && (edit.backend || draft.model.trim() !== (member.model ?? ''))) edit.model = draft.model;
    if (member.kind === 'worker' && draft.state !== (member.state ?? 'enabled')) edit.state = draft.state;
  }
  const canSave = !!draft && (adding ? canAdd && !!draft.label.trim() && !!connection : canEdit && Object.keys(edit).length > 0);

  function show(next: Draft) {
    setConfirming(false);
    setDraft(next);
    setOpen(true);
  }
  function change(values: Partial<Draft>) {
    setDraft(current => current && { ...current, ...values });
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || !draft) return;
    if (member) {
      if (settings.editMember(member.kind === 'router' ? null : member.id, edit)) setOpen(false);
    } else {
      const id = settings.addWorker({ label: draft.label, backend: draft.backend, model: draft.model }, draft.copy);
      if (id) {
        setArriving(id);
        setOpen(false);
      }
    }
  }

  return (
    <article className="team-config-page roppo-ui">
      <header className="team-config-heading">
        <h1 id="page-title" tabIndex={-1}>{L('Agent team', 'Agent 团队')}</h1>
      </header>
      <MemberRow member={settings.router} edit={() => show(memberDraft(settings.router))} arriving={false} L={L} />
      <section className="team-config-workers" aria-labelledby={form + '-workers'}>
        <header className="team-config-workers-heading">
          <h2 id={form + '-workers'}>{L('Workers', '执行者')}</h2>
          <Button disabled={!canAdd} onClick={() => show({
            label: '', backend: settings.defaultWorkerBackend, model: '', state: 'enabled',
          })}><Plus size={16} aria-hidden="true" />{L('Add worker', '添加执行者')}</Button>
        </header>
        {settings.workers.length > 0 && <ul className="team-config-roster">{settings.workers.map(worker => (
          <li key={worker.id} onAnimationEnd={() => { if (arriving === worker.id) setArriving(''); }}>
            <MemberRow member={worker} edit={() => show(memberDraft(worker))} arriving={arriving === worker.id} L={L} />
          </li>
        ))}</ul>}
        {settings.canEditTeam && settings.workers.length >= settings.workerLimit &&
          <p className="team-config-limit">
            <a href="/configure#advanced/configuration">{L('Change the worker limit', '调整执行者上限')}</a>
          </p>}
      </section>
      <Dialog placement="side" open={open} onClose={() => setOpen(false)} closeLabel={L('Close', '关闭')}
        title={confirming ? L('Remove this worker?', '移除这个执行者？') : member?.name ?? L('Add worker', '添加执行者')}
        footer={confirming ?
          <>
            <Button onClick={() => setConfirming(false)}>{L('Cancel', '取消')}</Button>
            <Button tone="primary" disabled={!canEdit} onClick={() => {
              if (member && settings.removeWorker(member.id)) setOpen(false);
            }}>{L('Remove worker', '移除执行者')}</Button>
          </> :
          <>
            {member?.kind === 'worker' && <Popover label={L('Worker actions', '执行者操作')} trigger={<Ellipsis size={19} />}>
              {dismiss => <div className="team-config-actions">
                <Button tone="quiet" disabled={!canAdd} onClick={() => {
                  dismiss();
                  show({ ...memberDraft(member), member: undefined, copy: member.id, label: member.name + L(' copy', ' 副本') });
                }}>{L('Duplicate', '复制执行者')}</Button>
                {draft?.state !== 'retiring' && <Button tone="quiet" disabled={!canEdit} onClick={() => {
                  dismiss();
                  change({ state: 'retiring' });
                }}>{L('Retire after current work', '手头任务完成后退出')}</Button>}
                <Button tone="quiet" disabled={!canEdit} onClick={() => { dismiss(); setConfirming(true); }}>
                  {L('Remove worker', '移除执行者')}
                </Button>
              </div>}
            </Popover>}
            <Button tone="quiet" onClick={() => setOpen(false)}>{L('Cancel', '取消')}</Button>
            <Button tone="primary" type="submit" form={form} disabled={!canSave}>
              {hasDraft ? L('Apply to draft', '加入草稿') : adding ? L('Add', '添加') : L('Save', '保存')}
            </Button>
          </>}>
        {confirming ? <p className="team-config-removal">{L(
          'This worker must finish its tasks before removal. Its history is kept.',
          '执行者手头的任务处理完后才能移除，历史记录会保留。',
        )}</p> : draft && <form id={form} className="team-config-fields" onSubmit={submit}>
          <label>{L('Name', '名称')}
            <InputControl value={draft.label} autoFocus disabled={!canEdit} maxLength={100}
              placeholder={member?.name} onChange={event => change({ label: event.target.value })} />
          </label>
          {clientRouter
            ? <a href="/configure#connections">{L('Model settings follow the connected client', '模型沿用已连接的客户端')} <ChevronRight size={15} /></a>
            : <>
              <label>{L('Model connection', '模型连接')}
                <SelectField value={draft.backend} disabled={!canEdit} onChange={event => change({
                  backend: event.target.value, model: event.target.value === member?.backend ? member.model ?? '' : '',
                })}>
                  {settings.connections.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                </SelectField>
              </label>
              <label>{L('Model', '模型')}
                <InputControl value={draft.model} disabled={!canEdit} onChange={event => change({ model: event.target.value })}
                  maxLength={300} list={form + '-models'} placeholder={connection?.model || L('Connection default', '使用连接默认模型')} />
                <datalist id={form + '-models'}>{[...models].filter(Boolean).map(model => <option key={model} value={model} />)}</datalist>
              </label>
            </>}
          {member?.kind === 'worker' && <div className="team-config-switch">
            <CheckField label={L('Accept new tasks', '接收新任务')} appearance="switch" disabled={!canEdit}
              checked={draft.state === 'enabled'}
              onChange={event => change({ state: event.target.checked ? 'enabled' : 'paused' })} />
            {draft.state === 'retiring' && <span>{L('Retiring', '退出中')}</span>}
          </div>}
          {member && <a className="team-config-rules" href={'/configure#prompts/member/' + encodeURIComponent(member.kind === 'router' ? 'router' : member.id)}>
            {L('Behavior rules', '行为规则')}<ChevronRight size={15} aria-hidden="true" />
          </a>}
        </form>}
      </Dialog>
    </article>
  );
}
