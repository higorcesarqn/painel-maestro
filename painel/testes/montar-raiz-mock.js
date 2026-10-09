#!/usr/bin/env node
'use strict';
/*
 * montar-raiz-mock.js: monta uma raiz falsa de _maestro/ (MAESTRO_DIR) a partir de mock-estado.json e
 * mock-detalhes.json, para ver o index.html com o servidor.js de verdade (e não com o ?mock=1).
 *
 * Uso:
 *   node testes/montar-raiz-mock.js [pasta] [--hostil]
 *     pasta     padrão: testes/tmp/raiz-mock (sempre dentro de testes/tmp/)
 *     --hostil  acrescenta um evento, uma pendência e um cartão com HTML, javascript: e textos enormes,
 *               para conferir que a página mostra tudo como texto
 *   Depois:
 *     MAESTRO_DIR=<pasta> PAINEL_AGORA=<gerado_em do mock> PAINEL_COLETOR=0 node servidor.js --porta 4793
 *   (o script imprime a linha pronta)
 */
const fs = require('fs');
const path = require('path');

const TMP = path.join(__dirname, 'tmp');
const args = process.argv.slice(2);
const hostil = args.includes('--hostil');
const pastaArg = args.find((a) => !a.startsWith('--'));
const raiz = path.resolve(pastaArg || path.join(TMP, 'raiz-mock'));
if (!raiz.startsWith(TMP + path.sep)) {
  console.error(`A raiz falsa precisa ficar dentro de ${TMP.replace(/\\/g, '/')}.`);
  process.exit(2);
}

const estado = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-estado.json'), 'utf8'));
const det = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-detalhes.json'), 'utf8'));

fs.rmSync(raiz, { recursive: true, force: true });
const gravar = (rel, conteudo) => {
  const f = path.join(raiz, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo, null, 2));
};
const jsonl = (linhas) => linhas.map((l) => JSON.stringify(l)).join('\n') + '\n';
const diaSP = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));

// registro/agentes.json
const agentes = estado.agentes.map((a) => ({
  slug: a.slug, nome: a.nome, tipo: a.tipo, cor: a.cor, responsabilidade: a.responsabilidade, terminal_id: null,
  diretorios: [], modelo: a.modelo, nivel: a.nivel, conectado_a: a.conectado_a, skills: a.skills, status: a.status,
  desde: a.desde || '2026-10-08', observacao: a.observacao || null,
}));
gravar('registro/agentes.json', { workspace: { id: 'mock', nome: estado.workspace.nome, raiz: estado.workspace.raiz }, padrao: { modelo: 'claude-opus-5-5[1m]', nivel: 'xhigh' }, agentes });

// eventos por mês
const eventos = det.eventos.slice();
const pendencias = estado.pendencias.slice();
const resumo = JSON.parse(JSON.stringify(estado.trello));
if (hostil) {
  const ts = '2026-10-09T10:24:00-03:00';
  eventos.push({
    id: 'EV-20261009-102400-beef', ts, agente: 'coordenador-trello', fluxo_id: 'F-20261008-0002', origem: 'agente:<b>x</b>', tipo: 'execucao', projeto: '<i>D</i>',
    trello: { shortLink: 'x', titulo: '<img src=x onerror="document.title=\'XSS\'">cartão hostil', url: 'javascript:document.title="XSS"', status_antes: '<b>A Fazer</b>', status_depois: 'Em andamento' },
    resumo: '<script>document.title="XSS"</script> resumo com HTML', direcao: '<img src=x onerror="document.title=\'XSS\'"> ' + 'longa '.repeat(200),
    passos: ['<a href="javascript:alert(1)">passo</a>'], comandos: ['rm -rf / <b>'], alteracoes: [{ arquivo: '<b>a</b>', antes: 1 }],
    resultado: 'falhou', validacao: '<svg onload=alert(1)>', proximo_passo: '<iframe src=//x>', precisa_dono: true, pendencias: ['P-0006', '<b>P-9</b>'], duracao_s: 3725,
  });
  pendencias.unshift({
    id: 'P-0099', aberta_em: ts, agente: 'cerebro', fluxo_id: 'F-20261008-0002', severidade: 'critica', tipo: 'decisao',
    titulo: '<img src=x onerror="document.title=\'XSS\'"> pendência hostil', contexto: '<script>alert(1)</script>\nsegunda linha',
    opcoes: ['<b>A</b>', 'B: javascript:alert(1)'], recomendacao: '<u>sublinhado</u>', trello: { shortLink: 'x', url: 'https://trello.com.evil.example/c/x' },
    status: 'aberta', resposta: null, respondida_em: null, resolvida_em: null, nota: null, motivo: null, teste: false, atualizada_em: ts,
  });
  resumo.projetos[0].cartoes.push({
    shortLink: 'evil', url: 'http://trello.com/c/evil', titulo: 'A: <img src=x onerror="document.title=\'XSS\'">', status: 'A Fazer', posicao: 9,
    espelho: { existe: false }, tem_descricao: false, checklist: { feitos: 0, total: 0 }, prazo: '2026-10-01T12:00:00-03:00', membros: [],
    problemas: [{ codigo: 'x', mecanico: false, texto: '<b>problema</b>' }],
  });
}
const porMes = new Map();
for (const e of eventos) {
  const mes = diaSP(e.ts).slice(0, 7);
  if (!porMes.has(mes)) porMes.set(mes, []);
  porMes.get(mes).push(e);
}
for (const [mes, lista] of porMes) {
  lista.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  gravar(`logs/eventos/${mes}.jsonl`, jsonl(lista));
}

// log bruto por agente e dia
const brutos = new Map();
for (const b of det.comandos_brutos) {
  const pasta = String(b.agente).replace(':', '-');
  const k = `logs/bruto/${pasta}/${diaSP(b.ts)}.jsonl`;
  if (!brutos.has(k)) brutos.set(k, []);
  brutos.get(k).push(b);
}
for (const [k, lista] of brutos) gravar(k, jsonl(lista.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))));

// estado
const maxP = Math.max(0, ...pendencias.map((p) => Number(String(p.id).replace(/\D/g, '')) || 0));
gravar('estado/pendencias.json', { proximo: maxP + 1, pendencias });
const dias = {};
for (const id of Object.keys(det.fluxos || {})) {
  const m = /^F-(\d{8})-(\d{4})$/.exec(id);
  if (m) dias[m[1]] = { ultimo: Math.max(Number(m[2]), (dias[m[1]] && dias[m[1]].ultimo) || 0) };
}
gravar('estado/contador-fluxos.json', { dias, fluxos: det.fluxos || {} });
gravar('estado/trello/resumo.json', resumo);
if (estado.trello_rst) gravar('estado/trello/rst.md', estado.trello_rst);
gravar('estado/trello/serie.jsonl', jsonl(estado.serie_trello || []));
if (estado.uso) gravar('estado/uso.json', estado.uso);

const rel = raiz.replace(/\\/g, '/');
console.log(`Raiz falsa montada em ${rel}${hostil ? ' (com dados hostis)' : ''}`);
console.log(`Para subir: MAESTRO_DIR=${rel} PAINEL_AGORA=${estado.gerado_em} PAINEL_COLETOR=0 node ${path.join(__dirname, '..', 'servidor.js').replace(/\\/g, '/')} --porta 4793`);
