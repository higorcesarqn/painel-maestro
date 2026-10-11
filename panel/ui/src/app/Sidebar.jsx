// Side menu: brand and the screens, in blocks by group (GROUPS in data/context.js).
// Arrows ↑ ↓ ← → go through every screen, from one group to the other, with the focus on the menu.
// The footer shows the panel's version (GET /api/state version, #36): v<semver> · <commit>, or v<semver> without git.
import '../styles/menu.css';
import { usePanel, SCREENS, GROUPS } from '../data/context.js';
import { obj } from '../data/format.js';
import { openPending } from '../data/tab.js';
import { t } from '../i18n/index.js';
import { Icon, LayoutDashboard, Inbox, ScrollText, Bot, Gauge, Workflow, Building } from '../components/Icon.jsx';

// Icon of each screen (new screen: add it here).
const ICONS = { overview: LayoutDashboard, items: Workflow, pending: Inbox, log: ScrollText, agents: Bot, usage: Gauge, organizations: Building };

export function Sidebar() {
  const { state, screen, goTo } = usePanel();
  // Counter next to the name: { n, tone, label }. The open pending decisions of every organization (GET /api/state),
  // the same count as the tab's title and favicon (data/tab.js).
  const pending = openPending(state);
  const counters = {
    pending: pending ? { n: pending.total, tone: pending.tone, label: t('sidebar.pendingCounter', { count: pending.total }) } : null,
  };
  const v = (state && obj(state.version)) || {};
  const version = !v.product ? null
    : v.commit ? t('sidebar.version', { product: v.product, commit: v.commit }) : t('sidebar.versionNoCommit', { product: v.product });
  const key = (ev) => {
    const delta = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    const order = GROUPS.flatMap((g) => SCREENS.filter((a) => a.group === g.id));
    const i = order.findIndex((a) => a.id === screen);
    const j = (i + delta + order.length) % order.length;
    goTo(order[j].id);
    const b = document.getElementById(`tab-${order[j].id}`);
    if (b) b.focus();
    ev.preventDefault();
  };
  return (
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-name">{t('sidebar.brand')}<b>.</b>{t('sidebar.brandSuffix')}</span>
        <span class="label">{t('sidebar.tagline')}</span>
      </div>
      <nav class="nav" role="tablist" aria-orientation="vertical" aria-label={t('sidebar.screens')} onKeyDown={key}>
        {GROUPS.map((g, gi) => {
          const screens = SCREENS.filter((a) => a.group === g.id);
          if (!screens.length) return null;
          return (
            <div class={`nav-block${gi ? ' separated' : ''}`} key={g.id} role="presentation">
              <span class="nav-group label" aria-hidden="true">{t(`groups.${g.id}`)}</span>
              {screens.map((a) => {
                const c = counters[a.id];
                return (
                  <button type="button" key={a.id} class="nav-item" role="tab" id={`tab-${a.id}`} aria-controls="main-panel"
                    aria-selected={screen === a.id ? 'true' : 'false'} tabindex={screen === a.id ? 0 : -1} onClick={() => goTo(a.id)}
                    title={c ? c.label : undefined}>
                    <Icon of={ICONS[a.id] || LayoutDashboard} size={17} />
                    <span class="name">{t(`nav.${a.id}`)}</span>
                    {c ? <span class={`counter ${c.tone}`} aria-label={c.label}>{c.n}</span> : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>
      <div class="sidebar-foot">
        <span class="label">{t('sidebar.localPanel')}</span>
        {version ? <span class="sidebar-version mono faint">{version}</span> : null}
        <span class="tiny faint">{t('sidebar.refreshNote')}</span>
      </div>
    </aside>
  );
}
