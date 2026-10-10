// The confirmation of removing an organization on the Organizations screen (#24): the organization's name and id, and the button that
// removes it (POST /api/organizations/<id>/remove). The store refuses an organization that has projects even when the screen is
// out of date; that error, a code, shows here translated, and onFailed() lets the screen read the register again.
// onRemoved(organization) runs after the organization is gone (also when it was already gone: 404); onClose closes without
// removing.
import { useState } from 'preact/hooks';
import { removeOrganization } from '../data/api.js';
import { txt } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Modal } from '../components/Modal.jsx';
import { Icon, Trash2, X } from '../components/Icon.jsx';

export function OrganizationRemoveModal({ organization: o, onRemoved, onFailed, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // While the POST runs the modal stays open: closing it would hide a removal that still happens.
  const close = () => { if (!busy) onClose(); };
  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await removeOrganization(o.id);
      onRemoved(o);
    } catch (e) {
      // Already removed elsewhere (the CLI or another tab): it is gone all the same.
      if (e.status === 404) {
        onRemoved(o);
        return;
      }
      setError(t('organizations.remove.failed', { message: e.message }));
      setBusy(false);
      if (onFailed) onFailed();
    }
  };
  return (
    <Modal onClose={close} labelId="organization-remove-title" width={520}>
      <div class="organization-form">
        <div class="modal-head">
          <div class="info"><span id="organization-remove-title" class="when">{t('organizations.remove.title')}</span></div>
          <div class="modal-nav">
            <button type="button" class="button icon-only" aria-label={t('common.closeEsc')} title={t('common.closeEsc')} disabled={busy} onClick={close}><Icon of={X} /></button>
          </div>
        </div>
        <div class="modal-body">
          <p><strong>{t('organizations.remove.question', { name: txt(o.name), id: txt(o.id) })}</strong></p>
          <p class="muted small">{t('organizations.remove.detail')}</p>
          {error && <p class="organization-form-error small" role="alert">{error}</p>}
          <div class="organization-form-actions">
            <button type="button" class="button" disabled={busy} onClick={close}>{t('organizations.remove.cancel')}</button>
            <button type="button" class="button danger" disabled={busy} onClick={remove}>
              <Icon of={Trash2} size={15} />{busy ? t('organizations.remove.removing') : t('organizations.remove.confirm')}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
