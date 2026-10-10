// Company selector at the top of the panel (#6): All / each company of maestro.db. The choice filters the screens of
// the new model (data/companies.js says how) and is remembered in this browser.
import { usePanel } from '../data/context.js';
import { t } from '../i18n/index.js';
import { Select } from '../components/fields.jsx';
import { Icon, Building } from '../components/Icon.jsx';

export function CompanySelect() {
  const { company, setCompany, companies } = usePanel();
  if (!companies.length) return null;
  const options = [['', t('companies.all')], ...companies.map((c) => [c.id, t('companies.option', { name: c.name, count: c.project_count })])];
  return (
    <label class="company-select" title={t('companies.selectorTitle')}>
      <Icon of={Building} size={15} />
      <span class="label">{t('companies.selectorLabel')}</span>
      <Select value={company} options={options} onChange={setCompany} ariaLabel={t('companies.selectorLabel')} />
    </label>
  );
}
