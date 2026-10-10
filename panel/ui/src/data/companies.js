// Company selector (#6): the companies of maestro.db (GET /api/companies, read again every 20 s) and the company the
// owner chose at the top of the panel ('' = all). The choice is remembered in this browser (localStorage, which may
// be blocked: then it only lasts while the page is open).
//
// How the filter reaches the screens: App puts { company, setCompany, companies, reloadCompanies, companyFilter } in
// the panel context; a screen of the new model passes companyFilter to its API reads (readItems(companyFilter) →
// /api/items?company=<id>) and lists the company in the dependencies of its reading. A new screen does the same.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { REFRESH_MS, readCompanies } from './api.js';
import { objs } from './format.js';

const STORAGE_KEY = 'painel-maestro.company';
const RE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

function stored() {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY) || '';
    return RE_ID.test(v) ? v : '';
  } catch (_) {
    return '';
  }
}

function store(value) {
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, value);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch (_) { /* blocked storage: the choice lasts while the page is open */ }
}

export function useCompanies() {
  const [chosen, setChosen] = useState(stored);
  const [companies, setCompanies] = useState(null); // null while the first read has not answered
  const seq = useRef(0);
  const reloadCompanies = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await readCompanies();
      if (mine === seq.current) setCompanies(objs(r && r.companies));
    } catch (_) { /* keeps the last good list; the screens show their own read errors */ }
  }, []);
  useEffect(() => {
    reloadCompanies();
    const timer = setInterval(reloadCompanies, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const setCompany = useCallback((id) => {
    const v = RE_ID.test(id || '') ? id : '';
    store(v);
    setChosen(v);
  }, []);
  // A company that no longer exists counts as "all" without forgetting the choice (it may come back).
  const company = !companies || companies.some((c) => c.id === chosen) ? chosen : '';
  const companyFilter = useMemo(() => ({ company }), [company]);
  return { company, setCompany, companies: companies || [], reloadCompanies, companyFilter };
}
