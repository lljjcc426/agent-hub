// This head bootstrap is shared by the React shell and standalone account/configuration pages.
(() => {
  if (window.roppoAppearance) return

  const storageKey = 'agenthub.configuration.appearance'
  const eventName = 'roppo:appearancechange'
  const root = document.documentElement
  const systemMode = matchMedia('(prefers-color-scheme: dark)')
  const systemMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const presets = [
    { id: 'default', name: 'Roppo', light: { background: '#ffffff', foreground: '#1b1b1b', accent: '#222222' }, dark: { background: '#171717', foreground: '#f2f2f2', accent: '#ebebeb' } },
    { id: 'catppuccin', name: 'Catppuccin', light: { background: '#eff1f5', foreground: '#4c4f69', accent: '#8839ef' }, dark: { background: '#1e1e2e', foreground: '#cdd6f4', accent: '#cba6f7' } },
    { id: 'everforest', name: 'Everforest', light: { background: '#fdf6e3', foreground: '#5c6a72', accent: '#708253' }, dark: { background: '#2d353b', foreground: '#d3c6aa', accent: '#a7c080' } },
    { id: 'github', name: 'GitHub', light: { background: '#ffffff', foreground: '#1f2328', accent: '#0969da' }, dark: { background: '#0d1117', foreground: '#f0f6fc', accent: '#4493f8' } },
    { id: 'gruvbox', name: 'Gruvbox', light: { background: '#fbf1c7', foreground: '#3c3836', accent: '#b57614' }, dark: { background: '#282828', foreground: '#ebdbb2', accent: '#fabd2f' } },
    { id: 'linear', name: 'Linear', light: { background: '#fafaff', foreground: '#292a3d', accent: '#5e6ad2' }, dark: { background: '#181a1f', foreground: '#f7f8f8', accent: '#828fff' } },
    { id: 'rosepine', name: 'Rose Pine', light: { background: '#faf4ed', foreground: '#575279', accent: '#907aa9' }, dark: { background: '#191724', foreground: '#e0def4', accent: '#c4a7e7' } },
    { id: 'solarized', name: 'Solarized', light: { background: '#fdf6e3', foreground: '#586e75', accent: '#268bd2' }, dark: { background: '#002b36', foreground: '#93a1a1', accent: '#2aa198' } },
    { id: 'vercel', name: 'Vercel', light: { background: '#ffffff', foreground: '#171717', accent: '#171717' }, dark: { background: '#0a0a0a', foreground: '#ededed', accent: '#ededed' } },
  ]
  const defaultSettings = () => ({
    version: 1, mode: 'light', separate: false, uiSize: 14, contentSize: 15, codeSize: 13,
    motion: 'system', smart: true, fullWidth: false, diff: 'color',
    profiles: {
      light: { preset: 'default', accentName: 'default', contrast: 45, ...presets[0].light },
      dark: { preset: 'default', accentName: 'default', contrast: 60, ...presets[0].dark },
    },
  })
  const modes = ['light', 'dark']
  const colorKeys = ['background', 'foreground', 'accent']
  const isColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
  const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max
  const validProfile = value => value && typeof value.preset === 'string'
    && ['default', 'blue', 'green', 'yellow', 'pink', 'orange', 'purple', 'black', 'white', 'custom'].includes(value.accentName)
    && inRange(value.contrast, 0, 100) && colorKeys.every(key => isColor(value[key]))
  const validSettings = value => value?.version === 1 && ['system', ...modes].includes(value.mode)
    && typeof value.separate === 'boolean' && inRange(value.uiSize, 12, 20)
    && inRange(value.contentSize, 12, 24) && inRange(value.codeSize, 11, 22)
    && ['system', 'on', 'off'].includes(value.motion) && typeof value.smart === 'boolean'
    && typeof value.fullWidth === 'boolean' && ['color', 'sign'].includes(value.diff)
    && modes.every(mode => validProfile(value.profiles?.[mode]))

  let settings = defaultSettings()
  let migrated = false
  try {
    const stored = localStorage.getItem(storageKey)
    if (stored) {
      const value = JSON.parse(stored)
      if (validSettings(value)) settings = value
    } else {
      const legacy = localStorage.getItem('agenthub.configuration.theme')
      if (legacy === 'light' || legacy === 'dark') {
        settings.mode = legacy
        migrated = true
      }
    }
  } catch {}

  const motionPreference = {
    get matches() { return settings.motion === 'on' || systemMotion.matches },
    addEventListener: (_type, listener) => window.addEventListener('roppo:motionchange', listener),
    removeEventListener: (_type, listener) => window.removeEventListener('roppo:motionchange', listener),
  }
  let reducedMotion = motionPreference.matches
  const style = document.createElement('style')
  style.id = 'roppo-appearance-runtime'
  document.head.append(style)
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  const mix = (a, b, amount) => '#' + rgb(a).map((value, i) => Math.round(value + (rgb(b)[i] - value) * amount).toString(16).padStart(2, '0')).join('')
  const luminance = hex => rgb(hex).map(value => {
    const n = value / 255
    return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4
  }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)
  const resolvedMode = () => settings.mode === 'system' ? (systemMode.matches ? 'dark' : 'light') : settings.mode
  const variables = entries => Object.entries(entries).map(([key, value]) => `--${key}:${value}`).join(';')
  const scope = ':root[data-appearance][data-appearance-mode][data-theme]'
  const paletteScope = `${scope},${scope} .roppo-ui,${scope} .management-content,${scope} .conversation-body,${scope} .team-file-dialog`

  function apply() {
    const mode = resolvedMode()
    const profile = settings.profiles[mode]
    const defaults = presets[0][mode]
    const backgroundChanged = profile.background.toLowerCase() !== defaults.background
    const foregroundChanged = profile.foreground.toLowerCase() !== defaults.foreground
    const accentChanged = profile.accent.toLowerCase() !== defaults.accent
    const contrastChanged = profile.contrast !== (mode === 'dark' ? 60 : 45)
    const palette = {}
    const assign = (names, value) => names.split(' ').forEach(name => { palette[name] = value })
    const ink = profile.foreground
    const paper = profile.background

    root.dataset.appearance = '1'
    root.dataset.theme = mode
    root.dataset.appearanceMode = settings.mode
    root.dataset.appearanceMotion = motionPreference.matches ? 'on' : 'off'
    root.dataset.appearanceFullWidth = String(settings.fullWidth)
    root.dataset.appearanceSmart = String(settings.smart)
    root.dataset.appearanceDiff = settings.diff
    root.toggleAttribute('data-appearance-ui-size', settings.uiSize !== 14)
    root.toggleAttribute('data-appearance-content-size', settings.contentSize !== 15)
    root.toggleAttribute('data-appearance-code-size', settings.codeSize !== 13)

    if (backgroundChanged) {
      assign('canvas surface c-bg c-raised rp-bg rp-panel team-paper team-surface', paper)
      assign('surface-soft c-side rp-rail panel rail wash', mix(paper, ink, .025))
      assign('surface-hover c-soft rp-soft', mix(paper, ink, .055))
      assign('c-hover rp-hover hover', mix(paper, ink, .085))
      assign('surface-selected rp-selected tint team-fill', mix(paper, ink, .11))
      assign('surface-muted', mix(paper, ink, .15))
      assign('text-inverse-bg', ink)
    }
    if (foregroundChanged) assign('text-primary c-text rp-ink ink team-ink', ink)
    if (backgroundChanged || foregroundChanged || accentChanged) assign('team-user-bubble', mix(paper, profile.accent, .12))
    if (backgroundChanged || foregroundChanged || contrastChanged) {
      const foregroundStrength = .04 + (100 - profile.contrast) * .002
      const secondary = mix(ink, paper, foregroundStrength)
      const faint = mix(ink, paper, foregroundStrength + .05)
      assign('text-secondary rp-muted body', secondary)
      assign('text-muted c-muted rp-faint muted team-muted', faint)
      assign('border-subtle c-line rp-line line team-line', mix(paper, ink, .09 + profile.contrast * .0012))
      assign('border-strong rp-line-strong control-line field', mix(paper, ink, .25 + profile.contrast * .002))
      assign('diagram-line neutral-dot', secondary)
      assign('diagram-off', mix(paper, ink, .14))
    }
    if (accentChanged) {
      const onAccent = contrast(profile.accent, '#ffffff') >= contrast(profile.accent, '#171717') ? '#ffffff' : '#171717'
      assign('action c-action rp-action accent team-action', profile.accent)
      assign('on-action c-on-action rp-on-action team-on-action', onAccent)
      assign('action-hover', mix(profile.accent, paper, .15))
      assign('focus-ring rp-focus focus', profile.accent)
      assign('focus-soft', profile.accent + '30')
      assign('selection-bg', mix(paper, profile.accent, .2))
    }

    const rules = []
    if (Object.keys(palette).length) rules.push(`${paletteScope}{${variables(palette)}}`)
    const type = {}
    const uiDelta = settings.uiSize - 14
    if (uiDelta) {
      Object.entries({ page: 28, dialog: 18, section: 16, body: 14, control: 14, input: 14, meta: 12 }).forEach(([name, size]) => { type['roppo-font-' + name] = size + uiDelta + 'px' })
      type['appearance-ui-delta'] = uiDelta + 'px'
      rules.push(`${scope},${scope} body{font-size:${settings.uiSize}px}`)
      rules.push(`@media(max-width:800px){${paletteScope}{--roppo-font-page:${24 + uiDelta}px;--roppo-font-input:${16 + uiDelta}px}}`)
    }
    if (settings.contentSize !== 15) {
      type['roppo-font-reading'] = 16 + settings.contentSize - 15 + 'px'
      type['appearance-content-delta'] = settings.contentSize - 15 + 'px'
    }
    if (settings.codeSize !== 13) {
      type['appearance-code-size'] = settings.codeSize + 'px'
      rules.push(`${scope} :is(.operator-workspace pre,.operator-workspace code,#account-app pre,#account-app code){font-size:var(--appearance-code-size)}`)
    }
    if (Object.keys(type).length) rules.unshift(`${paletteScope}{${variables(type)}}`)
    rules.push(`${scope}[data-appearance-motion="on"] *,${scope}[data-appearance-motion="on"] *::before,${scope}[data-appearance-motion="on"] *::after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:.01ms!important;transition-delay:0s!important}`)
    rules.push(`${scope}[data-appearance-motion="on"]::view-transition-group(*),${scope}[data-appearance-motion="on"]::view-transition-old(*),${scope}[data-appearance-motion="on"]::view-transition-new(*){animation:none!important}`)
    if (accentChanged) {
      rules.push(`${scope} #account-app .primary-button{background:var(--action);color:var(--on-action)}`)
      rules.push(`${scope} ::selection{background:var(--selection-bg);color:var(--text-primary,var(--ink))}`)
    }
    style.textContent = rules.join('\n')
  }
  function announce() {
    const motionChanged = reducedMotion !== motionPreference.matches
    reducedMotion = motionPreference.matches
    apply()
    window.dispatchEvent(new Event(eventName))
    if (motionChanged) window.dispatchEvent(new Event('roppo:motionchange'))
  }
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(settings)) } catch {}
  }
  function setAppearance(next) {
    settings = typeof next === 'function' ? next(settings) : next
    announce()
    persist()
  }
  const message = (en, zh) => root.lang.startsWith('zh') ? zh : en
  function parseTheme(value) {
    const prefix = 'roppo-theme-v1:'
    if (!value.trim().startsWith(prefix)) throw new Error(message('Use a Roppo theme sharing string.', '请使用 Roppo 主题分享字符串。'))
    let theme
    try { theme = JSON.parse(value.trim().slice(prefix.length)) }
    catch { throw new Error(message('The theme string is not valid JSON.', '主题字符串的 JSON 格式不正确。')) }
    if (!theme || !modes.includes(theme.mode) || !colorKeys.every(key => isColor(theme.colors?.[key])) || !inRange(theme.contrast, 0, 100)) {
      throw new Error(message('The theme needs valid colors and a contrast value from 0 to 100.', '主题需要有效的颜色，以及 0 到 100 之间的对比度。'))
    }
    return theme
  }
  function exportTheme(mode) {
    const profile = settings.profiles[mode]
    return 'roppo-theme-v1:' + JSON.stringify({ mode, preset: profile.preset, colors: { background: profile.background, foreground: profile.foreground, accent: profile.accent }, contrast: profile.contrast })
  }
  function importTheme(value, mode) {
    const theme = parseTheme(value)
    const profile = { ...settings.profiles[mode], ...theme.colors, contrast: theme.contrast, preset: presets.some(preset => preset.id === theme.preset) ? theme.preset : 'custom', accentName: 'custom' }
    setAppearance({ ...settings, profiles: { ...settings.profiles, [mode]: profile } })
  }
  window.roppoAppearance = {
    getSnapshot: () => settings,
    getMode: resolvedMode,
    motionPreference,
    setAppearance,
    presets,
    defaultSettings,
    exportTheme,
    importTheme,
    isTheme: value => { try { parseTheme(value); return true } catch { return false } },
  }
  window.addEventListener('storage', event => {
    if (event.key !== storageKey && event.key !== null) return
    let next = defaultSettings()
    if (event.newValue) {
      try {
        const value = JSON.parse(event.newValue)
        if (!validSettings(value)) return
        next = value
      } catch { return }
    }
    settings = next
    announce()
  })
  systemMode.addEventListener('change', () => { if (settings.mode === 'system') announce() })
  systemMotion.addEventListener('change', () => { if (reducedMotion !== motionPreference.matches) announce() })
  apply()
  if (migrated) persist()
})()
