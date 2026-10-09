// Modal window (dialog): focus trapped inside, Esc closes (onClose), click outside closes, gives the focus back on exit.
import { useEffect, useRef } from 'preact/hooks';

export function Modal({ onClose, labelId, children, width }) {
  const box = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement;
    if (box.current) box.current.focus();
    const key = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close.current(); return; }
      if (ev.key !== 'Tab' || !box.current) return;
      const focusable = [...box.current.querySelectorAll('button:not([disabled]), a[href], [tabindex="0"], summary, input, select')]
        .filter((x) => x.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (ev.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { last.focus(); ev.preventDefault(); }
      else if (!ev.shiftKey && document.activeElement === last) { first.focus(); ev.preventDefault(); }
    };
    document.addEventListener('keydown', key);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = '';
      if (before && document.contains(before) && typeof before.focus === 'function') before.focus();
    };
  }, []);
  return (
    <div class="modal-backdrop" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) close.current(); }}>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby={labelId} tabindex="-1" ref={box}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        {children}
      </div>
    </div>
  );
}

/** Floating panel tied to a header button (marked with data-opens-popover); closes with Esc or a click outside. */
export function Popover({ onClose, children, right = 0, id, role }) {
  const box = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const outside = (ev) => {
      if (box.current && !box.current.contains(ev.target) && !(ev.target.closest && ev.target.closest('[data-opens-popover]'))) close.current();
    };
    const key = (ev) => { if (ev.key === 'Escape') close.current(); };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key); };
  }, []);
  return <div class="popover" id={id} role={role} ref={box} style={{ right: `${right}px` }}>{children}</div>;
}
