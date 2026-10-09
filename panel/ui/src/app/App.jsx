// Panel shell: reads /api/state every 20 s, keeps the current screen in the URL (#overview, #log...),
// the Log filters and the event modal. Only the visible screen is drawn.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { PanelContext, SCREENS, OLD_SCREEN_IDS, newFilter } from '../data/context.js';
import { REFRESH_MS, ANALYSIS_REFRESH_MS, MOCK, readState, recalculateUsage, readEvents, readLog } from '../data/api.js';
import { syncClock, now, spDay, time, txt, obj, arr } from '../data/format.js';
import { logParams, analyze } from '../data/queries.js';
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
import { EventModal } from '../screens/EventModal.jsx';
import { Icon, TriangleAlert, Info } from '../components/Icon.jsx';

// One screen per item of SCREENS (data/context.js). A new screen goes here and there.
const SCREEN_COMPONENTS = { overview: Overview, items: Items, pending: PendingDecisions, log: Log, agents: Agents, usage: Usage };
// URL: #<screen> or #<screen>/<sub-tab>.
const hashParts = () => {
  const [raw, ...rest] = decodeURIComponent(location.hash.slice(1)).split('/');
  const id = OLD_SCREEN_IDS[raw] || raw;
  return SCREENS.some((a) => a.id === id) ? { id, sub: rest.join('/') } : { id: 'overview', sub: '' };
};
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
  const [modal, setModal] = useState(null); // { id, list, table }
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
    const ws = state && obj(state.workspace);
    const panel = ws && ws.name ? t('app.panelOf', { name: ws.name }) : t('app.panelDefault');
    document.title = t('app.documentTitle', { screen: t(`nav.${screen}`), panel });
  }, [screen, state && state.workspace && state.workspace.name]);

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

  // ---------- analysis of the last 7 days (Overview) ----------
  const [analytics, setAnalytics] = useState({ events: null, at: 0, error: null });
  const readingAnalysis = useRef(false);
  const readAnalysis = useCallback(async () => {
    if (readingAnalysis.current) return;
    readingAnalysis.current = true;
    try {
      const since = spDay(now() - 6 * 86400000);
      let events = [];
      for (let p = 1; p <= 4; p++) {
        const sp = new URLSearchParams({ since, page: String(p), per_page: '500' });
        const r = await readEvents(sp);
        events = events.concat(arr(r.events));
        if (!r.pages || p >= r.pages) break;
      }
      setAnalytics({ events, at: Date.now(), error: null });
    } catch (e) {
      setAnalytics((a) => ({ ...a, at: Date.now(), error: e }));
    } finally {
      readingAnalysis.current = false;
    }
  }, []);
  useEffect(() => {
    if (!state || screen !== 'overview') return;
    if (Date.now() - analytics.at > ANALYSIS_REFRESH_MS) readAnalysis();
  }, [screen, state]);

  const analysis = useMemo(() => (analytics.events ? analyze(analytics.events) : null), [analytics.events]);

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

  const openModal = useCallback((id, list, table) => {
    if (!id) return;
    setModal((m) => (Array.isArray(list)
      ? { id, list: list.filter((x) => typeof x === 'string' && x), table: table || null }
      : { id, list: m ? m.list : [], table: m ? m.table : null }));
  }, []);
  const closeModal = useCallback(() => setModal(null), []);

  // Old-model flows have no place in the new Log (#12): opens it without filters.
  const filterByFlow = useCallback(() => {
    setModal(null);
    setRawFilters(newFilter());
    setPage(1);
    goTo('log');
  }, []);
  const goToPendingDecision = useCallback((id) => {
    setModal(null);
    goTo('pending');
    setPendingTarget({ id, at: Date.now() });
  }, []);

  const ctx = {
    ...companySelector,
    state, connectionError, failingSince, screen, goTo, actionStatus, setActionStatus, recalculating, recalculate,
    modal, openModal, closeModal, setModal, filterByFlow, goToPendingDecision, pendingTarget,
    filters, setFilters, setRawFilters, page, setPage, log, loadLog,
    analytics, analysis, subroute,
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
      {modal && <EventModal />}
    </PanelContext.Provider>
  );
}
