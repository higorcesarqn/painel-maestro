// Base components of the panel (the panel's visual identity). Every text goes in as a JSX child: Preact always
// writes text as text, never as HTML.
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../i18n/index.js';
import { Icon, ChevronRight, Info } from './Icon.jsx';

const cls = (...xs) => xs.filter(Boolean).join(' ');

let hintSeq = 0;
/**
 * (i) icon that explains something on mouse hover or keyboard focus (Esc closes). Use it to take explanatory
 * text out of the cards. text: string · children: rich content · title: first line.
 * The bubble is position: fixed, computed on the spot: neither a scrolling card nor the screen edge cuts it.
 * It is a focusable <span> (not a <button>) so it can live inside a clickable card; a click on it does not leak.
 */
export function InfoHint({ text, title, children, size = 14, label, class: className }) {
  const ref = useRef(null);
  const idRef = useRef(null);
  if (!idRef.current) idRef.current = `info-hint-${++hintSeq}`;
  const [pos, setPos] = useState(null);
  const open = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = 300;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, r.left + r.width / 2 - width / 2));
    // above when there is room; otherwise below
    setPos(r.top > 170 ? { left, bottom: window.innerHeight - r.top + 8 } : { left, top: r.bottom + 8 });
  };
  const close = () => setPos(null);
  useEffect(() => {
    if (!pos) return undefined;
    const esc = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', esc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);
  if (!text && !children) return null;
  return (
    <span ref={ref} class={cls('info-hint', pos && 'open', className)} tabindex="0" aria-label={label || t('common.moreInfo')}
      aria-describedby={pos ? idRef.current : undefined}
      onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}>
      <Icon of={Info} size={size} />
      {pos && (
        <span class="info-bubble" role="tooltip" id={idRef.current} style={{
          left: `${pos.left}px`, top: pos.top !== undefined ? `${pos.top}px` : undefined, bottom: pos.bottom !== undefined ? `${pos.bottom}px` : undefined,
        }}>
          {title && <span class="info-title">{title}</span>}
          {text}{children}
        </span>
      )}
    </span>
  );
}

/**
 * Brand card: #101010, 1px #242424 border, 14px radius.
 * label: title in upper case (.3em) · info: explanation in the (i) icon next to the title · extra: short text beside it
 * actions: buttons on the right · scroll: the body scrolls inside (so the card fits the screen height)
 * flush: body without side padding
 */
export function Card({ label, info, extra, actions, scroll, flush, class: className, bodyClass, children, onClick, labelId, ...rest }) {
  const Tag = onClick ? 'button' : 'section';
  return (
    <Tag class={cls('card', onClick && 'clickable', className)} onClick={onClick} type={onClick ? 'button' : undefined} {...rest}>
      {(label || actions || extra) && (
        <div class="card-head">
          {label && <h2 class="label" id={labelId}>{label}</h2>}
          {info && <InfoHint text={typeof info === 'string' ? info : undefined}>{typeof info === 'string' ? null : info}</InfoHint>}
          {extra && <span class="extra">{extra}</span>}
          {actions && <div class="actions">{actions}</div>}
        </div>
      )}
      <div class={cls('card-body', scroll && 'scroll', flush && 'flush', bodyClass)}>{children}</div>
    </Tag>
  );
}

/**
 * Big number (KPI). With onClick it becomes a button; blue stripe at the bottom when highlighted.
 * info: explanation in the (i) icon next to the label (prefer it to a long "detail": the label stays on one line).
 */
export function Kpi({ label, info, value, unit, detail, highlight, onClick, medium, children, class: className, ariaLabel }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag class={cls('card kpi', onClick && 'clickable', highlight && 'highlight', className)} onClick={onClick} type={onClick ? 'button' : undefined} aria-label={ariaLabel}>
      <span class="label-row">
        <span class="label" title={typeof label === 'string' ? label : undefined}>{label}</span>
        {info && <InfoHint text={typeof info === 'string' ? info : undefined}>{typeof info === 'string' ? null : info}</InfoHint>}
      </span>
      <div class="kpi-row">
        <span class={cls('value', medium && 'medium')}>{value}{unit && <small>{unit}</small>}</span>
        {children}
      </div>
      {detail && <span class="detail">{detail}</span>}
      {highlight && <span class="stripe" aria-hidden="true" />}
    </Tag>
  );
}

/** Badge. tone: neutral | blue | ok | warning | danger | test · filled: filled background. */
export function Badge({ tone = 'neutral', filled, mono, title, children, class: className }) {
  return <span class={cls('badge', tone !== 'neutral' && tone, filled && 'filled', mono && 'mono', className)} title={title}>{children}</span>;
}

export function Dot({ color, size = 8, title }) {
  return <span class="dot" style={{ background: color || undefined, width: `${size}px`, height: `${size}px` }} title={title} aria-hidden="true" />;
}

export function Swatch({ color, title }) {
  return <span class="swatch" style={color ? { background: color } : undefined} title={title} aria-hidden="true" />;
}

const toneOf = (v, limits) => (v >= limits[1] ? 'danger' : v >= limits[0] ? 'warning' : null);

/** Thin bar from 0 to 100 (blue; amber from 70, red from 90). */
export function Meter({ value, label, limits = [70, 90], color }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div class={cls('meter', !color && toneOf(v, limits))} role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow={String(v)} aria-label={label}>
      <span style={{ width: `${v}%`, background: color || undefined }} />
    </div>
  );
}

/** Ring from 0 to 100 (circular meter), with the text in the center. */
export function Ring({ value, size = 92, thickness = 6, label, center, sub, large, limits = [70, 90] }) {
  const has = typeof value === 'number' && Number.isFinite(value);
  const v = has ? Math.max(0, Math.min(100, value)) : 0;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const tone = toneOf(v, limits);
  const color = tone === 'danger' ? 'var(--danger)' : tone === 'warning' ? 'var(--warning)' : 'var(--blue)';
  return (
    <div class="ring" style={{ width: `${size}px`, height: `${size}px` }} role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow={has ? String(v) : undefined} aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--card-3)" stroke-width={thickness} />
        {has && v > 0 && (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} stroke-width={thickness} stroke-linecap="round"
            stroke-dasharray={`${(v / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        )}
      </svg>
      <div class="ring-center">
        <span class={cls('ring-value', large && 'large')}>{center}</span>
        {sub && <span class="tiny muted">{sub}</span>}
      </div>
    </div>
  );
}

/** Segmented buttons (single choice). options: [{ id, name, n }] */
export function Segmented({ options, value, onChange, label }) {
  return (
    <div class="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={o.id} aria-pressed={value === o.id ? 'true' : 'false'} onClick={() => onChange(o.id)}>
          {o.name}{o.n !== undefined && <span class="n">{o.n}</span>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, center, children }) {
  return <div class={cls('empty', center && 'center')}>{icon && <Icon of={icon} size={22} />}{children}</div>;
}

// <details> that remembers whether the user opened or closed it (survives the refreshes and screen changes).
const remembered = new Map();
export function Collapsible({ storeKey, summary, open = false, children, class: className }) {
  const [openNow, setOpen] = useState(remembered.has(storeKey) ? remembered.get(storeKey) : open);
  return (
    <details class={cls('collapsible', className)} open={openNow}
      onToggle={(e) => { const v = e.currentTarget.open; remembered.set(storeKey, v); setOpen(v); }}>
      <summary><Icon of={ChevronRight} size={14} class="arrow" />{summary}</summary>
      {openNow && children}
    </details>
  );
}

export function Skeleton({ width = '100%', height = 14, style }) {
  return <span class="skeleton" style={{ display: 'block', width: typeof width === 'number' ? `${width}px` : width, height: `${height}px`, ...style }} aria-hidden="true" />;
}
