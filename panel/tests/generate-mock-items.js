#!/usr/bin/env node
'use strict';
// Writes tests/mock-items.json, the whole test mode (?mock=1, npm run demo): the answers of GET /api/items,
// GET /api/items/<project>/<number>, GET /api/organizations, GET /api/projects and (unfiltered) GET /api/pending-decisions
// for fictitious organizations, projects and events. The answers come out of the server's own code (panel/api-items.js,
// api-projects.js, api-pending-decisions.js and the projection in bin/flow-projection.js) over an in-memory store,
// so the mock never drifts from the API shape. Run: node panel/tests/generate-mock-items.js
// Usage and agents per item (#13): fictitious sessions linked to the items' maestros and the tasks' workers go into a
// temporary bruto.db with their transcripts; the real collector (bin/collect-usage.js) reads them with the fictitious
// plan below, and the real API (panel/api-usage.js) writes the answers of GET /api/usage and /api/agents.
// Overview and the shell (#14): GET /api/overview per organization (panel/api-overview.js) and GET /api/state (the server's
// own stateAnswer(): health, menu counter and plan) over the same store.
// The same organizations, projects and events are exported for build-mock-root.js, which writes them into a real
// maestro.db to look at the page with the real server.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { listItems, itemDetail } = require('../api-items.js');
const { listPendingDecisions } = require('../api-pending-decisions.js');
const { listOrganizations, listProjects } = require('../api-projects.js');
const { usageAnswer, listAgents } = require('../api-usage.js');
const { overview: overviewOf } = require('../api-overview.js');
const { stateAnswer } = require('../server.js');
const { STAGES, projectEventsByItem } = require('../../bin/flow-store.js');
const { openRawStore } = require('../../bin/raw-store.js');
const { collect } = require('../../bin/collect-usage.js');

const OUT = path.join(__dirname, 'mock-items.json');
const GENERATED_AT = '2026-10-09T10:24:30-03:00';
const NO_HML = STAGES.filter((s) => s !== 'hml_validation');
// The Claude plan the Maestri reports at the mock's moment (read 3 minutes before it).
const PLAN = {
  file: '~/.maestri/usage/providers/.status.json', window_5h_pct: 37, reset_5h: '2026-10-09T13:00:00-03:00',
  weekly_pct: 22, weekly_reset: '2026-10-13T09:00:00-03:00', updated_at: '2026-10-09T10:21:30-03:00',
};

const organizations = {
  contoso: 'Contoso',
  fabrikam: 'Fabrikam',
  personal: 'Pessoal',
  unassigned: 'Sem organização',
};
// Two organizations and "Pessoal", with GitHub and Azure DevOps projects (an Azure DevOps project with several
// repositories is a single project), and two repositories that landed in "Sem organização" (#6).
const projects = [
  { id: 'portal', name: 'Portal Contoso', organization_id: 'contoso', tracker: 'azure_devops', stages: STAGES, done_state: 'Committed', maestri_workspace: 'Contoso Portal',
    repos: ['dev.azure.com/contoso/portal/_git/portal-api', 'dev.azure.com/contoso/portal/_git/portal-web'] },
  { id: 'billing-api', name: 'Cobrança', organization_id: 'contoso', tracker: 'azure_devops', stages: STAGES, done_state: 'Done', maestri_workspace: 'Contoso Cobrança',
    repos: ['dev.azure.com/contoso/billing/_git/billing-api'] },
  { id: 'design-system', name: 'Design system', organization_id: 'contoso', tracker: 'github', stages: NO_HML, repos: ['github.com/contoso/design-system'] },
  { id: 'storefront', name: 'Loja', organization_id: 'fabrikam', tracker: 'github', stages: NO_HML, maestri_workspace: 'Fabrikam', repos: ['github.com/fabrikam/storefront'] },
  { id: 'erp', name: 'ERP Fabrikam', organization_id: 'fabrikam', tracker: 'azure_devops', stages: STAGES, done_state: 'Closed',
    repos: ['fabrikam.visualstudio.com/erp/_git/erp-core', 'fabrikam.visualstudio.com/erp/_git/erp-fiscal', 'fabrikam.visualstudio.com/erp/_git/erp-web'] },
  { id: 'painel-maestro', name: 'painel-maestro', organization_id: 'personal', tracker: 'github', stages: NO_HML, repos: ['github.com/higorcesarqn/painel-maestro'] },
  { id: 'scratch', name: 'scratch', organization_id: 'unassigned', tracker: 'github', stages: STAGES, repos: ['github.com/higorcesarqn/scratch'] },
  { id: 'relatorios-bi', name: 'relatorios-bi', organization_id: 'unassigned', tracker: 'azure_devops', stages: STAGES, repos: ['dev.azure.com/fabrikam/bi/_git/relatorios-bi'] },
].map((p) => ({ done_state: null, maestri_workspace: null, ...p, organization_name: organizations[p.organization_id], created_at: '2026-10-01T09:00:00-03:00' }));

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
  // Parked on Specification for a week (Overview, #14: stale items).
  ['storefront', 55, 'Busca por código de barras', [['2026-10-02T14:00:00', 'specification']]],
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
// Reports and findings (#8): [project, number, ISO moment, type, task (the origin, for a finding), [role, name], payload].
const report = (status, fields) => ({
  status, blocked_reason: null, branch: null, sha: null, tests: null, changes: null, decisions: [], risks: null, shared_files: [], text: null, ...fields,
});
const reportText = (lines) => lines.join('\n');
const finding = (n, title, classification, origin, newTask, description) => ({
  finding: n, title, description: description || null, classification, origin_task: origin, new_task: newTask,
});
TASKS.push(
  ['portal', 3112, '2026-10-08T13:12:00', 'task-report', 3113, ['worker', 'Ária'], report('ok', {
    branch: 'task/3113-modelo-pdf', sha: 'e41f0a6b3c2d',
    tests: 'npm test: 2 rodadas seguidas, 0 falhas (banco portal-3113.db recriado vazio)\nnpm run check: ok',
    changes: 'O extrato ganhou o modelo de PDF: cabeçalho com o logo, tabela de lançamentos e rodapé com a página.',
    decisions: ['Fonte embutida "Noto Sans": o servidor de HML não tem fontes do sistema.', 'A4 retrato por padrão; paisagem fica para a 3114, se precisar.'],
    risks: 'Tabelas com mais de 200 linhas quebram a página no meio da linha (ver achado).',
    shared_files: ['src/report/layout.ts', 'package.json'],
    text: reportText([
      'Task 3113, branch task/3113-modelo-pdf, SHA final e41f0a6, sobre a integradora (sem push, sem tracker, sem merge). Status: ok.',
      'Testes: npm test, duas rodadas seguidas, banco portal-3113.db recriado vazio; 0 falhas. npm run check: ok.',
      'O que mudou: o extrato ganhou o modelo de PDF (cabeçalho com o logo, tabela de lançamentos, rodapé com a página).',
      'Decisões:',
      '  1. Fonte embutida "Noto Sans": o servidor de HML não tem fontes do sistema.',
      '  2. A4 retrato por padrão; paisagem fica para a 3114, se precisar.',
      'Riscos: tabelas com mais de 200 linhas quebram a página no meio da linha.',
      'Arquivos compartilhados: src/report/layout.ts e package.json (a 3114 também mexe).',
    ]),
  })],
  ['portal', 3112, '2026-10-08T13:50:00', 'finding-recorded', 3113, MAESTRO, finding(1, 'Quebra de página no meio de uma linha da tabela', 'defect', 3113,
    { number: 3119, title: 'Não quebrar linhas da tabela entre páginas' }, 'Com mais de 200 lançamentos a linha 201 aparece cortada entre duas páginas.')],
  ['portal', 3112, '2026-10-08T13:52:00', 'finding-recorded', 3113, MAESTRO, finding(2, 'Nome do arquivo exportado', 'owner_decision', 3113, null,
    '"extrato.pdf" ou "extrato-<conta>-<mês>.pdf"? Depende do que o banco aceita no upload.')],
  ['portal', 3112, '2026-10-08T13:55:00', 'finding-recorded', 3113, MAESTRO, finding(3, 'Renomear a variável "tmp" do gerador', 'discarded', 3113, null)],
  ['portal', 3112, '2026-10-09T08:42:00', 'task-report', 3115, ['worker', 'Dora'], report('ok', {
    branch: 'task/3115-botao-exportar', sha: '9c8b7a6d5e4f',
    tests: 'npm test: 0 falhas (2 rodadas)\nTeste manual no Chrome e no Edge',
    changes: 'Botão "Exportar PDF" na tela do extrato; fica desabilitado enquanto o PDF é gerado.',
    decisions: ['O botão chama a rota da 3114 por um adaptador; enquanto ela não integra, devolve um PDF de exemplo.'],
    risks: 'Depende da rota da 3114 para funcionar de verdade.',
    shared_files: ['src/screens/Statement.tsx'],
    text: reportText([
      'Task 3115, branch task/3115-botao-exportar, SHA final 9c8b7a6. Status: ok.',
      'Testes: npm test, 0 falhas nas 2 rodadas; teste manual no Chrome e no Edge.',
      'O que mudou: botão "Exportar PDF" na tela do extrato, desabilitado enquanto o PDF é gerado.',
      'Decisões: 1. adaptador para a rota da 3114, com PDF de exemplo até ela integrar.',
      'Riscos: depende da 3114. Arquivos compartilhados: src/screens/Statement.tsx.',
    ]),
  })],
  ['portal', 3112, '2026-10-09T10:06:00', 'task-report', 3116, ['worker', 'subagente'], report('blocked', {
    blocked_reason: 'Falta o certificado A1 de homologação para assinar o PDF.',
    branch: 'task/3116-assinatura', sha: '2a3b4c5d6e7f',
    tests: 'Testes da assinatura com certificado de teste: ok. Sem o certificado de HML, nada para rodar lá.',
    changes: 'Assinatura digital pronta com certificado autoassinado.',
    text: 'Task 3116 bloqueada: falta o certificado A1 de homologação.\nCom ele, falta só trocar a configuração e rodar os testes de HML.',
  })],
  ['billing-api', 2875, '2026-10-08T11:35:00', 'finding-recorded', null, MAESTRO, finding(1, 'Cobrança duplicada quando duas tentativas correm juntas', 'defect', null,
    { number: 2880, title: 'Trava de concorrência no reprocessamento' }, 'O teste de concorrência do ajuste final reprovou: duas tentativas simultâneas cobram duas vezes.')],
  ['storefront', 48, '2026-10-05T11:20:00', 'task-report', 49, ['worker', 'Ária'], report('ok', {
    branch: 'task/49-carrinho', sha: '0b7a6c5d4e3f',
    tests: 'npm test: 0 falhas', changes: 'O carrinho fica salvo na conta do cliente.', decisions: ['Carrinho guardado por 30 dias.'],
    text: 'Task 49 pronta: o carrinho fica salvo na conta (30 dias). npm test: 0 falhas.',
  })],
  ['storefront', 48, '2026-10-08T16:50:00', 'task-report', 50, ['worker', 'Caio'], report('ok', {
    branch: 'task/50-juntar', sha: '5f4e3d2c1b0a', tests: 'npm test: 0 falhas', changes: 'Ao entrar, o carrinho do visitante se junta ao da conta.',
    text: 'Task 50 pronta: ao entrar, o carrinho do visitante se junta ao da conta.',
  })],
  ['storefront', 48, '2026-10-08T17:05:00', 'finding-recorded', 50, MAESTRO, finding(1, 'Itens repetidos somam a quantidade', 'owner_decision', 50,
    { number: 64, title: 'Regra para itens repetidos ao juntar carrinhos' }, 'Ao juntar, o mesmo produto nos dois carrinhos soma as quantidades. É o esperado?')],
);
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

// In-memory store with the same reads as bin/flow-store.js (the Log's page of events too, for the Overview).
const organizationOf = (e) => projects.find((p) => p.id === e.project_id).organization_id;
const store = {
  projects: () => projects,
  project: (id) => projects.find((p) => p.id === id) || null,
  organizations: () => Object.entries(organizations).map(([id, name]) => ({ id, name, created_at: '2026-10-01T09:00:00-03:00' })),
  projectRepos: (id) => projects.find((p) => p.id === id).repos.slice().sort(),
  allEvents: () => events,
  projectedItems: () => projectEventsByItem(events, new Map(projects.map((p) => [p.id, p]))),
  itemEvents: (projectId, number) => events.filter((e) => e.project_id === projectId && e.item_number === number),
  logEvents: (f, { limit = 50, offset = 0 } = {}) => {
    const list = events.filter((e) => (!f.organizations || f.organizations.includes(organizationOf(e))) && (!f.since || e.at >= f.since)).slice().reverse();
    return { total: list.length, events: list.slice(offset, offset + limit) };
  },
  logCounts: () => ({ organization: {}, project: {}, type: {} }),
};
const source = { store: () => store };
// The hook's last entry (bruto.db) a few minutes before the mock's moment: the hook is working.
const raw = { store: () => ({ lastAt: () => '2026-10-09T10:21:10-03:00' }) };

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
  const plan = PLAN;
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
    data.plan.file = plan.file;
    data.collection.duration_ms = 42;
    const file = { exists: true, data, error: null };
    const collector = { interval_min: 5, active: true, last: { at: GENERATED_AT, trigger: 'periodic', ok: true, duration_ms: 42, error: null }, running: false };
    const none = new URLSearchParams();
    return { file, collector, usage: usageAnswer(source, file, none, { collector }), agents: listAgents(source, { store: () => raw }, file, none) };
  } finally {
    raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const { items } = listItems(source);
  const details = {};
  for (const it of items) details[it.key] = itemDetail(source, it.project.id, it.number).item;
  const pending = listPendingDecisions(source);
  // Organizations and projects (#6): the answers of GET /api/organizations and GET /api/projects (the page filters them by organization).
  const { organizations: organizationList } = listOrganizations(source);
  const { projects: projectList } = listProjects(source, new URLSearchParams());
  // Overview (#14): the answer of GET /api/overview for every organization of the selector ('' = all), with the server's
  // default stale limit; and GET /api/state (health, menu counter and plan) by the server's own function.
  const nowMs = Date.parse(GENERATED_AT);
  const overview = {};
  for (const id of ['', ...organizationList.map((c) => c.id)]) {
    overview[id] = overviewOf(source, new URLSearchParams(id ? { organization: id } : {}), { nowMs, staleHours: 48 });
  }
  const { file, collector, usage, agents } = await usageAndAgents(source);
  const state = stateAnswer({ items: source, raw, usageFile: file, nowMs, collector });
  fs.writeFileSync(OUT, `${JSON.stringify({ generated_at: GENERATED_AT, state, organizations: organizationList, projects: projectList, items, details, pending_decisions: pending, overview, usage, agents }, null, 2)}
`);
  const taskStates = new Set(Object.values(details).flatMap((d) => d.tasks.map((x) => x.state)));
  const pd = pending.pending_decisions;
  console.log(`mock-items.json: ${items.length} itens em ${new Set(items.map((i) => i.stage)).size} etapas; tasks em ${taskStates.size} estados (${[...taskStates].join(", ")}); `
    + `${pd.length} pendências de ${new Set(pd.map((p) => p.kind)).size} tipos (${Object.entries(pending.counts.status).map(([s, n]) => `${n} ${s}`).join(', ')})`);
  const all = Object.values(details);
  console.log(`  ${all.reduce((n, d) => n + d.reports.length, 0)} relatórios e ${all.reduce((n, d) => n + d.findings.length, 0)} achados; ${agents.agents.length} agentes ativos; uso de ${usage.by_item['7d'].length} itens`);
}

module.exports = { GENERATED_AT, organizations, projects, events };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
