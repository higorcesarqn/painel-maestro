// Side menu: brand and the screens, in blocks by group (GROUPS in data/context.js).
// Arrows ↑ ↓ ← → go through every screen, from one group to the other, with the focus on the menu.
import '../styles/menu.css';
import { usePanel, SCREENS, GROUPS } from '../data/context.js';
import { obj } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Icon, LayoutDashboard, Inbox, ScrollText, Bot, Gauge } from '../components/Icon.jsx';

// Icon of each screen (new screen: add it here).
const ICONS = { overview: LayoutDashboard, pending: Inbox, log: ScrollText, agents: Bot, usage: Gauge };

export function Sidebar() {
  const { state, screen, goTo } = usePanel();
  const kp = (state && obj(state.kpis) && obj(state.kpis.pending_decisions)) || {};
  const bySeverity = obj(kp.by_severity) || {};
  const ws = (state && obj(state.workspace)) || {};
  // Counter next to the name: { n, tone, label }
  const counters = {
    pending: kp.total ? { n: kp.total, tone: bySeverity.critica ? 'strong' : 'blue', label: t('sidebar.pendingCounter', { count: kp.total }) } : null,
  };
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
        <span class="label" title={ws.root || ''}>{t('sidebar.workspace', { name: ws.name || '—' })}</span>
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
        <span class="tiny faint">{t('sidebar.refreshNote')}</span>
      </div>
    </aside>
  );
}
