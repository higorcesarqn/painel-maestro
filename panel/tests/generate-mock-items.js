#!/usr/bin/env node
'use strict';
// Writes tests/mock-items.json, the new model's part of the test mode (?mock=1): the answers of GET /api/items and
// GET /api/items/<project>/<number> for fictitious companies, projects and events. The answers come out of the
// server's own code (panel/api-items.js and the projection in bin/flow-projection.js) over an in-memory store,
// so the mock never drifts from the API shape. Run: node panel/tests/generate-mock-items.js
// Usage and agents per item (#13): fictitious sessions linked to the items' maestros and the tasks' workers go into a
// temporary bruto.db with their transcripts; the real collector (bin/collect-usage.js) reads them with the plan of
// tests/mock-state.json, and the real API (panel/api-usage.js) writes the answers of GET /api/usage and /api/agents.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { listItems, itemDetail } = require('../api-items.js');
const { usageAnswer, listAgents } = require('../api-usage.js');
const { STAGES } = require('../../bin/flow-store.js');
const { openRawStore } = require('../../bin/raw-store.js');
const { collect } = require('../../bin/collect-usage.js');

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

// PR, final adjustment, HML and conclusion (#9): a step may be an event [type, payload, role?] instead of a stage.
const GH = (repo, n) => `https://github.com/${repo}/pull/${n}`;
const ADO = (repo, n) => `https://dev.azure.com/contoso/Portal/_git/${repo}/pullrequest/${n}`;
const CARD = (n) => `https://dev.azure.com/contoso/Portal/_workitems/edit/${n}`;
const pr = (state, extra = {}) => ['pr-changed', { state, ...extra }];
const adjustmentOpened = ['final-adjustment-opened', {}];
const adjustment = (outcome, summary) => ['final-adjustment-finished', summary ? { outcome, summary } : { outcome }];
const hml = (passed, failed, blocked, card, summary) => ['hml-recorded', { passed, failed, blocked, card_url: card, ...(summary ? { summary } : {}) }, 'owner'];
const itemDone = ['item-done', {}];

// [project, number, title, [ [ISO moment, stage | event], ... ] ]: the first moment starts the item at that stage.
const ITEMS = [
  ['portal', 3100, 'Conciliação de boletos com o extrato do banco', [['2026-10-01T09:10:00', 'specification'], ['2026-10-01T15:40:00', 'implementation'],
    ['2026-10-01T15:45:00', pr('draft', { url: ADO('portal-web', 812), branch: 'feature/pbi-3100' })], ['2026-10-05T11:02:00', adjustmentOpened],
    ['2026-10-05T16:20:00', adjustment('passed', 'Testes e build ok; 2 ajustes de nomenclatura pedidos na revisão.')], ['2026-10-06T10:15:00', pr('ready')],
    ['2026-10-07T17:30:00', pr('merged')],
    ['2026-10-08T09:05:00', hml(5, 1, 1, CARD(3100), 'Cenário 4 reprovado: o extrato de outubro veio sem a tarifa.\nCenário 6 bloqueado: sem massa de boletos vencidos em HML.')]]],
  ['portal', 3112, 'Exportar o extrato em PDF', [['2026-10-07T14:00:00', 'specification'], ['2026-10-08T10:20:00', 'implementation'],
    ['2026-10-08T10:25:00', pr('draft', { url: ADO('portal-web', 830), branch: 'feature/pbi-3112' })]]],
  ['portal', 3088, 'Segunda via de boleto pelo portal', [['2026-09-28T09:00:00', 'implementation'],
    ['2026-09-28T09:05:00', pr('draft', { url: ADO('portal-web', 790), branch: 'feature/pbi-3088' })], ['2026-09-30T14:00:00', adjustmentOpened],
    ['2026-09-30T17:10:00', adjustment('passed')], ['2026-10-01T08:30:00', pr('ready')], ['2026-10-02T11:00:00', pr('merged')],
    ['2026-10-03T15:40:00', hml(8, 0, 0, CARD(3088))], ['2026-10-03T16:00:00', itemDone]]],
  ['billing-api', 2875, 'Reprocessar cobranças recusadas pelo gateway', [['2026-10-03T08:30:00', 'implementation'],
    ['2026-10-03T08:40:00', pr('draft', { url: 'https://contoso.visualstudio.com/Billing/_git/billing-api/pullrequest/415', branch: 'feature/pbi-2875' })],
    ['2026-10-07T16:45:00', adjustmentOpened], ['2026-10-08T11:30:00', adjustment('failed', 'Teste de concorrência falhou; virou uma task nova.')],
    ['2026-10-08T15:00:00', adjustmentOpened], ['2026-10-08T17:50:00', adjustment('passed')], ['2026-10-08T18:10:00', pr('ready')]]],
  ['billing-api', 2901, 'Limite de tentativas por cartão', [['2026-10-09T08:50:00', 'specification']]],
  ['storefront', 48, 'Carrinho salvo entre dispositivos', [['2026-10-02T10:00:00', 'specification'], ['2026-10-02T16:00:00', 'implementation'],
    ['2026-10-02T16:05:00', pr('draft', { url: GH('fabrikam/storefront', 61), branch: 'feature/issue-48' })], ['2026-10-09T09:40:00', adjustmentOpened]]],
  ['storefront', 52, 'Cupom de primeira compra', [['2026-10-04T11:00:00', 'implementation'],
    ['2026-10-06T13:20:00', pr('ready', { url: GH('fabrikam/storefront', 63), branch: 'feature/issue-52' })], ['2026-10-08T20:05:00', pr('merged')]]],
  ['painel-maestro', 5, 'Item ponta a ponta (tracer bullet)', [['2026-10-09T07:30:00', 'implementation']]],
  ['painel-maestro', 2, 'Remover Trello e Prospecção', [['2026-10-06T09:00:00', 'implementation'],
    ['2026-10-06T18:30:00', pr('ready', { url: GH('higorcesarqn/painel-maestro', 14), branch: 'feature/issue-2' })], ['2026-10-07T08:10:00', pr('merged')],
    ['2026-10-07T08:12:00', itemDone]]],
  ['scratch', 3, 'Testar o layout do relatório', [['2026-10-09T10:05:00', 'specification']]],
];

const events = [];
for (const [projectId, number, title, steps] of ITEMS) {
  steps.forEach(([at, step], i) => {
    const [type, payload, role] = typeof step === 'string'
      ? [i ? 'stage-changed' : 'item-started', i ? { stage: step } : { title, stage: step }]
      : step;
    events.push({
      id: 0, at: `${at}-03:00`, project_id: projectId, item_number: number, task_number: null,
      agent: { role: role || 'maestro', name: role === 'owner' ? null : i % 2 ? 'Ária' : 'Bento' }, source: 'cli',
      type, payload,
    });
  });
}

// Tasks: [project, number, ISO moment, type, task, [role, name], payload]. PBI 3112 has a task in every state; the other
// items with a graph are part way; items without one show a single task, themselves.
const MAESTRO = ['maestro', 'Bento'];
const TASKS = [
  ['portal', 3100, '2026-10-01T15:45:00', 'task-graph', null, MAESTRO, { tasks: [
    { number: 3101, title: 'Importar o extrato OFX', blocked_by: [], out: false },
    { number: 3102, title: 'Casar boletos com lançamentos', blocked_by: [3101], out: false },
  ] }],
  ['portal', 3100, '2026-10-01T16:00:00', 'task-dispatched', 3101, MAESTRO, { floor: 'Extrato OFX', worker: 'Ária', branch: 'task/3101-extrato-ofx' }],
  ['portal', 3100, '2026-10-02T18:20:00', 'task-integrated', 3101, MAESTRO, { sha: '4be1c2d9a7f0', sha_before: '9a01f3c' }],
  ['portal', 3100, '2026-10-03T09:00:00', 'task-dispatched', 3102, MAESTRO, { floor: 'Casamento', worker: 'Caio', branch: 'task/3102-casamento' }],
  ['portal', 3100, '2026-10-05T10:40:00', 'task-integrated', 3102, MAESTRO, { sha: '7c3d9e0b12aa', sha_before: '4be1c2d' }],

  ['portal', 3112, '2026-10-08T10:25:00', 'task-graph', null, MAESTRO, { tasks: [
    { number: 3113, title: 'Modelo do extrato em PDF', blocked_by: [], out: false },
    { number: 3114, title: 'Gerar o PDF no servidor', blocked_by: [3113], out: false },
    { number: 3115, title: 'Botão de exportar na tela do extrato', blocked_by: [3113], out: false },
    { number: 3116, title: 'Assinatura digital do PDF', blocked_by: [3114], out: false },
    { number: 3117, title: 'Enviar o PDF por e-mail', blocked_by: [3114, 3115], out: false },
    { number: 3118, title: 'Extrato em CSV', blocked_by: [], out: true },
  ] }],
  ['portal', 3112, '2026-10-08T10:30:00', 'task-dispatched', 3113, MAESTRO, { floor: 'Modelo PDF', worker: 'Ária', branch: 'task/3113-modelo-pdf' }],
  ['portal', 3112, '2026-10-08T13:10:00', 'task-status', 3113, ['worker', 'Ária'], { state: 'review', text: 'Modelo pronto, testes verdes', progress: { done: 3, total: 3 }, maestri: 'posted' }],
  ['portal', 3112, '2026-10-08T14:02:00', 'task-integrated', 3113, MAESTRO, { sha: 'e41f0a6b3c2d', sha_before: '1d2c3b4' }],
  ['portal', 3112, '2026-10-08T14:10:00', 'task-dispatched', 3114, MAESTRO, { floor: 'PDF no servidor', worker: 'Caio', branch: 'task/3114-pdf-servidor' }],
  ['portal', 3112, '2026-10-08T14:12:00', 'task-dispatched', 3115, MAESTRO, { floor: 'Botão exportar', worker: 'Dora', branch: 'task/3115-botao-exportar' }],
  ['portal', 3112, '2026-10-09T08:40:00', 'task-status', 3115, ['worker', 'Dora'], { state: 'review', text: 'Botão pronto, aguardando revisão', progress: { done: 4, total: 4 }, maestri: 'posted' }],
  ['portal', 3112, '2026-10-09T09:15:00', 'task-status', 3114, ['worker', 'Caio'], { state: 'working', text: 'Layout gerado, faltam as fontes', progress: { done: 2, total: 5 }, maestri: 'posted' }],
  ['portal', 3112, '2026-10-09T09:50:00', 'task-dispatched', 3116, MAESTRO, { floor: null, worker: 'subagente', branch: 'task/3116-assinatura' }],
  ['portal', 3112, '2026-10-09T10:05:00', 'task-status', 3116, ['worker', 'subagente'], { state: 'blocked', text: 'Preciso do certificado de homologação', progress: null, maestri: 'outside' }],

  ['storefront', 48, '2026-10-02T16:05:00', 'task-graph', null, MAESTRO, { tasks: [
    { number: 49, title: 'Persistir o carrinho na conta', blocked_by: [], out: false },
    { number: 50, title: 'Juntar carrinhos ao entrar', blocked_by: [49], out: false },
  ] }],
  ['storefront', 48, '2026-10-02T16:10:00', 'task-dispatched', 49, MAESTRO, { floor: 'Carrinho', worker: 'Ária', branch: 'task/49-carrinho' }],
  ['storefront', 48, '2026-10-05T11:30:00', 'task-integrated', 49, MAESTRO, { sha: '0b7a6c5d4e3f', sha_before: 'aa11bb2' }],
  ['storefront', 48, '2026-10-05T11:40:00', 'task-dispatched', 50, MAESTRO, { floor: 'Juntar carrinhos', worker: 'Caio', branch: 'task/50-juntar' }],
  ['storefront', 48, '2026-10-08T17:00:00', 'task-integrated', 50, MAESTRO, { sha: '5f4e3d2c1b0a', sha_before: '0b7a6c5' }],

  ['painel-maestro', 5, '2026-10-09T07:35:00', 'task-dispatched', 5, MAESTRO, { floor: 'Item ponta a ponta', worker: 'Ária', branch: 'task/5-item-ponta-a-ponta' }],
  ['painel-maestro', 5, '2026-10-09T10:10:00', 'task-status', 5, ['worker', 'Ária'], { state: 'working', text: 'API e telas prontas, faltam os testes', progress: { done: 4, total: 6 }, maestri: 'posted' }],
];
for (const [projectId, number, at, type, task, [role, name], payload] of TASKS) {
  events.push({ id: 0, at: `${at}-03:00`, project_id: projectId, item_number: number, task_number: task, agent: { role, name }, source: 'cli', type, payload });
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

// ---------- usage and agents per item (#13) ----------

// [session, project, item, task (worker) | null (maestro or no item), last seen, [[moment, input, output, cache write, cache read], ...]]
const SESSIONS = [
  ['s-3112-maestro', 'portal', 3112, null, '2026-10-09T10:15:00', [['2026-10-08T10:10:00', 900, 4200, 52000, 380000], ['2026-10-09T09:55:00', 700, 3100, 41000, 520000]]],
  ['s-3113', 'portal', 3112, 3113, '2026-10-08T13:20:00', [['2026-10-08T12:30:00', 1500, 14000, 120000, 1900000]]],
  ['s-3114', 'portal', 3112, 3114, '2026-10-09T10:22:00', [['2026-10-08T16:00:00', 1100, 9000, 90000, 1200000], ['2026-10-09T09:10:00', 1800, 16500, 140000, 2600000]]],
  ['s-3115', 'portal', 3112, 3115, '2026-10-09T08:45:00', [['2026-10-09T08:30:00', 1300, 11000, 95000, 1700000]]],
  ['s-3116', 'portal', 3112, 3116, '2026-10-09T10:06:00', [['2026-10-09T10:00:00', 400, 2600, 30000, 310000]]],
  ['s-3100-maestro', 'portal', 3100, null, '2026-10-08T09:10:00', [['2026-10-06T10:00:00', 600, 5200, 60000, 700000], ['2026-10-08T09:05:00', 300, 1800, 22000, 260000]]],
  ['s-2875-maestro', 'billing-api', 2875, null, '2026-10-08T18:15:00', [['2026-10-08T15:30:00', 1000, 8800, 70000, 1100000]]],
  ['s-48-maestro', 'storefront', 48, null, '2026-10-09T09:45:00', [['2026-10-09T09:41:00', 500, 3900, 36000, 500000]]],
  ['s-5-maestro', 'painel-maestro', 5, null, '2026-10-09T07:40:00', [['2026-10-09T07:32:00', 400, 2500, 28000, 240000]]],
  ['s-5-worker', 'painel-maestro', 5, 5, '2026-10-09T10:20:00', [['2026-10-09T08:15:00', 2100, 18000, 160000, 3100000], ['2026-10-09T10:12:00', 900, 7200, 64000, 1300000]]],
  ['s-scratch', 'scratch', null, null, '2026-10-09T10:05:00', [['2026-10-09T10:02:00', 200, 900, 12000, 90000]]],
];

function assistant(id, at, [i, o, cw, cr]) {
  return JSON.stringify({
    type: 'assistant', timestamp: new Date(at).toISOString(),
    message: { id, role: 'assistant', usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr } },
  });
}

/** The /api/usage and /api/agents answers of the mock: the real collector over a temporary bruto.db and transcripts. */
async function usageAndAgents(source) {
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-state.json'), 'utf8')).usage.plan;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-usage-'));
  const raw = openRawStore({ dir });
  try {
    const status = path.join(dir, 'maestri', 'usage', 'providers', '.status.json');
    fs.mkdirSync(path.dirname(status), { recursive: true });
    fs.writeFileSync(status, JSON.stringify({ providers: [{ id: 'claude', enabled: true, state: 'ready', plan: 'max', lastSuccessAt: plan.updated_at, meters: [{ id: 'plan', windows: [
      { id: 'five_hour', usedPercent: plan.window_5h_pct, resetsAt: plan.reset_5h, durationSeconds: 18000 },
      { id: 'seven_day', usedPercent: plan.weekly_pct, resetsAt: plan.weekly_reset, durationSeconds: 604800 },
    ] }] }], updatedAt: plan.updated_at }));
    for (const [id, project, item, task, seen, messages] of SESSIONS) {
      const transcript = path.join(dir, 'claude', 'projects', 'mock', `${id}.jsonl`);
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, `${messages.map(([at, ...u], n) => assistant(`${id}-${n}`, `${at}-03:00`, u)).join('\n')}\n`);
      const branch = task !== null ? `task/${task}` : item !== null ? `feature/issue-${item}` : 'main';
      raw.record({ at: `${seen}-03:00`, t: Date.parse(`${seen}-03:00`), session_id: id, project_id: project, item_number: item, task_number: task, branch, hook_event: 'PostToolUse', cwd: 'C:/mock' },
        { transcript_path: transcript, cwd: 'C:/mock' });
    }
    const data = await collect({ maestroDir: dir, maestriDataDir: path.join(dir, 'maestri'), claudeDir: path.join(dir, 'claude'), env: {}, now: GENERATED_AT, write: false });
    data.plan.file = plan.source.file;
    data.collection.duration_ms = 42;
    const file = { exists: true, data, error: null };
    const collector = { interval_min: 5, active: true, last: { at: GENERATED_AT, trigger: 'periodic', ok: true, duration_ms: 42, error: null }, running: false };
    const none = new URLSearchParams();
    return { usage: usageAnswer(source, file, none, { collector }), agents: listAgents(source, { store: () => raw }, file, none) };
  } finally {
    raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  const { items } = listItems(source);
  const details = {};
  for (const it of items) details[it.key] = itemDetail(source, it.project.id, it.number).item;
  const { usage, agents } = await usageAndAgents(source);
  fs.writeFileSync(OUT, `${JSON.stringify({ generated_at: GENERATED_AT, items, details, usage, agents }, null, 2)}\n`);
  const taskStates = new Set(Object.values(details).flatMap((d) => d.tasks.map((x) => x.state)));
  console.log(`mock-items.json: ${items.length} itens em ${new Set(items.map((i) => i.stage)).size} etapas; tasks em ${taskStates.size} estados (${[...taskStates].join(", ")}); ${agents.agents.length} agentes ativos; uso de ${usage.by_item['7d'].length} itens`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
