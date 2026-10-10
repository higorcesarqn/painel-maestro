// The "Renomear" modal of the Companies screen (#23): the company's current name, filled in, and its id, which never
// changes. The server checks the name under the store's rule (POST /api/companies/<id>/rename: up to 80 characters,
// unique ignoring case among the other companies; its own name with another case is accepted); its error, a code,
// shows here translated, and onFailed() lets the screen read the register again. onRenamed(company, from) runs after
// the rename; onClose closes without renaming.
import { useEffect, useRef, useState } from 'preact/hooks';
import { renameCompany } from '../data/api.js';
import { MAX_COMPANY_NAME } from '../data/companies.js';
import { txt } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Modal } from '../components/Modal.jsx';
import { Icon, X } from '../components/Icon.jsx';

export function CompanyRenameModal({ company: c, onRenamed, onFailed, onClose }) {
  const current = txt(c.name);
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameInput = useRef(null);
  // The Modal focuses its box when it opens; the name field takes the focus right after, with the name selected.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!nameInput.current) return;
      nameInput.current.focus();
      nameInput.current.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const trimmed = name.trim();
  const nameLong = trimmed.length > MAX_COMPANY_NAME;
  // The same name, exactly, changes nothing: the button waits for a change (another case is a change).
  const ready = !busy && !nameLong && trimmed !== '' && trimmed !== current;
  // While the POST runs the modal stays open: closing it would hide a rename that still happens.
  const close = () => { if (!busy) onClose(); };
  const save = async (ev) => {
    ev.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      const r = await renameCompany(c.id, name);
      onRenamed(r.company, current);
    } catch (e) {
      setError(t('companies.rename.failed', { message: e.message }));
      setBusy(false);
      onFailed();
    }
  };
  return (
    <Modal onClose={close} labelId="company-rename-title" width={560}>
      <form class="company-form" onSubmit={save}>
        <div class="modal-head">
          <div class="info"><span id="company-rename-title" class="when">{t('companies.rename.title')}</span></div>
          <div class="modal-nav">
            <button type="button" class="button icon-only" aria-label={t('common.closeEsc')} title={t('common.closeEsc')} disabled={busy} onClick={close}><Icon of={X} /></button>
          </div>
        </div>
        <div class="modal-body">
          <label class="field">
            <span class="label">{t('companies.rename.name')}</span>
            <input type="text" class="text-input" ref={nameInput} value={name} maxlength={200} autocomplete="off"
              aria-invalid={nameLong || trimmed === '' ? 'true' : undefined} aria-describedby="company-rename-name-hint" onInput={(e) => setName(e.currentTarget.value)} />
            <span id="company-rename-name-hint" class={nameLong || trimmed === '' ? 'company-form-error small' : 'muted small'}>
              {nameLong ? t('companies.rename.nameTooLong', { max: MAX_COMPANY_NAME, count: trimmed.length })
                : trimmed === '' ? t('companies.rename.nameMissing') : t('companies.rename.nameHint')}
            </span>
          </label>
          <p class="muted small">{t('companies.rename.idKept', { id: txt(c.id) })}</p>
          {error && <p class="company-form-error small" role="alert">{error}</p>}
          <div class="company-form-actions">
            <button type="button" class="button" disabled={busy} onClick={close}>{t('companies.rename.cancel')}</button>
            <button type="submit" class="button primary" disabled={!ready}>
              {busy ? t('companies.rename.saving') : t('companies.rename.save')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
