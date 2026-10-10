// The new organization modal of the Organizations screen (#22): the name and the id suggested from it (suggestOrganizationId),
// which follows the name until the owner edits it and never changes after the organization exists. An id outside the
// format is explained before saving; the server checks both fields (POST /api/organizations) and its error, a code, shows
// here translated. onCreated(organization) runs after the organization exists; onClose closes without creating.
import { useEffect, useRef, useState } from 'preact/hooks';
import { createOrganization } from '../data/api.js';
import { MAX_ORGANIZATION_NAME, RE_ID, suggestOrganizationId } from '../data/organizations.js';
import { t } from '../i18n/index.js';
import { Modal } from '../components/Modal.jsx';
import { Icon, X } from '../components/Icon.jsx';

export function OrganizationCreateModal({ onCreated, onClose }) {
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
  const nameLong = name.trim().length > MAX_ORGANIZATION_NAME;
  const idBad = id !== '' && !RE_ID.test(id);
  const idMissing = id === '' && name.trim() !== '';
  const ready = !busy && !idBad && !nameLong && id !== '' && name.trim() !== '';
  // While the POST runs the modal stays open: closing it would hide a creation that still happens.
  const close = () => { if (!busy) onClose(); };
  const changeName = (v) => {
    setName(v);
    if (!idEdited) setId(suggestOrganizationId(v));
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
      const r = await createOrganization(id, name);
      onCreated(r && r.organization ? r.organization : { id, name: name.trim() });
    } catch (e) {
      setError(t('organizations.create.failed', { message: e.message }));
      setBusy(false);
    }
  };
  let idText = t('organizations.create.idHint');
  if (idBad) idText = t('organizations.create.idInvalid');
  else if (idMissing) idText = t('organizations.create.idMissing');
  return (
    <Modal onClose={close} labelId="organization-create-title" width={560}>
      <form class="organization-form" onSubmit={save}>
        <div class="modal-head">
          <div class="info"><span id="organization-create-title" class="when">{t('organizations.create.title')}</span></div>
          <div class="modal-nav">
            <button type="button" class="button icon-only" aria-label={t('common.closeEsc')} title={t('common.closeEsc')} disabled={busy} onClick={close}><Icon of={X} /></button>
          </div>
        </div>
        <div class="modal-body">
          <label class="field">
            <span class="label">{t('organizations.create.name')}</span>
            <input type="text" class="text-input" ref={nameInput} value={name} maxlength={200} autocomplete="off" placeholder={t('organizations.create.namePlaceholder')}
              aria-invalid={nameLong ? 'true' : undefined} aria-describedby="organization-create-name-hint" onInput={(e) => changeName(e.currentTarget.value)} />
            <span id="organization-create-name-hint" class={nameLong ? 'organization-form-error small' : 'muted small'}>
              {nameLong ? t('organizations.create.nameTooLong', { max: MAX_ORGANIZATION_NAME, count: name.trim().length }) : t('organizations.create.nameHint')}
            </span>
          </label>
          <label class="field">
            <span class="label">{t('organizations.create.id')}</span>
            <input type="text" class="text-input mono" value={id} maxlength={200} autocomplete="off" spellcheck={false}
              aria-invalid={idBad ? 'true' : undefined} aria-describedby="organization-create-id-hint" onInput={(e) => changeId(e.currentTarget.value)} />
            <span id="organization-create-id-hint" class={idBad || idMissing ? 'organization-form-error small' : 'muted small'}>{idText}</span>
          </label>
          {error && <p class="organization-form-error small" role="alert">{error}</p>}
          <div class="organization-form-actions">
            <button type="button" class="button" disabled={busy} onClick={close}>{t('organizations.create.cancel')}</button>
            <button type="submit" class="button primary" disabled={!ready}>
              {busy ? t('organizations.create.saving') : t('organizations.create.save')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
