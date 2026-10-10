// Organization selector at the top of the panel (#6): All / each organization of maestro.db. The choice filters the screens of
// the new model (data/organizations.js says how) and is remembered in this browser.
import { usePanel } from '../data/context.js';
import { t } from '../i18n/index.js';
import { Select } from '../components/fields.jsx';
import { Icon, Building } from '../components/Icon.jsx';

export function OrganizationSelect() {
  const { organization, setOrganization, organizations } = usePanel();
  if (!organizations.length) return null;
  const options = [['', t('organizations.all')], ...organizations.map((c) => [c.id, t('organizations.option', { name: c.name, count: c.project_count })])];
  return (
    <label class="organization-select" title={t('organizations.selectorTitle')}>
      <Icon of={Building} size={15} />
      <span class="label">{t('organizations.selectorLabel')}</span>
      <Select value={organization} options={options} onChange={setOrganization} ariaLabel={t('organizations.selectorLabel')} />
    </label>
  );
}
