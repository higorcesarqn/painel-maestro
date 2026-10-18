// "Concluir" on the item page (#68): the owner concludes an active item on any stage, as `flow item done` does. The
// confirmation is on the page itself (never the browser's confirm()); confirmed, POST /api/items/<project>/<number>/done
// records item-done as the owner and cancels the item's open pending decisions. An item out of the active list shows
// nothing: there is no reopen button (a later flow event brings the item back). The tracker never changes.
import { useState } from 'preact/hooks';
import { concludeItem } from '../data/api.js';
import { txt } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Icon, CircleCheck, TriangleAlert } from '../components/Icon.jsx';

export function ItemConclude({ item, onChange }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [concluded, setConcluded] = useState(false);
  if (item.active === false || concluded) return null;
  const conclude = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await concludeItem(item.project.id, item.number);
    } catch (e) {
      setFailure(e.message);
      setBusy(false);
      return;
    }
    // Concluded: the button leaves at once, and a failed reload is not a failed conclusion (the page reads again on its own).
    setConcluded(true);
    if (onChange) onChange();
  };
  return (
    <div class="item-conclude">
      {asking ? (
        <div class="item-conclude-confirm" role="group" aria-label={t('items.conclude.button')}>
          <p class="small"><strong>{t('items.conclude.question', { ref: txt(item.tracker_ref) })}</strong> <span class="muted">{t('items.conclude.detail')}</span></p>
          <div class="item-conclude-actions">
            <button type="button" class="button small" disabled={busy} onClick={() => { setAsking(false); setFailure(null); }}>{t('items.conclude.cancel')}</button>
            <button type="button" class="button small primary" disabled={busy} onClick={conclude}>
              <Icon of={CircleCheck} size={14} />{busy ? t('items.conclude.concluding') : t('items.conclude.confirm')}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" class="button small" title={t('items.conclude.buttonTitle')} onClick={() => setAsking(true)}>
          <Icon of={CircleCheck} size={14} />{t('items.conclude.button')}
        </button>
      )}
      {failure && <p class="item-conclude-error small" role="alert"><Icon of={TriangleAlert} size={13} />{t('items.conclude.failed', { message: failure })}</p>}
    </div>
  );
}
