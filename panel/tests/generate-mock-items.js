#!/usr/bin/env node
'use strict';
// Writes tests/mock-items.json, the new model's part of the test mode (?mock=1): the answers of GET /api/items and
// GET /api/items/<project>/<number> for fictitious companies, projects and events. The answers come out of the
// server's own code (panel/api-items.js and the projection in bin/flow-projection.js) over an in-memory store,
// so the mock never drifts from the API shape. Run: node panel/tests/generate-mock-items.js

const fs = require('fs');
const path = require('path');
const { listItems, itemDetail } = require('../api-items.js');
const { STAGES } = require('../../bin/flow-store.js');

const OUT = path.join(__dirname, 'mock-items.json');
const GENERATED_AT = '2026-10-09T10:24:30-03:00';
const NO_HML = STAGES.filter((s) => s !== 'hml_validation');

const companies = {
  contoso: 'Contoso',
  fabrikam: 'Fabrikam',
  personal: 'Pessoal',
  unassigned: 'Sem empresa',
};
const projects = [
  { id: 'portal', name: 'Portal Contoso', company_id: 'contoso', tracker: 'azure_devops', stages: STAGES },
  { id: 'billing-api', name: 'Cobrança', company_id: 'contoso', tracker: 'azure_devops', stages: STAGES },
  { id: 'storefront', name: 'Loja', company_id: 'fabrikam', tracker: 'github', stages: NO_HML },
  { id: 'painel-maestro', name: 'painel-maestro', company_id: 'personal', tracker: 'github', stages: NO_HML },
  { id: 'scratch', name: 'scratch', company_id: 'unassigned', tracker: 'github', stages: STAGES },
].map((p) => ({ ...p, company_name: companies[p.company_id], done_state: null, maestri_workspace: null, created_at: '2026-10-01T09:00:00-03:00' }));

// [project, number, title, [ [ISO moment, stage], ... ] ]: the first moment starts the item at that stage.
const ITEMS = [
  ['portal', 3100, 'Conciliação de boletos com o extrato do banco', [['2026-10-01T09:10:00', 'specification'], ['2026-10-01T15:40:00', 'implementation'], ['2026-10-05T11:02:00', 'final_adjustment'], ['2026-10-06T10:15:00', 'pr_ready'], ['2026-10-07T17:30:00', 'merge'], ['2026-10-08T09:05:00', 'hml_validation']]],
  ['portal', 3112, 'Exportar o extrato em PDF', [['2026-10-07T14:00:00', 'specification'], ['2026-10-08T10:20:00', 'implementation']]],
  ['billing-api', 2875, 'Reprocessar cobranças recusadas pelo gateway', [['2026-10-03T08:30:00', 'implementation'], ['2026-10-07T16:45:00', 'final_adjustment'], ['2026-10-08T18:10:00', 'pr_ready']]],
  ['billing-api', 2901, 'Limite de tentativas por cartão', [['2026-10-09T08:50:00', 'specification']]],
  ['storefront', 48, 'Carrinho salvo entre dispositivos', [['2026-10-02T10:00:00', 'specification'], ['2026-10-02T16:00:00', 'implementation'], ['2026-10-09T09:40:00', 'final_adjustment']]],
  ['storefront', 52, 'Cupom de primeira compra', [['2026-10-04T11:00:00', 'implementation'], ['2026-10-06T13:20:00', 'pr_ready'], ['2026-10-08T20:05:00', 'merge']]],
  ['painel-maestro', 5, 'Item ponta a ponta (tracer bullet)', [['2026-10-09T07:30:00', 'implementation']]],
  ['painel-maestro', 2, 'Remover Trello e Prospecção', [['2026-10-06T09:00:00', 'implementation'], ['2026-10-06T18:30:00', 'pr_ready'], ['2026-10-07T08:10:00', 'merge'], ['2026-10-07T08:12:00', 'done']]],
  ['scratch', 3, 'Testar o layout do relatório', [['2026-10-09T10:05:00', 'specification']]],
];

const events = [];
for (const [projectId, number, title, steps] of ITEMS) {
  steps.forEach(([at, stage], i) => {
    events.push({
      id: 0, at: `${at}-03:00`, project_id: projectId, item_number: number, task_number: null,
      agent: { role: 'maestro', name: i % 2 ? 'Ária' : 'Bento' }, source: 'cli',
      type: i ? 'stage-changed' : 'item-started', payload: i ? { stage } : { title, stage },
    });
  });
}
events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
events.forEach((e, i) => { e.id = i + 1; });

// In-memory store with the same reads as bin/flow-store.js.
const store = {
  projects: () => projects,
  project: (id) => projects.find((p) => p.id === id) || null,
  allEvents: () => events,
  itemEvents: (projectId, number) => events.filter((e) => e.project_id === projectId && e.item_number === number),
};
const source = { store: () => store };

const { items } = listItems(source);
const details = {};
for (const it of items) details[it.key] = itemDetail(source, it.project.id, it.number).item;
fs.writeFileSync(OUT, `${JSON.stringify({ generated_at: GENERATED_AT, items, details }, null, 2)}\n`);
console.log(`mock-items.json: ${items.length} itens em ${new Set(items.map((i) => i.stage)).size} etapas`);
