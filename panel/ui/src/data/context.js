// Panel context: state read from the server, navigation between screens, Log filters and the event modal.
//
// Menu rule: the panel is a single app. A new screen = an item in SCREENS (id and group; its menu name and title
// come from the dictionary, nav.<id> and screens.<id>) + its component in SCREEN_COMPONENTS (app/App.jsx) + its
// icon in ICONS (app/Sidebar.jsx). No separate page. The group decides in which menu block it appears (GROUPS,
// in menu order); the URL is #<id> and, if the screen has sub-tabs, #<id>/<sub> (the App hands the sub-tab in
// `subroute`). The page of an item has a fixed address, #items/<project>/<number>, which the Maestri portal opens.
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

export const PanelContext = createContext(null);
export const usePanel = () => useContext(PanelContext);

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

/** Filters of the Log (new model): period and company, project, item (<project>/<number>) and event type. */
export function newFilter() {
  return { period: 'all', since: '', until: '', company: '', project: '', item: '', type: '' };
}
