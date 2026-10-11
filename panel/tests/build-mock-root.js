#!/usr/bin/env node
'use strict';
/*
 * build-mock-root.js: builds a fake data folder (MAESTRO_DIR) with the demo's organizations (the hidden one too, #50), projects and events
 * (generate-mock-items.js) in a real maestro.db, to look at index.html with the real server.js (and not with ?mock=1).
 *
 * Usage:
 *   node tests/build-mock-root.js [folder] [--hostile]
 *     folder     default: tests/tmp/mock-root (always inside tests/tmp/)
 *     --hostile  adds an item whose texts carry HTML, javascript: links and huge texts (title, report, finding,
 *                pending decision), to check that the page shows everything as text
 *   Then:
 *     MAESTRO_DIR=<folder> PANEL_NOW=<the demo's moment> PANEL_COLLECTOR=0 node server.js --port 4793
 *   (the script prints the ready line)
 */
const fs = require('fs');
const path = require('path');
const { openStore, UNASSIGNED_ORGANIZATION } = require('../../bin/flow-store.js');
const { GENERATED_AT, organizations, HIDDEN, projects, events } = require('./generate-mock-items.js');

const TMP = path.join(__dirname, 'tmp');
const args = process.argv.slice(2);
const hostile = args.includes('--hostile');
const folderArg = args.find((a) => !a.startsWith('--'));
const root = path.resolve(folderArg || path.join(TMP, 'mock-root'));
if (!root.startsWith(TMP + path.sep)) {
  console.error(`A raiz falsa precisa ficar dentro de ${TMP.replace(/\\/g, '/')}.`);
  process.exit(2);
}

const HOSTILE_ITEM = 4242;
const HTML = '<img src=x onerror="document.title=\'XSS\'">';
/** Events of an item whose every text tries to become HTML. */
function hostileEvents() {
  const at = (hhmm) => `2026-10-09T${hhmm}:00-03:00`;
  const e = (time, type, payload, task = null, role = 'maestro', name = '<b>Bento</b>') => ({
    at: at(time), project_id: 'portal', item_number: HOSTILE_ITEM, task_number: task, agent: { role, name }, source: 'cli', type, payload,
  });
  return [
    e('09:00', 'item-started', { title: `<script>document.title="XSS"</script> ${HTML} ${'título longo '.repeat(40)}`, stage: 'implementation' }),
    e('09:01', 'task-graph', { tasks: [{ number: 4243, title: `<a href="javascript:alert(1)">task</a>`, blocked_by: [], out: false }] }),
    e('09:02', 'task-dispatched', { floor: '<i>floor</i>', worker: '<u>Ária</u>', branch: 'task/4243-<b>x</b>' }, 4243),
    e('09:30', 'task-report', {
      status: 'blocked', blocked_reason: HTML, branch: 'task/4243', sha: '<b>sha</b>', tests: '<svg onload=alert(1)>', changes: 'longa '.repeat(400),
      decisions: ['<iframe src=//x>'], risks: '<style>body{display:none}</style>', shared_files: ['<b>a</b>'], text: `${HTML}\nsegunda linha`,
    }, 4243, 'worker', '<u>Ária</u>'),
    e('09:40', 'finding-recorded', { finding: 1, title: HTML, description: '<script>alert(1)</script>', classification: 'defect', origin_task: 4243, new_task: null }, 4243),
    e('09:50', 'pending-decision-opened', {
      kind: 'decision', severity: 'critical', title: `${HTML} pendência hostil`, context: '<script>alert(1)</script>\nsegunda linha',
      options: ['<b>A</b>', 'B: javascript:alert(1)'], recommendation: '<u>sublinhado</u>', maestri: { workspace: '<b>ws</b>', terminal: '<i>t</i>' },
    }),
    e('09:55', 'pr-changed', { state: 'draft', url: 'javascript:alert(1)', branch: '<b>feature/pbi-4242</b>' }),
  ];
}

fs.rmSync(root, { recursive: true, force: true });
const store = openStore({ dir: root });
try {
  store.transaction(() => {
    for (const [id, name] of Object.entries(organizations)) store.ensureOrganization(id, name, '2026-10-01T09:00:00-03:00');
    for (const id of HIDDEN) store.setOrganizationHidden(id, true, '2026-10-01T09:00:00-03:00');
    for (const p of projects) {
      const [first, ...others] = p.repos;
      // "Sem organização" only receives the unregistered repositories (the store refuses it in addProject).
      const fields = {
        id: p.id, name: p.name, tracker: p.tracker, stages: p.stages, remote: first, at: p.created_at,
        doneState: p.done_state, maestriWorkspace: p.maestri_workspace,
      };
      if (p.organization_id === UNASSIGNED_ORGANIZATION) store.addUnregisteredProject(fields);
      else store.addProject({ ...fields, organizationId: p.organization_id });
      for (const r of others) store.addRepo(p.id, r);
    }
    // The ids of maestro.db follow the order of writing: the same order (and ids) of the generator.
    for (const e of [...events, ...(hostile ? hostileEvents() : [])]) {
      store.appendEvent({
        at: e.at, type: e.type, projectId: e.project_id, itemNumber: e.item_number, taskNumber: e.task_number,
        agentRole: e.agent.role, agentName: e.agent.name, source: e.source, payload: e.payload,
      });
    }
  });
} finally {
  store.close();
}

const rel = root.replace(/\\/g, '/');
console.log(`Raiz falsa montada em ${rel}${hostile ? ` (com o item hostil portal/${HOSTILE_ITEM})` : ''}`);
console.log(`Para subir: MAESTRO_DIR=${rel} PANEL_NOW=${GENERATED_AT} PANEL_COLLECTOR=0 node ${path.join(__dirname, '..', 'server.js').replace(/\\/g, '/')} --port 4793`);
