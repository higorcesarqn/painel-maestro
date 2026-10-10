// Organization selector (#6): the organizations of maestro.db (GET /api/organizations, read again every 20 s) and the organization the
// owner chose at the top of the panel ('' = all). The choice is remembered in this browser (localStorage, which may
// be blocked: then it only lasts while the page is open).
//
// How the filter reaches the screens: App puts { organization, setOrganization, organizations, reloadOrganizations, organizationFilter } in
// the panel context; a screen of the new model passes organizationFilter to its API reads (readItems(organizationFilter) →
// /api/items?organization=<id>) and lists the organization in the dependencies of its reading. A new screen does the same.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { REFRESH_MS, readOrganizations } from './api.js';
import { objs } from './format.js';

// A new key since #26: the choice made under the old one is not carried over (back to all, once).
const STORAGE_KEY = 'painel-maestro.organization';
// The id format of the register (bin/flow-store.js); the server is the one that validates it.
export const RE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
// The longest organization name the store accepts (bin/flow-store.js); the server checks it again.
export const MAX_ORGANIZATION_NAME = 80;

/**
 * The id suggested for a new organization from its name (#22): lowercase, no accents, spaces and symbols become one hyphen,
 * trimmed of hyphens, up to 80 characters ("Fabrikam Ltda" -> "fabrikam-ltda").
 */
export function suggestOrganizationId(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 80).replace(/-+$/, '');
}

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

export function useOrganizations() {
  const [chosen, setChosen] = useState(stored);
  const [organizations, setOrganizations] = useState(null); // null while the first read has not answered
  const seq = useRef(0);
  const reloadOrganizations = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await readOrganizations();
      if (mine === seq.current) setOrganizations(objs(r && r.organizations));
    } catch (_) { /* keeps the last good list; the screens show their own read errors */ }
  }, []);
  useEffect(() => {
    reloadOrganizations();
    const timer = setInterval(reloadOrganizations, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const setOrganization = useCallback((id) => {
    const v = RE_ID.test(id || '') ? id : '';
    store(v);
    setChosen(v);
  }, []);
  // An organization that no longer exists counts as "all" without forgetting the choice (it may come back).
  const organization = !organizations || organizations.some((c) => c.id === chosen) ? chosen : '';
  const organizationFilter = useMemo(() => ({ organization }), [organization]);
  return { organization, setOrganization, organizations: organizations || [], reloadOrganizations, organizationFilter };
}
