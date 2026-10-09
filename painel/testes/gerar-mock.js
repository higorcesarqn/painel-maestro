#!/usr/bin/env node
'use strict';
/*
 * gerar-mock.js: gera os dados de teste do painel (modo ?mock=1 do index.html).
 *
 *   mock-estado.json    uma resposta realista de GET /api/estado (o contrato do painel)
 *   mock-detalhes.json  o que o modo de teste usa para imitar /api/eventos, /api/evento/<id>
 *                       e /api/fluxo/<id>: eventos completos (inclusive os de teste),
 *                       comandos brutos e fluxos
 *
 * Todos os dados são fictícios (workspace "Exemplo", projetos Atlas, Boreal, Cometa, Delta, Eco
 * e Faro, links do Trello EXEMPLO*). Nenhum nome, id ou caminho é real.
 *
 * Cenário: sexta, 09/10/2026 às 10:24:30 (America/Sao_Paulo).
 * - Quinta 08/10: montagem do workspace (fluxo F-20261008-0001) e a primeira leitura do Trello
 *   (fluxo F-20261008-0002), que achou 13 tarefas abertas com problemas de organização.
 * - A rotina leu o quadro de hora em hora; o dono mexeu em 3 cartões (2 começaram,
 *   1 foi concluído), e as escritas seguem bloqueadas até a P-0002.
 * - Sexta 09/10: o Maestri reiniciou às 08:55 e o Coordenador parou no diálogo de
 *   confiança; as leituras das 09:00 e 10:00 não rodaram (saúde amarela, P-0006 crítica).
 *
 * Uso: node gerar-mock.js   (grava os dois arquivos ao lado deste script)
 * Só biblioteca padrão. Determinístico: rodar de novo gera os mesmos arquivos.
 */

const fs = require('fs');
const path = require('path');

const AGORA = '2026-10-09T10:24:30-03:00';
const D1 = '2026-10-08';
const D2 = '2026-10-09';
const F1 = 'F-20261008-0001';
const F2 = 'F-20261008-0002';
const RAIZ = 'C:/exemplo/workspace';
const BIN = `${RAIZ}/_maestro/bin`;
const NORMALIZAR = `${RAIZ}/_maestro/skills/coordenador-trello/trello-leitura/normalizar.js`;
const ID_QUADRO = 'EXEMPLO0';
const URL_QUADRO = `https://trello.com/b/${ID_QUADRO}/quadro-exemplo`;
const URL_JSON_QUADRO = `https://trello.com/b/${ID_QUADRO}.json?cards=all&lists=all&labels=all&checklists=all&actions=none&members=none&card_attachments=false`;

const ts = (dia, hora) => `${dia}T${hora}-03:00`;
const min = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 60000);

function hex4(s) {
  let x = 2166136261;
  for (const ch of s) { x ^= ch.codePointAt(0); x = Math.imul(x, 16777619) >>> 0; }
  return (x & 0xffff).toString(16).padStart(4, '0');
}

// ---------------------------------------------------------------- agentes (agentes.json)

const AGENTES = [
  {
    slug: 'cerebro', nome: 'Cérebro Principal', tipo: 'maestro', cor: '#E8C547',
    responsabilidade: 'Cérebro Principal', status: 'ativo',
    modelo: 'claude-opus-5-5[1m]', nivel: 'xhigh',
    skills: ['orquestracao', 'pendencias', 'painel', 'onboarding-agente', 'protocolo-delegacao', 'registro-eventos'],
    conectado_a: ['coordenador-trello', 'portal:trello.com', 'portal:painel', 'nota:Trello — Manual de Organização', 'nota:Bootstrap · Progresso'],
    terminal: '0000aaaa-0000-4000-8000-000000000001', sessao: '0000aaaa-0000-4000-8000-0000000000a1',
    cwd: RAIZ,
  },
  {
    slug: 'coordenador-trello', nome: 'Coordenador do Trello', tipo: 'sub-cerebro', cor: '#3B82F6',
    responsabilidade: 'Coordenador do Trello', status: 'ativo',
    modelo: 'claude-opus-5-5[1m]', nivel: 'xhigh',
    skills: ['trello-leitura', 'trello-escrita-ui', 'trello-tarefas', 'trello-auditoria', 'trello-limpeza-semanal', 'trello-relatorio', 'trello-lapidacao', 'protocolo-delegacao', 'registro-eventos'],
    conectado_a: ['cerebro', 'portal:trello.com'],
    terminal: '0000bbbb-0000-4000-8000-000000000002', sessao: '0000bbbb-0000-4000-8000-0000000000b2',
    cwd: `${RAIZ}/.maestri/roles/0000bbbb`,
  },
];
const AG = Object.fromEntries(AGENTES.map((a) => [a.slug, a]));

// ---------------------------------------------------------------- Trello (estado final, leitura de 09/10 08:00)

const CARTOES = {};
function cartao(sl, titulo) { CARTOES[sl] = titulo; return sl; }
cartao('EXEMPLO1', 'A: 05/10 - Testar o fluxo de ponta a ponta');
cartao('EXEMPLO2', 'B: Blog - Calendário de posts do trimestre');
cartao('EXEMPLO3', 'B: Cliente - Vídeo de demonstração do produto');
cartao('EXEMPLO4', 'C: Revisar o desenho da arquitetura');
cartao('EXEMPLO5', 'C: Montar a primeira versão da fila de mensagens');
cartao('EXEMPLO6', 'D: Ajustar o envio de e-mails transacionais');
cartao('EXEMPLO7', 'D: Tema por cliente');
cartao('EXEMPLO8', 'D: Ambiente de testes');
cartao('EXEMPLO9', 'D: Fila de mensagens -> worker -> notificações');
cartao('EXEMPLOA', 'D: Conectar o provedor de SMS');
cartao('EXEMPLOB', 'E: Reunião com o fornecedor');
cartao('EXEMPLOC', 'F: Campanha de teste em outro país');
cartao('EXEMPLOD', 'F: Oferta sazonal de fim de ano');

const urlC = (sl) => `https://trello.com/c/${sl}`;
const P = (codigo, mecanico, texto) => ({ codigo, mecanico, texto });
const SEM_ESPELHO = { existe: false, coluna: null, correto: false, quantidade: 0 };
const TXT_SEM_DESC = 'Sem descrição → lapidar no template §7';
const TXT_BLOCO = 'Descrição dentro de ```markdown → tirar a cerca';
const semEspelho = (col) => P('sem-espelho', true, `Sem espelho → criar em ${col}`);

const DEF_CARTOES = [
  { p: 'A', sl: 'EXEMPLO1', status: 'Em andamento', espelho: { existe: true, coluna: '📝 A fazer', correto: false, quantidade: 1 }, desc: true, bloco: true, ck: [0, 0],
    problemas: [P('espelho-coluna-errada', true, 'Etiqueta Em andamento, espelho em 📝 A fazer → mover para ⏳ Em andamento'), P('descricao-em-bloco-de-codigo', false, TXT_BLOCO), P('passos-fora-de-checklist', false, '58 passos "- [ ]" na descrição em 7 seções → um checklist por seção')] },
  { p: 'B', sl: 'EXEMPLO2', status: 'Em andamento', espelho: SEM_ESPELHO, desc: true, ck: [3, 8], problemas: [semEspelho('⏳ Em andamento')] },
  { p: 'B', sl: 'EXEMPLO3', status: 'A Fazer', espelho: { existe: true, coluna: '📝 A fazer', correto: true, quantidade: 1 }, desc: false, problemas: [P('sem-descricao', false, TXT_SEM_DESC)] },
  { p: 'C', sl: 'EXEMPLO4', status: 'Concluído', espelho: { existe: true, coluna: '⏳ Em andamento', correto: false, quantidade: 1 }, desc: true, bloco: true,
    problemas: [P('espelho-coluna-errada', true, 'Etiqueta Concluído, espelho em ⏳ Em andamento → mover para ✅ Concluído'), P('descricao-em-bloco-de-codigo', false, TXT_BLOCO)] },
  { p: 'C', sl: 'EXEMPLO5', status: 'A Fazer', espelho: SEM_ESPELHO, desc: true, bloco: true,
    problemas: [semEspelho('📝 A fazer'), P('descricao-em-bloco-de-codigo', false, TXT_BLOCO), P('possivel-duplicada', false, `Possível duplicada com ${CARTOES.EXEMPLO9} (${urlC('EXEMPLO9')}): em comum mensagens, fila`)] },
  { p: 'D', sl: 'EXEMPLO6', status: 'Em andamento', espelho: SEM_ESPELHO, desc: false, prazo: '2026-10-08T21:00:00.000Z', problemas: [semEspelho('⏳ Em andamento'), P('sem-descricao', false, TXT_SEM_DESC)] },
  { p: 'D', sl: 'EXEMPLO7', status: 'A Fazer', espelho: SEM_ESPELHO, desc: false, ck: [1, 3], problemas: [semEspelho('📝 A fazer'), P('sem-descricao', false, 'Sem descrição (tem só o checklist) → lapidar no template §7')] },
  { p: 'D', sl: 'EXEMPLO8', status: 'A Fazer', espelho: SEM_ESPELHO, desc: false, problemas: [semEspelho('📝 A fazer'), P('sem-descricao', false, TXT_SEM_DESC)] },
  { p: 'D', sl: 'EXEMPLO9', status: 'A Fazer', espelho: SEM_ESPELHO, desc: true,
    problemas: [semEspelho('📝 A fazer'), P('descricao-insuficiente', false, 'Descrição insuficiente (só um link) → completar Resumo e Pronto quando'), P('possivel-duplicada', false, `Possível duplicada com ${CARTOES.EXEMPLO5} (${urlC('EXEMPLO5')}): em comum mensagens, fila`)] },
  { p: 'D', sl: 'EXEMPLOA', status: 'A Fazer', espelho: SEM_ESPELHO, desc: false, problemas: [semEspelho('📝 A fazer'), P('sem-descricao', false, TXT_SEM_DESC)] },
  { p: 'E', sl: 'EXEMPLOB', status: 'A Fazer', espelho: SEM_ESPELHO, desc: false, prazo: '2026-10-12T17:00:00.000Z', problemas: [semEspelho('📝 A fazer'), P('sem-descricao', false, TXT_SEM_DESC)] },
  { p: 'F', sl: 'EXEMPLOC', status: 'A Fazer', espelho: SEM_ESPELHO, desc: false, problemas: [semEspelho('📝 A fazer'), P('sem-descricao', false, TXT_SEM_DESC)] },
  { p: 'F', sl: 'EXEMPLOD', status: 'A Fazer', espelho: SEM_ESPELHO, desc: false, problemas: [semEspelho('📝 A fazer'), P('sem-descricao', false, TXT_SEM_DESC)] },
];

const DECISAO_ECO = 'definir etiqueta e prefixo. A coluna é amarela, mas o cartão usa a etiqueta "Eco Lab" (laranja escuro) e o prefixo E:. Etiqueta "Eco" amarela ou coluna "Eco Lab"? Prefixo E: ou EC:? Até decidir, vale "Eco Lab" + E:.';

const DEF_PROJETOS = [
  { prefixo: 'A', nome: 'Atlas', coluna: '🟩 Atlas', cor: 'green', emoji: '🟩', coluna_quadro: '🟩 Atlas' },
  { prefixo: 'B', nome: 'Boreal', coluna: '🟦 Boreal', cor: 'blue', emoji: '🟦', coluna_quadro: '🟦 Boreal' },
  { prefixo: 'C', nome: 'Cometa', coluna: '🟪 Cometa', cor: 'purple', emoji: '🟪', coluna_quadro: '🟪 Cometa' },
  { prefixo: 'D', nome: 'Delta', coluna: '🟥 Delta', cor: 'red', emoji: '🟥', coluna_quadro: '🟥 Delta' },
  { prefixo: 'E', nome: 'Eco', coluna: '🟨 Eco', cor: 'orange_dark', emoji: '🟨', coluna_quadro: '🟨  Eco', decisao_pendente: DECISAO_ECO },
  { prefixo: 'F', nome: 'Faro', coluna: '⬜ Faro', cor: 'black_dark', emoji: '⬜', coluna_quadro: '⬜  Faro' },
];

const CHAVE_STATUS = { 'A Fazer': 'a_fazer', 'Em andamento': 'em_andamento', 'Concluído': 'concluido' };

function montarResumo() {
  const projetos = DEF_PROJETOS.map((p) => {
    const contagem = { a_fazer: 0, em_andamento: 0, concluido: 0 };
    const cartoes = DEF_CARTOES.filter((c) => c.p === p.prefixo).map((c, i) => {
      contagem[CHAVE_STATUS[c.status]]++;
      return {
        shortLink: c.sl, url: urlC(c.sl), titulo: CARTOES[c.sl], status: c.status, posicao: i + 1,
        espelho: c.espelho, tem_descricao: !!c.desc, descricao_em_bloco_de_codigo: !!c.bloco,
        checklist: { feitos: (c.ck || [0, 0])[0], total: (c.ck || [0, 0])[1] },
        prazo: c.prazo || null, prazo_concluido: false, membros: [],
        problemas: c.problemas,
      };
    });
    const saida = { prefixo: p.prefixo, nome: p.nome, coluna: p.coluna, cor: p.cor, emoji: p.emoji, coluna_quadro: p.coluna_quadro, contagem, cartoes };
    if (p.decisao_pendente) saida.decisao_pendente = p.decisao_pendente;
    return saida;
  });
  const totais = { abertas: 0, a_fazer: 0, em_andamento: 0, concluido: 0 };
  for (const p of projetos) {
    totais.abertas += p.cartoes.length;
    for (const k of ['a_fazer', 'em_andamento', 'concluido']) totais[k] += p.contagem[k];
  }

  const mecanicos = [];
  for (const c of DEF_CARTOES) {
    for (const pr of c.problemas.filter((x) => x.mecanico && x.codigo === 'sem-espelho')) {
      mecanicos.push({ codigo: pr.codigo, cartao: c.sl, url: urlC(c.sl), titulo: CARTOES[c.sl], texto: pr.texto, acao: pr.texto.replace('Sem espelho → ', '').replace(/^criar/, 'criar espelho'), pendencia: 'P-0002' });
    }
  }
  for (const c of DEF_CARTOES) {
    for (const pr of c.problemas.filter((x) => x.mecanico && x.codigo === 'espelho-coluna-errada')) {
      const [, de, para] = /espelho em (.+) → mover para (.+)$/.exec(pr.texto);
      mecanicos.push({ codigo: pr.codigo, cartao: c.sl, url: urlC(c.sl), titulo: CARTOES[c.sl], texto: pr.texto, acao: `mover o espelho de ${de} para ${para}`, pendencia: 'P-0002' });
    }
  }
  const itensDe = (codigo) => DEF_CARTOES.filter((c) => c.problemas.some((x) => x.codigo === codigo)).map((c) => {
    const pr = c.problemas.find((x) => x.codigo === codigo);
    const extra = /\(tem só o checklist\)/.test(pr.texto) ? 'tem só o checklist' : /só um link/.test(pr.texto) ? 'só um link' : /58 passos/.test(pr.texto) ? '58 passos em 7 seções → um checklist por seção' : '';
    return { cartao: c.sl, url: urlC(c.sl), titulo: CARTOES[c.sl], texto: extra };
  });
  const bloco = itensDe('descricao-em-bloco-de-codigo');
  const semDesc = itensDe('sem-descricao');
  const decisoes = [
    { codigo: 'projeto-pendente', alvo: 'Eco', texto: `Projeto 🟨 Eco com decisão pendente: ${DECISAO_ECO}`, pendencia: 'P-0003' },
    { codigo: 'etiqueta-nome-divergente', alvo: 'Feito', texto: 'Etiqueta "Feito" ≠ coluna "✅ Concluído" → propor renomear para "Concluído"' },
    { codigo: 'etiqueta-sem-uso', alvo: 'etiquetas sem uso', pendencia: 'P-0005',
      texto: '5 etiquetas sem uso ou sem nome: "Boreal antigo" (preto suave), "Cometa antigo" (céu escuro) e 3 sem nome (laranja, vermelho, amarelo) → propor remover (exclusão só com ok do dono)',
      itens: [
        { id: '000000000000000000000001', nome: 'Boreal antigo', cor: 'black_light', sem_nome: false, usos: 0 },
        { id: '000000000000000000000002', nome: 'Cometa antigo', cor: 'sky_dark', sem_nome: false, usos: 0 },
        { id: '000000000000000000000003', nome: '', cor: 'orange', sem_nome: true, usos: 0 },
        { id: '000000000000000000000004', nome: '', cor: 'red', sem_nome: true, usos: 0 },
        { id: '000000000000000000000005', nome: '', cor: 'yellow', sem_nome: true, usos: 0 },
      ],
      codigos: ['etiqueta-sem-uso', 'etiqueta-sem-nome'] },
    { codigo: 'nome-coluna-fora-do-padrao', alvo: 'nomes de coluna', texto: '2 colunas com espaço duplo: "🟨  Eco", "⬜  Faro" → propor renomear para "🟨 Eco", "⬜ Faro"',
      itens: [{ coluna: '🟨  Eco', canonico: '🟨 Eco', motivo: 'espaço duplo' }, { coluna: '⬜  Faro', canonico: '⬜ Faro', motivo: 'espaço duplo' }] },
    { codigo: 'possivel-duplicada', alvo: `${CARTOES.EXEMPLO9} × ${CARTOES.EXEMPLO5}`, cartao: 'EXEMPLO9',
      texto: 'Possível duplicada entre Delta e Cometa (em comum: mensagens, fila) → decidir se uma vira parte da outra',
      cartoes: ['EXEMPLO9', 'EXEMPLO5'],
      itens: [{ cartao: 'EXEMPLO9', url: urlC('EXEMPLO9'), titulo: CARTOES.EXEMPLO9, texto: 'Delta' }, { cartao: 'EXEMPLO5', url: urlC('EXEMPLO5'), titulo: CARTOES.EXEMPLO5, texto: 'Cometa' }] },
    { codigo: 'descricao-em-bloco-de-codigo', alvo: `${bloco.length} cartões`, texto: `${bloco.length} descrições dentro de bloco de código (\`\`\`markdown) → tirar a cerca (o Trello mostra tudo em fonte mono, sem títulos)`, cartoes: bloco.map((i) => i.cartao), itens: bloco },
    { codigo: 'passos-fora-de-checklist', alvo: CARTOES.EXEMPLO1, cartao: 'EXEMPLO1', texto: '1 cartão com passos "- [ ]" na descrição → virar Checklist do Trello', cartoes: ['EXEMPLO1'], itens: itensDe('passos-fora-de-checklist') },
    { codigo: 'sem-descricao', alvo: `${semDesc.length} cartões`, texto: `${semDesc.length} cartões sem descrição → lapidar no template §7 (perguntar o contexto que faltar)`, cartoes: semDesc.map((i) => i.cartao), itens: semDesc },
    { codigo: 'descricao-insuficiente', alvo: CARTOES.EXEMPLO9, cartao: 'EXEMPLO9', texto: '1 descrição insuficiente → completar (Resumo + Pronto quando)', cartoes: ['EXEMPLO9'], itens: itensDe('descricao-insuficiente') },
  ];

  const espelho = (esp, orig, i, valido) => {
    const c = DEF_CARTOES.find((x) => x.sl === orig);
    return { espelho: esp, original: orig, url: urlC(orig), titulo: CARTOES[orig], projeto: c.p, status: c.status, posicao: i, valido };
  };
  return {
    coletado_em: ts(D2, '08:00:30'),
    gerado_em: ts(D2, '08:00:44'),
    fluxo_id: F2,
    quadro: { id: ID_QUADRO, nome: 'Quadro Exemplo', url: URL_QUADRO },
    totais,
    projetos,
    colunas_status: [
      { chave: 'a_fazer', etiqueta: 'A Fazer', coluna: '📝 A fazer', emoji: '📝', coluna_quadro: '📝 A fazer', espelhos: [espelho('ESPELHO1', 'EXEMPLO1', 1, false), espelho('ESPELHO2', 'EXEMPLO3', 2, true)] },
      { chave: 'em_andamento', etiqueta: 'Em andamento', coluna: '⏳ Em andamento', emoji: '⏳', coluna_quadro: '⏳ Em andamento', espelhos: [espelho('ESPELHO3', 'EXEMPLO4', 1, false)] },
      { chave: 'concluido', etiqueta: 'Concluído', coluna: '✅ Concluído', emoji: '✅', coluna_quadro: '✅ Concluído', espelhos: [] },
    ],
    nao_classificados: [],
    auditoria: { mecanicos, decisoes },
    caixa_de_entrada: { itens: null, nota: 'a Caixa de entrada do Trello não vem no JSON do quadro' },
    pendencias: [
      { id: 'P-0002', severidade: 'alta', titulo: 'Liberar as correções mecânicas do quadro (espelhos)', url: null, ligada_a: ['sem-espelho', 'espelho-coluna-errada'] },
      { id: 'P-0003', severidade: 'alta', titulo: 'Eco: definir etiqueta e prefixo', url: urlC('EXEMPLOB'), ligada_a: ['projeto-pendente'] },
      { id: 'P-0005', severidade: 'baixa', titulo: 'Remover 5 etiquetas sem uso ou sem nome', url: null, ligada_a: ['etiqueta-sem-uso'] },
    ],
    avisos: [],
    mudancas: {
      desde: ts(D1, '22:00:20'), novos: [], mudou_status: [],
      concluidos: [{ shortLink: 'EXEMPLO4', titulo: CARTOES.EXEMPLO4, url: urlC('EXEMPLO4'), prefixo: 'C', antes: 'Em andamento' }],
      arquivados: [],
    },
  };
}

function montarRst(r) {
  const L = [];
  const emoji = { 'A Fazer': '📝', 'Em andamento': '⏳', 'Concluído': '✅' };
  L.push('RST · Relatório de Status do Trello');
  L.push(`Gerado: 09/10/2026 08:00 · Leitura do quadro: 08:00 · Fluxo: ${F2}`);
  L.push('');
  L.push('1. Números');
  L.push(`Abertas: ${r.totais.abertas} · 📝 A fazer: ${r.totais.a_fazer} · ⏳ Em andamento: ${r.totais.em_andamento} · ✅ Concluído aguardando limpeza: ${r.totais.concluido}`);
  L.push(`Por projeto: ${r.projetos.map((p) => `${p.prefixo} ${p.cartoes.length}`).join(' · ')}`);
  L.push('');
  L.push('2. Em andamento agora (ordem do quadro)');
  for (const p of r.projetos) {
    for (const c of p.cartoes.filter((x) => x.status === 'Em andamento')) {
      const ck = c.checklist.total ? `checklist ${c.checklist.feitos}/${c.checklist.total}` : 'sem checklist';
      const prazo = c.prazo ? 'prazo 08/10 (atrasado)' : 'sem prazo';
      const esp = c.espelho.existe ? (c.espelho.correto ? '' : ` · ⚠ espelho em ${c.espelho.coluna}`) : ' · ⚠ sem espelho';
      L.push(`⏳ ${c.titulo} · ${ck} · ${prazo} · ${c.url}${esp}`);
    }
  }
  L.push('');
  L.push('3. Próximos (topo de 📝 A fazer, até 5)');
  L.push(`📝 ${CARTOES['EXEMPLO3']} · sem prazo · ${urlC('EXEMPLO3')}`);
  L.push('   + 8 tarefas em A Fazer sem espelho no lugar (sem posição de prioridade; ver seção 5)');
  L.push('');
  L.push('4. Por projeto');
  for (const p of r.projetos) {
    const partes = [];
    if (p.contagem.a_fazer) partes.push(`📝 ${p.contagem.a_fazer}`);
    if (p.contagem.em_andamento) partes.push(`⏳ ${p.contagem.em_andamento}`);
    if (p.contagem.concluido) partes.push(`✅ ${p.contagem.concluido}`);
    L.push(`${p.emoji} ${p.prefixo} · ${p.nome} (${p.cartoes.length}): ${partes.join(' · ')}${p.decisao_pendente ? ' · ⚠ decisão pendente (seção 5)' : ''}`);
    for (const c of p.cartoes) {
      const ck = c.checklist.total ? ` checklist ${c.checklist.feitos}/${c.checklist.total}` : '';
      L.push(`   - ${c.titulo} [${c.status}]${ck} · ${c.url} · ⚠ ${c.problemas.length}`);
    }
  }
  L.push('');
  L.push('5. Consistência (auditoria)');
  const semEsp = r.auditoria.mecanicos.filter((m) => m.codigo === 'sem-espelho');
  const colErr = r.auditoria.mecanicos.filter((m) => m.codigo === 'espelho-coluna-errada');
  L.push(`Mecânicos (corrijo sozinho quando liberado): ${r.auditoria.mecanicos.length}`);
  L.push(`   - ${semEsp.length} tarefas sem espelho:`);
  for (const m of semEsp) L.push(`      · ${m.titulo} → ${m.acao} · ${m.url}`);
  L.push(`   - ${colErr.length} espelhos na coluna errada:`);
  for (const m of colErr) L.push(`      · ${m.titulo} → ${m.acao} · ${m.url}`);
  L.push(`Precisam de decisão: ${r.auditoria.decisoes.length}`);
  for (const d of r.auditoria.decisoes) {
    L.push(`   - ${d.texto}${d.pendencia ? ` (${d.pendencia})` : ''}`);
    for (const i of (d.itens || []).filter((x) => x.cartao)) L.push(`      · ${i.titulo}${i.texto && !['Delta', 'Cometa'].includes(i.texto) ? ` (${i.texto})` : ''} · ${i.url}`);
  }
  L.push('');
  L.push('6. Precisa do dono');
  for (const p of r.pendencias) L.push(`   - ${p.id} [${p.severidade}] ${p.titulo}${p.url ? ` · ${p.url}` : ''}`);
  L.push('   - 6 decisões da seção 5 ainda sem pendência aberta');
  L.push('');
  L.push('7. Mudanças desde o último relatório (de 22:00 a 08:00)');
  for (const c of r.mudancas.concluidos) L.push(`   - Concluído: ${c.titulo} (estava ${emoji[c.antes] || ''} ${c.antes}) · ${c.url}`);
  return L.join('\n') + '\n';
}

// série: uma linha por leitura (estado/trello/serie.jsonl)
const SERIE = [
  [D1, '13:52:10', 11, 2, 0, 11],
  [D1, '16:00:15', 11, 2, 0, 11],
  [D1, '17:00:20', 11, 2, 0, 11],
  [D1, '18:00:10', 10, 3, 0, 11],
  [D1, '19:00:25', 10, 3, 0, 11],
  [D1, '20:00:30', 9, 4, 0, 11],
  [D1, '21:00:15', 9, 4, 0, 11],
  [D1, '22:00:20', 9, 4, 0, 11],
  [D2, '08:00:30', 9, 3, 1, 12],
].map(([dia, hora, af, ea, co, mec]) => ({
  coletado_em: ts(dia, hora), abertas: af + ea + co, a_fazer: af, em_andamento: ea, concluido: co,
  alertas_mecanicos: mec, alertas_decisao: 9, fluxo_id: F2,
}));

// ---------------------------------------------------------------- eventos (logs/eventos/2026-10.jsonl)

const TIPOS = ['pedido-recebido', 'delegacao', 'resposta-recebida', 'aviso', 'consulta', 'execucao', 'auditoria', 'relatorio', 'decisao', 'pendencia-aberta', 'pendencia-resolvida', 'bloqueio', 'erro', 'manutencao', 'bootstrap'];
const RESULTADOS = ['ok', 'parcial', 'falhou', 'bloqueado', 'aguardando-dono', 'em-andamento'];
const COM_DIRECAO = ['decisao', 'execucao', 'delegacao', 'auditoria'];

function trelloRef(sl, antes, depois) {
  return { shortLink: sl, titulo: CARTOES[sl], url: urlC(sl), status_antes: antes, status_depois: depois };
}

const EVENTOS = [];
function ev(dia, hora, agente, fluxo, tipo, resultado, resumo, x = {}) {
  const t = ts(dia, hora);
  const e = {
    id: `EV-${dia.replace(/-/g, '')}-${hora.replace(/:/g, '')}-${hex4(agente + resumo)}`,
    ts: t, agente, fluxo_id: fluxo,
    origem: x.origem || 'cerebro',
    tipo,
    projeto: x.projeto || null,
    trello: x.trello || null,
    resumo,
    direcao: x.direcao || null,
    passos: x.passos || [],
    comandos: x.comandos || [],
    alteracoes: x.alteracoes || [],
    resultado,
    validacao: x.validacao || null,
    proximo_passo: x.proximo_passo || null,
    precisa_dono: !!x.precisa_dono,
    pendencias: x.pendencias || [],
    duracao_s: x.duracao_s == null ? null : x.duracao_s,
  };
  if (x.teste) e.teste = true;
  e.sessao = x.sessao === undefined ? AG[agente].sessao : x.sessao;
  if (x.tipo_original) { e.tipo_original = x.tipo_original; e.importado_de = 'logs/pre-registro.md'; }
  // validações do registrar (§10.3), para o mock não mentir sobre o formato
  if (!TIPOS.includes(tipo)) throw new Error(`tipo inválido: ${tipo}`);
  if (!RESULTADOS.includes(resultado)) throw new Error(`resultado inválido: ${resultado}`);
  if (resumo.length > 100) throw new Error(`resumo com ${resumo.length} caracteres: ${resumo}`);
  if (COM_DIRECAO.includes(x.tipo_original || tipo) && !e.direcao) throw new Error(`direcao obrigatória: ${resumo}`);
  EVENTOS.push(e);
  return e;
}

// ---- Fluxo 1: bootstrap (pré-registro importado e eventos do registrar)
const pre = (hora, tipoOriginal, resultado, resumo, x = {}) => ev(D1, hora, 'cerebro', F1, 'bootstrap', resultado, resumo, Object.assign({ tipo_original: tipoOriginal, sessao: null }, x));
pre('00:52:02', 'pedido-recebido', 'ok', 'Pedido do dono: montar o workspace a partir do documento de instruções', {
  origem: 'dono-direto',
  direcao: 'Pedido chegou pelo chat do Maestri; carreguei as skills de conexão e de gestão do Maestri antes de agir.',
});
pre('00:54:00', 'consulta', 'ok', 'Lido o documento de instruções inteiro', {
  origem: 'dono-direto',
  direcao: 'Leitura integral antes de qualquer ação, como o próprio pedido exige; nada foi criado nessa etapa.',
});
pre('00:57:00', 'consulta', 'ok', 'Fase 0: reconhecimento do Maestri, do Claude Code e da máquina', {
  origem: 'dono-direto',
  direcao: `Só leitura: workspace Exemplo em ${RAIZ}; uso do plano em ~/.maestri/usage/providers/.status.json; sem Python; Node 22 presente.`,
});
pre('00:58:30', 'pendencia-aberta', 'aguardando-dono', 'Perguntado ao dono: confirmar a raiz e escolher Node.js ou instalar Python', {
  origem: 'dono-direto', precisa_dono: true, pendencias: ['P-0001'],
  direcao: 'O documento manda confirmar a raiz antes de criar arquivos e parar se faltar python3; recomendei Node.js (já instalado e é o runtime dos hooks).',
});
pre('00:59:30', 'consulta', 'em-andamento', 'Disparado workflow de 3 sondas (CLI do Maestri, Claude Code, Windows)', {
  origem: 'dono-direto',
  direcao: 'Testes empíricos só no scratchpad para descobrir o formato real dos hooks, a carga de CLAUDE.md e skills a partir de diretório-pai, o modelo 1M, a trava de arquivo em Node, junções e a porta 4777.',
});
pre('01:00:30', 'decisao', 'ok', 'Dono confirmou: raiz do workspace, Node.js, todos os agentes em Opus 5.5 1M xhigh', {
  origem: 'dono-direto', pendencias: ['P-0001'],
  direcao: 'Decisão do dono registrada; modelo e nível por agente vão para agentes.json para o painel mostrar; controle pelo painel fica como evolução sugerida.',
});
pre('01:01:00', 'execucao', 'ok', 'Criada a árvore de diretórios de _maestro/', {
  origem: 'dono-direto',
  direcao: 'Criei só pastas, na raiz confirmada pelo dono; arquivos vêm na Fase 1 depois que as convenções fecharem a Fase 0.',
});
ev(D1, '01:35:10', 'cerebro', F1, 'execucao', 'ok', 'Fase 1: CLAUDE.md, fichas, protocolos e manual do Trello gravados', {
  origem: 'dono-direto', sessao: null, duracao_s: 1830,
  direcao: 'Textos integrais do documento de instruções, com a adaptação para Node registrada em decisoes.md; o manual foi salvo verbatim e conferido por hash.',
  passos: ['Gravei o CLAUDE.md da raiz', 'Gravei as fichas do Cérebro e do Coordenador', 'Gravei os 4 protocolos (delegação, autonomia, registro, pendências)', 'Salvei o manual do Trello e os princípios verbatim', 'Conferi os hashes antes e depois'],
  alteracoes: ['CLAUDE.md (raiz do workspace)', '_maestro/registro/fichas/cerebro.md', '_maestro/registro/fichas/coordenador-trello.md', '_maestro/conhecimento/protocolos/ (4 arquivos)', '_maestro/conhecimento/trello/manual.md'],
  validacao: 'md5 do manual igual ao do documento original (antes.md5 = depois.md5)',
});
ev(D1, '02:10:45', 'cerebro', F1, 'decisao', 'ok', 'Registradas as decisões de adaptação em decisoes.md', {
  origem: 'dono-direto', sessao: null,
  direcao: 'Cada adaptação da máquina (Node, junções, EXLOCK, hooks no settings do usuário) virou decisão numerada, para os próximos agentes não refazerem as sondas.',
  alteracoes: ['_maestro/registro/decisoes.md'],
});
ev(D1, '02:40:00', 'cerebro', F1, 'execucao', 'ok', 'Fase 2: registrar.js e pendencia.js com trava EXLOCK e gravação atômica', {
  origem: 'dono-direto', sessao: null, duracao_s: 2410,
  direcao: 'EXLOCK do Windows no lugar do fcntl: a trava some sozinha quando o processo dono dela morre; os JSONL usam uma chamada de append por linha, sem trava.',
  passos: ['Escrevi lib_maestro.js (trava, gravação atômica, fuso)', 'Escrevi registrar.js e pendencia.js', 'Criei os wrappers sh e .cmd', 'Rodei o teste de concorrência com 8 processos'],
  comandos: [`node ${BIN}/registrar.js novo-fluxo --titulo "Teste de concorrência"`, `node ${BIN}/testes/concorrencia.js --processos 8 --vezes 100`],
  alteracoes: ['_maestro/bin/lib_maestro.js', '_maestro/bin/registrar.js', '_maestro/bin/pendencia.js', '_maestro/bin/registrar, registrar.cmd, pendencia, pendencia.cmd'],
  validacao: 'Contador fechou 800/800 com 8 processos; 0 linhas corrompidas em 2400 appends',
});
ev(D1, '02:52:12', 'cerebro', F1, 'execucao', 'ok', 'Teste do registrar: evento completo via --json', {
  origem: 'sistema', sessao: null, teste: true,
  direcao: 'Evento de teste para conferir a validação e a gravação; marcado como teste para o painel esconder.',
});
ev(D1, '02:53:40', 'cerebro', F1, 'erro', 'falhou', 'Teste do registrar: resultado inválido rejeitado com código 2', {
  origem: 'sistema', sessao: null, teste: true,
  validacao: 'O registrar recusou "resultado": "talvez" e não gravou nada',
});
ev(D1, '03:05:30', 'cerebro', F1, 'execucao', 'ok', 'Hooks do log bruto instalados no settings.json do usuário', {
  origem: 'dono-direto', sessao: null, duracao_s: 640,
  direcao: 'Forma exec (node + args) por ser ~100 ms mais rápida que via Git Bash; backup e mescla com os hooks que já existem, nunca sobrescrita.',
  passos: ['Backup de ~/.claude/settings.json', 'Mescla dos 8 eventos na forma exec', 'Validação do JSON', 'Sessão de teste conferindo o log bruto'],
  comandos: [`node ${BIN}/instalar-hooks.js --backup`],
  alteracoes: ['~/.claude/settings.json (8 hooks acrescentados; backup ao lado)'],
  validacao: 'A sessão de teste gravou SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, Stop e SessionEnd',
});
ev(D1, '03:20:05', 'cerebro', F1, 'execucao', 'ok', 'Fase 3: recrutado o Coordenador do Trello (Opus 5.5 1M, xhigh)', {
  origem: 'dono-direto',
  direcao: 'Recruta com --preset "Claude Code" e o comando que fixa o modelo; terminal_id e diretório gravados em agentes.json.',
  comandos: ['maestri recruit "Coordenador do Trello" --preset "Claude Code" --command \'claude --model "claude-opus-5-5[1m]" --effort xhigh\''],
  alteracoes: ['_maestro/registro/agentes.json (terminal_id e diretorios do Coordenador)'],
  validacao: 'maestri list mostra o Coordenador conectado ao Cérebro e ao portal trello.com',
});
ev(D1, '03:31:50', 'cerebro', F1, 'execucao', 'ok', 'Skills do Coordenador expostas por junção e carregando', {
  origem: 'dono-direto',
  direcao: 'Junção NTFS em .claude/skills da raiz porque symlink exige admin; conferi que as 7 skills aparecem na sessão do Coordenador.',
  alteracoes: ['.claude/skills/ (7 junções para _maestro/skills/coordenador-trello)'],
  validacao: 'A sessão do Coordenador listou trello-leitura, trello-escrita-ui, trello-tarefas, trello-auditoria, trello-limpeza-semanal, trello-relatorio e trello-lapidacao',
});

// ---- Fluxo 2: primeira leitura do Trello, auditoria, pendências e rotina
ev(D1, '13:48:30', 'cerebro', F2, 'delegacao', 'ok', 'Delegada ao Coordenador a primeira leitura completa do quadro', {
  origem: 'cerebro',
  direcao: 'Fase 4 do bootstrap em somente leitura: o dono vê o diagnóstico antes de liberar qualquer escrita. Pedi RST, auditoria e as pendências de decisão.',
  comandos: [`node ${BIN}/registrar.js novo-fluxo --titulo "Trello: primeira leitura, auditoria e pendências"`, 'maestri ask "Coordenador do Trello" "[DELEGACAO F-20261008-0002] Faça a primeira leitura completa do quadro…"'],
});
ev(D1, '13:49:05', 'coordenador-trello', F2, 'pedido-recebido', 'ok', 'Pedido do Cérebro: primeira leitura completa, RST e auditoria (somente leitura)', { origem: 'cerebro' });
ev(D1, '13:52:40', 'coordenador-trello', F2, 'execucao', 'ok', 'Leitura completa do quadro pelo JSON: 13 cartões abertos', {
  origem: 'cerebro', duracao_s: 215,
  direcao: 'Usei o JSON do quadro em vez da interface porque traz espelhos e checklists numa leitura só; nenhuma escrita, bootstrap em somente leitura.',
  passos: ['Naveguei para o JSON do quadro', 'Salvei o bruto em snapshot-bruto.json', 'A primeira normalização falhou (body truncado) e reli o JSON', 'Normalizei para resumo.json e acrescentei a linha em serie.jsonl', 'Voltei o portal ao quadro'],
  comandos: [`maestri portal navigate "trello.com" "${URL_JSON_QUADRO}"`, 'maestri portal text "trello.com" body', `node ${NORMALIZAR} --fluxo ${F2}`, 'maestri portal navigate "trello.com" "https://trello.com/b/EXEMPLO0/quadro-exemplo"'],
  alteracoes: ['estado/trello/snapshot-bruto.json', 'estado/trello/resumo.json', 'estado/trello/serie.jsonl (+1 linha)'],
  validacao: '13 cartões abertos no JSON = 13 no resumo; 3 espelhos lidos (2 em 📝 A fazer, 1 em ⏳ Em andamento)',
  proximo_passo: 'Rodar a auditoria (manual §8) e gerar o RST',
});
ev(D1, '14:05:10', 'coordenador-trello', F2, 'auditoria', 'ok', 'Auditoria do quadro: 11 correções mecânicas e 9 decisões', {
  origem: 'cerebro', duracao_s: 742,
  direcao: 'Classifiquei como mecânico só o que o manual §12 permite fazer sem ok (criar e mover espelhos); nomes, etiquetas, descrições e escopo ficaram como decisão.',
  passos: ['Reli o checklist de auditoria do manual §8', 'Comparei item a item com o diagnóstico do manual §10', 'Separei mecânicos (nível 1) de decisões (nível 2 e 3)'],
  validacao: 'Bate com o diagnóstico do manual §10: 10 sem espelho + 1 na coluna errada; 9 decisões',
  proximo_passo: 'Gerar o RST e abrir as pendências de decisão',
});
ev(D1, '14:06:00', 'coordenador-trello', F2, 'relatorio', 'ok', 'RST gerado e salvo em estado/trello/rst.md', {
  origem: 'cerebro', alteracoes: ['estado/trello/rst.md'],
});
ev(D1, '14:12:20', 'coordenador-trello', F2, 'pendencia-aberta', 'aguardando-dono', 'Aberta P-0002: liberar as correções mecânicas do quadro', {
  origem: 'cerebro', precisa_dono: true, pendencias: ['P-0002'],
  comandos: [`node ${BIN}/pendencia.js abrir --agente coordenador-trello --fluxo ${F2} --severidade alta --tipo aprovacao --titulo "Liberar as correções mecânicas do quadro (espelhos)"`],
});
ev(D1, '14:13:05', 'coordenador-trello', F2, 'pendencia-aberta', 'aguardando-dono', 'Aberta P-0003: Eco, definir etiqueta e prefixo', {
  origem: 'cerebro', precisa_dono: true, pendencias: ['P-0003'], projeto: 'E', trello: trelloRef('EXEMPLOB', 'A Fazer', 'A Fazer'),
});
ev(D1, '14:13:50', 'coordenador-trello', F2, 'pendencia-aberta', 'aguardando-dono', 'Aberta P-0004: renomear a etiqueta "Feito" para "Concluído"', {
  origem: 'cerebro', precisa_dono: true, pendencias: ['P-0004'],
});
ev(D1, '14:14:30', 'coordenador-trello', F2, 'pendencia-aberta', 'aguardando-dono', 'Aberta P-0005: remover 5 etiquetas sem uso ou sem nome', {
  origem: 'cerebro', precisa_dono: true, pendencias: ['P-0005'],
});
ev(D1, '14:16:00', 'cerebro', F2, 'resposta-recebida', 'ok', 'Recebido do Coordenador: RST e 4 pendências abertas', { origem: 'agente:coordenador-trello' });
ev(D1, '14:18:30', 'cerebro', F2, 'aviso', 'ok', 'Avisado o dono: 4 decisões do Trello esperando (P-0002 a P-0005)', {
  origem: 'cerebro', pendencias: ['P-0002', 'P-0003', 'P-0004', 'P-0005'],
});

// ---- de volta ao fluxo 1 (Fases 5 e 6)
ev(D1, '15:12:30', 'cerebro', F1, 'execucao', 'ok', 'Fase 5: painel no ar em http://127.0.0.1:4777', {
  origem: 'dono-direto',
  direcao: 'Servidor Node só em 127.0.0.1 com checagem de Host; o terminal Servidor do Painel roda o node e o próprio servidor grava o PID em estado/painel.pid.',
  comandos: ['curl -s -o /dev/null -w "%{http_code} %{time_total}" http://127.0.0.1:4777/api/estado', 'curl -s -H "Host: exemplo.invalido" http://127.0.0.1:4777/api/estado'],
  validacao: 'GET /api/estado 200 em 41 ms; Host forjado recebeu 403',
});
ev(D1, '15:20:00', 'cerebro', F1, 'consulta', 'parcial', 'Conferido o painel no portal: 6 abas, tema claro e escuro', {
  origem: 'dono-direto',
  direcao: 'Screenshots do portal Painel em 900 px e em tela cheia; o gráfico do Trello ainda tem um ponto só.',
  proximo_passo: 'O gráfico ganha pontos com as leituras de hora em hora (Fase 6)',
});
ev(D1, '15:41:00', 'cerebro', F1, 'decisao', 'ok', 'Dono aprovou a rotina de leitura do Trello de hora em hora (8h às 22h)', {
  origem: 'dono-direto',
  direcao: 'Leitura é só consulta ao JSON do quadro: custo baixo e mantém a saúde do painel verde. A limpeza semanal fica para depois da liberação das escritas.',
});
ev(D1, '15:44:30', 'cerebro', F1, 'execucao', 'ok', 'Rotina "Trello · leitura" criada no Maestri, pulando se ocupado', {
  origem: 'dono-direto',
  direcao: 'Criada pela CLI com o prompt da §13 e o fluxo F-20261008-0002 no texto, para as leituras ficarem ligadas à primeira; a primeira execução é às 16:00.',
  comandos: ['maestri routine create "Trello · leitura" --command "[ROTINA F-20261008-0002] Leia o quadro (somente leitura)…" --hourly --from 08:00 --to 22:00 --skip-if-busy'],
  validacao: 'maestri routine list mostra a rotina ativa, próxima execução às 16:00',
});
ev(D1, '15:58:00', 'cerebro', F1, 'relatorio', 'ok', 'Relatório final do bootstrap entregue ao dono', {
  origem: 'dono-direto', pendencias: ['P-0002', 'P-0003', 'P-0005'],
  proximo_passo: 'Aguardar as decisões P-0002, P-0003 e P-0005 para liberar as escritas no Trello',
});

// ---- leituras de rotina (fluxo 2)
const leitura = (dia, hora, resumo, x = {}) => ev(dia, hora, 'coordenador-trello', F2, 'execucao', 'ok', resumo, Object.assign({
  origem: 'rotina', duracao_s: 38,
  direcao: 'Leitura de rotina pelo JSON do quadro, somente leitura; resumo, série e RST atualizados.',
  validacao: '13 cartões abertos no JSON = 13 no resumo',
}, x));
leitura(D1, '16:00:40', 'Leitura do quadro: 13 abertas, sem mudança');
leitura(D1, '17:00:35', 'Leitura do quadro: 13 abertas, sem mudança');
leitura(D1, '18:00:30', 'Leitura do quadro: D: Ajustar o envio de e-mails passou para Em andamento', {
  projeto: 'D', trello: trelloRef('EXEMPLO6', 'A Fazer', 'Em andamento'),
  direcao: 'Mudança feita pelo dono no quadro; só registrei. O cartão continua sem espelho (correção mecânica esperando a P-0002).',
});
leitura(D1, '19:00:25', 'Leitura do quadro: 13 abertas, sem mudança');
leitura(D1, '20:00:50', 'Leitura do quadro: B: Blog - Calendário passou para Em andamento', {
  projeto: 'B', trello: trelloRef('EXEMPLO2', 'A Fazer', 'Em andamento'),
  direcao: 'Mudança feita pelo dono; só registrei. Checklist em 3/8, ainda sem espelho.',
});
leitura(D1, '21:00:20', 'Leitura do quadro: 13 abertas, sem mudança');
leitura(D1, '22:00:30', 'Leitura do quadro: 13 abertas, sem mudança');
leitura(D2, '08:00:45', 'Leitura do quadro: C: Revisar o desenho concluído, espelho ficou em Em andamento', {
  projeto: 'C', trello: trelloRef('EXEMPLO4', 'Em andamento', 'Concluído'), duracao_s: 44,
  direcao: 'O dono concluiu o cartão à noite. Mover o espelho para ✅ Concluído é mecânico, mas as escritas seguem bloqueadas até a P-0002; alertas mecânicos passaram de 11 para 12.',
  passos: ['Naveguei para o JSON do quadro', 'Salvei o bruto', 'Normalizei e comparei com a leitura das 22:00', 'Avisei o Cérebro do alerta novo', 'Voltei o portal ao quadro'],
  comandos: [`maestri portal navigate "trello.com" "${URL_JSON_QUADRO}"`, 'maestri portal text "trello.com" body', `node ${NORMALIZAR} --fluxo ${F2}`, 'maestri ask "Cérebro Principal" "[AVISO F-20261008-0002] Novo alerta mecânico…"'],
  alteracoes: ['estado/trello/resumo.json', 'estado/trello/serie.jsonl (+1 linha)', 'estado/trello/rst.md'],
  proximo_passo: 'Mover o espelho quando a P-0002 for liberada',
});

// ---- sexta 09/10
ev(D2, '08:41:10', 'cerebro', F2, 'resposta-recebida', 'ok', 'Dono respondeu a P-0004: pode renomear "Feito" para "Concluído"', {
  origem: 'dono-direto', pendencias: ['P-0004'],
  comandos: [`node ${BIN}/pendencia.js responder P-0004 --resposta "Pode renomear."`],
});
ev(D2, '08:42:00', 'cerebro', F2, 'delegacao', 'ok', 'Repassada ao Coordenador a resposta da P-0004', {
  origem: 'dono-direto', pendencias: ['P-0004'],
  direcao: 'As escritas ainda não foram liberadas (P-0002); pedi para guardar a resposta e executar junto com as correções mecânicas, num ciclo só, relendo o JSON no fim.',
});
ev(D2, '09:15:30', 'cerebro', F2, 'erro', 'falhou', 'Rotina das 09:00 não registrou a leitura do Trello', {
  origem: 'sistema', precisa_dono: true,
  direcao: 'Conferi o terminal do Coordenador: depois do reinício do Maestri às 08:55 ele está parado no diálogo "Do you trust the files in this folder?". Não aceito diálogo de confiança sozinho.',
  passos: ['Notei a falta do evento das 09:00', 'Perguntei ao Coordenador pelo maestri (sem resposta em 60 s)', 'Olhei o terminal: diálogo de confiança aberto'],
  proximo_passo: 'Abrir pendência crítica para o dono aceitar o diálogo',
});
ev(D2, '09:30:10', 'cerebro', F2, 'consulta', 'ok', 'Teste do painel: evento marcado como teste', { origem: 'sistema', teste: true });
ev(D2, '10:02:15', 'cerebro', F2, 'pendencia-aberta', 'bloqueado', 'Aberta P-0006: aceitar o diálogo de confiança no terminal do Coordenador', {
  origem: 'sistema', precisa_dono: true, pendencias: ['P-0006'],
  direcao: 'Crítica porque o Trello está sem leitura desde 08:00 e as rotinas seguem falhando; recomendei aceitar na raiz para nenhum role parar de novo.',
  proximo_passo: 'Quando o dono aceitar, pedir uma leitura avulsa e conferir o hook do Coordenador',
});
ev(D2, '10:20:05', 'cerebro', F2, 'consulta', 'ok', 'Dono perguntou o status do Trello: respondido com o RST das 08:00', {
  origem: 'dono-direto',
  direcao: 'Respondi com o RST salvo das 08:00 e avisei que a leitura está parada até a P-0006.',
});

EVENTOS.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

// ---------------------------------------------------------------- pendências (estado/pendencias.json)

const PENDENCIAS = [
  {
    id: 'P-0001', aberta_em: ts(D1, '00:58:30'), agente: 'cerebro', fluxo_id: F1, severidade: 'critica', tipo: 'decisao',
    titulo: 'Confirmar a raiz do workspace e a linguagem dos scripts (não há Python)',
    contexto: 'O documento de instruções manda confirmar a raiz antes de criar arquivos e parar se faltar python3. Nesta máquina não há Python; o Node 22 já roda os hooks.',
    opcoes: [`A: raiz ${RAIZ} e scripts em Node.js 22`, 'B: instalar o Python 3 e seguir o documento à risca'],
    recomendacao: 'A: o Node já está instalado e é o runtime dos hooks; o fcntl do Python nem existe no Windows.',
    trello: null, status: 'resolvida', resposta: 'A. E todos os agentes em Opus 5.5 com 1M, nível xhigh.',
    respondida_em: ts(D1, '01:00:30'), resolvida_em: ts(D1, '01:00:30'), nota: 'Registrado em decisoes.md.', motivo: null, teste: false, atualizada_em: ts(D1, '01:00:30'),
  },
  {
    id: 'P-0002', aberta_em: ts(D1, '14:12:20'), agente: 'coordenador-trello', fluxo_id: F2, severidade: 'alta', tipo: 'aprovacao',
    titulo: 'Liberar as correções mecânicas do quadro (espelhos)',
    contexto: 'Na leitura de 08/10 eram 11: 10 tarefas sem espelho e o espelho do A: 05/10 na coluna errada. Desde 09/10 08:00 são 12 (o espelho do C: Revisar o desenho ficou em ⏳ Em andamento). São correções dentro das regras do manual §12, mas o bootstrap está em somente leitura.',
    opcoes: ['A: liberar todas agora', 'B: liberar só os espelhos na coluna errada e revisar a lista dos sem espelho antes', 'C: manter somente leitura por enquanto'],
    recomendacao: 'A: são mecânicas e reversíveis (arquivar o espelho desfaz), e confiro relendo o JSON depois de cada uma.',
    trello: null, status: 'aberta', resposta: null, respondida_em: null, resolvida_em: null, nota: null, motivo: null, teste: false, atualizada_em: ts(D2, '08:00:45'),
  },
  {
    id: 'P-0003', aberta_em: ts(D1, '14:13:05'), agente: 'coordenador-trello', fluxo_id: F2, severidade: 'alta', tipo: 'decisao',
    titulo: 'Eco: definir etiqueta e prefixo',
    contexto: 'A coluna é amarela, o único cartão usa a etiqueta Eco Lab (laranja escuro) e o prefixo E:. Não existe etiqueta "Eco".',
    opcoes: ["A: etiqueta 'Eco' amarela, prefixo E:", "B: etiqueta 'Eco' amarela, prefixo EC:", "C: coluna vira 'Eco Lab', mantém E:"],
    recomendacao: 'A: o prefixo de uma letra já é usado pelos outros projetos e a etiqueta amarela casa com a coluna.',
    trello: { shortLink: 'EXEMPLOB', url: urlC('EXEMPLOB') }, status: 'aberta', resposta: null, respondida_em: null, resolvida_em: null, nota: null, motivo: null, teste: false, atualizada_em: ts(D1, '14:13:05'),
  },
  {
    id: 'P-0004', aberta_em: ts(D1, '14:13:50'), agente: 'coordenador-trello', fluxo_id: F2, severidade: 'normal', tipo: 'decisao',
    titulo: 'Renomear a etiqueta "Feito" para "Concluído"',
    contexto: 'A etiqueta de status se chama "Feito", mas a coluna é "✅ Concluído" (manual §10, item 3).',
    opcoes: ['A: renomear a etiqueta para "Concluído"', 'B: manter "Feito" e renomear a coluna'],
    recomendacao: 'A, como o manual já prevê.',
    trello: null, status: 'respondida', resposta: 'Pode renomear.', respondida_em: ts(D2, '08:41:10'), resolvida_em: null, nota: 'Executar junto com as correções mecânicas (P-0002).', motivo: null, teste: false, atualizada_em: ts(D2, '08:42:00'),
  },
  {
    id: 'P-0005', aberta_em: ts(D1, '14:14:30'), agente: 'coordenador-trello', fluxo_id: F2, severidade: 'baixa', tipo: 'aprovacao',
    titulo: 'Remover 5 etiquetas sem uso ou sem nome',
    contexto: '"Boreal antigo" (preto suave), "Cometa antigo" (céu escuro) e 3 sem nome (laranja, vermelho, amarelo). Nenhum cartão usa. Exclusão só com ok do dono.',
    opcoes: ['A: remover as 5', 'B: remover só as 3 sem nome'],
    recomendacao: 'A: nenhuma está em uso e elas confundem quem escolhe etiqueta.',
    trello: null, status: 'aberta', resposta: null, respondida_em: null, resolvida_em: null, nota: null, motivo: null, teste: false, atualizada_em: ts(D1, '14:14:30'),
  },
  {
    id: 'P-0006', aberta_em: ts(D2, '10:02:15'), agente: 'cerebro', fluxo_id: F2, severidade: 'critica', tipo: 'aprovacao',
    titulo: 'Aceitar o diálogo de confiança no terminal do Coordenador',
    contexto: 'Depois do reinício do Maestri às 08:55, o Claude do Coordenador parou em "Do you trust the files in this folder?". As leituras das 09:00 e das 10:00 não rodaram e o Trello está sem leitura desde 08:00.',
    opcoes: ['A: aceitar no terminal do Coordenador', 'B: aceitar uma vez na raiz do workspace, para nenhum role parar de novo'],
    recomendacao: 'B: resolve de vez para todos os roles do workspace (a confiança vale para as pastas abaixo).',
    trello: null, status: 'aberta', resposta: null, respondida_em: null, resolvida_em: null, nota: null, motivo: null, teste: false, atualizada_em: ts(D2, '10:02:15'),
  },
];

// ---------------------------------------------------------------- comandos brutos (logs/bruto/<agente>/AAAA-MM-DD.jsonl)

const BRUTOS = [];
function bruto(dia, hora, agente, evento, ferramenta, entrada, x = {}) {
  const a = AG[agente];
  const linha = { ts: ts(dia, hora), agente, terminal: a.terminal, sessao: a.sessao };
  if (x.fluxo) linha.fluxo_id = x.fluxo;
  linha.evento = evento;
  if (ferramenta) linha.ferramenta = ferramenta;
  if (evento === 'UserPromptSubmit') linha.prompt = entrada;
  else if (entrada != null) linha.entrada = entrada;
  if (evento === 'PostToolUse') linha.ok = true;
  if (evento === 'PostToolUseFailure') { linha.ok = false; linha.erro = x.erro || 'falhou'; }
  if (x.saida) linha.saida_resumo = x.saida;
  if (x.duracao_ms != null) linha.duracao_ms = x.duracao_ms;
  linha.cwd = a.cwd;
  linha.versao = '2.1.292';
  BRUTOS.push(linha);
}
const C = 'cerebro';
const K = 'coordenador-trello';
const REG = `node ${BIN}/registrar.js evento --json -`;

// bootstrap depois dos hooks (03:05): sessão do Cérebro sem fluxo no prompt
bruto(D1, '03:18:44', C, 'PostToolUse', 'Bash', 'maestri preset list', { duracao_ms: 820, saida: 'Claude Code, Codex, Antigravity, OpenCode, Shell' });
bruto(D1, '03:19:40', C, 'PostToolUse', 'Bash', 'maestri recruit "Coordenador do Trello" --preset "Claude Code" --command \'claude --model "claude-opus-5-5[1m]" --effort xhigh\'', { duracao_ms: 6140, saida: 'Recruited "Coordenador do Trello"' });
bruto(D1, '03:19:58', C, 'PostToolUse', 'Edit', `${RAIZ}/_maestro/registro/agentes.json`, { duracao_ms: 35 });
bruto(D1, '03:20:03', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 190 });
bruto(D1, '03:29:12', C, 'PostToolUse', 'Bash', `node -e "require('fs').symlinkSync('${RAIZ}/_maestro/skills/coordenador-trello/trello-leitura', '${RAIZ}/.claude/skills/trello-leitura', 'junction')"`, { duracao_ms: 120 });
bruto(D1, '03:31:47', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 185 });
// fluxo 2: delegação (prompt do dono sem fluxo; o id só aparece no texto mandado ao Coordenador)
bruto(D1, '13:47:52', C, 'UserPromptSubmit', null, 'Pode seguir para a Fase 4.');
bruto(D1, '13:48:12', C, 'PostToolUse', 'Bash', `node ${BIN}/registrar.js novo-fluxo --titulo "Trello: primeira leitura, auditoria e pendências"`, { duracao_ms: 210, saida: F2 });
bruto(D1, '13:48:21', C, 'PostToolUse', 'Bash', 'maestri ask "Coordenador do Trello" "[DELEGACAO F-20261008-0002] Faça a primeira leitura completa do quadro (somente leitura), gere o RST e a auditoria e abra as pendências de decisão."', { duracao_ms: 1450 });
bruto(D1, '13:48:29', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 175 });
// Coordenador: o prompt traz o fluxo, e as entradas seguintes herdam
bruto(D1, '13:49:01', K, 'UserPromptSubmit', null, '[DELEGACAO F-20261008-0002] Faça a primeira leitura completa do quadro (somente leitura), gere o RST e a auditoria e abra as pendências de decisão.', { fluxo: F2 });
bruto(D1, '13:49:03', K, 'PostToolUse', 'Bash', REG, { fluxo: F2, duracao_ms: 180 });
bruto(D1, '13:49:20', K, 'PostToolUse', 'Skill', 'trello-leitura', { fluxo: F2, duracao_ms: 40 });
bruto(D1, '13:49:41', K, 'PostToolUse', 'Bash', `maestri portal navigate "trello.com" "${URL_JSON_QUADRO}"`, { fluxo: F2, duracao_ms: 2310 });
bruto(D1, '13:50:05', K, 'PostToolUse', 'Bash', `maestri portal text "trello.com" body > ${RAIZ}/_maestro/estado/trello/snapshot-bruto.json`, { fluxo: F2, duracao_ms: 1870 });
bruto(D1, '13:50:31', K, 'PostToolUseFailure', 'Bash', `node ${NORMALIZAR} --fluxo ${F2}`, { fluxo: F2, duracao_ms: 260, erro: 'Exit code 2: ErroEntrada: o JSON do quadro terminou no meio (body truncado); leia de novo com maestri portal text' });
bruto(D1, '13:51:10', K, 'PostToolUse', 'Bash', `maestri portal text "trello.com" body > ${RAIZ}/_maestro/estado/trello/snapshot-bruto.json`, { fluxo: F2, duracao_ms: 2050 });
bruto(D1, '13:51:44', K, 'PostToolUse', 'Bash', `node ${NORMALIZAR} --fluxo ${F2}`, { fluxo: F2, duracao_ms: 310, saida: 'Resumo: 13 abertas · 11 a fazer · 2 em andamento · 0 concluído' });
bruto(D1, '13:52:06', K, 'PostToolUse', 'Bash', 'maestri portal navigate "trello.com" "https://trello.com/b/EXEMPLO0/quadro-exemplo"', { fluxo: F2, duracao_ms: 1980 });
bruto(D1, '13:52:38', K, 'PostToolUse', 'Bash', REG, { fluxo: F2, duracao_ms: 190 });
bruto(D1, '13:58:12', K, 'PostToolUse', 'Read', `${RAIZ}/_maestro/conhecimento/trello/manual.md`, { fluxo: F2, duracao_ms: 22 });
bruto(D1, '14:00:02', K, 'PostToolUse', 'Glob', '_maestro/estado/trello/*.json', { duracao_ms: 15 });
bruto(D1, '14:04:55', K, 'PostToolUse', 'Bash', REG, { fluxo: F2, duracao_ms: 200 });
bruto(D1, '14:05:58', K, 'PostToolUse', 'Bash', REG, { fluxo: F2, duracao_ms: 170 });
bruto(D1, '14:12:18', K, 'PostToolUse', 'Bash', `node ${BIN}/pendencia.js abrir --agente coordenador-trello --fluxo ${F2} --severidade alta --tipo aprovacao --titulo "Liberar as correções mecânicas do quadro (espelhos)"`, { fluxo: F2, duracao_ms: 230, saida: 'P-0002' });
bruto(D1, '14:13:02', K, 'PostToolUse', 'Bash', `node ${BIN}/pendencia.js abrir --agente coordenador-trello --fluxo ${F2} --severidade alta --tipo decisao --titulo "Eco: definir etiqueta e prefixo" --trello EXEMPLOB`, { fluxo: F2, duracao_ms: 220, saida: 'P-0003' });
bruto(D1, '14:13:47', K, 'PostToolUse', 'Bash', `node ${BIN}/pendencia.js abrir --agente coordenador-trello --fluxo ${F2} --severidade normal --tipo decisao --titulo "Renomear a etiqueta \\"Feito\\" para \\"Concluído\\""`, { fluxo: F2, duracao_ms: 215, saida: 'P-0004' });
bruto(D1, '14:14:27', K, 'PostToolUse', 'Bash', `node ${BIN}/pendencia.js abrir --agente coordenador-trello --fluxo ${F2} --severidade baixa --tipo aprovacao --titulo "Remover 5 etiquetas sem uso ou sem nome"`, { fluxo: F2, duracao_ms: 225, saida: 'P-0005' });
bruto(D1, '14:15:10', K, 'PostToolUse', 'Bash', 'maestri ask "Cérebro Principal" "[RESPOSTA F-20261008-0002] RST em estado/trello/rst.md; 11 mecânicos, 9 decisões; abri P-0002 a P-0005."', { fluxo: F2, duracao_ms: 1320 });
bruto(D1, '14:15:12', K, 'Stop', null, null, { fluxo: F2 });
// leitura de 09/10 08:00
bruto(D2, '08:00:02', K, 'UserPromptSubmit', null, '[ROTINA F-20261008-0002] Leia o quadro (somente leitura), atualize snapshot, resumo e série, e registre o evento. Se houver alerta novo de consistência ou algo que precise do dono, avise o Cérebro com [AVISO].', { fluxo: F2 });
bruto(D2, '08:00:14', K, 'PostToolUse', 'Bash', `maestri portal navigate "trello.com" "${URL_JSON_QUADRO}"`, { fluxo: F2, duracao_ms: 2240 });
bruto(D2, '08:00:21', K, 'PostToolUse', 'Bash', `maestri portal text "trello.com" body > ${RAIZ}/_maestro/estado/trello/snapshot-bruto.json`, { fluxo: F2, duracao_ms: 1910 });
bruto(D2, '08:00:30', K, 'PostToolUse', 'Bash', `node ${NORMALIZAR} --fluxo ${F2}`, { fluxo: F2, duracao_ms: 295, saida: 'Resumo: 13 abertas · 9 a fazer · 3 em andamento · 1 concluído · 12 mecânicos' });
bruto(D2, '08:00:38', K, 'PostToolUse', 'Bash', 'maestri ask "Cérebro Principal" "[AVISO F-20261008-0002] Novo alerta mecânico: o espelho do C: Revisar o desenho ficou em ⏳ Em andamento."', { fluxo: F2, duracao_ms: 1290 });
bruto(D2, '08:00:41', K, 'PostToolUse', 'Bash', 'maestri portal navigate "trello.com" "https://trello.com/b/EXEMPLO0/quadro-exemplo"', { fluxo: F2, duracao_ms: 1730 });
bruto(D2, '08:00:44', K, 'PostToolUse', 'Bash', REG, { fluxo: F2, duracao_ms: 185 });
bruto(D2, '08:00:47', K, 'Stop', null, null, { fluxo: F2 });
bruto(D2, '08:58:12', K, 'SessionEnd', null, null, { fluxo: F2 });
// Cérebro na sexta (prompts do dono sem id de fluxo: correlação pela janela de tempo, §10.4)
bruto(D2, '08:41:00', C, 'UserPromptSubmit', null, 'Sobre a P-0004: pode renomear.');
bruto(D2, '08:41:08', C, 'PostToolUse', 'Bash', `node ${BIN}/pendencia.js responder P-0004 --resposta "Pode renomear."`, { duracao_ms: 205 });
bruto(D2, '08:41:09', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 180 });
bruto(D2, '08:41:55', C, 'PostToolUse', 'Bash', 'maestri ask "Coordenador do Trello" "[DELEGACAO F-20261008-0002] Resposta da P-0004: pode renomear Feito para Concluído. Execute junto com as correções mecânicas quando a P-0002 liberar as escritas."', { duracao_ms: 1380 });
bruto(D2, '08:41:59', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 170 });
bruto(D2, '09:14:40', C, 'PostToolUse', 'Bash', 'maestri list', { duracao_ms: 760 });
bruto(D2, '09:15:02', C, 'PostToolUseFailure', 'Bash', 'maestri ask "Coordenador do Trello" "[ROTINA F-20261008-0002] A leitura das 09:00 rodou?"', { duracao_ms: 60110, erro: 'Exit code 1: o terminal "Coordenador do Trello" não respondeu em 60 s' });
bruto(D2, '09:15:28', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 190 });
bruto(D2, '10:02:10', C, 'PostToolUse', 'Bash', `node ${BIN}/pendencia.js abrir --agente cerebro --fluxo ${F2} --severidade critica --tipo aprovacao --titulo "Aceitar o diálogo de confiança no terminal do Coordenador"`, { duracao_ms: 240, saida: 'P-0006' });
bruto(D2, '10:02:13', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 175 });
bruto(D2, '10:19:30', C, 'UserPromptSubmit', null, 'Como está o Trello?');
bruto(D2, '10:19:58', C, 'PostToolUse', 'Read', `${RAIZ}/_maestro/estado/trello/rst.md`, { duracao_ms: 18 });
bruto(D2, '10:20:03', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 180 });
bruto(D2, '10:23:58', C, 'PostToolUse', 'Bash', `node ${BIN}/registrar.js ultimos --horas 2`, { duracao_ms: 160 });

BRUTOS.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

// ---------------------------------------------------------------- uso (estado/uso.json, §12)

const PLANO = {
  disponivel: true, fonte: 'provedor Claude do Maestri (~/.maestri/usage/providers/.status.json)',
  janela_5h_pct: 37, reset_5h: ts(D2, '13:00:00'), semanal_pct: 22, reset_semanal: '2026-10-13T09:00:00-03:00',
  atualizado_em: ts(D2, '10:21:30'),
};
const TOKENS = {
  janela_5h: [
    { agente: 'cerebro', entrada: 2140, saida: 18650, cache_escrita: 286400, cache_leitura: 8934200 },
    { agente: 'coordenador-trello', entrada: 610, saida: 5320, cache_escrita: 98200, cache_leitura: 2210500 },
  ],
  hoje: [
    { agente: 'cerebro', entrada: 2140, saida: 18650, cache_escrita: 286400, cache_leitura: 8934200 },
    { agente: 'coordenador-trello', entrada: 610, saida: 5320, cache_escrita: 98200, cache_leitura: 2210500 },
    { agente: 'desconhecido:atlas', entrada: 820, saida: 6100, cache_escrita: 51200, cache_leitura: 1302000 },
  ],
  '7d': [
    { agente: 'cerebro', entrada: 41820, saida: 412300, cache_escrita: 3184500, cache_leitura: 96541000 },
    { agente: 'coordenador-trello', entrada: 9840, saida: 61250, cache_escrita: 1240300, cache_leitura: 24318700 },
    { agente: 'desconhecido:atlas', entrada: 3100, saida: 22400, cache_escrita: 402100, cache_leitura: 5120400 },
  ],
};
const r1 = (v) => Math.round(v * 10) / 10;
function periodoUso(lista, pctPlano) {
  const comC = lista.map((x) => Object.assign({}, x, { consumo_relativo: Math.round(x.entrada + 5 * x.saida + 1.25 * x.cache_escrita + 0.1 * x.cache_leitura) }));
  const soma = comC.reduce((s, x) => s + x.consumo_relativo, 0);
  return comC.map((x) => {
    const pc = r1((100 * x.consumo_relativo) / soma);
    return Object.assign(x, { pct_consumo: pc, pct_plano_estimado: pctPlano == null ? null : r1((pc * pctPlano) / 100) });
  }).sort((a, b) => b.pct_consumo - a.pct_consumo);
}
const USO = {
  coletado_em: ts(D2, '10:21:44'),
  plano: PLANO,
  por_agente: {
    janela_5h: periodoUso(TOKENS.janela_5h, PLANO.janela_5h_pct),
    hoje: periodoUso(TOKENS.hoje, null),
    '7d': periodoUso(TOKENS['7d'], PLANO.semanal_pct),
  },
};

// ---------------------------------------------------------------- montagem de /api/estado

const naoTeste = EVENTOS.filter((e) => !e.teste);
const recentes = [...naoTeste].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
const camposTabela = (e) => ({
  id: e.id, ts: e.ts, agente: e.agente, projeto: e.projeto, trello: e.trello, resumo: e.resumo,
  direcao: e.direcao, resultado: e.resultado, tipo: e.tipo, fluxo_id: e.fluxo_id, precisa_dono: e.precisa_dono,
});
const resumoTrello = montarResumo();
const ultimoBruto = (slug) => {
  const l = BRUTOS.filter((b) => b.agente === slug);
  return l.length ? l[l.length - 1].ts : null;
};
const usoAgente = (slug) => {
  const r = {};
  for (const per of ['janela_5h', 'hoje', '7d']) {
    const x = USO.por_agente[per].find((i) => i.agente === slug);
    r[per] = x ? { pct_consumo: x.pct_consumo, consumo_relativo: x.consumo_relativo, pct_plano_estimado: x.pct_plano_estimado } : null;
  }
  return r;
};

const abertas = PENDENCIAS.filter((p) => p.status === 'aberta' && !p.teste);
const ordemSev = { critica: 0, alta: 1, normal: 2, baixa: 3 };
const porSevIdade = (a, b) => ordemSev[a.severidade] - ordemSev[b.severidade] || Date.parse(a.aberta_em) - Date.parse(b.aberta_em);
const pendOrdenadas = [
  ...PENDENCIAS.filter((p) => p.status === 'aberta' || p.status === 'respondida').sort(porSevIdade),
  ...PENDENCIAS.filter((p) => p.status !== 'aberta' && p.status !== 'respondida')
    .sort((a, b) => Date.parse(b.resolvida_em || b.atualizada_em) - Date.parse(a.resolvida_em || a.atualizada_em)).slice(0, 20),
];

const idadeTrello = min(resumoTrello.coletado_em, AGORA);
const hooks = AGENTES.map((a) => ({ agente: a.slug, ultimo_bruto: ultimoBruto(a.slug), idade_min: min(ultimoBruto(a.slug), AGORA) }));

const estado = {
  gerado_em: AGORA,
  workspace: { nome: 'Exemplo', raiz: RAIZ },
  saude: {
    nivel: idadeTrello > 240 ? 'vermelho' : idadeTrello > 120 ? 'amarelo' : 'verde',
    motivos: idadeTrello > 120 ? [`Leitura do Trello há ${Math.floor(idadeTrello / 60)} h ${String(idadeTrello % 60).padStart(2, '0')} min (limite de 2 h)`] : [],
    trello_idade_min: idadeTrello,
    ultimo_evento_idade_min: min(recentes[0].ts, AGORA),
    uso_idade_min: min(PLANO.atualizado_em, AGORA),
    hooks,
    wire: false,
  },
  kpis: {
    pendencias: {
      total: abertas.length,
      critica: abertas.filter((p) => p.severidade === 'critica').length,
      alta: abertas.filter((p) => p.severidade === 'alta').length,
      normal: abertas.filter((p) => p.severidade === 'normal').length,
      baixa: abertas.filter((p) => p.severidade === 'baixa').length,
    },
    trello: Object.assign({}, resumoTrello.totais, { alertas_mecanicos: resumoTrello.auditoria.mecanicos.length, alertas_decisao: resumoTrello.auditoria.decisoes.length }),
    uso: {
      disponivel: PLANO.disponivel, janela_5h_pct: PLANO.janela_5h_pct, reset_5h: PLANO.reset_5h,
      semanal_pct: PLANO.semanal_pct, reset_semanal: PLANO.reset_semanal, idade_min: min(PLANO.atualizado_em, AGORA),
    },
  },
  agentes: AGENTES.map((a) => {
    const meus = recentes.filter((e) => e.agente === a.slug);
    const u = meus[0] || null;
    return {
      slug: a.slug, nome: a.nome, tipo: a.tipo, cor: a.cor, responsabilidade: a.responsabilidade, status: a.status,
      modelo: a.modelo, nivel: a.nivel, skills: a.skills, conectado_a: a.conectado_a,
      ultimo_evento: u ? { ts: u.ts, resumo: u.resumo, tipo: u.tipo, resultado: u.resultado } : null,
      eventos_hoje: meus.filter((e) => e.ts.startsWith(D2)).length,
      // o fluxo 1 (bootstrap) terminou no relatório final; o fluxo 2 segue aberto (pendências)
      fluxos_abertos: meus.some((e) => e.fluxo_id === F2) ? 1 : 0,
      ultimo_bruto: ultimoBruto(a.slug),
      uso: usoAgente(a.slug),
    };
  }),
  pendencias: pendOrdenadas,
  trello: resumoTrello,
  trello_rst: montarRst(resumoTrello),
  serie_trello: SERIE.slice(-200),
  uso: USO,
  eventos: recentes.slice(0, 200).map(camposTabela),
};

const detalhes = {
  descricao: 'Dados extras do modo de teste do painel (index.html?mock=1): eventos completos (inclusive os de teste), comandos brutos e fluxos, para imitar /api/eventos, /api/evento/<id> e /api/fluxo/<id> sem o servidor. Gerado por testes/gerar-mock.js.',
  gerado_em: AGORA,
  fluxos: {
    [F1]: { titulo: 'Bootstrap da Fase 1', agente: 'cerebro', criado_em: ts(D1, '00:52:02') },
    [F2]: { titulo: 'Trello: primeira leitura, auditoria e pendências', agente: 'cerebro', criado_em: ts(D1, '13:48:12') },
  },
  eventos: EVENTOS,
  comandos_brutos: BRUTOS,
};

// ---------------------------------------------------------------- conferências e gravação

const ids = new Set();
for (const e of EVENTOS) {
  if (ids.has(e.id)) throw new Error(`id repetido: ${e.id}`);
  ids.add(e.id);
}
const dias = new Set(naoTeste.map((e) => e.ts.slice(0, 10)));
const fluxos = new Set(EVENTOS.map((e) => e.fluxo_id));
if (dias.size !== 2 || fluxos.size !== 2) throw new Error('o cenário deve ter 2 dias e 2 fluxos');
if (resumoTrello.totais.abertas !== 13) throw new Error('o diagnóstico tem 13 tarefas abertas');

const dir = __dirname;
fs.writeFileSync(path.join(dir, 'mock-estado.json'), JSON.stringify(estado, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(dir, 'mock-detalhes.json'), JSON.stringify(detalhes, null, 2) + '\n', 'utf8');
console.log(`mock-estado.json: ${estado.eventos.length} eventos na tabela, ${estado.pendencias.length} pendências, ${resumoTrello.totais.abertas} tarefas no Trello, saúde ${estado.saude.nivel}`);
console.log(`mock-detalhes.json: ${EVENTOS.length} eventos (${EVENTOS.length - naoTeste.length} de teste), ${BRUTOS.length} comandos brutos, ${fluxos.size} fluxos`);
