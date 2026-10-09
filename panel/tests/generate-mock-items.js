#!/usr/bin/env node
'use strict';
// Writes tests/mock-items.json, the new model's part of the test mode (?mock=1): the answers of GET /api/items,
// GET /api/items/<project>/<number>, GET /api/companies, GET /api/projects and (unfiltered) GET /api/pending-decisions
// for fictitious companies, projects and events. The answers come out of the server's own code (panel/api-items.js,
// api-projects.js, api-pending-decisions.js and the projection in bin/flow-projection.js) over an in-memory store,
// so the mock never drifts from the API shape. Run: node panel/tests/generate-mock-items.js

const fs = require('fs');
const path = require('path');
const { listItems, itemDetail } = require('../api-items.js');
const { listPendingDecisions } = require('../api-pending-decisions.js');
const { listCompanies, listProjects } = require('../api-projects.js');
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
// Two companies and "Pessoal", with GitHub and Azure DevOps projects (an Azure DevOps project with several
// repositories is a single project), and two repositories that landed in "Sem empresa" (#6).
const projects = [
  { id: 'portal', name: 'Portal Contoso', company_id: 'contoso', tracker: 'azure_devops', stages: STAGES, done_state: 'Committed', maestri_workspace: 'Contoso Portal',
    repos: ['dev.azure.com/contoso/portal/_git/portal-api', 'dev.azure.com/contoso/portal/_git/portal-web'] },
  { id: 'billing-api', name: 'Cobrança', company_id: 'contoso', tracker: 'azure_devops', stages: STAGES, done_state: 'Done', maestri_workspace: 'Contoso Cobrança',
    repos: ['dev.azure.com/contoso/billing/_git/billing-api'] },
  { id: 'design-system', name: 'Design system', company_id: 'contoso', tracker: 'github', stages: NO_HML, repos: ['github.com/contoso/design-system'] },
  { id: 'storefront', name: 'Loja', company_id: 'fabrikam', tracker: 'github', stages: NO_HML, maestri_workspace: 'Fabrikam', repos: ['github.com/fabrikam/storefront'] },
  { id: 'erp', name: 'ERP Fabrikam', company_id: 'fabrikam', tracker: 'azure_devops', stages: STAGES, done_state: 'Closed',
    repos: ['fabrikam.visualstudio.com/erp/_git/erp-core', 'fabrikam.visualstudio.com/erp/_git/erp-fiscal', 'fabrikam.visualstudio.com/erp/_git/erp-web'] },
  { id: 'painel-maestro', name: 'painel-maestro', company_id: 'personal', tracker: 'github', stages: NO_HML, repos: ['github.com/higorcesarqn/painel-maestro'] },
  { id: 'scratch', name: 'scratch', company_id: 'unassigned', tracker: 'github', stages: STAGES, repos: ['github.com/higorcesarqn/scratch'] },
  { id: 'relatorios-bi', name: 'relatorios-bi', company_id: 'unassigned', tracker: 'azure_devops', stages: STAGES, repos: ['dev.azure.com/fabrikam/bi/_git/relatorios-bi'] },
].map((p) => ({ done_state: null, maestri_workspace: null, ...p, company_name: companies[p.company_id], created_at: '2026-10-01T09:00:00-03:00' }));

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
  ['design-system', 31, 'Tokens de cor para o modo escuro', [['2026-10-06T14:00:00', 'implementation'], ['2026-10-08T11:30:00', 'pr_ready']]],
  ['erp', 1204, 'Nota fiscal de serviço eletrônica', [['2026-10-05T09:00:00', 'specification'], ['2026-10-06T10:00:00', 'implementation']]],
  ['relatorios-bi', 77, 'Painel de vendas por região', [['2026-10-08T15:20:00', 'implementation']]],
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

// Pending decisions (#10): [ref, project, number, ISO moment, type, task, [role, name], payload]. The id of a pending
// decision is the id of its opening event, so the closing events name it by ref (filled in after the ids are given).
// Open and closed ones of every kind; the review of task 3113 is resolved by its integration (no closing event).
const CONTOSO = { workspace: 'Contoso', terminal: 'Maestro PBI 3112' };
const PENDING = [
  ['review-3113', 'portal', 3112, '2026-10-08T13:12:00', 'pending-decision-opened', 3113, MAESTRO, {
    kind: 'task_review', severity: 'normal', title: 'Revisar e integrar a task 3113 (modelo do PDF)',
    context: 'Modelo pronto, 3 testes novos verdes. Diff pequeno: só o template e o teste.', options: ['A: Integrar', 'B: Pedir ajuste'],
    recommendation: 'A: o diff está limpo e os testes cobrem o cabeçalho e o rodapé.', maestri: CONTOSO }],
  ['parallel', 'portal', 3112, '2026-10-08T14:04:00', 'pending-decision-opened', null, MAESTRO, {
    kind: 'parallelize', severity: 'normal', title: 'Paralelizar as tasks 3114 e 3115?',
    context: 'As duas mexem no fluxo de exportação do extrato (serviço e tela). Em paralelo terminam um dia antes, com risco de conflito no serviço.',
    options: ['A: Paralelizar', 'B: Uma depois da outra'], recommendation: 'A: o conflito fica num arquivo só, fácil de resolver na integração.', maestri: CONTOSO }],
  [null, 'portal', 3112, '2026-10-08T14:08:00', 'pending-decision-resolved', null, ['owner', null], { pending_decision: 'parallel', decision: 'Pode paralelizar. A 3115 integra primeiro.' }],
  [null, 'portal', 3112, '2026-10-09T08:42:00', 'pending-decision-opened', 3115, MAESTRO, {
    kind: 'task_review', severity: 'high', title: 'Revisar e integrar a task 3115 (botão de exportar)',
    context: 'Botão pronto, 4/4 testes verdes. Mudou o componente de cabeçalho da tela do extrato.', options: ['A: Integrar', 'B: Pedir ajuste', 'C: Esperar a 3114'],
    recommendation: 'A: a 3114 não depende do botão.', maestri: CONTOSO }],
  [null, 'portal', 3112, '2026-10-09T10:06:00', 'pending-decision-opened', 3116, MAESTRO, {
    kind: 'worker_blocked', severity: 'critical', title: 'Falta o certificado de homologação para assinar o PDF',
    context: 'O subagente da 3116 parou: a assinatura digital precisa do certificado A1 de homologação, que não está no cofre do projeto.',
    options: ['A: Enviar o certificado', 'B: Assinar com certificado de teste por enquanto'], recommendation: 'B, e abrir um achado para trocar antes do HML.', maestri: CONTOSO }],
  [null, 'portal', 3100, '2026-10-08T16:30:00', 'pending-decision-opened', null, ['owner', 'Higor'], {
    kind: 'hml', severity: 'high', title: 'Cenário 4 reprovado em HML: boleto pago em duplicidade',
    context: 'Na Validação HML, um boleto pago duas vezes no mesmo dia foi conciliado só uma vez. Cenários 1 a 3 aprovados.',
    options: ['A: Voltar para Implementação', 'B: Aprovar e abrir um item novo'], recommendation: 'A: é o caso que motivou o item.',
    maestri: { workspace: 'Contoso', terminal: 'Maestro PBI 3100' } }],
  ['retry', 'billing-api', 2875, '2026-10-07T17:00:00', 'pending-decision-opened', null, MAESTRO, {
    kind: 'decision', severity: 'normal', title: 'Quantas retentativas para cobrança recusada?',
    context: 'O gateway recomenda até 4; o contrato fala em 3.', options: ['A: 3 retentativas', 'B: 4 retentativas'], recommendation: 'A: segue o contrato.',
    maestri: { workspace: 'Contoso', terminal: 'Maestro PBI 2875' } }],
  [null, 'billing-api', 2875, '2026-10-07T18:20:00', 'pending-decision-resolved', null, ['maestro', 'Bento'], { pending_decision: 'retry', decision: 'A: 3 retentativas, com intervalo de 24 h.' }],
  ['limit', 'billing-api', 2901, '2026-10-09T09:00:00', 'pending-decision-opened', null, MAESTRO, {
    kind: 'decision', severity: 'low', title: 'Limite por cartão ou por cliente?', options: ['A: Por cartão', 'B: Por cliente'],
    maestri: { workspace: 'Contoso', terminal: 'Maestro PBI 2901' } }],
  [null, 'billing-api', 2901, '2026-10-09T09:30:00', 'pending-decision-canceled', null, MAESTRO, { pending_decision: 'limit', reason: 'Entrou na especificação do item.' }],
  [null, 'storefront', 48, '2026-10-09T09:45:00', 'pending-decision-opened', null, ['maestro', 'Ária'], {
    kind: 'finding', severity: 'normal', title: 'Achado: o carrinho anônimo expira em 24 h',
    context: 'Na revisão final apareceu que o carrinho de quem não entrou na conta some em 24 h; ao juntar carrinhos, itens antigos se perdem.',
    options: ['A: Manter 24 h', 'B: Estender para 7 dias (task nova)'], recommendation: 'B, como task nova para triagem.',
    maestri: { workspace: 'Fabrikam', terminal: 'Maestro #48' } }],
  ['finding-5', 'painel-maestro', 5, '2026-10-09T08:30:00', 'pending-decision-opened', 5, ['maestro', 'Ária'], {
    kind: 'finding', severity: 'low', title: 'Achado: o selo de saúde não conta o maestro.db',
    options: ['A: Corrigir agora', 'B: Task nova para triagem'], maestri: { workspace: 'Pessoal', terminal: 'Maestro #5' } }],
  [null, 'painel-maestro', 5, '2026-10-09T09:00:00', 'pending-decision-resolved', 5, ['owner', null], { pending_decision: 'finding-5', decision: 'B: vira task nova para triagem.' }],
];
const refs = new Map();
for (const [ref, projectId, number, at, type, task, [role, name], payload] of PENDING) {
  const e = { id: 0, at: `${at}-03:00`, project_id: projectId, item_number: number, task_number: task, agent: { role, name }, source: 'cli', type, payload };
  if (ref) refs.set(ref, e);
  events.push(e);
}

events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
events.forEach((e, i) => { e.id = i + 1; });
for (const e of events) if (typeof e.payload.pending_decision === 'string') e.payload.pending_decision = refs.get(e.payload.pending_decision).id;

// In-memory store with the same reads as bin/flow-store.js.
const store = {
  projects: () => projects,
  project: (id) => projects.find((p) => p.id === id) || null,
  companies: () => Object.entries(companies).map(([id, name]) => ({ id, name, created_at: '2026-10-01T09:00:00-03:00' })),
  projectRepos: (id) => projects.find((p) => p.id === id).repos.slice().sort(),
  allEvents: () => events,
  itemEvents: (projectId, number) => events.filter((e) => e.project_id === projectId && e.item_number === number),
};
const source = { store: () => store };

const { items } = listItems(source);
const details = {};
for (const it of items) details[it.key] = itemDetail(source, it.project.id, it.number).item;
const pending = listPendingDecisions(source);
// Companies and projects (#6): the answers of GET /api/companies and GET /api/projects (the page filters them by company).
const { companies: companyList } = listCompanies(source);
const { projects: projectList } = listProjects(source, new URLSearchParams());
fs.writeFileSync(OUT, `${JSON.stringify({ generated_at: GENERATED_AT, companies: companyList, projects: projectList, items, details, pending_decisions: pending }, null, 2)}\n`);
const taskStates = new Set(Object.values(details).flatMap((d) => d.tasks.map((x) => x.state)));
const pd = pending.pending_decisions;
console.log(`mock-items.json: ${items.length} itens em ${new Set(items.map((i) => i.stage)).size} etapas; tasks em ${taskStates.size} estados (${[...taskStates].join(", ")}); `
  + `${pd.length} pendências de ${new Set(pd.map((p) => p.kind)).size} tipos (${Object.entries(pending.counts.status).map(([s, n]) => `${n} ${s}`).join(', ')})`);
