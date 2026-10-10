// Companies (#21): the whole register, one card per company with its projects, whatever the company selector at the
// top says (a note tells so: a move's destination is never hidden). The cards come in the order of GET /api/companies
// (alphabetical, "Sem empresa" last); "Sem empresa" shows only when it has projects. Each project is a ProjectRow,
// shared with the "Sem empresa" card of the Items screen. The "Nova empresa" button opens CompanyCreateModal (#22);
// with no company yet, the screen points to it. Each company but "Sem empresa" has Renomear (#23), which opens
// CompanyRenameModal, and Excluir (#24): disabled with the number of projects to move first, otherwise it opens
// CompanyRemoveModal. Reads GET /api/companies and GET /api/projects every 20 s; after a move, a creation, a rename or
// a removal it reads both again, reloads the company selector (the other screens read the names from the API again on
// their next read) and shows a status notice; removing the company of the selector sets it back to all.
import { useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { readCompanies, readProjects } from '../data/api.js';
import { usePolling } from '../data/polling.js';
import { obj, objs, txt } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Card, Empty, Skeleton } from '../components/base.jsx';
import { Icon, Building, Info, Pencil, Plus, Trash2 } from '../components/Icon.jsx';
import { ProjectRow } from './ProjectRow.jsx';
import { CompanyCreateModal } from './CompanyCreateModal.jsx';
import { CompanyRenameModal } from './CompanyRenameModal.jsx';
import { CompanyRemoveModal } from './CompanyRemoveModal.jsx';
import '../styles/companies.css';

async function readRegister() {
  const [c, p] = await Promise.all([readCompanies(), readProjects()]);
  return { companies: objs(c && c.companies), projects: objs(p && p.projects) };
}

export function Companies() {
  const { company: selected, setCompany, reloadCompanies, setActionStatus } = usePanel();
  const { answer, error, reload } = usePolling(readRegister, []);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [removing, setRemoving] = useState(null);
  const companies = answer ? answer.companies : [];
  const projects = answer ? answer.projects : [];
  const projectsOf = (c) => projects.filter((p) => (obj(p.company) || {}).id === c.id);
  const shown = companies.filter((c) => !c.unassigned || projectsOf(c).length > 0);
  const changed = (message) => {
    setActionStatus(message);
    reload();
    reloadCompanies();
  };
  const created = (company) => {
    setCreating(false);
    changed(t('companies.create.created', { name: txt(company.name) }));
  };
  const renamed = (company, from) => {
    setRenaming(null);
    changed(t('companies.rename.renamed', { from, name: txt(company.name) }));
  };
  const failed = () => {
    reload();
    reloadCompanies();
  };
  const removed = (company) => {
    setRemoving(null);
    if (selected === company.id) setCompany('');
    changed(t('companies.remove.removed', { name: txt(company.name) }));
  };
  return (
    <div class="screen screen-companies">
      <div class="companies-top">
        <p class="companies-note muted small"><Icon of={Info} size={14} />{t('companies.screenNote')}</p>
        <button type="button" class="button primary" onClick={() => setCreating(true)}><Icon of={Plus} size={15} />{t('companies.create.button')}</button>
      </div>
      {error && <p class="companies-error small" role="alert">{t('companies.readFailed', { message: error.message })}</p>}
      {!answer && !error && <Card><Skeleton /><Skeleton style={{ marginTop: '10px' }} /></Card>}
      {answer && !shown.length && <Card><Empty icon={Building} center>{t('companies.none')}</Empty></Card>}
      {shown.length > 0 && (
        <div class="companies-grid">
          {shown.map((c) => (
            <CompanyCard key={c.id} company={c} projects={projectsOf(c)} companies={companies} onMoved={changed} onRename={setRenaming} onRemove={setRemoving} />
          ))}
        </div>
      )}
      {creating && <CompanyCreateModal onCreated={created} onClose={() => setCreating(false)} />}
      {renaming && <CompanyRenameModal company={renaming} onRenamed={renamed} onFailed={failed} onClose={() => setRenaming(null)} />}
      {removing && <CompanyRemoveModal company={removing} onRemoved={removed} onFailed={failed} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function CompanyCard({ company: c, projects, companies, onMoved, onRename, onRemove }) {
  return (
    <Card class={`company-card${c.unassigned ? ' unassigned' : ''}`} label={txt(c.name)}
      info={c.unassigned ? t('companies.unassignedInfo') : undefined}
      actions={c.unassigned ? undefined : (
        <>
          <RenameButton company={c} onRename={onRename} />
          <RemoveButton company={c} count={projects.length} onRemove={onRemove} />
        </>
      )}
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

/** Renomear of a company card (#23): opens the modal with the current name. */
function RenameButton({ company: c, onRename }) {
  const label = t('companies.rename.label', { name: txt(c.name) });
  return (
    <button type="button" class="button small" aria-label={label} title={label} onClick={() => onRename(c)}>
      <Icon of={Pencil} size={14} />{t('companies.rename.button')}
    </button>
  );
}

/**
 * Excluir of a company card: disabled while the company has projects (count: the projects listed on the card, so the
 * button agrees with the list next to it), saying how many to move first.
 */
function RemoveButton({ company: c, count, onRemove }) {
  const name = txt(c.name);
  const hint = `company-remove-hint-${c.id}`;
  return (
    <span class="company-remove">
      {count > 0 && <span id={hint} class="muted small">{t('companies.remove.blocked', { count })}</span>}
      <button type="button" class="button small company-remove-button" disabled={count > 0} aria-describedby={count > 0 ? hint : undefined}
        aria-label={t('companies.remove.label', { name })}
        title={count > 0 ? t('companies.remove.blockedTitle', { count, name }) : t('companies.remove.label', { name })}
        onClick={() => onRemove(c)}>
        <Icon of={Trash2} size={14} />{t('companies.remove.button')}
      </button>
    </span>
  );
}
