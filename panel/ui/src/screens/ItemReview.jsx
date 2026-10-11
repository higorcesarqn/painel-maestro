// Reports and findings of an item (#8): the workers' reports grouped by task (the last one open, the older ones
// folded; each with its diff summary when it has one, #54) and the maestro's findings with their classification and
// the new task each one became. Also the texts of these events in the timeline. Everything comes computed by the
// server's projection
// (GET /api/items/<project>/<number> → item.reports, item.findings, tasks[].finding); the texts are shown exactly as
// the agents wrote them (only as text, never as HTML).
import { arr, obj, objs, txt, dateTime, age, number } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Card, Badge, Empty } from '../components/base.jsx';
import { FileText, Search } from '../components/Icon.jsx';
import { TaskStateBadge } from './ItemTasks.jsx';
import '../styles/item-review.css';

const STATUS_TONE = { ok: 'ok', blocked: 'danger' };
const CLASS_TONE = { defect: 'danger', owner_decision: 'warning', discarded: 'neutral' };

/** The task number as the tracker shows it: "#13" on GitHub, the card id on Azure DevOps. */
const taskRef = (tracker, n) => (tracker === 'azure_devops' ? String(n) : `#${n}`);
const agentLine = (agent) => {
  const a = obj(agent) || {};
  return arr([a.role ? t(`items.roles.${a.role}`) : '', txt(a.name)]).filter(Boolean).join(' · ');
};

function ReportField({ label, children }) {
  return (
    <div class="report-field">
      <dt class="label">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The diff summary of a report (TaskDiff, #54): the totals and the files the task committed since it left the
 * integration branch, with the lines added and removed, and the "also in task #N" tag on the files another task of the
 * item also changed (also_in, #56; tracker formats the number). Nothing when the report has none (old, or no base).
 */
function DiffSummary({ diff, tracker }) {
  const d = obj(diff);
  if (!d) return null;
  const files = objs(d.files).filter((f) => typeof f.path === 'string');
  const total = obj(d.total) || {};
  const plusMinus = (added, removed) => (
    <>
      <span class="diff-added" title={t('review.diff.addedTitle')}>{t('review.diff.added', { count: number(added) })}</span>
      <span class="diff-removed" title={t('review.diff.removedTitle')}>{t('review.diff.removed', { count: number(removed) })}</span>
    </>
  );
  return (
    <ReportField label={t('review.fields.diff')}>
      <div class="report-diff">
        <p class="report-diff-total small">
          <span>{t('review.diff.files', { count: Number.isInteger(total.files) ? total.files : files.length })}</span>
          <span class="mono">{plusMinus(total.added, total.removed)}</span>
          {d.base_ref && <span class="muted mono" title={txt(d.base)}>{t('review.diff.base', { base: txt(d.base_ref) })}</span>}
        </p>
        {files.length > 0 ? (
          <ul class="report-diff-files small mono">
            {files.map((f, i) => (
              <li key={i}>
                <span class="diff-name">
                  <span class="diff-path" title={f.path}>{f.path}</span>
                  {arr(f.also_in).filter(Number.isInteger).map((n) => (
                    <Badge key={n} tone="warning" class="diff-also">{t('review.diff.alsoIn', { task: taskRef(tracker, n) })}</Badge>
                  ))}
                </span>
                {plusMinus(f.added, f.removed)}
              </li>
            ))}
          </ul>
        ) : <p class="muted small">{t('review.diff.empty')}</p>}
      </div>
    </ReportField>
  );
}

function Report({ report: r, open, tracker }) {
  const decisions = arr(r.decisions).filter((x) => typeof x === 'string');
  const files = arr(r.shared_files).filter((x) => typeof x === 'string');
  return (
    <details class="report" open={open}>
      <summary class="report-summary">
        <Badge tone={STATUS_TONE[r.status] || 'neutral'}>{t(`review.reportStatus.${r.status === 'blocked' ? 'blocked' : 'ok'}`)}</Badge>
        <span class="muted small mono" title={dateTime(r.at)}>{dateTime(r.at)}</span>
        <span class="muted small">{agentLine(r.agent)}</span>
        {r.branch && <span class="small mono report-branch" title={txt(r.branch)}>{txt(r.branch)}</span>}
        {r.sha && <span class="small mono" title={txt(r.sha)}>{String(r.sha).slice(0, 7)}</span>}
      </summary>
      <dl class="report-body">
        {r.blocked_reason && <ReportField label={t('review.fields.blockedReason')}><p class="pre small">{txt(r.blocked_reason)}</p></ReportField>}
        {r.tests && <ReportField label={t('review.fields.tests')}><p class="pre small">{txt(r.tests)}</p></ReportField>}
        {r.changes && <ReportField label={t('review.fields.changes')}><p class="pre small">{txt(r.changes)}</p></ReportField>}
        <DiffSummary diff={r.diff} tracker={tracker} />
        {decisions.length > 0 && (
          <ReportField label={t('review.fields.decisions')}>
            <ol class="report-decisions small">{decisions.map((d, i) => <li key={i} class="pre">{d}</li>)}</ol>
          </ReportField>
        )}
        {r.risks && <ReportField label={t('review.fields.risks')}><p class="pre small">{txt(r.risks)}</p></ReportField>}
        {files.length > 0 && (
          <ReportField label={t('review.fields.sharedFiles')}>
            <ul class="report-files small mono">{files.map((f, i) => <li key={i}>{f}</li>)}</ul>
          </ReportField>
        )}
        {r.text && <ReportField label={t('review.fields.text')}><p class="pre small report-text">{txt(r.text)}</p></ReportField>}
      </dl>
    </details>
  );
}

/** The reports card: one group per task, in the order of the tasks; the last report of each task comes open. */
export function ItemReports({ item }) {
  const reports = objs(item.reports).filter((r) => Number.isInteger(r.task_number));
  const tasks = objs(item.tasks);
  const order = [...tasks.map((x) => x.number), ...reports.map((r) => r.task_number)].filter((n, i, all) => all.indexOf(n) === i);
  const groups = order.map((n) => ({ task: tasks.find((x) => x.number === n), number: n, reports: reports.filter((r) => r.task_number === n) }))
    .filter((g) => g.reports.length);
  return (
    <Card label={t('review.reports.title')} info={t('review.reports.info')} extra={reports.length ? t('review.reports.count', { count: reports.length }) : null} class="item-reports" scroll>
      {!groups.length && <Empty icon={FileText} center>{t('review.reports.none')}</Empty>}
      {groups.map((g) => (
        <section key={g.number} class="report-group">
          <h3 class="report-task">
            <span class="mono">{taskRef(item.tracker, g.number)}</span>
            <span>{txt(g.task && g.task.title) || t('items.tasks.untitled')}</span>
            {g.task && <TaskStateBadge state={g.task.state} />}
          </h3>
          {g.reports.slice().reverse().map((r, i) => <Report key={r.id || i} report={r} open={i === 0} tracker={item.tracker} />)}
        </section>
      ))}
    </Card>
  );
}

/** The findings card: what the maestro found in the reviews, how it was classified and the task it became. */
export function ItemFindings({ item }) {
  const findings = objs(item.findings).filter((f) => Number.isInteger(f.number));
  const tasks = objs(item.tasks);
  return (
    <Card label={t('review.findings.title')} info={t('review.findings.info')} extra={findings.length ? t('review.findings.count', { count: findings.length }) : null} class="item-findings" scroll>
      {!findings.length && <Empty icon={Search} center>{t('review.findings.none')}</Empty>}
      {findings.length > 0 && (
        <ol class="finding-list">
          {findings.map((f) => {
            const newTask = obj(f.new_task);
            const task = newTask && tasks.find((x) => x.number === newTask.number);
            const origin = Number.isInteger(f.origin_task) ? taskRef(item.tracker, f.origin_task) : null;
            return (
              <li key={f.number} class={`finding ${f.classification}`}>
                <span class="finding-number mono" aria-label={t('review.findings.number', { finding: f.number })}>{f.number}</span>
                <div class="finding-main">
                  <div class="finding-line">
                    <span class="finding-title">{txt(f.title)}</span>
                    <Badge tone={CLASS_TONE[f.classification] || 'neutral'}>{t(`review.classes.${CLASS_TONE[f.classification] ? f.classification : 'discarded'}`)}</Badge>
                  </div>
                  {f.description && <p class="pre muted small finding-description">{txt(f.description)}</p>}
                  <div class="finding-meta small muted">
                    {origin && <span>{t('review.findings.origin', { task: origin })}</span>}
                    {newTask && (
                      <span class="finding-task" title={txt(newTask.title)}>
                        {t('review.findings.newTask', { task: taskRef(item.tracker, newTask.number) })}
                        {task && <TaskStateBadge state={task.state} />}
                      </span>
                    )}
                    <span title={dateTime(f.recorded_at)}>{t('review.findings.recorded', { age: age(f.recorded_at), agent: agentLine(f.agent) || '—' })}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/** Text of a report or finding event in the timeline, or null when the event is not one of them. */
export function reviewEventText(e) {
  const p = obj(e.payload) || {};
  const newTask = obj(p.new_task);
  if (e.type === 'task-report') {
    return t('review.events.report', { task: e.task_number, status: t(`review.reportStatus.${p.status === 'blocked' ? 'blocked' : 'ok'}`) });
  }
  if (e.type === 'finding-recorded') {
    const params = { finding: p.finding, title: txt(p.title), classification: t(`review.classes.${CLASS_TONE[p.classification] ? p.classification : 'discarded'}`) };
    return newTask ? t('review.events.findingWithTask', { ...params, task: newTask.number }) : t('review.events.finding', params);
  }
  if (e.type === 'finding-linked') return t('review.events.findingLinked', { finding: p.finding, task: newTask ? newTask.number : '—' });
  return null;
}
