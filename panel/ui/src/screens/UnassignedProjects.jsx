// Projects in "Sem empresa" (#6): repositories where the flow command ran without a register land there. They show
// highlighted on top of the Items screen, each with the choice of a company and a Move button
// (POST /api/projects/<id>/company, which carries X-Panel: 1 like every POST of the page).
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { REFRESH_MS, readProjects, moveProject } from '../data/api.js';
import { objs, txt } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Card, Badge } from '../components/base.jsx';
import { Select } from '../components/fields.jsx';
import { Icon, FolderInput } from '../components/Icon.jsx';
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
  const targets = companies.filter((c) => c.id !== UNASSIGNED);
  const moved = (message) => {
    setActionStatus(message);
    load();
    reloadCompanies();
    if (onMoved) onMoved();
  };
  return (
    <Card class="unassigned-projects" label={t('companies.unassignedTitle')} info={t('companies.unassignedInfo')}
      extra={t('companies.unassignedCount', { count: projects.length })}>
      {!targets.length && <p class="muted small">{t('companies.noTarget')}</p>}
      <ul class="unassigned-list">
        {projects.map((p) => <UnassignedRow key={p.id} project={p} targets={targets} onMoved={moved} />)}
      </ul>
    </Card>
  );
}

function UnassignedRow({ project: p, targets, onMoved }) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options = [['', t('companies.choose')], ...targets.map((c) => [c.id, txt(c.name)])];
  const move = async () => {
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      const r = await moveProject(p.id, target);
      const to = r && r.project && r.project.company ? r.project.company.name : target;
      onMoved(t('companies.moved', { project: txt(p.name), company: txt(to) }));
    } catch (e) {
      setError(t('companies.moveFailed', { project: txt(p.name), message: e.message }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li class="unassigned-row">
      <div class="unassigned-name">
        <strong>{txt(p.name)}</strong>
        <span class="muted small mono">{Array.isArray(p.repos) ? p.repos.map(txt).join(' · ') : ''}</span>
      </div>
      <Badge>{t(`items.trackers.${p.tracker}`)}</Badge>
      <span class="muted small">{t('companies.projectItems', { count: Number(p.item_count) || 0 })}</span>
      {targets.length > 0 && (
        <span class="unassigned-move">
          <span class="label">{t('companies.moveTo')}</span>
          <Select value={target} options={options} onChange={setTarget} ariaLabel={t('companies.moveLabel', { project: txt(p.name) })} />
          <button type="button" class="button small primary" disabled={!target || busy} onClick={move}>
            <Icon of={FolderInput} size={14} />{busy ? t('companies.moving') : t('companies.move')}
          </button>
        </span>
      )}
      {error && <p class="unassigned-error small" role="alert">{error}</p>}
    </li>
  );
}
