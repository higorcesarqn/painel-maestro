// Projects in "unassigned" (#6): repositories where the flow command ran without a register land there. They show
// highlighted on top of the Items screen, each in the project line shared with the Organizations screen (ProjectRow.jsx:
// the choice of an organization and a Move button, POST /api/projects/<id>/organization with X-Panel: 1 like every POST of the page).
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { REFRESH_MS, readProjects } from '../data/api.js';
import { objs } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Card } from '../components/base.jsx';
import { ProjectRow } from './ProjectRow.jsx';
import '../styles/organizations.css';

const UNASSIGNED = 'unassigned';

/** onMoved(): called after a project changed organization (the screen reads its lists again). */
export function UnassignedProjects({ onMoved }) {
  const { organization, organizations, reloadOrganizations, setActionStatus } = usePanel();
  const [projects, setProjects] = useState([]);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await readProjects({ organization: UNASSIGNED });
      if (mine === seq.current) setProjects(objs(r && r.projects));
    } catch (_) { /* keeps the last good list */ }
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (organization && organization !== UNASSIGNED) return null;
  if (!projects.length) return null;
  const moved = (message) => {
    setActionStatus(message);
    load();
    reloadOrganizations();
    if (onMoved) onMoved();
  };
  return (
    <Card class="unassigned-projects" label={t('organizations.unassignedTitle')} info={t('organizations.unassignedInfo')}
      extra={t('organizations.projectCount', { count: projects.length })}>
      {!organizations.some((c) => !c.unassigned) && <p class="muted small">{t('organizations.noTarget')}</p>}
      <ul class="project-list">
        {projects.map((p) => <ProjectRow key={p.id} project={p} organizations={organizations} onMoved={moved} />)}
      </ul>
    </Card>
  );
}
