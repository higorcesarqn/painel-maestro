// The end of an item's flow (#9): the PR (link and state), the final adjustment, the HML validation and the
// conclusion, as the server's projection computes them (GET /api/items/<project>/<number>). Also the texts of
// these events in the timeline and the filter of the item list (a done item leaves the active list but can still
// be found). Links only go to the trackers' domains (trackerHref).
import { useState } from 'preact/hooks';
import { obj, objs, txt, number, dateTime, age } from '../data/format.js';
import { trackerHref } from '../data/links.js';
import { markItemMerged } from '../data/api.js';
import { t, translateCode } from '../i18n/index.js';
import { Card, Badge, Segmented } from '../components/base.jsx';
import { Icon, ExternalLink, GitBranch, GitMerge, TriangleAlert } from '../components/Icon.jsx';
import '../styles/item-delivery.css';

const PR_TONE = { draft: 'neutral', ready: 'blue', merged: 'ok' };
const ADJUSTMENT_TONE = { open: 'blue', passed: 'ok', failed: 'danger' };
const HML_TONE = { approved: 'ok', failed: 'danger', blocked: 'warning' };

export function ItemDelivery({ item, onChange }) {
  const usesHml = objs(item.stages).some((s) => s.id === 'hml_validation');
  return (
    <Card class="delivery-card" label={t('delivery.title')} info={t('delivery.info')}>
      <div class="delivery-grid">
        <PrBlock pr={obj(item.pr)} tracker={item.tracker}>
          <MergeCheck item={item} onChange={onChange} />
        </PrBlock>
        <AdjustmentBlock adjustment={obj(item.final_adjustment)} />
        <HmlBlock hml={obj(item.hml)} uses={usesHml} />
        <CompletionBlock at={item.completed_at} />
      </div>
    </Card>
  );
}

function Block({ title, children }) {
  return (
    <section class="delivery-block">
      <h3 class="label">{title}</h3>
      {children}
    </section>
  );
}

/** A link that opens the tracker, or plain text when the URL is not a tracker's. */
function TrackerLink({ url, children }) {
  if (!trackerHref(url)) return <span>{children}</span>;
  return (
    <a class="link delivery-link" href={trackerHref(url)} target="_blank" rel="noopener noreferrer" title={t('delivery.openInTracker')}>
      {children}<Icon of={ExternalLink} size={13} />
    </a>
  );
}

function PrBlock({ pr, tracker, children }) {
  if (!pr) return <Block title={t('delivery.pr.title')}><p class="muted small">{t('delivery.pr.none')}</p></Block>;
  const when = pr.merged_at ? t('delivery.pr.mergedAt', { when: dateTime(pr.merged_at) })
    : pr.ready_at ? t('delivery.pr.readyAt', { when: dateTime(pr.ready_at) }) : t('delivery.pr.openedAt', { when: dateTime(pr.opened_at) });
  return (
    <Block title={t('delivery.pr.title')}>
      <div class="delivery-line">
        <Badge tone={PR_TONE[pr.state] || 'neutral'}>{t(`delivery.prStates.${pr.state}`)}</Badge>
        {(pr.url || pr.number) && (
          <TrackerLink url={pr.url}>{pr.number ? t(`delivery.prRef.${tracker === 'azure_devops' ? 'azure_devops' : 'github'}`, { number: pr.number }) : t('delivery.pr.link')}</TrackerLink>
        )}
      </div>
      {pr.branch && <div class="delivery-line small mono" title={t('delivery.pr.branch')}><Icon of={GitBranch} size={13} /><span>{txt(pr.branch)}</span></div>}
      <p class="muted small">{when}</p>
      {children}
    </Block>
  );
}

// ---------- merge check (#11) ----------
// While the PR is ready and not merged, the server reads it in the tracker from time to time (merge_check: when it
// last read it, or the code of the failure). The button records the merge by hand when that read fails.

function MergeCheck({ item, onChange }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const pr = obj(item.pr);
  if (!pr || pr.state !== 'ready') return null;
  const check = obj(item.merge_check);
  let status;
  if (check && check.error) {
    status = <p class="delivery-alert small" role="alert"><Icon of={TriangleAlert} size={13} />{t('delivery.mergeCheck.failed', { reason: translateCode(check.error), when: dateTime(check.checked_at) })}</p>;
  } else if (check && check.enabled === false) {
    status = <p class="muted small">{t('delivery.mergeCheck.off', { reason: translateCode(check.reason) })}</p>;
  } else if (check && check.checked_at) {
    status = <p class="muted small">{t('delivery.mergeCheck.checkedAt', { when: dateTime(check.checked_at) })}</p>;
  } else {
    status = <p class="muted small">{t('delivery.mergeCheck.waiting')}</p>;
  }
  const mark = async () => {
    if (!window.confirm(t('delivery.mergeCheck.confirm', { ref: txt(item.tracker_ref) }))) return;
    setBusy(true);
    setFailure(null);
    try {
      await markItemMerged(item.project.id, item.number);
      if (onChange) await onChange();
    } catch (e) {
      setFailure(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="delivery-stack merge-check">
      {status}
      <div class="delivery-line">
        <button type="button" class="button small" disabled={busy} title={t('delivery.mergeCheck.buttonTitle')} onClick={mark}>
          <Icon of={GitMerge} size={14} />{busy ? t('delivery.mergeCheck.marking') : t('delivery.mergeCheck.button')}
        </button>
      </div>
      {failure && <p class="delivery-alert small" role="alert">{t('delivery.mergeCheck.markFailed', { message: failure })}</p>}
    </div>
  );
}

function AdjustmentBlock({ adjustment: a }) {
  if (!a) return <Block title={t('delivery.adjustment.title')}><p class="muted small">{t('delivery.adjustment.none')}</p></Block>;
  const when = a.finished_at ? t('delivery.adjustment.finishedAt', { when: dateTime(a.finished_at) }) : t('delivery.adjustment.openedAt', { when: dateTime(a.opened_at) });
  return (
    <Block title={t('delivery.adjustment.title')}>
      <div class="delivery-line"><Badge tone={ADJUSTMENT_TONE[a.status] || 'neutral'}>{t(`delivery.adjustmentStates.${a.status}`)}</Badge></div>
      {a.summary && <p class="small pre delivery-summary">{txt(a.summary)}</p>}
      <p class="muted small">{when}</p>
    </Block>
  );
}

function HmlBlock({ hml: h, uses }) {
  if (!h) return <Block title={t('delivery.hml.title')}><p class="muted small">{uses ? t('delivery.hml.none') : t('delivery.hml.notUsed')}</p></Block>;
  return (
    <Block title={t('delivery.hml.title')}>
      <div class="delivery-line">
        <Badge tone={HML_TONE[h.outcome] || 'neutral'}>{t(`delivery.hmlOutcomes.${h.outcome}`)}</Badge>
        {h.card_url && <TrackerLink url={h.card_url}>{t('delivery.hml.card')}</TrackerLink>}
      </div>
      <dl class="hml-counts">
        <div class="ok"><dt class="muted small">{t('delivery.hml.passed')}</dt><dd>{number(h.passed)}</dd></div>
        <div class="danger"><dt class="muted small">{t('delivery.hml.failed')}</dt><dd>{number(h.failed)}</dd></div>
        <div class="warning"><dt class="muted small">{t('delivery.hml.blocked')}</dt><dd>{number(h.blocked)}</dd></div>
      </dl>
      {h.summary && <p class="small pre delivery-summary">{txt(h.summary)}</p>}
      <p class="muted small">{t('delivery.hml.recordedAt', { when: dateTime(h.recorded_at) })}</p>
    </Block>
  );
}

function CompletionBlock({ at }) {
  return (
    <Block title={t('delivery.completion.title')}>
      {at ? (
        <div class="delivery-stack">
          <div class="delivery-line"><Badge tone="ok">{t('delivery.completion.done')}</Badge></div>
          <p class="muted small">{t('delivery.completion.at', { when: dateTime(at), age: age(at) })}</p>
        </div>
      ) : <p class="muted small">{t('delivery.completion.pending')}</p>}
    </Block>
  );
}

/** Text of a delivery event in the timeline, or null when the event is not one of them. */
export function deliveryEventText(e) {
  const p = obj(e.payload) || {};
  if (e.type === 'pr-changed' && p.state === 'merged' && e.source === 'panel') return t(`delivery.events.prMergedByPanel.${obj(e.agent) && e.agent.role === 'owner' ? 'owner' : 'check'}`);
  if (e.type === 'pr-changed') return t(`delivery.events.pr.${p.state}`);
  if (e.type === 'final-adjustment-opened') return t('delivery.events.adjustmentOpened');
  if (e.type === 'final-adjustment-finished') return t(`delivery.events.adjustment.${p.outcome}`);
  if (e.type === 'hml-recorded') return t('delivery.events.hml', { passed: number(p.passed), failed: number(p.failed), blocked: number(p.blocked) });
  if (e.type === 'item-done') return t('delivery.events.itemDone');
  return null;
}

/** Filter of the item list: active (default), done or all. Returns the items shown and the control. */
export function useDoneFilter(items) {
  const [which, setWhich] = useState('active');
  const active = items.filter((it) => it.active !== false);
  const done = items.filter((it) => it.active === false);
  const shown = which === 'active' ? active : which === 'done' ? done : items;
  const control = (
    <Segmented label={t('delivery.listFilter.label')} value={which} onChange={setWhich} options={[
      { id: 'active', name: t('delivery.listFilter.active'), n: active.length },
      { id: 'done', name: t('delivery.listFilter.done'), n: done.length },
      { id: 'all', name: t('delivery.listFilter.all'), n: items.length },
    ]} />
  );
  return { shown, control, which };
}
