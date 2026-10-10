// SVG charts drawn here (no library): light, sharp and in the brand colors.
// They all measure their own container (ResizeObserver) and take the available width and height.
//   BarChart    vertical bars stacked by series (e.g. events per day and per agent)
//   LineChart   series over time with crosshair and tooltip
//   Donut       share of each part in a total (e.g. results of the events)
//   Sparkline   minimal trend inside a KPI
//   BarList     horizontal ranking (e.g. consumption per agent)
//   StackedBar  a single bar, split into the parts (e.g. status of the tasks)
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '../i18n/index.js';

/** Measures the element (width and height) and follows size changes. */
export function useSize() {
  const ref = useRef(null);
  const [m, setM] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setM((a) => (Math.abs(a.width - r.width) < 1 && Math.abs(a.height - r.height) < 1 ? a : { width: Math.floor(r.width), height: Math.floor(r.height) }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, m];
}

export function niceStep(max, divisions = 4) {
  const raw = max / divisions;
  const p10 = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  for (const m of [1, 2, 5, 10]) if (m * p10 >= raw) return Math.max(1, m * p10);
  return 10 * p10;
}

function Tooltip({ x, y, width, title, rows }) {
  const left = x + 14 + 190 > width ? Math.max(0, x - 14 - 190) : x + 14;
  return (
    <div class="tooltip" style={{ left: `${left}px`, top: `${y}px` }} role="presentation">
      {title && <div class="tooltip-title">{title}</div>}
      {rows.map((l) => (
        <div class="tooltip-row" key={l.name}>{l.color && <i style={{ background: l.color }} />}{l.name}<b>{l.value}</b></div>
      ))}
    </div>
  );
}

export function Legend({ series }) {
  return (
    <div class="legend">
      {series.map((s) => <span key={s.key || s.name}><i style={{ background: s.color }} />{s.name}</span>)}
    </div>
  );
}

/**
 * Stacked vertical bars.
 * data: [{ key, label, title, values: { [series]: n } }] · series: [{ key, name, color }]
 */
export function BarChart({ data, series, ariaLabel, format = String, highlightLast }) {
  const [ref, { width: W, height: H }] = useSize();
  const [focus, setFocus] = useState(null);
  const m = { l: 30, r: 4, t: 8, b: 24 };
  const w = Math.max(0, W - m.l - m.r);
  const h = Math.max(0, H - m.t - m.b);
  const totals = data.map((d) => series.reduce((s, x) => s + (Number(d.values[x.key]) || 0), 0));
  const vmax = Math.max(1, ...totals);
  const step = niceStep(vmax);
  const top = Math.ceil(vmax / step) * step;
  const band = data.length ? w / data.length : 0;
  const bar = Math.min(38, band * 0.58);
  const y = (v) => m.t + (1 - v / top) * h;
  const grid = [];
  for (let v = 0; v <= top; v += step) grid.push(v);
  return (
    <div class="chart" ref={ref} onMouseLeave={() => setFocus(null)}>
      {W > 0 && H > 0 && (
        <svg width={W} height={H} role="img" aria-label={ariaLabel}>
          {grid.map((v) => (
            <g key={v}>
              <line class={v === 0 ? 'axis' : 'grid'} x1={m.l} x2={m.l + w} y1={y(v)} y2={y(v)} />
              <text x={m.l - 8} y={y(v) + 4} text-anchor="end">{v}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const x0 = m.l + i * band + (band - bar) / 2;
            let base = 0;
            const active = focus === i;
            return (
              <g key={d.key} onMouseEnter={() => setFocus(i)}>
                <rect x={m.l + i * band} y={m.t} width={band} height={h} fill={active ? '#141414' : 'transparent'} />
                {series.map((s) => {
                  const v = Number(d.values[s.key]) || 0;
                  if (!v) return null;
                  const y1 = y(base + v); const y0 = y(base);
                  base += v;
                  return <rect key={s.key} x={x0} y={y1} width={bar} height={Math.max(1, y0 - y1 - 1)} rx="2" fill={s.color} opacity={focus === null || active ? 1 : 0.55} />;
                })}
                <text x={m.l + i * band + band / 2} y={H - 6} text-anchor="middle" style={highlightLast && i === data.length - 1 ? { fill: 'var(--text)' } : undefined}>{d.label}</text>
              </g>
            );
          })}
        </svg>
      )}
      {focus !== null && data[focus] && (
        <Tooltip x={m.l + focus * band + band / 2} y={m.t} width={W} title={data[focus].title || data[focus].label}
          rows={[...series.filter((s) => Number(data[focus].values[s.key])).map((s) => ({ name: s.name, color: s.color, value: format(Number(data[focus].values[s.key])) })),
            { name: t('charts.total'), value: format(totals[focus]) }]} />
      )}
    </div>
  );
}

/**
 * Series over time. points: [{ t (ms), title, [series]: n }] · series: [{ key, name, color }]
 * xLabel(t) writes the axis marks; the series labels sit at the end of each line.
 */
export function LineChart({ points, series, ariaLabel, xLabel, format = String, rightMargin = 118 }) {
  const [ref, { width: W, height: H }] = useSize();
  const [focus, setFocus] = useState(null);
  if (!points.length) return <div class="chart" ref={ref} />;
  const m = { l: 34, r: rightMargin, t: 12, b: 26 };
  const w = Math.max(0, W - m.l - m.r);
  const h = Math.max(0, H - m.t - m.b);
  const t0 = points[0].t; const t1 = points[points.length - 1].t;
  const vmax = Math.max(1, ...points.flatMap((p) => series.map((s) => (Number.isFinite(p[s.key]) ? p[s.key] : 0))));
  const step = niceStep(vmax);
  const top = Math.ceil(vmax / step) * step;
  const x = (ms) => m.l + (t1 === t0 ? w / 2 : ((ms - t0) / (t1 - t0)) * w);
  const y = (v) => m.t + (1 - v / top) * h;
  const grid = [];
  for (let v = 0; v <= top; v += step) grid.push(v);
  // x axis marks without overlapping (min. 96 px); the last one always shows
  const marks = [];
  for (const p of points) if (!marks.length || x(p.t) - x(marks[marks.length - 1].t) >= 96) marks.push(p);
  const last = points[points.length - 1];
  if (marks[marks.length - 1] !== last) {
    if (marks.length > 1 && x(last.t) - x(marks[marks.length - 1].t) < 96) marks.pop();
    marks.push(last);
  }
  const labels = [];
  for (const s of series) {
    const valid = points.filter((p) => Number.isFinite(p[s.key]));
    if (!valid.length) continue;
    const u = valid[valid.length - 1];
    labels.push({ y: y(u[s.key]), text: `${s.name} ${format(u[s.key])}`, x: x(u.t) + 10, key: s.key });
  }
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 15) labels[i].y = labels[i - 1].y + 15;
  const move = (ev) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    let best = 0;
    for (let i = 0; i < points.length; i++) if (Math.abs(x(points[i].t) - mx) < Math.abs(x(points[best].t) - mx)) best = i;
    setFocus(best);
  };
  const pf = focus !== null ? points[focus] : null;
  return (
    <div class="chart" ref={ref}>
      {W > 0 && H > 0 && (
        <svg width={W} height={H} role="img" aria-label={ariaLabel} onMouseMove={move} onMouseLeave={() => setFocus(null)}>
          {grid.map((v) => (
            <g key={v}>
              <line class={v === 0 ? 'axis' : 'grid'} x1={m.l} x2={m.l + w} y1={y(v)} y2={y(v)} />
              <text x={m.l - 8} y={y(v) + 4} text-anchor="end">{v}</text>
            </g>
          ))}
          {marks.map((p, i) => (
            <text key={p.t} x={x(p.t)} y={H - 6} text-anchor={marks.length === 1 ? 'middle' : i === 0 ? 'start' : i === marks.length - 1 ? 'end' : 'middle'}>{xLabel(p.t)}</text>
          ))}
          {series.map((s) => {
            const valid = points.filter((p) => Number.isFinite(p[s.key]));
            return (
              <g key={s.key}>
                {valid.length > 1 && <path d={valid.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join('')}
                  fill="none" stroke={s.color} stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />}
                {valid.map((p) => <circle key={p.t} cx={x(p.t)} cy={y(p[s.key])} r={valid.length > 40 ? 0 : 3} fill={s.color} />)}
              </g>
            );
          })}
          {labels.map((r) => <text key={r.key} class="series-label" x={r.x} y={Math.min(H - m.b, r.y) + 4}>{r.text}</text>)}
          {pf && <line class="crosshair" x1={x(pf.t)} x2={x(pf.t)} y1={m.t} y2={m.t + h} />}
          {pf && series.map((s) => Number.isFinite(pf[s.key]) && <circle key={s.key} cx={x(pf.t)} cy={y(pf[s.key])} r="4.5" fill={s.color} stroke="var(--card)" stroke-width="2" />)}
          <rect x={m.l - 8} y="0" width={w + 16} height={H} fill="transparent" />
        </svg>
      )}
      {pf && <Tooltip x={x(pf.t)} y={m.t} width={W} title={pf.title} rows={series.map((s) => ({ name: s.name, color: s.color, value: Number.isFinite(pf[s.key]) ? format(pf[s.key]) : '—' }))} />}
    </div>
  );
}

/** Donut: slices [{ key, name, value, color }]; the center shows the total or the slice under the mouse. */
export function Donut({ slices, size = 150, thickness = 14, ariaLabel, center, sub }) {
  const [focus, setFocus] = useState(null);
  const total = slices.reduce((s, f) => s + (f.value || 0), 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const visible = slices.filter((f) => f.value > 0);
  const gap = visible.length > 1 ? 3 : 0;
  let accumulated = 0;
  const active = focus !== null ? slices.find((f) => f.key === focus) : null;
  return (
    <div class="ring" style={{ width: `${size}px`, height: `${size}px` }} onMouseLeave={() => setFocus(null)}>
      <svg width={size} height={size} role="img" aria-label={ariaLabel}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--card-3)" stroke-width={thickness} />
        {total > 0 && visible.map((f) => {
          const length = (f.value / total) * c;
          const el = (
            <circle key={f.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={f.color} stroke-width={focus === f.key ? thickness + 3 : thickness}
              stroke-dasharray={`${Math.max(0.5, length - gap)} ${c}`} stroke-dashoffset={-accumulated}
              transform={`rotate(-90 ${size / 2} ${size / 2})`} onMouseEnter={() => setFocus(f.key)} style={{ cursor: 'default' }} />
          );
          accumulated += length;
          return el;
        })}
      </svg>
      <div class="ring-center" style={{ pointerEvents: 'none' }}>
        <span class="ring-value large">{active ? active.value : center}</span>
        <span class="tiny muted">{active ? active.name : sub}</span>
      </div>
    </div>
  );
}

/** Minimal trend: thin bars (default) or a line. */
export function Sparkline({ values, width = 120, height = 32, color = 'var(--blue)', kind = 'bars', ariaLabel, highlightLast = true }) {
  const n = values.length;
  if (!n) return null;
  const max = Math.max(1, ...values);
  if (kind === 'line') {
    const x = (i) => (n === 1 ? width / 2 : (i / (n - 1)) * (width - 2) + 1);
    const y = (v) => height - 2 - (v / max) * (height - 4);
    return (
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        <path d={values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')} fill="none" stroke={color} stroke-width="1.5" stroke-linejoin="round" />
        <circle cx={x(n - 1)} cy={y(values[n - 1])} r="2.5" fill={color} />
      </svg>
    );
  }
  const band = width / n;
  const b = Math.max(1, band - 2);
  return (
    <svg width={width} height={height} role="img" aria-label={ariaLabel}>
      {values.map((v, i) => {
        const h = v ? Math.max(2, (v / max) * height) : 1;
        return <rect key={i} x={i * band} y={height - h} width={b} height={h} rx="1" fill={v ? color : 'var(--card-3)'} opacity={highlightLast && i !== n - 1 && v ? 0.5 : 1} />;
      })}
    </svg>
  );
}

/** Horizontal ranking: items [{ key, name (node), value (0-100), valueLabel, sub, color, ariaLabel }]. */
export function BarList({ items, max = 100 }) {
  return (
    <div class="bar-list">
      {items.map((it) => (
        <div class="bar-row" key={it.key}>
          <div class="bar-name">{it.name}</div>
          <div class="bar-value">{it.valueLabel}</div>
          <div class="bar-track" role="img" aria-label={it.ariaLabel}>
            <span style={{ width: `${Math.max(0, Math.min(100, (it.value / (max || 1)) * 100))}%`, background: it.color || 'var(--blue)' }} />
          </div>
          {it.sub && <div class="bar-sub">{it.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/** One bar split into the parts: [{ key, value, color, name }]. format(v) writes the value in each part's tooltip. */
export function StackedBar({ parts, ariaLabel, format }) {
  const total = parts.reduce((s, p) => s + (p.value || 0), 0);
  const part = (p) => `${p.name}: ${format ? format(p.value) : p.value} (${Math.round((p.value / total) * 100)}%)`;
  return (
    <div class="stacked-bar" role="img" aria-label={ariaLabel}>
      {total > 0 && parts.filter((p) => p.value > 0).map((p) => <span key={p.key} title={part(p)} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />)}
    </div>
  );
}

/** True once the element becomes visible for the first time (defer work off screen). */
export function useVisible(ref) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible || !ref.current) return undefined;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); } });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visible]);
  return visible;
}
