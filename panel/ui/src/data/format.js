// Dates, numbers and texts: always in the Sao Paulo time zone, on the server clock and in the active language
// (i18n/locale.js; Brazilian format today). The words around the numbers come from the dictionary.
import { LOCALE } from '../i18n/locale.js';
import { t, display } from '../i18n/index.js';

export const TZ = 'America/Sao_Paulo';

const dateFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
export const dayMonthFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, day: '2-digit', month: '2-digit' });
const timeFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export const hmFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const weekdayFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, weekday: 'long' });
const weekdayShortFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, weekday: 'short' });
// Technical formats (not shown): ISO day and the hour as a number.
const isoDayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourNumberFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const numberFormat = new Intl.NumberFormat(LOCALE);
const pctFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const compactFormat = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });

// "Now" is the server clock (it follows the fixed clock of the tests and the mock).
let clock = { generated: NaN, received: 0 };
export function syncClock(generatedAt) {
  clock = { generated: Date.parse(generatedAt), received: Date.now() };
}
export function now() {
  return Number.isFinite(clock.generated) ? clock.generated + (Date.now() - clock.received) : Date.now();
}

export function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const ms = typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms) : null;
}
export const date = (v) => { const d = toDate(v); return d ? dateFormat.format(d) : '—'; };
export const time = (v) => { const d = toDate(v); return d ? timeFormat.format(d) : '—'; };
export const hm = (v) => { const d = toDate(v); return d ? hmFormat.format(d) : '—'; };
export const dayMonth = (v) => { const d = toDate(v); return d ? dayMonthFormat.format(d) : '—'; };
export const dateTime = (v) => { const d = toDate(v); return d ? `${dateFormat.format(d)} ${hmFormat.format(d)}` : '—'; };
export const dateTimeSec = (v) => { const d = toDate(v); return d ? `${dateFormat.format(d)} ${timeFormat.format(d)}` : '—'; };
export const spDay = (v) => { const d = toDate(v); return d ? isoDayFormat.format(d) : ''; };
export const spHour = (v) => { const d = toDate(v); return d ? Number(hourNumberFormat.format(d)) % 24 : null; };
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export function weekday(v) {
  const d = toDate(v);
  return d ? capitalize(t('time.weekday', { name: weekdayFormat.format(d) })) : '';
}
export function weekdayShort(v) {
  const d = toDate(v);
  return d ? capitalize(t('time.weekdayShort', { name: weekdayShortFormat.format(d) })) : '';
}
export const dayHeading = (v) => t('time.dayHeading', { weekday: weekday(v), date: date(v) });

/** How long ago, from minutes: now, 5 min, 2 h 24 min, 3 d (texts in time.now and time.ago). */
export function elapsedText(min) {
  if (min === null || min === undefined || !Number.isFinite(Number(min))) return '—';
  const m = Math.max(0, Math.round(Number(min)));
  if (m < 1) return t('time.now');
  if (m < 60) return t('time.ago.minutes', { minutes: m });
  if (m < 48 * 60) {
    const hours = Math.floor(m / 60);
    const minutes = m % 60;
    return minutes ? t('time.ago.hoursMinutes', { hours, minutes }) : t('time.ago.hours', { hours });
  }
  return t('time.ago.days', { days: Math.floor(m / 1440) });
}
export function age(v) {
  const d = toDate(v);
  if (!d) return '—';
  return elapsedText((now() - d.getTime()) / 60000);
}
/** "42 s", "2 min 5 s", "1 h 02 min". */
export function duration(s) {
  if (s === null || s === undefined || !Number.isFinite(Number(s))) return null;
  const n = Math.round(Number(s));
  if (n < 60) return t('time.duration.seconds', { seconds: n });
  if (n < 3600) {
    const seconds = n % 60;
    const minutes = Math.floor(n / 60);
    return seconds ? t('time.duration.minutesSeconds', { minutes, seconds }) : t('time.duration.minutes', { minutes });
  }
  const hours = Math.floor(n / 3600);
  const minutes = String(Math.floor((n % 3600) / 60)).padStart(2, '0');
  return t('time.duration.hoursMinutes', { hours, minutes });
}
export const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? numberFormat.format(v) : '—');
export const compact = (v) => (typeof v === 'number' && Number.isFinite(v) ? compactFormat.format(v) : '—');
export const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${pctFormat.format(v)}%` : '—');

export const arr = (v) => (Array.isArray(v) ? v : []);
export const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
/** Only the items that are objects (a null in the middle of a state array does not bring the section down). */
export const objs = (v) => arr(v).filter((x) => obj(x));
/** Text to show for any API value: a server code ({code, ...params}) is translated by the dictionary. */
export const txt = display;
export function truncate(s, n) {
  const x = txt(s);
  return x.length > n ? `${x.slice(0, n - 1)}…` : x;
}
/** Lower case without accents, for searching. */
export function normalize(s) {
  return txt(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
export const timeMs = (v) => { const ms = Date.parse(v); return Number.isFinite(ms) ? ms : 0; };
