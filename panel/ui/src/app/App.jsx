// Panel shell: reads /api/state every 20 s, keeps the current screen in the URL (#overview, #log...),
// the Log filters and the pending decision to open when the Overview sends the person there. Only the visible
// screen is drawn.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { PanelContext, SCREENS, parseHash, newFilter } from '../data/context.js';
import { REFRESH_MS, MOCK, readState, recalculateUsage, readLog } from '../data/api.js';
import { syncClock, time, txt, obj } from '../data/format.js';
import { logParams } from '../data/queries.js';
import { useCompanies } from '../data/companies.js';
import { t } from '../i18n/index.js';
import { Sidebar } from './Sidebar.jsx';
import { Header } from './Header.jsx';
import { Overview } from '../screens/Overview.jsx';
import { Items } from '../screens/Items.jsx';
import { PendingDecisions } from '../screens/PendingDecisions.jsx';
import { Log } from '../screens/Log.jsx';
import { Agents } from '../screens/Agents.jsx';
import { Usage } from '../screens/Usage.jsx';
import { Companies } from '../screens/Companies.jsx';
import { Icon, TriangleAlert, Info } from '../components/Icon.jsx';

// One screen per item of SCREENS (data/screens.js). A new screen goes here and there.
const SCREEN_COMPONENTS = { overview: Overview, items: Items, pending: PendingDecisions, log: Log, agents: Agents, usage: Usage, companies: Companies };
// URL: #<screen> or #<screen>/<sub-tab> (data/screens.js); a malformed address opens the Overview.
const hashParts = () => parseHash(location.hash);
const screenFromHash = () => hashParts().id;
const hashOf = (id, sub) => `#${id}${sub ? `/${sub}` : ''}`;

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
  // goTo('log') changes the screen; goTo('<screen>', '<sub-tab>') opens the screen already on the sub-tab.
  const goTo = useCallback((id, sub = '') => {
    const target = SCREENS.some((a) => a.id === id) ? id : 'overview';
    const s = target === id ? String(sub || '') : '';
    setScreen(target);
    setSubroute(s);
    if (location.hash !== hashOf(target, s)) history.replaceState(null, '', hashOf(target, s));
  }, []);
  useEffect(() => {
    const h = () => { const p = hashParts(); setScreen(p.id); setSubroute(p.sub); };
    window.addEventListener('hashchange', h);
    if (location.hash !== hashOf(screen, subroute)) history.replaceState(null, '', hashOf(screen, subroute));
    return () => window.removeEventListener('hashchange', h);
  }, []);
  useEffect(() => {
    document.title = t('app.documentTitle', { screen: t(`nav.${screen}`), panel: t('app.panel') });
  }, [screen]);

  // ---------- company selector (#6) ----------
  const companySelector = useCompanies();
  const { company, companyFilter } = companySelector;

  // ---------- Log: filters, page and reading (the company comes from the selector) ----------
  const [filters, setRawFilters] = useState(newFilter);
  const [page, setPage] = useState(1);
  const [log, setLog] = useState({ answer: null, error: null, loading: false });
  const logSeq = useRef(0);
  const filtersRef = useRef(filters); filtersRef.current = filters;
  const pageRef = useRef(page); pageRef.current = page;
  const companyFilterRef = useRef(companyFilter); companyFilterRef.current = companyFilter;
  const loadLog = useCallback(async (silent) => {
    const seq = ++logSeq.current;
    if (!silent) setLog((l) => ({ ...l, loading: true }));
    try {
      const r = await readLog(logParams({ ...filtersRef.current, ...companyFilterRef.current }, pageRef.current));
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
  useEffect(() => { if (screen === 'log' || log.answer) loadLog(false); }, [filters, page, companyFilter]);
  // Another company: the project and item of the Log may belong to the previous one, so they go, and back to page 1.
  const previousCompany = useRef(company);
  useEffect(() => {
    if (previousCompany.current === company) return;
    previousCompany.current = company;
    setRawFilters((f) => (f.project || f.item ? { ...f, project: '', item: '' } : f));
    setPage(1);
  }, [company]);
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

  const ctx = {
    ...companySelector,
    state, connectionError, failingSince, screen, goTo, actionStatus, setActionStatus, recalculating, recalculate,
    goToPendingDecision, pendingTarget,
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
          <div>
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
