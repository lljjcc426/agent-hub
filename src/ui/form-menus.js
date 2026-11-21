// Keep the native field as the form value, label and validation target.
// The shared popup also works in dialogs and standalone configuration pages.
;(() => {
  if (typeof document === 'undefined') return
  const installed = Symbol.for('roppo.formMenus')
  if (document[installed]) return
  document[installed] = true

  const style = document.createElement('style')
  style.nonce = document.currentScript?.nonce || ''
  style.textContent = String.raw`
/* Resolve colors within the owning surface, including standalone configuration and the board. */
:root, .management-content {
  --rp-field-panel:var(--surface,var(--c-bg,var(--bg,Canvas)));
  --rp-field-ink:var(--c-text,var(--ink,CanvasText));
  --rp-field-line:var(--c-line,var(--line,#ddd));
  --rp-field-hover:var(--surface-hover,var(--c-hover,var(--hover,color-mix(in srgb,currentColor 8%,transparent))));
}
.roppo-ui {
  --rp-field-panel:var(--rp-panel); --rp-field-ink:var(--rp-ink);
  --rp-field-line:var(--rp-line); --rp-field-hover:var(--rp-hover);
}
select.rp-select-field:not([multiple]) {
  box-sizing:border-box; max-width:100%; min-width:0; min-height:36px;
  appearance:none; padding:6px 32px 6px 12px; font:inherit; color:inherit;
  border:1px solid var(--rp-field-line); border-radius:var(--rp-corner-field,12px);
  background-color:var(--rp-field-panel);
  --rp-select-chevron:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 16 16'%3E%3Cpath d='m4 6 4 4 4-4' fill='none' stroke='%23808080' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.6'/%3E%3C/svg%3E");
  background-size:14px; background-repeat:no-repeat; background-position:right 10px center;
  text-overflow:ellipsis; cursor:pointer;
}
/* Older layouts still size their fields; keep the component shape and arrow. */
select.rp-select-field:not([multiple]) {
  background-image:var(--rp-select-chevron) !important; background-position:right 10px center !important;
  background-repeat:no-repeat !important; background-size:14px !important; padding-inline-end:32px !important;
  border-radius:var(--rp-corner-field,12px) !important;
}
:where(form,details) :is(input.rp-field-input:not([type=checkbox],[type=radio],[type=file],[type=hidden],[type=range]),textarea.rp-textarea):not(:where(.browser-address *, .resource-search *, .market-search *, .automation-search *)) {
  box-sizing:border-box; min-width:0; max-width:100%; padding:8px 11px;
  border:1px solid var(--rp-field-line);
  border-radius:var(--rp-corner-field,12px); color:inherit; background-color:var(--rp-field-panel);
}
.rp-field-input:is([type=checkbox],[type=radio]) {accent-color:var(--rp-field-ink)}
:is(.rp-field-input,.rp-textarea):focus-visible, select.rp-select-field:focus-visible, .rp-disclosure-field > summary:focus-visible {
  outline:2px solid var(--rp-focus,#777); outline-offset:2px;
}
select.rp-select-field:disabled {cursor:default; opacity:.55}
.rp-field-menu {
  display:block; position:fixed; inset:auto; z-index:1000; margin:0; padding:4px; box-sizing:border-box;
  width:max-content; max-width:calc(100vw - 16px); overflow:auto; overscroll-behavior:contain;
  border:1px solid var(--rp-field-line); border-radius:12px;
  color:var(--rp-field-ink); background:var(--rp-field-panel);
  box-shadow:0 6px 24px rgb(0 0 0 / 12%); font:inherit; font-size:14px; line-height:1.45;
}
.rp-field-menu [role=option], .rp-field-group {position:relative; padding:7px 30px 7px 10px; overflow-wrap:anywhere; border-radius:8px}
.rp-field-menu [role=option] {cursor:pointer; user-select:none}
.rp-field-menu [data-active] {background:var(--rp-field-hover)}
.rp-field-menu [aria-selected=true]::after {content:"✓"; position:absolute; right:10px}
.rp-field-menu [aria-disabled=true], .rp-field-group {opacity:.55; cursor:default}
.rp-disclosure-field > summary {cursor:pointer}
.rp-disclosure-field > summary[data-rp-heading] {display:flex; align-items:center; justify-content:space-between; gap:8px; list-style:none}
.rp-disclosure-field > summary[data-rp-heading]::-webkit-details-marker {display:none}
.rp-disclosure-field > summary[data-rp-heading]::after {content:""; width:6px; height:6px; flex:none; margin-inline:5px; border:solid currentColor; border-width:0 1.5px 1.5px 0; transform:rotate(-45deg); transition:transform .16s ease}
.rp-disclosure-field[open] > summary[data-rp-heading]::after {transform:rotate(45deg)}
@media (prefers-reduced-motion:reduce) {.rp-disclosure-field > summary[data-rp-heading]::after {transition:none}}
`
  document.head.append(style)

  const reducedMotion = window.roppoAppearance?.motionPreference ?? matchMedia('(prefers-reduced-motion: reduce)')
  let current = null
  let leavingMenu = null
  let sequence = 0
  function field(target) {
    return target instanceof HTMLSelectElement && target.matches('.rp-select-field:enabled') &&
      !target.multiple && target.size <= 1 ? target : null
  }
  function close(animate = true) {
    if (!current) return
    const { select, menu, observer, opening, folded } = current
    current = null
    observer.disconnect()
    menu.inert = true
    menu.setAttribute('aria-hidden', 'true')
    menu.style.pointerEvents = 'none'
    if (animate && !reducedMotion.matches && menu.isConnected) {
      const style = getComputedStyle(menu)
      const visible = {opacity:style.opacity, transform:style.transform}
      opening?.cancel()
      leavingMenu = menu
      const exit = menu.animate([visible,folded], {duration:110,easing:'ease-out',fill:'forwards'})
      const remove = () => {
        menu.remove()
        if (leavingMenu === menu) leavingMenu = null
      }
      void exit.finished.then(remove, remove)
    } else {
      opening?.cancel()
      menu.remove()
    }
    select.removeAttribute('aria-controls')
    select.removeAttribute('aria-activedescendant')
    select.setAttribute('aria-expanded', 'false')
  }
  function highlight(row, scroll = true) {
    if (!current || !row) return
    current.active?.removeAttribute('data-active')
    current.active = row
    row.dataset.active = ''
    current.select.setAttribute('aria-activedescendant', row.id)
    if (scroll) {
      // Keep scrolling inside the picker. Moving the page would dismiss it.
      const bounds = current.menu.getBoundingClientRect()
      const option = row.getBoundingClientRect()
      if (option.top < bounds.top) current.menu.scrollTop += option.top - bounds.top
      else if (option.bottom > bounds.bottom) current.menu.scrollTop += option.bottom - bounds.bottom
    }
  }
  function choose(row) {
    if (!current || !row || row.getAttribute('aria-disabled') === 'true') return
    const {select} = current
    const index = Number(row.dataset.index)
    close()
    if (!field(select) || select.selectedIndex === index) return
    select.selectedIndex = index
    select.dispatchEvent(new Event('input', {bubbles:true}))
    select.dispatchEvent(new Event('change', {bubbles:true}))
  }
  function open(select) {
    close(false)
    leavingMenu?.remove()
    leavingMenu = null
    select.focus({preventScroll:true})
    const menu = document.createElement('div')
    menu.className = 'rp-field-menu'
    menu.id = 'roppo-field-menu-' + ++sequence
    menu.setAttribute('role', 'listbox')
    const labelledBy = select.getAttribute('aria-labelledby')
    if (labelledBy) menu.setAttribute('aria-labelledby', labelledBy)
    else {
      const labels = Array.from(select.labels || [], label => {
        const copy = label.cloneNode(true)
        copy.querySelectorAll('input,select,textarea,[aria-hidden=true]').forEach(node => node.remove())
        return copy.textContent.trim()
      })
      menu.setAttribute('aria-label', select.getAttribute('aria-label') || labels.join(' ') || select.name)
    }
    menu.setAttribute('popover', 'manual')
    let lastGroup
    let containerForOptions = menu
    const rows = []
    let selected
    for (const option of select.options) {
      const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null
      if (option.hidden || group?.hidden) continue
      if (group && group !== lastGroup) {
        containerForOptions = document.createElement('div')
        containerForOptions.setAttribute('role', 'group')
        containerForOptions.setAttribute('aria-label', group.label)
        const heading = document.createElement('div')
        heading.className = 'rp-field-group'
        heading.setAttribute('aria-hidden', 'true')
        heading.textContent = group.label
        containerForOptions.append(heading)
        menu.append(containerForOptions)
      } else if (!group) containerForOptions = menu
      lastGroup = group
      const row = document.createElement('div')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(option.selected))
      row.dataset.index = String(option.index)
      row.id = menu.id + '-' + option.index
      row.textContent = option.label
      if (option.disabled || group?.disabled) row.setAttribute('aria-disabled','true')
      else {
        rows.push(row)
        if (option.selected) selected = row
      }
      containerForOptions.append(row)
    }
    // Inherit local theme tokens even when the field is in a modal.
    const container = select.closest('dialog, .roppo-ui, .management-content') || document.body
    container.append(menu)
    if (menu.showPopover) menu.showPopover()
    const rect = select.getBoundingClientRect()
    const width = Math.min(Math.max(rect.width, menu.getBoundingClientRect().width), innerWidth - 16)
    const below = innerHeight - rect.bottom - 10
    const above = rect.top - 10
    const flip = below < Math.min(248, menu.scrollHeight) && above > below
    Object.assign(menu.style, {
      transformOrigin: flip ? 'bottom center' : 'top center',
      width: width + 'px', left: Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + 'px',
      maxHeight: Math.max(24, Math.min(320, flip ? above : below)) + 'px',
      top: flip ? 'auto' : (rect.bottom + 4) + 'px',
      bottom: flip ? (innerHeight - rect.top + 4) + 'px' : 'auto',
    })
    const observer = new MutationObserver(changes => {
      if (!select.isConnected || !field(select) || changes.some(change => select.contains(change.target))) close()
    })
    observer.observe(document.body, {childList:true,subtree:true})
    observer.observe(select, {childList:true, subtree:true, characterData:true, attributes:true,
      attributeFilter:['disabled','hidden','multiple','size','selected','label','value']})
    const folded = {opacity:0, transform:'translateY('+(flip ? 4 : -4)+'px) scale(.98)'}
    const opening = reducedMotion.matches ? null : menu.animate([folded,{opacity:1,transform:'none'}],
      {duration:170,easing:'cubic-bezier(.22,.72,.2,1)'})
    current = {select, menu, rows, observer, opening, folded, prefix:'', typedAt:0, active:null}
    select.setAttribute('aria-controls', menu.id)
    select.setAttribute('aria-expanded', 'true')
    highlight(selected || rows[0])
    menu.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse') e.preventDefault() })
    menu.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse') highlight(rows.includes(e.target) ? e.target : null, false)
    })
    menu.addEventListener('click', e => choose(e.target.closest('[role=option]')))
  }
  document.addEventListener('pointerdown', e => {
    if (current?.menu.contains(e.target)) return
    const select = field(e.target)
    if (select && e.button === 0) {
      e.preventDefault()
      if (current?.select === select) close()
      else open(select)
    } else close()
  }, true)
  // Suppress the native mouse picker as well as the pointer default.
  document.addEventListener('mousedown', e => { if (field(e.target) && e.button === 0) e.preventDefault() }, true)
  document.addEventListener('click', e => {
    const select = field(e.target)
    if (select) {
      e.preventDefault()
      if (e.detail === 0 && !current) open(select)
    }
  }, true)
  document.addEventListener('keydown', e => {
    const select = field(e.target)
    if (!select || e.ctrlKey || e.metaKey) return
    if (!current || current.select !== select) {
      if (['ArrowDown','ArrowUp','Enter',' ','F4'].includes(e.key)) {
        e.preventDefault()
        open(select)
      }
      return
    }
    const {rows, active} = current
    if (e.key === 'Tab') { close(); return }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
    if (['Enter',' '].includes(e.key)) { e.preventDefault(); choose(active); return }
    const index = rows.indexOf(active)
    const movement = {ArrowDown: index+1, ArrowUp:index-1, Home:0, End:rows.length-1}
    if (Object.hasOwn(movement, e.key)) {
      e.preventDefault()
      highlight(rows[Math.min(rows.length-1, Math.max(0, movement[e.key]))])
    } else if (e.key.length === 1 && !e.altKey) {
      e.preventDefault()
      const now = Date.now()
      current.prefix = (now-current.typedAt < 650 ? current.prefix : '') + e.key.toLocaleLowerCase()
      current.typedAt = now
      highlight(rows.find(row => row.textContent.toLocaleLowerCase().startsWith(current.prefix)))
    }
  }, true)
  document.addEventListener('focusin', e => { if (current && e.target !== current.select && !current.menu.contains(e.target)) close() })
  document.addEventListener('scroll', e => { if (current && !current.menu.contains(e.target)) close() }, true)
  window.addEventListener('resize', close)
})()
