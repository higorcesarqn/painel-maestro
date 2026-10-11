// Side menu: brand and the work screens, in blocks by group (WORK_GROUPS in data/screens.js).
// Arrows ↑ ↓ ← → go through the work screens (ARROW_SCREENS), from one group to the other, with the focus on the menu.
// The footer has the gear of Settings (#48), out of the blocks and of the arrows, and the panel's version
// (GET /api/state version, #36): v<semver> · <commit>, or v<semver> without git.
import '../styles/menu.css';
import { usePanel, SCREENS, WORK_GROUPS, ARROW_SCREENS } from '../data/context.js';
import { obj } from '../data/format.js';
import { openPending } from '../data/tab.js';
import { t } from '../i18n/index.js';
import { Icon, LayoutDashboard, Inbox, ScrollText, Bot, Gauge, Workflow, Gear } from '../components/Icon.jsx';

// Icon of each work screen (new screen: add it here).
const ICONS = { overview: LayoutDashboard, items: Workflow, pending: Inbox, log: ScrollText, agents: Bot, usage: Gauge };

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
  // The menu keeps one tab in the Tab order: the open screen, or the first one while Settings is open.
  const focusable = ARROW_SCREENS.includes(screen) ? screen : ARROW_SCREENS[0];
  const key = (ev) => {
    const delta = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    // From the tab in the Tab order: the open screen or, from Settings, the first one.
    const i = ARROW_SCREENS.indexOf(focusable);
    const j = (i + delta + ARROW_SCREENS.length) % ARROW_SCREENS.length;
    goTo(ARROW_SCREENS[j]);
    const b = document.getElementById(`tab-${ARROW_SCREENS[j]}`);
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
        {WORK_GROUPS.map((g, gi) => {
          const screens = SCREENS.filter((a) => a.group === g.id);
          if (!screens.length) return null;
          return (
            <div class={`nav-block${gi ? ' separated' : ''}`} key={g.id} role="presentation">
              <span class="nav-group label" aria-hidden="true">{t(`groups.${g.id}`)}</span>
              {screens.map((a) => {
                const c = counters[a.id];
                return (
                  <button type="button" key={a.id} class="nav-item" role="tab" id={`tab-${a.id}`} aria-controls="main-panel"
                    aria-selected={screen === a.id ? 'true' : 'false'} tabindex={a.id === focusable ? 0 : -1} onClick={() => goTo(a.id)}
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
        <div class="sidebar-foot-top">
          <span class="label">{t('sidebar.localPanel')}</span>
          <button type="button" class="button icon-only settings-button" id="tab-settings" aria-label={t('nav.settings')} title={t('nav.settings')}
            aria-current={screen === 'settings' ? 'page' : undefined} onClick={() => goTo('settings')}>
            <Icon of={Gear} size={16} />
          </button>
        </div>
        {version ? <span class="sidebar-version mono faint">{version}</span> : null}
        <span class="tiny faint">{t('sidebar.refreshNote')}</span>
      </div>
    </aside>
  );
}
