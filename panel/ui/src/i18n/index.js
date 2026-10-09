// Translation of every text the page shows (ADR 0004): the code holds keys, the dictionary holds the texts.
//
//   t('log.page', { page: 2, pages: 7 })        → "Página 2 de 7"
//   t('log.eventCount', { count: 1500 })        → "1.500 eventos" (plural chosen by `count`)
//   translateCode({ code: 'hook_stale', ... })  → the text of a server code ({code, ...params})
//   display(value)                              → a server code translated, anything else as text
//
// A dictionary entry is one of:
//   'text with {param}'                 parameters are replaced by their value (`count` goes out as a formatted number)
//   { one: '...', other: '...' }        plural, chosen by params.count with the language's plural rule
//   (params, helpers) => 'text'         when the text needs logic; helpers = { t, translateCode, display }
// A missing key comes back as the key itself, so nothing breaks and the gap is visible.
import { LOCALE } from './locale.js';
import ptBR, { pluralRule as ptBRPlural } from './pt-BR.js';

export { LOCALE };

// Each language: its texts and its plural rule (count → 'zero' | 'one' | 'two' | 'few' | 'many' | 'other').
const DICTIONARIES = { 'pt-BR': { texts: ptBR, plural: ptBRPlural } };
const { texts: dictionary, plural: pluralRule } = DICTIONARIES[LOCALE] || DICTIONARIES['pt-BR'];
const countFormat = new Intl.NumberFormat(LOCALE);

function lookup(key) {
  let node = dictionary;
  for (const part of String(key).split('.')) {
    if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

const isPlural = (v) => !!(v && typeof v === 'object' && typeof v.other === 'string');

/** Whether the dictionary has a text for the key. */
export function has(key) {
  const v = lookup(key);
  return typeof v === 'string' || typeof v === 'function' || isPlural(v);
}

function interpolate(text, params) {
  return text.replace(/\{(\w+)\}/g, (whole, name) => {
    if (!params || !(name in params)) return whole;
    const v = params[name];
    if (name === 'count' && typeof v === 'number') return countFormat.format(v);
    return v === null || v === undefined ? '' : String(v);
  });
}

/** Text of a key in the active language, with parameters. */
export function t(key, params = {}) {
  const entry = lookup(key);
  if (typeof entry === 'function') return entry(params, helpers);
  if (typeof entry === 'string') return interpolate(entry, params);
  if (isPlural(entry)) {
    const n = Number(params.count);
    const form = pluralRule(Number.isFinite(n) ? n : 0);
    return interpolate(typeof entry[form] === 'string' ? entry[form] : entry.other, params);
  }
  return String(key);
}

/** A server code: {code: 'hook_stale', ...params}. */
export const isCode = (v) => !!(v && typeof v === 'object' && !Array.isArray(v) && typeof v.code === 'string');

/** Text of a server code; an unknown code comes back as the code itself, and a non-code value as it is. */
export function translateCode(c) {
  if (!isCode(c)) return c;
  return has(`codes.${c.code}`) ? t(`codes.${c.code}`, c) : c.code;
}

/** What to show for an API value that may be a code: the translation, the text, or '' for nothing. */
export function display(v) {
  if (v === null || v === undefined) return '';
  if (isCode(v)) return translateCode(v);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(display).join(', ');
  if (typeof v === 'object') return Object.keys(v).map((k) => `${k}: ${display(v[k])}`).join(' · ');
  return String(v);
}

const helpers = { t, translateCode, display };
