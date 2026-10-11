// Settings (#48): the register's settings, out of the work blocks of the menu (the gear on its footer). One tab per
// sub-tab of the screen (SCREENS, data/screens.js), each with its own address, #settings/<sub>; the App hands the sub-tab
// in `subroute`, already resolved to one of them (#settings opens the first). Organizations is the first and, for now,
// the only one: the Organizations screen of before (#21), whole.
import { usePanel, SCREENS } from '../data/context.js';
import { t } from '../i18n/index.js';
import { Organizations } from './Organizations.jsx';
import '../styles/settings.css';

// One component per sub-tab of the settings screen (a new sub-tab goes here and in SCREENS).
const SUB_COMPONENTS = { organizations: Organizations };
const SUBS = SCREENS.find((a) => a.id === 'settings').subs;

export function Settings() {
  const { subroute, goTo } = usePanel();
  const current = subroute; // already one of SUBS (screenAt)
  const Sub = SUB_COMPONENTS[current];
  const key = (ev) => {
    const delta = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    const next = SUBS[(SUBS.indexOf(current) + delta + SUBS.length) % SUBS.length];
    goTo('settings', next);
    const b = document.getElementById(`settings-tab-${next}`);
    if (b) b.focus();
    ev.preventDefault();
  };
  return (
    <div class="screen screen-settings">
      <div class="settings-tabs" role="tablist" aria-label={t('settings.tabsLabel')} onKeyDown={key}>
        {SUBS.map((s) => (
          <button type="button" key={s} class="settings-tab" role="tab" id={`settings-tab-${s}`} aria-controls="settings-panel"
            aria-selected={s === current ? 'true' : 'false'} tabindex={s === current ? 0 : -1} onClick={() => goTo('settings', s)}>
            {t(`settings.tabs.${s}`)}
          </button>
        ))}
      </div>
      <div class="settings-panel" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${current}`}>
        <Sub />
      </div>
    </div>
  );
}
