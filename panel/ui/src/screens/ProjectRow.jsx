// A project's line (#21), shared by the Organizations screen and the "unassigned" card of the Items screen: name,
// repositories, tracker, items and "Mover para" (an organization + the Move button, POST /api/projects/<id>/organization).
// The destinations leave out the project's own organization and "unassigned", which the store never accepts as one.
import { useState } from 'preact/hooks';
import { moveProject } from '../data/api.js';
import { obj, txt } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Badge } from '../components/base.jsx';
import { Select } from '../components/fields.jsx';
import { Icon, FolderInput } from '../components/Icon.jsx';
import '../styles/organizations.css';

/** The organizations a project may move to: every one but its own and "unassigned". */
const moveTargets = (project, organizations) => organizations.filter((c) => !c.unassigned && c.id !== (obj(project.organization) || {}).id);

/** organizations: GET /api/organizations · onMoved(message): called after the project changed organization. */
export function ProjectRow({ project: p, organizations, onMoved }) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const targets = moveTargets(p, organizations);
  const options = [['', t('organizations.choose')], ...targets.map((c) => [c.id, txt(c.name)])];
  const move = async () => {
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      const r = await moveProject(p.id, target);
      const to = r && r.project && r.project.organization ? r.project.organization.name : target;
      setTarget('');
      onMoved(t('organizations.moved', { project: txt(p.name), organization: txt(to) }));
    } catch (e) {
      setError(t('organizations.moveFailed', { project: txt(p.name), message: e.message }));
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
      <span class="muted small">{t('organizations.projectItems', { count: Number(p.item_count) || 0 })}</span>
      {targets.length > 0 && (
        <span class="project-row-move">
          <span class="label">{t('organizations.moveTo')}</span>
          <Select value={target} options={options} onChange={setTarget} ariaLabel={t('organizations.moveLabel', { project: txt(p.name) })} />
          <button type="button" class="button small primary" disabled={!target || busy} onClick={move}>
            <Icon of={FolderInput} size={14} />{busy ? t('organizations.moving') : t('organizations.move')}
          </button>
        </span>
      )}
      {error && <p class="project-row-error small" role="alert">{error}</p>}
    </li>
  );
}
