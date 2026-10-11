// The browser tab (#43): the title and the favicon show the open pending decisions without asking any permission.
// The count is kpis.pending_decisions.total of GET /api/state: every organization, whatever the top selector says,
// the same number as the menu counter (Sidebar). A critical one (by_severity) turns the tone strong, like there.
// Pure functions: the shell (App) is the one that writes document.title and swaps the <link rel="icon">.
import { obj } from './format.js';
import { t } from '../i18n/index.js';

/** Open pending decisions of the state: { total, tone: 'blue' | 'strong' }, or null when there is none. */
export function openPending(state) {
  const kp = (state && obj(state.kpis) && obj(state.kpis.pending_decisions)) || {};
  const total = Number(kp.total) || 0;
  if (total <= 0) return null;
  const bySeverity = obj(kp.by_severity) || {};
  return { total, tone: bySeverity.critical ? 'strong' : 'blue' };
}

/** "(n) {screen} · {panel}" with n > 0 open pending decisions, "{screen} · {panel}" without. */
export function documentTitle(screen, count) {
  const params = { screen: t(`nav.${screen}`), panel: t('app.panel') };
  return count > 0 ? t('app.documentTitlePending', { ...params, count }) : t('app.documentTitle', params);
}

// The icon: the inbox of the pending decisions screen (lucide "inbox"), light on the panel's black; the dot goes on its
// corner, with a black ring to stand apart from the drawing. Colors of base.css: --text, --blue-text (the brand's dot)
// and --danger (the strong counter). The CSP accepts img-src data:, so nothing is a file.
const DOT = { blue: '#4F6BFF', strong: '#F2555A' };
const icon = (dot) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
  + '<rect width="32" height="32" rx="7" fill="#000"/>'
  + '<g transform="translate(4 4)" fill="none" stroke="#F5F5F5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
  + '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>'
  + '<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'
  + '</g>'
  + (dot ? `<circle cx="25" cy="7" r="7" fill="#000"/><circle cx="25" cy="7" r="5.2" fill="${dot}"/>` : '')
  + '</svg>';
const dataUri = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
const NO_DOT = dataUri(icon(null));
const FAVICONS = { blue: dataUri(icon(DOT.blue)), strong: dataUri(icon(DOT.strong)) };

/** The favicon as a data: URI: no dot (tone null), blue dot or strong dot. */
export function faviconHref(tone) {
  return FAVICONS[tone] || NO_DOT;
}
