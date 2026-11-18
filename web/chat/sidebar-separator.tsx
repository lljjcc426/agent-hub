import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';

type Pane = 'navigation' | 'agents' | 'panel';
type Props = {
  pane: Pane;
  controls: string;
  label: string;
  expandNavigation?: () => void;
};

/** Resize the existing track, so the handle itself never consumes layout space. */
export function SidebarSeparator({ pane, controls, label, expandNavigation }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number; moved: boolean } | null>(null);
  const property = '--' + pane + '-size';
  const key = 'roppo.layout.' + pane + '.width';

  useLayoutEffect(() => {
    const handle = ref.current!;
    const sidebar = handle.parentElement!;
    const shell = handle.closest<HTMLElement>('.chat-shell')!;
    const region = pane === 'panel' ? sidebar.parentElement! : shell;
    try {
      const saved = Number(localStorage.getItem(key));
      if (Number.isFinite(saved) && saved > 0) shell.style.setProperty(property, saved + 'px');
    } catch {}
    const measure = () => {
      const width = Math.round(sidebar.getBoundingClientRect().width);
      if (!region.clientWidth) return;
      handle.setAttribute('aria-valuenow', String(Math.round(100 * width / region.clientWidth)));
      handle.setAttribute('aria-valuetext', width + ' px');
    };
    const observer = new ResizeObserver(measure);
    observer.observe(sidebar);
    observer.observe(region);
    measure();
    return () => {
      observer.disconnect();
      if (drag.current) delete shell.dataset.resizing;
      drag.current = null;
    };
  }, [key, pane, property]);

  function resize(width: number) {
    const shell = ref.current!.closest<HTMLElement>('.chat-shell')!;
    if (pane === 'navigation' && !shell.classList.contains('functions-expanded')) {
      if (width < 76) return;
      expandNavigation?.();
    }
    shell.style.setProperty(property, Math.max(0, width) + 'px');
  }

  function save() {
    const handle = ref.current!;
    const shell = handle.closest<HTMLElement>('.chat-shell')!;
    if (pane === 'navigation' && !shell.classList.contains('functions-expanded')) return;
    // Save the rendered width after CSS has reserved space for the conversation.
    if (!handle.getClientRects().length) return;
    const width = Math.round(handle.parentElement!.getBoundingClientRect().width);
    if (!width) return;
    shell.style.setProperty(property, width + 'px');
    try { localStorage.setItem(key, String(width)); } catch {}
  }

  function begin(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || drag.current) return;
    const handle = event.currentTarget;
    const shell = handle.closest<HTMLElement>('.chat-shell')!;
    if (shell.dataset.resizing) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    shell.dataset.resizing = pane;
    drag.current = { pointer: event.pointerId, x: event.clientX, width: handle.parentElement!.getBoundingClientRect().width, moved: false };
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (start?.pointer !== event.pointerId) return;
    const delta = event.clientX - start.x;
    if (!start.moved && Math.abs(delta) < 2) return;
    start.moved = true;
    resize(start.width + (pane === 'panel' ? -delta : delta));
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (start?.pointer !== event.pointerId) return;
    drag.current = null;
    if (start.moved) save();
    delete event.currentTarget.closest<HTMLElement>('.chat-shell')!.dataset.resizing;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    const width = event.currentTarget.parentElement!.getBoundingClientRect().width;
    const step = pane === 'panel' ? -16 : 16;
    const next = { ArrowLeft: width - step, ArrowRight: width + step, Home: 0, End: innerWidth }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    resize(next);
    // Expanding the icon rail also changes React state before the next paint.
    requestAnimationFrame(() => { if (ref.current) save(); });
  }

  return <div ref={ref} className="sidebar-separator" role="separator" tabIndex={0}
    aria-label={label} aria-controls={controls} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={100}
    onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}
    onLostPointerCapture={finish} onKeyDown={keyboard} />;
}
