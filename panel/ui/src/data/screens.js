// The panel's screens and its address (no Preact here, so the address rules can be checked without a browser).
//
// Menu rule: the panel is a single app. A new screen = an item in SCREENS (id and group; its menu name and title
// come from the dictionary, nav.<id> and screens.<id>) + its component in SCREEN_COMPONENTS (app/App.jsx) + its
// icon in ICONS (app/Sidebar.jsx). No separate page. The group decides in which menu block it appears (GROUPS,
// in menu order); the URL is #<id> and, if the screen has sub-tabs, #<id>/<sub> (the App hands the sub-tab in
// `subroute`). The page of an item has a fixed address, #items/<project>/<number>, which the Maestri portal opens.

export const GROUPS = [
  { id: 'workspace' },
];

export const SCREENS = [
  { id: 'overview', group: 'workspace' },
  { id: 'items', group: 'workspace' },
  { id: 'pending', group: 'workspace' },
  { id: 'log', group: 'workspace' },
  { id: 'agents', group: 'workspace' },
  { id: 'usage', group: 'workspace' },
];

// Addresses of before the screens were in English (#visao, #pendencias...): still open the right screen.
export const OLD_SCREEN_IDS = { visao: 'overview', pendencias: 'pending', agentes: 'agents', uso: 'usage' };

const OVERVIEW = { id: 'overview', sub: '' };

/** { id, sub } of an address (#<screen> or #<screen>/<sub-tab>); unknown or malformed addresses open the Overview. */
export function parseHash(hash) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(hash || '').replace(/^#/, ''));
  } catch (_) {
    return OVERVIEW; // bad percent-encoding (a link cut in half): the page still opens
  }
  const [raw, ...rest] = decoded.split('/');
  const id = OLD_SCREEN_IDS[raw] || raw;
  return SCREENS.some((a) => a.id === id) ? { id, sub: rest.join('/') } : { ...OVERVIEW };
}
