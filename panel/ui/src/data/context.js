// Panel context: state read from the server (GET /api/state), navigation between screens, the company selector and
// the Log filters.
//
// The screens, their groups and the address rules live in screens.js (re-exported here).
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

export const PanelContext = createContext(null);
export const usePanel = () => useContext(PanelContext);

export { GROUPS, SCREENS, OLD_SCREEN_IDS, parseHash } from './screens.js';

/** Filters of the Log: period, project, item (<project>/<number>) and event type. The company is the
 * selector at the top of the panel (companyFilter, #6), joined to these filters when the Log is read. */
export function newFilter() {
  return { period: 'all', since: '', until: '', project: '', item: '', type: '' };
}
