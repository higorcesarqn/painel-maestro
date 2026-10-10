// The page id (#37): the build (scripts/publish.js) writes a hash of the bundle into <meta name="page-id">, and
// GET /api/state brings the id of the current index.html as version.page. Another id there means the page changed on
// disk after this tab loaded it: the shell shows the "reload" strip. The demo (?mock=1) never compares, and neither
// does a page without an id (npm run dev).
import { MOCK } from './api.js';
import { obj } from './format.js';

const meta = document.querySelector('meta[name="page-id"]');
export const PAGE_ID = (meta && meta.getAttribute('content')) || null;

/** True when the state's version.page is another page than this tab's (both ids known); never in the demo. */
export function pageOutdated(state) {
  if (MOCK || !PAGE_ID) return false;
  const v = obj(state && state.version);
  const page = v && typeof v.page === 'string' ? v.page : '';
  return page !== '' && page !== PAGE_ID;
}
