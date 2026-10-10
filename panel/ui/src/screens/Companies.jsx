// Companies (#21): the whole register, one card per company with its projects, whatever the company selector at the
// top says (a note tells so: a move's destination is never hidden). The cards come in the order of GET /api/companies
// (alphabetical, "Sem empresa" last); "Sem empresa" shows only when it has projects. Each project is a ProjectRow,
// shared with the "Sem empresa" card of the Items screen. Reads GET /api/companies and GET /api/projects every 20 s;
// after a move it reads both again and reloads the company selector.
import { usePanel } from '../data/context.js';
import { readCompanies, readProjects } from '../data/api.js';
import { usePolling } from '../data/polling.js';
import { obj, objs, txt } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Card, Empty, Skeleton } from '../components/base.jsx';
import { Icon, Building, Info } from '../components/Icon.jsx';
import { ProjectRow } from './ProjectRow.jsx';
import '../styles/companies.css';

async function readRegister() {
  const [c, p] = await Promise.all([readCompanies(), readProjects()]);
  return { companies: objs(c && c.companies), projects: objs(p && p.projects) };
}

export function Companies() {
  const { reloadCompanies, setActionStatus } = usePanel();
  const { answer, error, reload } = usePolling(readRegister, []);
  const companies = answer ? answer.companies : [];
  const projects = answer ? answer.projects : [];
  const projectsOf = (c) => projects.filter((p) => (obj(p.company) || {}).id === c.id);
  const shown = companies.filter((c) => !c.unassigned || projectsOf(c).length > 0);
  const moved = (message) => {
    setActionStatus(message);
    reload();
    reloadCompanies();
  };
  return (
    <div class="screen screen-companies">
      <p class="companies-note muted small"><Icon of={Info} size={14} />{t('companies.screenNote')}</p>
      {error && <p class="companies-error small" role="alert">{t('companies.readFailed', { message: error.message })}</p>}
      {!answer && !error && <Card><Skeleton /><Skeleton style={{ marginTop: '10px' }} /></Card>}
      {answer && !shown.length && <Card><Empty icon={Building} center>{t('companies.none')}</Empty></Card>}
      {shown.length > 0 && (
        <div class="companies-grid">
          {shown.map((c) => (
            <CompanyCard key={c.id} company={c} projects={projectsOf(c)} companies={companies} onMoved={moved} />
          ))}
        </div>
      )}
    </div>
  );
}

function CompanyCard({ company: c, projects, companies, onMoved }) {
  return (
    <Card class={`company-card${c.unassigned ? ' unassigned' : ''}`} label={txt(c.name)}
      info={c.unassigned ? t('companies.unassignedInfo') : undefined}
      extra={(
        <span class="company-meta">
          <span class="mono">{txt(c.id)}</span>
          <span>{t('companies.projectCount', { count: Number(c.project_count) || 0 })}</span>
          <span>{t('companies.projectItems', { count: Number(c.item_count) || 0 })}</span>
        </span>
      )}>
      {c.unassigned && !companies.some((x) => !x.unassigned) && <p class="muted small">{t('companies.noTarget')}</p>}
      {projects.length
        ? <ul class="project-list">{projects.map((p) => <ProjectRow key={p.id} project={p} companies={companies} onMoved={onMoved} />)}</ul>
        : <p class="muted small">{t('companies.noProjects')}</p>}
    </Card>
  );
}
