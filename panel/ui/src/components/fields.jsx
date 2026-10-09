// Form fields in the brand style (Log filters and the like).
import { Icon, Search, ChevronDown } from './Icon.jsx';

export function Field({ label, children, hidden }) {
  return (
    <label class="field" hidden={hidden}>
      <span class="label">{label}</span>
      {children}
    </label>
  );
}

/** options: [[value, name]] */
export function Select({ value, options, onChange, ariaLabel, width }) {
  return (
    <span class="select-box" style={width ? { width: `${width}px` } : undefined}>
      <select class="select" value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.currentTarget.value)}>
        {options.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
      </select>
      <Icon of={ChevronDown} size={14} class="select-arrow" />
    </span>
  );
}

export function SearchBox({ value, onChange, placeholder, ariaLabel, width }) {
  return (
    <span class="search">
      <Icon of={Search} size={15} />
      <input type="search" value={value} placeholder={placeholder} aria-label={ariaLabel} style={width ? { width: `${width}px` } : undefined}
        onInput={(e) => onChange(e.currentTarget.value)} />
    </span>
  );
}

export function DateField({ value, onChange, ariaLabel }) {
  return (
    <span class="date">
      <input type="date" value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.currentTarget.value)} />
    </span>
  );
}

export function Toggle({ checked, onChange, children }) {
  return (
    <label class="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span class="track" aria-hidden="true" />
      {children}
    </label>
  );
}
