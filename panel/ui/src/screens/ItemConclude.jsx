// "Concluir" and "Interromper" on the item page (#68, #70): the owner concludes or interrupts an active item on any
// stage, as `flow item done` / `flow item interrupt` do. The confirmation is on the page itself (never the browser's
// confirm()); "Interromper" also asks for the reason (required, several lines, up to MAX_DECISION characters).
// Confirmed, POST /api/items/<project>/<number>/done (or .../interrupt with { reason }) records the event as the owner
// and cancels the item's open pending decisions. An item out of the active list shows nothing: there is no reopen
// button (a later flow event brings the item back). The tracker never changes.
import { useEffect, useState } from 'preact/hooks';
import { concludeItem, interruptItem } from '../data/api.js';
import { MAX_DECISION } from '../data/domain.js';
import { txt } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Icon, CircleCheck, Ban, TriangleAlert } from '../components/Icon.jsx';

export function ItemConclude({ item, onChange }) {
  // null, 'conclude' or 'interrupt': which confirmation is open.
  const [asking, setAsking] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [closed, setClosed] = useState(false);
  // Once the page reads the item out of the active list, the local mark is no longer needed: if a later flow event
  // brings the item back, the buttons come back with it.
  useEffect(() => { if (item.active === false) setClosed(false); }, [item.active]);
  if (item.active === false || closed) return null;
  const trimmed = reason.replace(/\r\n?/g, '\n').trim();
  const tooLong = trimmed.length > MAX_DECISION;
  const close = async () => {
    setBusy(true);
    setFailure(null);
    try {
      if (asking === 'interrupt') await interruptItem(item.project.id, item.number, trimmed);
      else await concludeItem(item.project.id, item.number);
    } catch (e) {
      setFailure(e.message);
      setBusy(false);
      return;
    }
    // Closed: the buttons leave at once, and a failed reload is not a failed closing (the page reads again on its own).
    setClosed(true);
    setAsking(null);
    setReason('');
    setBusy(false);
    if (onChange) onChange();
  };
  const cancel = () => { setAsking(null); setFailure(null); };
  const ask = (which) => { setAsking(which); setFailure(null); };
  const failed = failure && (asking === 'interrupt' ? t('items.interrupt.failed', { message: failure }) : t('items.conclude.failed', { message: failure }));
  return (
    <div class="item-conclude">
      {asking === 'conclude' && (
        <div class="item-conclude-confirm" role="group" aria-label={t('items.conclude.button')}>
          <p class="small"><strong>{t('items.conclude.question', { ref: txt(item.tracker_ref) })}</strong> <span class="muted">{t('items.conclude.detail')}</span></p>
          <div class="item-conclude-actions">
            <button type="button" class="button small" disabled={busy} onClick={cancel}>{t('items.conclude.cancel')}</button>
            <button type="button" class="button small primary" disabled={busy} onClick={close}>
              <Icon of={CircleCheck} size={14} />{busy ? t('items.conclude.concluding') : t('items.conclude.confirm')}
            </button>
          </div>
        </div>
      )}
      {asking === 'interrupt' && (
        <form class="item-conclude-confirm item-interrupt-confirm" aria-label={t('items.interrupt.button')} onSubmit={(e) => { e.preventDefault(); if (trimmed && !tooLong && !busy) close(); }}>
          <p class="small"><strong>{t('items.interrupt.question', { ref: txt(item.tracker_ref) })}</strong> <span class="muted">{t('items.interrupt.detail')}</span></p>
          <label class="field item-interrupt-field">
            <span class="label">{t('items.interrupt.reason')}</span>
            <textarea class="item-interrupt-reason" rows={3} value={reason} disabled={busy} required aria-invalid={tooLong ? 'true' : undefined}
              placeholder={t('items.interrupt.reasonHint')} onInput={(e) => setReason(e.currentTarget.value)} />
          </label>
          {tooLong && <p class="item-conclude-error small">{t('items.interrupt.tooLong', { count: trimmed.length, max: MAX_DECISION })}</p>}
          <div class="item-conclude-actions">
            <button type="button" class="button small" disabled={busy} onClick={cancel}>{t('items.conclude.cancel')}</button>
            <button type="submit" class="button small primary" disabled={busy || !trimmed || tooLong}>
              <Icon of={Ban} size={14} />{busy ? t('items.interrupt.interrupting') : t('items.interrupt.confirm')}
            </button>
          </div>
        </form>
      )}
      {!asking && (
        <div class="item-conclude-actions">
          <button type="button" class="button small" title={t('items.conclude.buttonTitle')} onClick={() => ask('conclude')}>
            <Icon of={CircleCheck} size={14} />{t('items.conclude.button')}
          </button>
          <button type="button" class="button small" title={t('items.interrupt.buttonTitle')} onClick={() => ask('interrupt')}>
            <Icon of={Ban} size={14} />{t('items.interrupt.button')}
          </button>
        </div>
      )}
      {failed && <p class="item-conclude-error small" role="alert"><Icon of={TriangleAlert} size={13} />{failed}</p>}
    </div>
  );
}
