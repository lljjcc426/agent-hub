import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertCircle, ListFilter, LoaderCircle, Plus, Trash2, X } from 'lucide-react';
import { Button, ChoiceGroup, Dialog, EmptyState, IconButton, TextAreaField, TextField, Toast } from '../ui';
import type { StructuredSettings } from './structured-settings.ts';

type Label = (en: string, zh: string) => string;
type Mode = 'off' | 'observe' | 'auto';
interface Rule { id: string; instruction: string }
interface Intake {
  mode: Mode;
  rules: Rule[];
  modeEditable: boolean;
  rulesEditable: boolean;
  select: (value: Mode) => void;
  changeRule: (index: number, field: keyof Rule, value: string) => void;
  addRule: () => void;
  removeRule: (index: number) => void;
}
export interface SettingsEditorState {
  draft: { count: number; invalid?: string; conflict: boolean } | null;
  busy: string;
  blocked: boolean;
  structured: StructuredSettings | null;
  notice: { level: 'success' | 'warning' | 'error'; en: string; zh: string; details?: string } | null;
  dismiss: () => void;
  save: () => void;
  savePrompts: (() => void) | null;
  discard: () => void;
  intake: Intake | null;
}

// The configuration controller owns the draft, including edits from the JSON editor.
let current: SettingsEditorState | null = null;
const listeners = new Set<() => void>();
export function publishSettings(next: SettingsEditorState) {
  if (!next.busy && next.notice?.level === 'success' && (next.notice !== current?.notice || current?.busy)) {
    window.setTimeout(next.dismiss, 2800);
  }
  current = next;
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const snapshot = () => current;
export function useSettingsEditor() {
  return useSyncExternalStore(subscribe, snapshot);
}

function IntakeForm({ intake, L }: { intake: Intake; L: Label }) {
  const [remove, setRemove] = useState<number | null>(null);
  const focusNew = useRef(false);
  const form = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (focusNew.current) {
      form.current?.querySelector<HTMLInputElement>('.intake-rule:last-child input')?.focus();
      focusNew.current = false;
    }
  }, [intake.rules.length]);
  const heading = L('When a message matches', '遇到符合条件的消息时');
  const add = L('Add condition', '添加条件');
  const removeLabel = L('Remove condition', '移除条件');
  return (
    <div className="roppo-ui intake-form" ref={form}>
      <section className="intake-mode">
        <h2>{heading}</h2>
        <ChoiceGroup label={heading} value={intake.mode} onChange={intake.select}
          choices={[
            { value: 'off', label: L('Ignore', '忽略'), disabled: !intake.modeEditable },
            { value: 'observe', label: L('Record only', '只记录'), disabled: !intake.modeEditable },
            { value: 'auto', label: L('Start a task', '自动开始任务'), disabled: !intake.modeEditable },
          ]} />
      </section>
      <section className="intake-conditions">
        <header>
          <h2>{L('Conditions', '跟进条件')}</h2>
          <Button disabled={!intake.rulesEditable} onClick={() => { focusNew.current = true; intake.addRule(); }}>
            <Plus size={15} aria-hidden="true" />{add}
          </Button>
        </header>
        {intake.rules.length === 0
          ? <EmptyState icon={<ListFilter size={22} />}>{L('No conditions yet', '尚未添加跟进条件')}</EmptyState>
          : <div className="intake-rules">{intake.rules.map((rule, index) => {
              const name = L('Condition name', '条件名称');
              const instruction = L('When should Roppo follow up?', '什么情况下需要跟进？');
              return <div className="intake-rule" key={index}>
                <div className="intake-rule-head">
                  <label htmlFor={'f-rules-' + index + '-id'}>{name}</label>
                  <IconButton label={removeLabel} disabled={!intake.rulesEditable} onClick={() => setRemove(index)}>
                    <Trash2 size={16} />
                  </IconButton>
                </div>
                <TextField label={name} id={'f-rules-' + index + '-id'} value={rule.id} maxLength={80}
                  disabled={!intake.rulesEditable} onChange={e => intake.changeRule(index, 'id', e.target.value)} />
                <label htmlFor={'f-rules-' + index + '-instruction'}>{instruction}</label>
                <TextAreaField label={instruction} id={'f-rules-' + index + '-instruction'} rows={3}
                  value={rule.instruction} maxLength={8000} disabled={!intake.rulesEditable}
                  onChange={e => intake.changeRule(index, 'instruction', e.target.value)} />
              </div>;
            })}</div>}
      </section>
      <Dialog open={remove !== null} title={L('Remove this condition?', '移除这个条件？')}
        closeLabel={L('Close', '关闭')} onClose={() => setRemove(null)} footer={<>
          <Button onClick={() => setRemove(null)}>{L('Cancel', '取消')}</Button>
          <Button tone="primary" disabled={!intake.rulesEditable} onClick={() => {
            if (remove !== null) intake.removeRule(remove);
            setRemove(null);
          }}>{removeLabel}</Button>
        </>}>
        {remove !== null && (intake.rules[remove]?.id || L('New condition', '新条件'))}
      </Dialog>
    </div>
  );
}

const progress: Record<string, [string, string]> = {
  refresh: ['Refreshing host status…', '正在刷新主机状态…'],
  setup: ['Checking setup…', '正在检查环境…'],
  prompts: ['Loading instructions…', '正在读取指令…'],
  preview: ['Preparing preview…', '正在生成预览…'],
  working: ['Working…', '正在处理…'],
};

function Feedback({ view, L }: { view: SettingsEditorState; L: Label }) {
  const { notice, draft, busy, blocked } = view;
  const [dialog, setDialog] = useState<'discard' | 'details' | null>(null);
  const saving = busy === 'save';
  const problem = !busy && !draft?.conflict && notice && notice.level !== 'success' ? notice : null;
  const status = progress[busy];
  const text = problem ? L(problem.en, problem.zh) : draft?.conflict ? L('Revision conflict', '版本冲突')
    : draft?.invalid ? view.structured?.problems[draft.invalid] ?? L('Check field · ', '请修正字段 · ') + draft.invalid
    : status ? L(...status) : draft && !saving ? L('Unsaved changes', '有未保存的更改') : '';
  return <div className="settings-feedback roppo-ui">
    <Toast message={!busy && notice?.level === 'success' ? L(notice.en, notice.zh) : ''} />
    {(draft || problem || status || saving) && <div className="settings-action-dock" id={draft || saving ? 'savebar' : undefined}>
      {text && <span className="settings-action-message" role={problem?.level === 'error' ? 'alert' : 'status'}>
        {problem || draft?.conflict || draft?.invalid ? <AlertCircle size={16} /> : status ? <LoaderCircle size={16} className="rp-spin" /> : null}
        {text}
      </span>}
      {problem?.details && <Button tone="quiet" onClick={() => setDialog('details')}>{L('Details', '详情')}</Button>}
      {draft && <Button tone="quiet" disabled={blocked} onClick={() => setDialog('discard')}>{L('Discard', '放弃更改')}</Button>}
      {view.savePrompts && !saving && <Button disabled={blocked || !!draft?.invalid} onClick={view.savePrompts}>
        {L('Save rules only', '仅保存行为规则')}
      </Button>}
      {(draft || saving) && <Button tone="primary" className="primary" busy={saving}
        disabled={blocked || (!draft?.conflict && (!draft?.count || !!draft.invalid))} onClick={view.save}>
        {saving ? L('Saving…', '保存中…') : draft?.conflict ? L('Review conflict', '核对冲突')
          : draft && draft.count > 1 ? L('Save all changes', '保存全部更改') : L('Save changes', '保存更改')}
      </Button>}
      {problem && !draft && <IconButton label={L('Dismiss', '关闭')} onClick={view.dismiss}><X size={16} /></IconButton>}
    </div>}
    <Dialog open={dialog === 'discard' && !!draft} title={L('Discard changes?', '放弃更改？')}
      closeLabel={L('Close', '关闭')} onClose={() => setDialog(null)} footer={<>
        <Button onClick={() => setDialog(null)}>{L('Cancel', '取消')}</Button>
        <Button tone="primary" disabled={blocked} onClick={() => { setDialog(null); view.discard(); }}>{L('Discard', '放弃更改')}</Button>
      </>}>{L('All unsaved configuration changes will be discarded.', '将放弃所有尚未保存的设置更改。')}</Dialog>
    <Dialog open={dialog === 'details' && !!problem} title={L('Details', '详情')}
      closeLabel={L('Close', '关闭')} onClose={() => setDialog(null)}>
      <pre className="settings-notice-detail">{problem?.details}</pre>
    </Dialog>
  </div>;
}

export function IntakeEditor({ language }: { language: string }) {
  const view = useSyncExternalStore(subscribe, snapshot);
  return view?.intake ? <IntakeForm intake={view.intake} L={(en, zh) => language === 'en' ? en : zh} /> : null;
}
export function SettingsFeedback({ language }: { language: string }) {
  const view = useSyncExternalStore(subscribe, snapshot);
  return view ? <Feedback view={view} L={(en, zh) => language === 'en' ? en : zh} /> : null;
}
