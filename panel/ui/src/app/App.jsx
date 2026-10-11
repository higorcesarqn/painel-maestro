// Panel shell: reads /api/state every 20 s, keeps the current screen in the URL (#overview, #log...),
// the Log filters and the pending decision to open when the Overview sends the person there. Only the visible
// screen is drawn. When a state read says the page changed on disk (version.page, #37), a fixed strip asks for a
// reload, which is only ever the person's click. The tab's title and favicon show the open pending decisions of every
// organization (#43, data/tab.js), from each state read, on any screen. With the bell on (#45, data/notification.js),
// a pending decision that opened while the tab was hidden becomes a browser notification; the shell is the only one
// touching the Notification API.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { PanelContext, screenAt, parseHash, newFilter } from '../data/context.js';
import { REFRESH_MS, MOCK, readState, recalculateUsage, readLog } from '../data/api.js';
import { syncClock, time, txt, obj } from '../data/format.js';
import { logParams } from '../data/queries.js';
import { pageOutdated } from '../data/page.js';
import { openPending, documentTitle, faviconHref } from '../data/tab.js';
import { pendingNotice, openList, bellState, noticeContent, loadWanted, saveWanted } from '../data/notification.js';
import { useOrganizations } from '../data/organizations.js';
import { t, LOCALE } from '../i18n/index.js';
import { Sidebar } from './Sidebar.jsx';
import { Header } from './Header.jsx';
import { Overview } from '../screens/Overview.jsx';
import { Items } from '../screens/Items.jsx';
import { PendingDecisions } from '../screens/PendingDecisions.jsx';
import { Log } from '../screens/Log.jsx';
import { Agents } from '../screens/Agents.jsx';
import { Usage } from '../screens/Usage.jsx';
import { Settings } from '../screens/Settings.jsx';
import { Icon, TriangleAlert, Info, RefreshCw } from '../components/Icon.jsx';

// One screen per item of SCREENS (data/screens.js). A new screen goes here and there.
const SCREEN_COMPONENTS = { overview: Overview, items: Items, pending: PendingDecisions, log: Log, agents: Agents, usage: Usage, settings: Settings };
// URL: #<screen> or #<screen>/<sub-tab> (data/screens.js); a malformed address opens the Overview, and an old one (#organizations)
// is written back as the address of today (#settings/organizations).
const hashParts = () => parseHash(location.hash);
const screenFromHash = () => hashParts().id;
const hashOf = (id, sub) => `#${id}${sub ? `/${sub}` : ''}`;
// Writes the address of a screen without a new history entry (and without a hashchange) when it is not the current one.
const writeHash = (id, sub) => { if (location.hash !== hashOf(id, sub)) history.replaceState(null, '', hashOf(id, sub)); };
// The browser's Notification API: absent in some embedded browsers (the Maestri portal, probably), and then no bell.
const NOTIFICATIONS = typeof window !== 'undefined' && 'Notification' in window;

export function App() {
  const [state, setState] = useState(null);
  const [connectionError, setConnectionError] = useState(null);
  const [failingSince, setFailingSince] = useState(null);
  const [screen, setScreen] = useState(screenFromHash);
  const [subroute, setSubroute] = useState(() => hashParts().sub);
  const [actionStatus, setActionStatus] = useState('');
  const [recalculating, setRecalculating] = useState(false);
  const [pendingTarget, setPendingTarget] = useState(null);
  const screenRef = useRef(screen);
  screenRef.current = screen;

  // ---------- reading the state ----------
  const reading = useRef(false);
  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const st = await readState();
      if (st && typeof st === 'object') {
        syncClock(st.generated_at);
        setState(st);
      }
      setConnectionError(null);
      setFailingSince(null);
    } catch (e) {
      setConnectionError(e);
      setFailingSince((f) => f || Date.now());
    } finally {
      reading.current = false;
    }
    if (screenRef.current === 'log') loadLogRef.current(true);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    const visibility = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, []);

  // ---------- navigation ----------
  // goTo('log') changes the screen; goTo('<screen>', '<sub-tab>') opens the screen already on the sub-tab (goTo('settings'):
  // its default sub-tab).
  const goTo = useCallback((id, sub = '') => {
    const p = screenAt(id, sub);
    setScreen(p.id);
    setSubroute(p.sub);
    writeHash(p.id, p.sub);
  }, []);
  useEffect(() => {
    const h = () => {
      const p = hashParts();
      setScreen(p.id);
      setSubroute(p.sub);
      writeHash(p.id, p.sub);
    };
    window.addEventListener('hashchange', h);
    writeHash(screen, subroute);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  // ---------- browser tab (#43): "(n) " in the title and a dot in the favicon ----------
  const pending = openPending(state);
  const pendingTotal = pending ? pending.total : 0;
  const pendingTone = pending ? pending.tone : null;
  useEffect(() => {
    document.title = documentTitle(screen, pendingTotal);
  }, [screen, pendingTotal]);
  useEffect(() => {
    const link = document.querySelector('link[rel="icon"]');
    if (link) link.href = faviconHref(pendingTone);
  }, [pendingTone]);

  // ---------- organization selector (#6) ----------
  const organizationSelector = useOrganizations();
  const { organization, organizationFilter } = organizationSelector;

  // ---------- Log: filters, page and reading (the organization comes from the selector) ----------
  const [filters, setRawFilters] = useState(newFilter);
  const [page, setPage] = useState(1);
  const [log, setLog] = useState({ answer: null, error: null, loading: false });
  const logSeq = useRef(0);
  const filtersRef = useRef(filters); filtersRef.current = filters;
  const pageRef = useRef(page); pageRef.current = page;
  const organizationFilterRef = useRef(organizationFilter); organizationFilterRef.current = organizationFilter;
  const loadLog = useCallback(async (silent) => {
    const seq = ++logSeq.current;
    if (!silent) setLog((l) => ({ ...l, loading: true }));
    try {
      const r = await readLog(logParams({ ...filtersRef.current, ...organizationFilterRef.current }, pageRef.current));
      if (seq !== logSeq.current) return;
      const pages = r.pages || Math.max(1, Math.ceil((r.total || 0) / (r.per_page || 50)));
      // the page may be gone (fewer events with the filter): back to the last one that exists
      if (pageRef.current > pages && (r.total || 0) > 0) { setPage(pages); return; }
      setLog({ answer: r, error: null, loading: false });
    } catch (e) {
      if (seq !== logSeq.current) return;
      setLog((l) => ({ ...l, error: e, loading: false }));
    }
  }, []);
  const loadLogRef = useRef(loadLog);
  useEffect(() => { if (screen === 'log' || log.answer) loadLog(false); }, [filters, page, organizationFilter]);
  // Another organization: the project and item of the Log may belong to the previous one, so they go, and back to page 1.
  const previousOrganization = useRef(organization);
  useEffect(() => {
    if (previousOrganization.current === organization) return;
    previousOrganization.current = organization;
    setRawFilters((f) => (f.project || f.item ? { ...f, project: '', item: '' } : f));
    setPage(1);
  }, [organization]);
  useEffect(() => { if (screen === 'log' && !log.answer) loadLog(false); }, [screen]);
  const setFilters = useCallback((change) => {
    setRawFilters((f) => (typeof change === 'function' ? change(f) : { ...f, ...change }));
    setPage(1);
  }, []);

  // ---------- actions ----------
  const recalculate = useCallback(async () => {
    setRecalculating(true);
    setActionStatus('');
    try {
      const st = await recalculateUsage();
      syncClock(st.generated_at);
      setState(st);
      setConnectionError(null); setFailingSince(null);
      const r = obj(st.recalculation);
      setActionStatus(r && r.ok === false
        ? t('app.collectorFailed', { error: txt(r.error) })
        : MOCK ? t('app.recalculatedMock', { time: time(st.generated_at) }) : t('app.recalculated', { time: time(st.generated_at) }));
      if (screenRef.current === 'log') loadLog(true);
    } catch (e) {
      setActionStatus(t('app.recalculateFailed', { message: e.message }));
    } finally {
      setRecalculating(false);
    }
  }, []);

  const goToPendingDecision = useCallback((id) => {
    goTo('pending');
    setPendingTarget({ id, at: Date.now() });
  }, []);

  // ---------- browser notification (#45): the bell and a notification for a new pending decision ----------
  // Every state read asks the rule with the ids of the previous one (none on the first read, which never notifies) and
  // whether the tab is in sight; the notification only goes out with the bell on. The permission is only ever asked by
  // the bell's click, never in the demo.
  const [wanted, setWanted] = useState(loadWanted);
  const [permission, setPermission] = useState(() => (NOTIFICATIONS ? Notification.permission : 'default'));
  const bell = bellState({ supported: NOTIFICATIONS, mock: MOCK, permission, wanted });
  const bellRef = useRef(bell);
  bellRef.current = bell;
  const previousIds = useRef(null);
  useEffect(() => {
    const open = openList(state);
    if (!open) return;
    const notice = pendingNotice(previousIds.current, open, document.visibilityState === 'visible');
    previousIds.current = open.map((p) => p.id);
    if (!NOTIFICATIONS) return;
    setPermission(Notification.permission); // the owner may have changed it in the browser's settings
    if (!notice || bellRef.current !== 'on' || Notification.permission !== 'granted') return;
    const content = noticeContent(notice);
    try {
      const n = new Notification(content.title, { body: content.body, tag: content.tag, lang: LOCALE });
      n.onclick = () => {
        window.focus();
        if (content.target) goToPendingDecision(content.target);
        else goTo('pending');
        n.close();
      };
    } catch (_) { /* a browser that only notifies from a service worker: the tab's title and favicon still say it */ }
  }, [state]);
  const toggleBell = useCallback(async () => {
    if (!NOTIFICATIONS || MOCK) return;
    if (bellRef.current === 'on') {
      setWanted(false);
      saveWanted(false);
      return;
    }
    let answer = Notification.permission;
    if (answer !== 'granted') {
      try { answer = (await Notification.requestPermission()) || Notification.permission; } catch (_) { answer = Notification.permission; }
    }
    setPermission(answer);
    if (answer === 'granted') {
      setWanted(true);
      saveWanted(true);
    }
  }, []);

  const ctx = {
    ...organizationSelector,
    state, connectionError, failingSince, screen, goTo, actionStatus, setActionStatus, recalculating, recalculate,
    goToPendingDecision, pendingTarget, bell, toggleBell,
    filters, setFilters, setRawFilters, page, setPage, log, loadLog,
    subroute,
  };

  const Screen = SCREEN_COMPONENTS[screen] || Overview;
  return (
    <PanelContext.Provider value={ctx}>
      <div class="app">
        <Sidebar />
        <div class="main">
          <Header />
          <div class="banners">
            {pageOutdated(state) && (
              <div class="banner update" role="status"><Icon of={RefreshCw} />
                <span>{t('app.pageOutdated')}</span>
                <button type="button" class="button primary small" onClick={() => location.reload()}>{t('app.reload')}</button>
              </div>
            )}
            {MOCK && (
              <div class="banner mock"><Icon of={Info} />{t('app.mockBanner')}</div>
            )}
            {connectionError && (
              <div class="banner error" role="alert"><Icon of={TriangleAlert} />
                {state
                  ? t('app.connectionErrorWithData', { message: connectionError.message })
                  : t('app.connectionError', { message: connectionError.message })}
              </div>
            )}
          </div>
          <main class="content" id="main-panel" role="tabpanel" aria-labelledby={`tab-${screen}`}>
            <Screen />
          </main>
        </div>
      </div>
    </PanelContext.Provider>
  );
}
