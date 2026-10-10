// Projects in "Sem empresa" (#6): repositories where the flow command ran without a register land there. They show
// highlighted on top of the Items screen, each in the project line shared with the Companies screen (ProjectRow.jsx:
// the choice of a company and a Move button, POST /api/projects/<id>/company with X-Panel: 1 like every POST of the page).
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { REFRESH_MS, readProjects } from '../data/api.js';
import { objs } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Card } from '../components/base.jsx';
import { ProjectRow } from './ProjectRow.jsx';
import '../styles/companies.css';

const UNASSIGNED = 'unassigned';

/** onMoved(): called after a project changed company (the screen reads its lists again). */
export function UnassignedProjects({ onMoved }) {
  const { company, companies, reloadCompanies, setActionStatus } = usePanel();
  const [projects, setProjects] = useState([]);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await readProjects({ company: UNASSIGNED });
      if (mine === seq.current) setProjects(objs(r && r.projects));
    } catch (_) { /* keeps the last good list */ }
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (company && company !== UNASSIGNED) return null;
  if (!projects.length) return null;
  const moved = (message) => {
    setActionStatus(message);
    load();
    reloadCompanies();
    if (onMoved) onMoved();
  };
  return (
    <Card class="unassigned-projects" label={t('companies.unassignedTitle')} info={t('companies.unassignedInfo')}
      extra={t('companies.projectCount', { count: projects.length })}>
      {!companies.some((c) => !c.unassigned) && <p class="muted small">{t('companies.noTarget')}</p>}
      <ul class="project-list">
        {projects.map((p) => <ProjectRow key={p.id} project={p} companies={companies} onMoved={moved} />)}
      </ul>
    </Card>
  );
}
