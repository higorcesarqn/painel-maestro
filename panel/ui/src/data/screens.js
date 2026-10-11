// The panel's screens and its address (no Preact here, so the address rules can be checked without a browser).
//
// Menu rule: the panel is a single app. A new screen = an item in SCREENS (id and group; its menu name and title
// come from the dictionary, nav.<id> and screens.<id>) + its component in SCREEN_COMPONENTS (app/App.jsx) + for a
// work screen, its icon in ICONS (app/Sidebar.jsx). No separate page. The group decides in which menu block it appears (GROUPS,
// in menu order); the URL is #<id> and, if the screen has sub-tabs, #<id>/<sub> (the App hands the sub-tab in
// `subroute`). The page of an item has a fixed address, #items/<project>/<number>, which the Maestri portal opens.
//
// A group with `footer` is out of the work blocks and out of the arrows: Settings (#48), the gear on the menu's
// footer. A screen with `subs` has fixed sub-tabs, the first being the default one (#settings is #settings/organizations).

export const GROUPS = [
  { id: 'workspace' },
  { id: 'settings', footer: true },
];

export const SCREENS = [
  { id: 'overview', group: 'workspace' },
  { id: 'items', group: 'workspace' },
  { id: 'pending', group: 'workspace' },
  { id: 'log', group: 'workspace' },
  { id: 'agents', group: 'workspace' },
  { id: 'usage', group: 'workspace' },
  { id: 'settings', group: 'settings', subs: ['organizations'] },
];

/** The work blocks of the menu, in menu order (the footer groups are drawn apart). */
export const WORK_GROUPS = GROUPS.filter((g) => !g.footer);

/** The screens the menu's arrows go through, in menu order: the work blocks, without Settings. */
export const ARROW_SCREENS = WORK_GROUPS.flatMap((g) => SCREENS.filter((a) => a.group === g.id).map((a) => a.id));

// Addresses of before: the screens in Portuguese (#visao, #pendencias...) and the Organizations screen, now a sub-tab of
// Settings (#48). Each still opens the right place.
export const OLD_ADDRESSES = { visao: 'overview', pendencias: 'pending', agentes: 'agents', uso: 'usage', organizations: 'settings/organizations' };

const OVERVIEW = { id: 'overview', sub: '' };

/** { id, sub } of a screen and sub-tab: an unknown screen is the Overview; a screen with fixed sub-tabs gets the default one
 * when the sub-tab is not one of them. */
export function screenAt(id, sub = '') {
  const screen = SCREENS.find((a) => a.id === id);
  if (!screen) return { ...OVERVIEW };
  const s = String(sub || '');
  if (screen.subs) return { id, sub: screen.subs.includes(s) ? s : screen.subs[0] };
  return { id, sub: s };
}

/** { id, sub } of an address (#<screen> or #<screen>/<sub-tab>); unknown or malformed addresses open the Overview. */
export function parseHash(hash) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(hash || '').replace(/^#/, ''));
  } catch (_) {
    return { ...OVERVIEW }; // bad percent-encoding (a link cut in half): the page still opens
  }
  const [raw, ...rest] = decoded.split('/');
  const [id, ...sub] = (OLD_ADDRESSES[raw] || raw).split('/');
  return screenAt(id, [...sub, ...rest].join('/'));
}
