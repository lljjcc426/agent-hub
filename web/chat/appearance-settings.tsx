import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Download } from 'lucide-react';
import { Button, CheckField, ChoiceGroup, IconButton, InputControl } from '../ui/controls.tsx';
import { Dialog, DisclosureRoot, DisclosureSummary, Popover, Toast } from '../ui/overlays.tsx';
import {
  appearancePresets,
  exportAppearanceTheme,
  importAppearanceTheme,
  isAppearanceTheme,
  useAppearance,
  useAppearanceMode,
} from './appearance-store.ts';
import { useAppearanceSkinManager } from './appearance-skins.tsx';
import './appearance-settings.css';

type Labels = (english: string, chinese: string) => string;
type ProfileMode = 'light' | 'dark';
type Settings = ReturnType<typeof useAppearance>[0];
type Profile = Settings['profiles'][ProfileMode];
type HSV = { h: number; s: number; v: number };

const accentColors: Record<string, Record<ProfileMode, string>> = {
  blue: { light: '#3a83f7', dark: '#6d99f7' },
  green: { light: '#2f8b57', dark: '#79bd8f' },
  yellow: { light: '#b49120', dark: '#dfc76a' },
  pink: { light: '#c4679a', dark: '#e7a0c6' },
  orange: { light: '#bb713b', dark: '#e4ab79' },
  purple: { light: '#8562be', dark: '#bea4eb' },
  black: { light: '#111111', dark: '#111111' },
  white: { light: '#eeeeee', dark: '#eeeeee' },
};

function toHSV(hex: string): HSV {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = 0;
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? delta / max : 0, v: max };
}

function fromHSV({ h, s, v }: HSV) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + rgb.map(n => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('');
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="appearance-row">
    <div className="appearance-label"><span>{label}</span></div>
    <div className="appearance-control">{children}</div>
  </div>;
}

function MiniWindow({ mode, label }: { mode: 'system' | ProfileMode; label: string }) {
  return <><span className="appearance-mini-window" data-mode={mode} aria-hidden="true">
    {(mode === 'system' ? ['light', 'dark'] : [mode]).map(part => <span className="appearance-mini-half" data-mode={part} key={part}>
      <span className="appearance-mini-rail"><i /><i /><i /></span>
      <span className="appearance-mini-main"><i /><i /><i /><b /></span>
    </span>)}
  </span><span className="appearance-mode-tooltip" aria-hidden="true">{label}</span></>;
}

function menuNavigation(event: KeyboardEvent<HTMLDivElement>) {
  const menu = (event.target as HTMLElement).closest('[role="menu"]');
  if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]'));
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  items[next]?.focus();
}

function MenuPopover({ label, trigger, children, onToggle }: {
  label: string;
  trigger: ReactNode;
  children: (dismiss: () => void) => ReactNode;
  onToggle?: () => void;
}) {
  const dropdown = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!onToggle) return;
    const root = dropdown.current!;
    function toggle(event: Event) {
      if ((event.target as HTMLElement).matches('.rp-popover:not(.appearance-submenu)')) onToggle!();
    }
    root.addEventListener('toggle', toggle, true);
    return () => root.removeEventListener('toggle', toggle, true);
  }, [onToggle]);
  return <div className="appearance-dropdown" ref={dropdown} onKeyDown={event => {
    if (event.key !== 'ArrowDown' || (event.target as HTMLElement).closest('[role="menu"]')) return;
    const root = event.currentTarget;
    const button = root.querySelector<HTMLButtonElement>(':scope > button')!;
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
    event.preventDefault();
    requestAnimationFrame(() => root.querySelector<HTMLButtonElement>('[role="menu"] button')?.focus());
  }}>
    <Popover label={label} trigger={trigger}>{dismiss => <div onKeyDown={menuNavigation}>{children(dismiss)}</div>}</Popover>
  </div>;
}

function ThemePicker({ mode, profile, L, onSelect }: {
  mode: ProfileMode;
  profile: Profile;
  L: Labels;
  onSelect: (id: string) => void;
}) {
  const [submenu, setSubmenu] = useState(false);
  const submenuTrigger = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (submenu) submenuRef.current!.showPopover({ source: submenuTrigger.current! });
  }, [submenu]);
  const selected = appearancePresets.find(preset => preset.id === profile.preset);
  const defaultPalette = appearancePresets[0]![mode];
  const name = selected?.id === 'default' ? L('Roppo Default', 'Roppo 默认') : selected?.name ?? L('Custom', '自定义');
  const label = mode === 'light' ? L('Light theme', '浅色主题') : L('Dark theme', '深色主题');
  function openSubmenu(focus = false) {
    setSubmenu(true);
    if (focus) requestAnimationFrame(() => submenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
  }
  return <MenuPopover label={label} onToggle={() => setSubmenu(false)} trigger={<>
    <span aria-hidden="true" className="appearance-theme-sample" style={{ backgroundColor: profile.background, color: profile.accent }}>Aa</span>
    <span className="appearance-picker-name">{name}</span><ChevronDown size={15} />
  </>}>
    {dismiss => <div className="appearance-theme-menu" data-submenu={submenu || undefined} onKeyDown={event => {
      if ((event.key === 'ArrowLeft' || event.key === 'Escape') && submenu) {
        event.preventDefault();
        setSubmenu(false);
        submenuTrigger.current?.focus();
      }
    }}>
      <div className="appearance-menu-list" role="menu" aria-label={L('Theme', '主题')}>
        <button type="button" className="appearance-menu-item" role="menuitemradio" aria-checked={profile.preset === 'default'}
          onPointerEnter={() => setSubmenu(false)} onFocus={() => setSubmenu(false)} onClick={() => {
          onSelect('default'); setSubmenu(false); dismiss();
        }}>
          <span aria-hidden="true" className="appearance-theme-sample" style={{ backgroundColor: defaultPalette.background, color: defaultPalette.accent }}>Aa</span><span>{L('Roppo Default', 'Roppo 默认')}</span>
          {profile.preset === 'default' && <Check size={15} />}
        </button>
        <button type="button" ref={submenuTrigger} className="appearance-menu-item appearance-submenu-trigger" role="menuitem" aria-haspopup="menu" aria-expanded={submenu}
          onPointerEnter={() => openSubmenu()} onClick={() => openSubmenu()} onKeyDown={event => {
            if (event.key === 'ArrowRight') { event.preventDefault(); openSubmenu(true); }
          }}>
          <span aria-hidden="true" className="appearance-theme-sample">Aa</span><span>{L('Theme presets', '主题预设')}</span><ChevronRight size={15} />
        </button>
      </div>
      {submenu && <div ref={submenuRef} popover="manual" className="rp-popover appearance-menu-list appearance-submenu" role="menu" aria-label={L('Theme presets', '主题预设')}>
        {appearancePresets.filter(preset => preset.id !== 'default').map(preset => <button type="button" key={preset.id}
          className="appearance-menu-item" role="menuitemradio" aria-checked={profile.preset === preset.id} onClick={() => onSelect(preset.id)}>
          <span aria-hidden="true" className="appearance-theme-sample" style={{ backgroundColor: preset[mode].background, color: preset[mode].accent }}>Aa</span>
          <span>{preset.name}</span>{profile.preset === preset.id && <Check size={15} />}
        </button>)}
      </div>}
    </div>}
  </MenuPopover>;
}

function ColorPlane({ value, label, L, onChange }: { value: string; label: string; L: Labels; onChange: (value: string) => void }) {
  const [hsv, setHSV] = useState(() => toHSV(value));
  useEffect(() => {
    setHSV(current => {
      if (fromHSV(current) === value.toLowerCase()) return current;
      const next = toHSV(value);
      return next.s === 0 ? { ...next, h: current.h } : next;
    });
  }, [value]);
  function update(next: HSV) { setHSV(next); onChange(fromHSV(next)); }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    update({ ...hsv, s: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), v: 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) });
  }
  return <div className="appearance-color-plane">
    <button type="button" className="appearance-sv" role="slider" aria-label={label + L(' saturation and brightness', '饱和度与明度')}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv.s * 100)}
      aria-valuetext={L(`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`, `饱和度 ${Math.round(hsv.s * 100)}%，明度 ${Math.round(hsv.v * 100)}%`)}
      style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${hsv.h} 100% 50%)` }}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); move(event); }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event); }}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const step = event.shiftKey ? .1 : .01;
        update({ ...hsv, s: Math.max(0, Math.min(1, hsv.s + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0))),
          v: Math.max(0, Math.min(1, hsv.v + (event.key === 'ArrowDown' ? -step : event.key === 'ArrowUp' ? step : 0))) });
      }}>
      <span style={{ left: hsv.s * 100 + '%', top: (1 - hsv.v) * 100 + '%' }} />
    </button>
    <input className="appearance-hue" type="range" min="0" max="359" value={hsv.h} aria-label={label + L(' hue', '色相')}
      onChange={event => update({ ...hsv, h: Number(event.target.value) })} />
  </div>;
}

function ColorField({ value, label, L, onChange, testId }: { value: string; label: string; L: Labels; onChange: (value: string) => void; testId: string }) {
  const [draft, setDraft] = useState(value.toUpperCase());
  useEffect(() => setDraft(value.toUpperCase()), [value]);
  return <div className="appearance-color-field">
    <Popover label={label + L(' color picker', '调色盘')} trigger={<span aria-hidden="true" className="appearance-color-dot" style={{ backgroundColor: value }} />}>
      {() => <ColorPlane value={value} label={label} L={L} onChange={onChange} />}
    </Popover>
    <InputControl aria-label={label + L(' hex color', '十六进制颜色')} data-testid={testId} value={draft} maxLength={7} spellCheck={false}
      onChange={event => {
        const next = event.target.value;
        setDraft(next);
        if (/^#[\da-f]{6}$/i.test(next)) onChange(next.toLowerCase());
      }} onBlur={() => setDraft(value.toUpperCase())} />
  </div>;
}

function NumberField({ value, min, max, label, testId, onChange }: { value: number; min: number; max: number; label: string; testId: string; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <InputControl type="number" className="appearance-number" aria-label={label} data-testid={testId}
    min={min} max={max} step={1} value={draft} onChange={event => {
      const next = event.target.value, number = event.target.valueAsNumber;
      setDraft(next);
      if (Number.isInteger(number) && number >= min && number <= max) onChange(number);
    }} onBlur={() => setDraft(String(value))} />;
}

export function AppearanceSettings({ L }: { L: Labels }) {
  const [settings, setAppearance] = useAppearance();
  const currentMode = useAppearanceMode();
  const [advanced, setAdvanced] = useState(false);
  const [importMode, setImportMode] = useState<ProfileMode | null>(null);
  const [importText, setImportText] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const importInvoker = useRef<HTMLButtonElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const skins = useAppearanceSkinManager(L);
  const importInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (importMode) importInput.current?.focus(); }, [importMode]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const modes: ProfileMode[] = settings.separate ? ['light', 'dark'] : [currentMode];
  const accentNames: Record<string, string> = {
    default: L('Default', '默认'), blue: L('Blue', '蓝色'), green: L('Green', '绿色'), yellow: L('Yellow', '黄色'),
    pink: L('Pink', '粉色'), orange: L('Orange', '橙色'), purple: L('Purple', '紫色'), black: L('Black', '黑色'),
    white: L('White', '白色'), custom: L('Custom', '自定义'),
  };
  function notify(text: string) {
    clearTimeout(toastTimer.current);
    setMessage(text);
    toastTimer.current = setTimeout(() => setMessage(''), 2500);
  }
  function updateProfile(mode: ProfileMode, change: Partial<Profile>) {
    setAppearance(previous => ({ ...previous, profiles: { ...previous.profiles, [mode]: { ...previous.profiles[mode], ...change } } }));
  }
  function selectPreset(mode: ProfileMode, id: string) {
    const preset = appearancePresets.find(candidate => candidate.id === id)!;
    setAppearance(previous => {
      const profiles = { ...previous.profiles };
      for (const target of previous.separate ? [mode] : ['light', 'dark'] as const) {
        profiles[target] = { ...profiles[target], ...preset[target], preset: id, accentName: 'default' };
      }
      return { ...previous, profiles };
    });
  }
  function selectAccent(mode: ProfileMode, name: string, customColor?: string) {
    setAppearance(previous => {
      const profiles = { ...previous.profiles };
      for (const target of previous.separate ? [mode] : ['light', 'dark'] as const) {
        const profile = profiles[target];
        const preset = appearancePresets.find(candidate => candidate.id === profile.preset) ?? appearancePresets[0]!;
        const accent = customColor ?? (name === 'custom' ? profile.accent : name === 'default' ? preset[target].accent : accentColors[name]![target]);
        profiles[target] = { ...profile, accentName: name, accent };
      }
      return { ...previous, profiles };
    });
  }
  async function copyTheme(mode: ProfileMode) {
    setError('');
    try {
      await navigator.clipboard.writeText(exportAppearanceTheme(mode));
      notify(mode === 'light' ? L('Light theme copied', '已复制浅色主题') : L('Dark theme copied', '已复制深色主题'));
    } catch {
      setError(L('Could not copy the theme. Allow clipboard access and try again.', '未能复制主题，请允许访问剪贴板后重试。'));
    }
  }
  const canImport = importMode !== null && isAppearanceTheme(importText, importMode);
  function applyImport() {
    if (!canImport || !importMode) return;
    importAppearanceTheme(importText, importMode);
    notify(importMode === 'light' ? L('Light theme imported', '已导入浅色主题') : L('Dark theme imported', '已导入深色主题'));
    setImportMode(null);
  }
  return <div className="general-scroll roppo-ui appearance-page">
    <article className="general appearance-settings">
      <h1>{L('Appearance', '外观')}</h1>
      {skins.controls}
      <section className="appearance-section">
        <div className="appearance-visual-heading"><h2>{L('Visual style', '视觉风格')}</h2>{skins.resetButton}</div>
        <SettingRow label={L('Color mode', '模式')}>
          <div className="appearance-mode">
            <ChoiceGroup label={L('Color mode', '模式')} appearance="tiles" value={settings.mode} onChange={mode => setAppearance(previous => ({ ...previous, mode }))}
              choices={[
                { value: 'system', label: L('System', '跟随系统'), visual: <MiniWindow mode="system" label={L('System', '跟随系统')} /> },
                { value: 'light', label: L('Light', '浅色'), visual: <MiniWindow mode="light" label={L('Light', '浅色')} /> },
                { value: 'dark', label: L('Dark', '深色'), visual: <MiniWindow mode="dark" label={L('Dark', '深色')} /> },
              ]} />
          </div>
        </SettingRow>
      </section>
      <section className="appearance-section appearance-themes">
        {modes.map(mode => {
          const profile = settings.profiles[mode];
          const modeName = mode === 'light' ? L('Light theme', '浅色主题') : L('Dark theme', '深色主题');
          return <div className="appearance-profile" key={mode} data-profile={mode}>
            <SettingRow label={settings.separate ? modeName : L('Theme', '主题')}>
              <IconButton label={mode === 'light' ? L('Import light theme', '导入浅色主题') : L('Import dark theme', '导入深色主题')} data-testid={'import-' + mode}
                onClick={event => { importInvoker.current = event.currentTarget; setImportText(''); setImportMode(mode); }}><Download size={18} /></IconButton>
              <IconButton label={mode === 'light' ? L('Copy light theme', '复制浅色主题') : L('Copy dark theme', '复制深色主题')} data-testid={'copy-' + mode}
                onClick={() => void copyTheme(mode)}><Copy size={18} /></IconButton>
              <ThemePicker mode={mode} profile={profile} L={L} onSelect={id => selectPreset(mode, id)} />
            </SettingRow>
            <SettingRow label={L('Accent', '强调色')}>
              <MenuPopover label={modeName + L(' accent', '强调色')} trigger={<>
                {profile.accentName !== 'custom' && <span aria-hidden="true" className="appearance-color-dot" style={{ backgroundColor: profile.accent }} />}
                <span>{accentNames[profile.accentName] ?? accentNames.custom}</span><ChevronDown size={15} />
              </>}>
                {dismiss => <div className="appearance-menu-list" role="menu" aria-label={L('Accent', '强调色')}>
                  {['default', 'blue', 'green', 'yellow', 'pink', 'orange', 'purple', mode === 'light' ? 'black' : 'white', 'custom'].map(name => <button type="button" key={name}
                    className="appearance-menu-item" role="menuitemradio" aria-checked={profile.accentName === name} onClick={() => { selectAccent(mode, name); dismiss(); }}>
                    {name === 'custom' ? <span aria-hidden="true" className="appearance-theme-sample">Aa</span> : <span aria-hidden="true" className="appearance-color-dot" style={{ backgroundColor: name === 'default'
                      ? (appearancePresets.find(preset => preset.id === profile.preset) ?? appearancePresets[0]!)[mode].accent : accentColors[name]![mode] }} />}
                    <span>{accentNames[name]}</span>{profile.accentName === name && <Check size={15} />}
                  </button>)}
                </div>}
              </MenuPopover>
              {profile.accentName === 'custom' && <ColorField label={modeName + L(' accent', '强调色')} value={profile.accent} L={L} testId={'hex-' + mode + '-accent'} onChange={color => selectAccent(mode, 'custom', color)} />}
            </SettingRow>
            <SettingRow label={L('Background', '背景')}>
              <ColorField label={modeName + L(' background', '背景')} value={profile.background} L={L} testId={'hex-' + mode + '-background'} onChange={background => updateProfile(mode, { background, preset: 'custom', accentName: 'custom' })} />
            </SettingRow>
            <SettingRow label={L('Foreground', '前景')}>
              <ColorField label={modeName + L(' foreground', '前景')} value={profile.foreground} L={L} testId={'hex-' + mode + '-foreground'} onChange={foreground => updateProfile(mode, { foreground, preset: 'custom', accentName: 'custom' })} />
            </SettingRow>
          </div>;
        })}
      </section>
      <DisclosureRoot className="rp-disclosure appearance-advanced" data-testid="advanced" onToggle={event => setAdvanced(event.currentTarget.open)}>
        <DisclosureSummary>{L('Advanced', '高级')}<ChevronDown size={16} /></DisclosureSummary>
        <div className="rp-disclosure-clip" inert={!advanced} aria-hidden={!advanced}><div>
          <SettingRow label={L('UI font size', '界面字号')}>
            <NumberField value={settings.uiSize} min={12} max={20} label={L('UI font size', '界面字号')} testId="ui-size" onChange={uiSize => setAppearance(previous => ({ ...previous, uiSize }))} />
          </SettingRow>
          <SettingRow label={L('Content font size', '内容字号')}>
            <NumberField value={settings.contentSize} min={12} max={24} label={L('Content font size', '内容字号')} testId="content-size" onChange={contentSize => setAppearance(previous => ({ ...previous, contentSize }))} />
          </SettingRow>
          <SettingRow label={L('Code font size', '代码字号')}>
            <NumberField value={settings.codeSize} min={11} max={22} label={L('Code font size', '代码字号')} testId="code-size" onChange={codeSize => setAppearance(previous => ({ ...previous, codeSize }))} />
          </SettingRow>
          <SettingRow label={L('Reduce motion', '减少动态效果')}>
            <ChoiceGroup label={L('Reduce motion', '减少动态效果')} value={settings.motion} onChange={motion => setAppearance(previous => ({ ...previous, motion }))}
              choices={[{ value: 'system', label: L('System', '系统') }, { value: 'on', label: L('On', '开启') }, { value: 'off', label: L('Off', '关闭') }]} />
          </SettingRow>
          <SettingRow label={L('Separate light and dark modes', '分别设置浅色和深色模式')}>
            <CheckField appearance="switch" hideLabel label={L('Separate light and dark modes', '分别设置浅色和深色模式')} data-testid="separate-modes" checked={settings.separate} onChange={event => setAppearance(previous => ({ ...previous, separate: event.target.checked }))} />
          </SettingRow>
          <div className="appearance-contrast-group">
            {settings.separate && <div className="appearance-contrast-heading">{L('Contrast', '对比度')}</div>}
            {modes.map(mode => <SettingRow key={mode} label={settings.separate ? mode === 'light' ? L('Light theme', '浅色主题') : L('Dark theme', '深色主题') : L('Contrast', '对比度')}>
              <div className="appearance-slider"><input type="range" min="0" max="100" step="1" value={settings.profiles[mode].contrast} data-testid={'contrast-' + mode}
                aria-label={mode === 'light' ? L('Light theme contrast', '浅色主题对比度') : L('Dark theme contrast', '深色主题对比度')} onChange={event => updateProfile(mode, { contrast: Number(event.target.value) })} />
                <output>{settings.profiles[mode].contrast}</output></div>
            </SettingRow>)}
          </div>
          <SettingRow label={L('Smart punctuation', '智能标点')}>
            <CheckField appearance="switch" hideLabel label={L('Smart punctuation', '智能标点')} checked={settings.smart} onChange={event => setAppearance(previous => ({ ...previous, smart: event.target.checked }))} />
          </SettingRow>
          <SettingRow label={L('Full-width conversations', '对话全宽显示')}>
            <CheckField appearance="switch" hideLabel label={L('Full-width conversations', '对话全宽显示')} checked={settings.fullWidth} onChange={event => setAppearance(previous => ({ ...previous, fullWidth: event.target.checked }))} />
          </SettingRow>
          <SettingRow label={L('Diff indicators', '差异标记')}>
            <ChoiceGroup label={L('Diff indicators', '差异标记')} value={settings.diff} onChange={diff => setAppearance(previous => ({ ...previous, diff }))}
              choices={[{ value: 'color', label: L('Color', '颜色') }, { value: 'sign', label: '+/−' }]} />
          </SettingRow>
        </div></div>
      </DisclosureRoot>
      {error && <p className="appearance-error" role="alert">{error}</p>}
    </article>
    <Dialog open={importMode !== null} title={L('Import theme', '导入主题')} closeLabel={L('Close dialog', '关闭对话框')}
      onClose={() => setImportMode(null)} onAfterClose={() => importInvoker.current?.focus({ preventScroll: true })}
      footer={<><Button onClick={() => setImportMode(null)}>{L('Cancel', '取消')}</Button><Button tone="primary" disabled={!canImport} data-testid="import-submit" onClick={applyImport}>{L('Import', '导入')}</Button></>}>
      <form onSubmit={event => { event.preventDefault(); applyImport(); }}>
        <InputControl ref={importInput} type="text" className="appearance-import-input" data-testid="import-input" aria-label={L('Theme string', '主题字符串')}
          value={importText} onChange={event => setImportText(event.target.value)} placeholder={'roppo-theme-v1:{"mode":"' + (importMode ?? currentMode) + '","colors":{…}}'} spellCheck={false} autoComplete="off" />
      </form>
    </Dialog>
    <Toast message={message} />
    {skins.overlays}
  </div>;
}
