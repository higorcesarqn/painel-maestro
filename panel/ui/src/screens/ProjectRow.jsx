// A project's line (#21), shared by the Companies screen and the "Sem empresa" card of the Items screen: name,
// repositories, tracker, items and "Mover para" (a company + the Move button, POST /api/projects/<id>/company).
// The destinations leave out the project's own company and "Sem empresa", which the store never accepts as one.
import { useState } from 'preact/hooks';
import { moveProject } from '../data/api.js';
import { obj, txt } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Badge } from '../components/base.jsx';
import { Select } from '../components/fields.jsx';
import { Icon, FolderInput } from '../components/Icon.jsx';
import '../styles/companies.css';

/** The companies a project may move to: every one but its own and "Sem empresa". */
const moveTargets = (project, companies) => companies.filter((c) => !c.unassigned && c.id !== (obj(project.company) || {}).id);

/** companies: GET /api/companies · onMoved(message): called after the project changed company. */
export function ProjectRow({ project: p, companies, onMoved }) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const targets = moveTargets(p, companies);
  const options = [['', t('companies.choose')], ...targets.map((c) => [c.id, txt(c.name)])];
  const move = async () => {
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      const r = await moveProject(p.id, target);
      const to = r && r.project && r.project.company ? r.project.company.name : target;
      setTarget('');
      onMoved(t('companies.moved', { project: txt(p.name), company: txt(to) }));
    } catch (e) {
      setError(t('companies.moveFailed', { project: txt(p.name), message: e.message }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li class="project-row">
      <div class="project-row-name">
        <strong>{txt(p.name)}</strong>
        <span class="muted small mono">{Array.isArray(p.repos) ? p.repos.map(txt).join(' · ') : ''}</span>
      </div>
      <Badge>{t(`items.trackers.${p.tracker}`)}</Badge>
      <span class="muted small">{t('companies.projectItems', { count: Number(p.item_count) || 0 })}</span>
      {targets.length > 0 && (
        <span class="project-row-move">
          <span class="label">{t('companies.moveTo')}</span>
          <Select value={target} options={options} onChange={setTarget} ariaLabel={t('companies.moveLabel', { project: txt(p.name) })} />
          <button type="button" class="button small primary" disabled={!target || busy} onClick={move}>
            <Icon of={FolderInput} size={14} />{busy ? t('companies.moving') : t('companies.move')}
          </button>
        </span>
      )}
      {error && <p class="project-row-error small" role="alert">{error}</p>}
    </li>
  );
}
