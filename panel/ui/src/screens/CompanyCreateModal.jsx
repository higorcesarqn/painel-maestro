// The "Nova empresa" modal of the Companies screen (#22): the name and the id suggested from it (suggestCompanyId),
// which follows the name until the owner edits it and never changes after the company exists. An id outside the
// format is explained before saving; the server checks both fields (POST /api/companies) and its error, a code, shows
// here translated. onCreated(company) runs after the company exists; onClose closes without creating.
import { useEffect, useRef, useState } from 'preact/hooks';
import { createCompany } from '../data/api.js';
import { MAX_COMPANY_NAME, RE_ID, suggestCompanyId } from '../data/companies.js';
import { t } from '../i18n/index.js';
import { Modal } from '../components/Modal.jsx';
import { Icon, X } from '../components/Icon.jsx';

export function CompanyCreateModal({ onCreated, onClose }) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameInput = useRef(null);
  // The Modal focuses its box when it opens; the name field takes the focus right after.
  useEffect(() => {
    const frame = requestAnimationFrame(() => nameInput.current && nameInput.current.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const nameLong = name.trim().length > MAX_COMPANY_NAME;
  const idBad = id !== '' && !RE_ID.test(id);
  const idMissing = id === '' && name.trim() !== '';
  const ready = !busy && !idBad && !nameLong && id !== '' && name.trim() !== '';
  // While the POST runs the modal stays open: closing it would hide a creation that still happens.
  const close = () => { if (!busy) onClose(); };
  const changeName = (v) => {
    setName(v);
    if (!idEdited) setId(suggestCompanyId(v));
  };
  const changeId = (v) => {
    setId(v);
    setIdEdited(v !== '');
  };
  const save = async (ev) => {
    ev.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      const r = await createCompany(id, name);
      onCreated(r && r.company ? r.company : { id, name: name.trim() });
    } catch (e) {
      setError(t('companies.create.failed', { message: e.message }));
      setBusy(false);
    }
  };
  let idText = t('companies.create.idHint');
  if (idBad) idText = t('companies.create.idInvalid');
  else if (idMissing) idText = t('companies.create.idMissing');
  return (
    <Modal onClose={close} labelId="company-create-title" width={560}>
      <form class="company-form" onSubmit={save}>
        <div class="modal-head">
          <div class="info"><span id="company-create-title" class="when">{t('companies.create.title')}</span></div>
          <div class="modal-nav">
            <button type="button" class="button icon-only" aria-label={t('common.closeEsc')} title={t('common.closeEsc')} disabled={busy} onClick={close}><Icon of={X} /></button>
          </div>
        </div>
        <div class="modal-body">
          <label class="field">
            <span class="label">{t('companies.create.name')}</span>
            <input type="text" class="text-input" ref={nameInput} value={name} maxlength={200} autocomplete="off" placeholder={t('companies.create.namePlaceholder')}
              aria-invalid={nameLong ? 'true' : undefined} aria-describedby="company-create-name-hint" onInput={(e) => changeName(e.currentTarget.value)} />
            <span id="company-create-name-hint" class={nameLong ? 'company-form-error small' : 'muted small'}>
              {nameLong ? t('companies.create.nameTooLong', { max: MAX_COMPANY_NAME, count: name.trim().length }) : t('companies.create.nameHint')}
            </span>
          </label>
          <label class="field">
            <span class="label">{t('companies.create.id')}</span>
            <input type="text" class="text-input mono" value={id} maxlength={200} autocomplete="off" spellcheck={false}
              aria-invalid={idBad ? 'true' : undefined} aria-describedby="company-create-id-hint" onInput={(e) => changeId(e.currentTarget.value)} />
            <span id="company-create-id-hint" class={idBad || idMissing ? 'company-form-error small' : 'muted small'}>{idText}</span>
          </label>
          {error && <p class="company-form-error small" role="alert">{error}</p>}
          <div class="company-form-actions">
            <button type="button" class="button" disabled={busy} onClick={close}>{t('companies.create.cancel')}</button>
            <button type="submit" class="button primary" disabled={!ready}>
              {busy ? t('companies.create.saving') : t('companies.create.save')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
