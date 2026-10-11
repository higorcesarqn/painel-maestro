// Organizations (#21), the first sub-tab of Settings (#48, screens/Settings.jsx): the whole register, one card per
// organization with its projects, whatever the organization selector at the top says, the hidden organizations included (#50;
// a note tells so: a move's destination is never hidden). It is the only place that reads them (?hidden=include). The cards come
// in the order of GET /api/organizations (alphabetical, "unassigned" last), a hidden one in its usual place with the "Oculta" badge
// and its open pending decisions, which reach the panel nowhere else; "unassigned" shows when it has projects or is hidden (to be
// shown again). Each project is a ProjectRow, shared with the "unassigned" card of the Items screen. The new organization button
// opens OrganizationCreateModal (#22); with no organization yet, the screen points to it. Every card has Ocultar / Mostrar (#50),
// without a confirmation (undoing is one click); each organization but "unassigned" also has Renomear (#23), which opens
// OrganizationRenameModal, and Excluir (#24): disabled with the number of projects to move first, otherwise it opens
// OrganizationRemoveModal. Reads GET /api/organizations and GET /api/projects every 20 s; after a move, a creation, a rename,
// a removal, hiding or showing it reads both again, reloads the organization selector (the other screens read the names from the
// API again on their next read) and shows a status notice; removing the organization of the selector sets it back to all (hiding
// it does not: the selector counts a hidden choice as all and keeps it for when it is shown again).
import { useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { readOrganizations, readProjects, hideOrganization, unhideOrganization } from '../data/api.js';
import { usePolling } from '../data/polling.js';
import { obj, objs, txt } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Badge, Card, Empty, Skeleton } from '../components/base.jsx';
import { Icon, Building, Eye, EyeOff, Info, Pencil, Plus, Trash2 } from '../components/Icon.jsx';
import { ProjectRow } from './ProjectRow.jsx';
import { OrganizationCreateModal } from './OrganizationCreateModal.jsx';
import { OrganizationRenameModal } from './OrganizationRenameModal.jsx';
import { OrganizationRemoveModal } from './OrganizationRemoveModal.jsx';
import '../styles/organizations.css';

// The whole register, the hidden organizations and their projects included (#50).
const WHOLE = { hidden: 'include' };

async function readRegister() {
  const [o, p] = await Promise.all([readOrganizations(WHOLE), readProjects(WHOLE)]);
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
  const shown = organizations.filter((o) => !o.unassigned || o.hidden || projectsOf(o).length > 0);
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
  const toggled = (organization) => {
    const name = txt(organization.name);
    changed(organization.hidden ? t('organizations.hide.hidden', { name }) : t('organizations.hide.shown', { name }));
  };
  const toggleFailed = (organization, message) => {
    setActionStatus(t('organizations.hide.failed', { name: txt(organization.name), message }));
    failed();
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
            <OrganizationCard key={o.id} organization={o} projects={projectsOf(o)} organizations={organizations} onMoved={changed} onRename={setRenaming} onRemove={setRemoving}
              onToggled={toggled} onToggleFailed={toggleFailed} />
          ))}
        </div>
      )}
      {creating && <OrganizationCreateModal onCreated={created} onClose={() => setCreating(false)} />}
      {renaming && <OrganizationRenameModal organization={renaming} onRenamed={renamed} onFailed={failed} onClose={() => setRenaming(null)} />}
      {removing && <OrganizationRemoveModal organization={removing} onRemoved={removed} onFailed={failed} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function OrganizationCard({ organization: o, projects, organizations, onMoved, onRename, onRemove, onToggled, onToggleFailed }) {
  const open = Number(o.open_pending_count) || 0;
  return (
    <Card class={`organization-card${o.unassigned ? ' unassigned' : ''}`} label={txt(o.name)}
      info={o.unassigned ? t('organizations.unassignedInfo') : undefined}
      actions={(
        <>
          <HideButton organization={o} onToggled={onToggled} onFailed={onToggleFailed} />
          {!o.unassigned && <RenameButton organization={o} onRename={onRename} />}
          {!o.unassigned && <RemoveButton organization={o} count={projects.length} onRemove={onRemove} />}
        </>
      )}
      extra={(
        <span class="organization-meta">
          {o.hidden && <Badge class="organization-hidden-badge" title={t('organizations.hiddenTitle')}>{t('organizations.hidden')}</Badge>}
          {o.hidden && (
            <span class={open > 0 ? 'organization-open-pending' : undefined} title={t('organizations.openPendingTitle')}>
              {t('organizations.openPending', { count: open })}
            </span>
          )}
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

/**
 * Ocultar / Mostrar of an organization card (#50): hides or shows it at once, without a confirmation (undoing is one click).
 * onToggled(organization) gets the organization as the API answered it; onFailed(organization, message) the error.
 */
function HideButton({ organization: o, onToggled, onFailed }) {
  const [busy, setBusy] = useState(false);
  const name = txt(o.name);
  // What the button does now: show a hidden organization, or hide a visible one.
  const action = o.hidden
    ? { call: unhideOrganization, icon: Eye, text: t('organizations.hide.showButton'), label: t('organizations.hide.showLabel', { name }) }
    : { call: hideOrganization, icon: EyeOff, text: t('organizations.hide.button'), label: t('organizations.hide.label', { name }) };
  const toggle = async () => {
    setBusy(true);
    try {
      onToggled((await action.call(o.id)).organization);
    } catch (e) {
      onFailed(o, e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" class="button small" aria-label={action.label} title={action.label} disabled={busy} onClick={toggle}>
      <Icon of={action.icon} size={14} />
      {busy ? t('organizations.hide.busy') : action.text}
    </button>
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
