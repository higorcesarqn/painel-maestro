// The confirmation of removing a company on the Companies screen (#24): the company's name and id, and the button that
// removes it (POST /api/companies/<id>/remove). The store refuses a company that has projects even when the screen is
// out of date; that error, a code, shows here translated, and onFailed() lets the screen read the register again.
// onRemoved(company) runs after the company is gone (also when it was already gone: 404); onClose closes without
// removing.
import { useState } from 'preact/hooks';
import { removeCompany } from '../data/api.js';
import { txt } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Modal } from '../components/Modal.jsx';
import { Icon, Trash2, X } from '../components/Icon.jsx';

export function CompanyRemoveModal({ company: c, onRemoved, onFailed, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // While the POST runs the modal stays open: closing it would hide a removal that still happens.
  const close = () => { if (!busy) onClose(); };
  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await removeCompany(c.id);
      onRemoved(c);
    } catch (e) {
      // Already removed elsewhere (the CLI or another tab): it is gone all the same.
      if (e.status === 404) {
        onRemoved(c);
        return;
      }
      setError(t('companies.remove.failed', { message: e.message }));
      setBusy(false);
      if (onFailed) onFailed();
    }
  };
  return (
    <Modal onClose={close} labelId="company-remove-title" width={520}>
      <div class="company-form">
        <div class="modal-head">
          <div class="info"><span id="company-remove-title" class="when">{t('companies.remove.title')}</span></div>
          <div class="modal-nav">
            <button type="button" class="button icon-only" aria-label={t('common.closeEsc')} title={t('common.closeEsc')} disabled={busy} onClick={close}><Icon of={X} /></button>
          </div>
        </div>
        <div class="modal-body">
          <p><strong>{t('companies.remove.question', { name: txt(c.name), id: txt(c.id) })}</strong></p>
          <p class="muted small">{t('companies.remove.detail')}</p>
          {error && <p class="company-form-error small" role="alert">{error}</p>}
          <div class="company-form-actions">
            <button type="button" class="button" disabled={busy} onClick={close}>{t('companies.remove.cancel')}</button>
            <button type="button" class="button danger" disabled={busy} onClick={remove}>
              <Icon of={Trash2} size={15} />{busy ? t('companies.remove.removing') : t('companies.remove.confirm')}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
