import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Download, Pencil, Plus, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import { Button, IconButton, InputControl } from '../ui/controls.tsx';
import { Dialog, Popover } from '../ui/overlays.tsx';
import { getAppearance, setAppearance, useAppearance, type AppearanceSettings } from './appearance-store.ts';
import {
  deleteAppearanceSkin, exportAppearanceSkin, getAppearanceSkins, importAppearanceSkin,
  parseAppearanceSkin, renameAppearanceSkin, resetAppearanceToSkin, restoreAppearanceSkins,
  saveAppearanceSkin, selectAppearanceSkin, suggestAppearanceSkinName, useAppearanceSkins,
  type AppearanceSkin,
} from './appearance-skins-store.ts';
import './appearance-skins.css';

type Labels = (english: string, chinese: string) => string;
type SkinFile = ReturnType<typeof parseAppearanceSkin>;
type Modal = { kind: 'save' | 'export' | 'import' } | { kind: 'rename' | 'delete'; skin: AppearanceSkin };

function Swatch({ appearance }: { appearance: AppearanceSettings }) {
  return <span className="appearance-skin-swatch" aria-hidden="true">
    {(['light', 'dark'] as const).map(mode => <i key={mode} style={{ background: appearance.profiles[mode].background }} />)}
  </span>;
}

function Summary({ appearance, L }: { appearance: AppearanceSettings; L: Labels }) {
  return <dl className="appearance-skin-summary">
    <div><dt>{L('Color mode', '模式')}</dt><dd>{appearance.mode === 'system' ? L('System', '跟随系统') : appearance.mode === 'light' ? L('Light', '浅色') : L('Dark', '深色')}</dd></div>
    <div><dt>{L('Color profiles', '深浅配色')}</dt><dd><Swatch appearance={appearance} />{L('Light and dark', '浅色和深色')}</dd></div>
    <div><dt>{L('UI / content / code sizes', '界面 / 内容 / 代码字号')}</dt><dd>{appearance.uiSize} / {appearance.contentSize} / {appearance.codeSize} px</dd></div>
    <div><dt>{L('Other appearance options', '其他外观选项')}</dt><dd>{L('All included', '全部包含')}</dd></div>
  </dl>;
}

function navigateMenu(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  items[next]?.focus();
}

export function useAppearanceSkinManager(L: Labels) {
  const [appearance] = useAppearance();
  const skins = useAppearanceSkins();
  const [modal, setModal] = useState<Modal | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [parsed, setParsed] = useState<SkinFile | null>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ message: string; undo?: () => void } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const current = skins.skins.find(skin => skin.id === skins.activeId);
  const defaultName = L('Roppo Default', 'Roppo 默认');
  const currentName = current?.name ?? (skins.activeId === 'default' ? defaultName : L('Current custom', '当前自定义'));
  const sample = current?.appearance ?? skins.resetBase;

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (modal?.kind === 'save' || modal?.kind === 'rename' || (modal?.kind === 'import' && parsed)) {
      input.current?.focus();
      input.current?.select();
    }
  }, [modal, parsed]);
  function notify(message: string, undo?: () => void) {
    clearTimeout(timer.current);
    setNotice({ message, undo });
    timer.current = setTimeout(() => setNotice(null), undo ? 6500 : 2500);
  }
  function clearNotice() { clearTimeout(timer.current); setNotice(null); }
  function close() { setModal(null); setError(''); }
  function open(next: Modal, element: HTMLElement | null) {
    invoker.current = element;
    setName(next.kind === 'rename' ? next.skin.name : next.kind === 'save'
      ? suggestAppearanceSkinName(L('My skin', '我的皮肤')) : currentName);
    setParsed(null);
    setPaste(null);
    setError('');
    setModal(next);
  }
  function report(cause: unknown) {
    const code = (cause as { code?: string })?.code;
    setError(code === 'invalid-name' ? L('Enter a skin name (up to 60 characters).', '请填写皮肤名称（最多 60 个字符）。')
      : code === 'duplicate-name' ? L('A skin with this name already exists. Choose another name.', '已有同名皮肤，请更换名称。')
      : code === 'storage' ? L('Could not save to this browser. Check browser storage and try again.', '无法保存到当前浏览器，请检查浏览器存储后重试。')
      : L('Could not read this skin. Choose a valid Roppo skin file.', '无法读取皮肤，请选择有效的 Roppo 皮肤文件。'));
  }
  function perform(action: () => void) {
    setError('');
    try { action(); } catch (cause) { report(cause); }
  }
  function select(id: string, dismiss: () => void) {
    perform(() => { selectAppearanceSkin(id); clearNotice(); dismiss(); });
  }
  function save() {
    perform(() => {
      if (modal?.kind === 'rename') renameAppearanceSkin(modal.skin.id, name);
      else saveAppearanceSkin(name);
      close();
      notify(modal?.kind === 'rename' ? L('Skin renamed', '已重命名皮肤') : L('Skin saved', '已保存皮肤'));
    });
  }
  function remove() {
    if (modal?.kind !== 'delete') return;
    perform(() => {
      const before = getAppearanceSkins();
      deleteAppearanceSkin(modal.skin.id);
      close();
      notify(L('Skin deleted', '已删除皮肤'), () => restoreAppearanceSkins(before));
    });
  }
  function reset() {
    perform(() => {
      const before = getAppearance();
      if (resetAppearanceToSkin()) notify(L('Restored current skin settings', '已恢复当前皮肤的设置'), () => setAppearance(before));
    });
  }
  function read(raw: string) {
    const payload = parseAppearanceSkin(raw);
    setParsed(payload);
    setName(suggestAppearanceSkinName(payload.name));
    setError('');
  }
  async function upload(file: File) {
    setLoading(true);
    setParsed(null);
    setError('');
    try { read(await file.text()); } catch (cause) { report(cause); }
    finally { setLoading(false); }
  }
  function finishImport(apply: boolean) {
    if (!parsed) return;
    perform(() => {
      importAppearanceSkin(parsed, name, apply);
      close();
      notify(L('Skin imported', '已导入皮肤'));
    });
  }
  function download() {
    perform(() => {
      const url = URL.createObjectURL(new Blob([exportAppearanceSkin(name)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name.replace(/[\\/:*?"<>|]/g, '_') + '.roppo-skin.json';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      close();
    });
  }
  const modalTitle = modal?.kind === 'save' ? L('Save as skin', '另存为皮肤')
    : modal?.kind === 'rename' ? L('Rename skin', '重命名皮肤')
    : modal?.kind === 'delete' ? L('Delete skin', '删除皮肤')
    : modal?.kind === 'import' ? L('Import skin', '导入皮肤') : L('Export skin', '导出皮肤');
  const nameField = <label className="appearance-skin-name-field">{L('Skin name', '皮肤名称')}
    <InputControl ref={input} className="appearance-import-input" value={name} maxLength={60} onChange={event => { setName(event.target.value); setError(''); }} autoComplete="off" />
  </label>;

  return {
    controls: <section className="appearance-skin-section" aria-label={L('Appearance skin', '外观皮肤')}>
      <div className="appearance-row appearance-skin-row">
        <div className="appearance-label"><span>{L('Appearance skin', '外观皮肤')}</span></div>
        <div className="appearance-control">
          <div className="appearance-skin-picker" onKeyDown={event => {
            if (event.key !== 'ArrowDown' || (event.target as HTMLElement).closest('[role="menu"]')) return;
            const root = event.currentTarget;
            const trigger = root.querySelector<HTMLButtonElement>(':scope > button')!;
            if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
            requestAnimationFrame(() => root.querySelector<HTMLButtonElement>('[role="menu"] button')?.focus());
            event.preventDefault();
          }}>
            <Popover label={L('Choose skin', '选择皮肤')} trigger={<><Swatch appearance={sample} /><span className="appearance-skin-name" title={currentName}>{currentName}</span><ChevronDown size={15} /></>}>
              {dismiss => <div className="appearance-skin-menu" role="menu" aria-label={L('Appearance skins', '外观皮肤')} onKeyDown={navigateMenu}>
                <div className="appearance-skin-group">{L('Default configuration', '默认配置')}</div>
                <button type="button" className="appearance-menu-item" role="menuitemradio" aria-checked={skins.activeId === 'default'} onClick={() => select('default', dismiss)}>
                  <span className="appearance-skin-default-swatch" aria-hidden="true" /><span>{defaultName}</span>{skins.activeId === 'default' && <Check size={15} />}
                </button>
                <div className="appearance-skin-group">{L('My skins', '我的皮肤')}</div>
                {skins.skins.length === 0 && <div className="appearance-skin-empty">{L('No saved skins', '暂无皮肤')}</div>}
                {skins.skins.map(skin => <div className="appearance-skin-menu-row" key={skin.id}>
                  <button type="button" className="appearance-menu-item" role="menuitemradio" aria-checked={skins.activeId === skin.id} onClick={() => select(skin.id, dismiss)}>
                    <Swatch appearance={skin.appearance} /><span className="appearance-skin-name" title={skin.name}>{skin.name}</span>{skins.activeId === skin.id && <Check size={15} />}
                  </button>
                  <IconButton label={L('Rename ', '重命名 ') + skin.name} onClick={() => { dismiss(); open({ kind: 'rename', skin }, document.querySelector('.appearance-skin-picker > button')); }}><Pencil size={15} /></IconButton>
                  <IconButton label={L('Delete ', '删除 ') + skin.name} onClick={() => { dismiss(); open({ kind: 'delete', skin }, document.querySelector('.appearance-skin-picker > button')); }}><Trash2 size={15} /></IconButton>
                </div>)}
              </div>}
            </Popover>
          </div>
          <Button className="appearance-skin-save" onClick={event => open({ kind: 'save' }, event.currentTarget)}><Plus size={16} />{L('Save as skin', '另存为皮肤')}</Button>
          <IconButton label={L('Import skin', '导入皮肤')} onClick={event => open({ kind: 'import' }, event.currentTarget)}><Download size={18} /></IconButton>
          <IconButton label={L('Export skin', '导出皮肤')} onClick={event => open({ kind: 'export' }, event.currentTarget)}><Upload size={18} /></IconButton>
        </div>
      </div>
    </section>,
    resetButton: <IconButton label={L('Reset', '重置')} onClick={reset}><RotateCcw size={17} /></IconButton>,
    overlays: <>
      {error && !modal && <p className="appearance-skin-error" role="alert">{error}</p>}
      <Dialog open={modal !== null} title={modalTitle} closeLabel={L('Close dialog', '关闭对话框')} className="appearance-skin-dialog"
        onClose={close} onAfterClose={() => invoker.current?.focus({ preventScroll: true })}
        footer={<>
          <Button onClick={close}>{L('Cancel', '取消')}</Button>
          {modal?.kind === 'save' || modal?.kind === 'rename' ? <Button tone="primary" onClick={save}>{modal.kind === 'save' ? L('Save skin', '保存皮肤') : L('Save', '保存')}</Button>
            : modal?.kind === 'delete' ? <Button tone="primary" onClick={remove}>{L('Delete', '删除')}</Button>
            : modal?.kind === 'export' ? <Button tone="primary" onClick={download}>{L('Export', '导出')}</Button>
            : <><Button disabled={!parsed || loading} onClick={() => finishImport(false)}>{L('Import only', '仅导入')}</Button><Button tone="primary" disabled={!parsed || loading} onClick={() => finishImport(true)}>{L('Import and apply', '导入并应用')}</Button></>}
        </>}>
        {(modal?.kind === 'save' || modal?.kind === 'rename') && <form onSubmit={event => { event.preventDefault(); save(); }}>{nameField}</form>}
        {modal?.kind === 'save' && <Summary appearance={appearance} L={L} />}
        {modal?.kind === 'delete' && <p>{L('Delete “', '删除“') + modal.skin.name + L('”? The applied appearance will be kept.', '”？当前已应用的外观会保留。')}</p>}
        {modal?.kind === 'export' && <>
          <dl className="appearance-skin-summary"><div><dt>{L('File name', '文件名')}</dt><dd>{name.replace(/[\\/:*?"<>|]/g, '_')}.roppo-skin.json</dd></div></dl>
          <Summary appearance={appearance} L={L} />
        </>}
        {modal?.kind === 'import' && <>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label={L('Skin file', '皮肤文件')} onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void upload(file);
          }} />
          <div className="appearance-skin-import-actions">
            <Button busy={loading} onClick={() => fileInput.current?.click()}><Upload size={17} />{L('Choose a skin file', '选择皮肤文件')}</Button>
            {!parsed && paste === null && <Button tone="quiet" onClick={() => setPaste('')}>{L('Paste skin configuration', '粘贴皮肤配置')}</Button>}
          </div>
          {!parsed && paste !== null && <div className="appearance-skin-paste">
            <textarea className="rp-textarea" value={paste} onChange={event => setPaste(event.target.value)} aria-label={L('Skin configuration', '皮肤配置')} spellCheck={false} />
            <Button disabled={!paste.trim()} onClick={() => perform(() => read(paste))}>{L('Read configuration', '读取配置')}</Button>
          </div>}
          {parsed && <><form onSubmit={event => { event.preventDefault(); finishImport(true); }}>{nameField}</form><Summary appearance={parsed.appearance} L={L} /></>}
        </>}
        {error && <p className="appearance-skin-error" role="alert">{error}</p>}
      </Dialog>
      <div className="rp-toast-region appearance-skin-toast" role="status" aria-live="polite" aria-atomic="true">
        <span className="rp-toast" data-visible={!!notice} aria-hidden={!notice} inert={!notice}>
          <Check size={16} aria-hidden="true" /><span>{notice?.message}</span>
          {notice?.undo && <button type="button" onClick={() => perform(() => { notice.undo!(); clearNotice(); })}>{L('Undo', '撤销')}</button>}
          <button type="button" aria-label={L('Dismiss notification', '关闭提示')} onClick={clearNotice}><X size={15} /></button>
        </span>
      </div>
    </>,
  };
}
