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
const taskStates = new Set(Object.values(details).flatMap((d) => d.tasks.map((x) => x.state)));
console.log(`mock-items.json: ${items.length} itens em ${new Set(items.map((i) => i.stage)).size} etapas; tasks em ${taskStates.size} estados (${[...taskStates].join(", ")})`);
const all = Object.values(details);
console.log(`  ${all.reduce((n, d) => n + d.reports.length, 0)} relatórios e ${all.reduce((n, d) => n + d.findings.length, 0)} achados`);
