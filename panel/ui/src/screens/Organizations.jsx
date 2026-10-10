// Organizations (#21): the whole register, one card per organization with its projects, whatever the organization selector at the
// top says (a note tells so: a move's destination is never hidden). The cards come in the order of GET /api/organizations
// (alphabetical, "unassigned" last); "unassigned" shows only when it has projects. Each project is a ProjectRow,
// shared with the "unassigned" card of the Items screen. The new organization button opens OrganizationCreateModal (#22);
// with no organization yet, the screen points to it. Each organization but "unassigned" has Renomear (#23), which opens
// OrganizationRenameModal, and Excluir (#24): disabled with the number of projects to move first, otherwise it opens
// OrganizationRemoveModal. Reads GET /api/organizations and GET /api/projects every 20 s; after a move, a creation, a rename or
// a removal it reads both again, reloads the organization selector (the other screens read the names from the API again on
// their next read) and shows a status notice; removing the organization of the selector sets it back to all.
import { useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { readOrganizations, readProjects } from '../data/api.js';
import { usePolling } from '../data/polling.js';
import { obj, objs, txt } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Card, Empty, Skeleton } from '../components/base.jsx';
import { Icon, Building, Info, Pencil, Plus, Trash2 } from '../components/Icon.jsx';
import { ProjectRow } from './ProjectRow.jsx';
import { OrganizationCreateModal } from './OrganizationCreateModal.jsx';
import { OrganizationRenameModal } from './OrganizationRenameModal.jsx';
import { OrganizationRemoveModal } from './OrganizationRemoveModal.jsx';
import '../styles/organizations.css';

async function readRegister() {
  const [o, p] = await Promise.all([readOrganizations(), readProjects()]);
  return { organizations: objs(o && o.organizations), projects: objs(p && p.projects) };
}

export function Organizations() {
  const { organization: selected, setOrganization, reloadOrganizations, setActionStatus } = usePanel();
  const { answer, error, reload } = usePolling(readRegister, []);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [removing, setRemoving] = useState(null);
  const organizations = answer ? answer.organizations : [];
  const projects = answer ? answer.projects : [];
  const projectsOf = (o) => projects.filter((p) => (obj(p.organization) || {}).id === o.id);
  const shown = organizations.filter((o) => !o.unassigned || projectsOf(o).length > 0);
  const changed = (message) => {
    setActionStatus(message);
    reload();
    reloadOrganizations();
  };
  const created = (organization) => {
    setCreating(false);
    changed(t('organizations.create.created', { name: txt(organization.name) }));
  };
  const renamed = (organization, from) => {
    setRenaming(null);
    changed(t('organizations.rename.renamed', { from, name: txt(organization.name) }));
  };
  const failed = () => {
    reload();
    reloadOrganizations();
  };
  const removed = (organization) => {
    setRemoving(null);
    if (selected === organization.id) setOrganization('');
    changed(t('organizations.remove.removed', { name: txt(organization.name) }));
  };
  return (
    <div class="screen screen-organizations">
      <div class="organizations-top">
        <p class="organizations-note muted small"><Icon of={Info} size={14} />{t('organizations.screenNote')}</p>
        <button type="button" class="button primary" onClick={() => setCreating(true)}><Icon of={Plus} size={15} />{t('organizations.create.button')}</button>
      </div>
      {error && <p class="organizations-error small" role="alert">{t('organizations.readFailed', { message: error.message })}</p>}
      {!answer && !error && <Card><Skeleton /><Skeleton style={{ marginTop: '10px' }} /></Card>}
      {answer && !shown.length && <Card><Empty icon={Building} center>{t('organizations.none')}</Empty></Card>}
      {shown.length > 0 && (
        <div class="organizations-grid">
          {shown.map((o) => (
            <OrganizationCard key={o.id} organization={o} projects={projectsOf(o)} organizations={organizations} onMoved={changed} onRename={setRenaming} onRemove={setRemoving} />
          ))}
        </div>
      )}
      {creating && <OrganizationCreateModal onCreated={created} onClose={() => setCreating(false)} />}
      {renaming && <OrganizationRenameModal organization={renaming} onRenamed={renamed} onFailed={failed} onClose={() => setRenaming(null)} />}
      {removing && <OrganizationRemoveModal organization={removing} onRemoved={removed} onFailed={failed} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function OrganizationCard({ organization: o, projects, organizations, onMoved, onRename, onRemove }) {
  return (
    <Card class={`organization-card${o.unassigned ? ' unassigned' : ''}`} label={txt(o.name)}
      info={o.unassigned ? t('organizations.unassignedInfo') : undefined}
      actions={o.unassigned ? undefined : (
        <>
          <RenameButton organization={o} onRename={onRename} />
          <RemoveButton organization={o} count={projects.length} onRemove={onRemove} />
        </>
      )}
      extra={(
        <span class="organization-meta">
          <span class="mono">{txt(o.id)}</span>
          <span>{t('organizations.projectCount', { count: Number(o.project_count) || 0 })}</span>
          <span>{t('organizations.projectItems', { count: Number(o.item_count) || 0 })}</span>
        </span>
      )}>
      {o.unassigned && !organizations.some((x) => !x.unassigned) && <p class="muted small">{t('organizations.noTarget')}</p>}
      {projects.length
        ? <ul class="project-list">{projects.map((p) => <ProjectRow key={p.id} project={p} organizations={organizations} onMoved={onMoved} />)}</ul>
        : <p class="muted small">{t('organizations.noProjects')}</p>}
    </Card>
  );
}

/** Renomear of an organization card (#23): opens the modal with the current name. */
function RenameButton({ organization: o, onRename }) {
  const label = t('organizations.rename.label', { name: txt(o.name) });
  return (
    <button type="button" class="button small" aria-label={label} title={label} onClick={() => onRename(o)}>
      <Icon of={Pencil} size={14} />{t('organizations.rename.button')}
    </button>
  );
}

/**
 * Excluir of an organization card: disabled while the organization has projects (count: the projects listed on the card, so the
 * button agrees with the list next to it), saying how many to move first.
 */
function RemoveButton({ organization: o, count, onRemove }) {
  const name = txt(o.name);
  const hint = `organization-remove-hint-${o.id}`;
  return (
    <span class="organization-remove">
      {count > 0 && <span id={hint} class="muted small">{t('organizations.remove.blocked', { count })}</span>}
      <button type="button" class="button small organization-remove-button" disabled={count > 0} aria-describedby={count > 0 ? hint : undefined}
        aria-label={t('organizations.remove.label', { name })}
        title={count > 0 ? t('organizations.remove.blockedTitle', { count, name }) : t('organizations.remove.label', { name })}
        onClick={() => onRemove(o)}>
        <Icon of={Trash2} size={14} />{t('organizations.remove.button')}
      </button>
    </span>
  );
}
