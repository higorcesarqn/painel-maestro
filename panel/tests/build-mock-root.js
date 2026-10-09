#!/usr/bin/env node
'use strict';
/*
 * build-mock-root.js: builds a fake data root (MAESTRO_DIR) from mock-state.json and mock-details.json,
 * to see index.html with the real server.js (and not with ?mock=1).
 *
 * The mocks are in the API shape (English fields); the files written here are the ones the server reads:
 * the hook's raw log (logs/raw), the collector's usage (state/usage.json) and the old model's files
 * (registro/agentes.json, logs/eventos, estado/pendencias.json, estado/contador-fluxos.json), converted
 * back to their Portuguese field names (legacy-records.js; removed in #18).
 *
 * Usage:
 *   node tests/build-mock-root.js [folder] [--hostile]
 *     folder     default: tests/tmp/mock-root (always inside tests/tmp/)
 *     --hostile  adds an event and a pending decision with HTML, javascript: and huge texts,
 *                to check that the page shows everything as text
 *   Then:
 *     MAESTRO_DIR=<folder> PANEL_NOW=<generated_at of the mock> PANEL_COLLECTOR=0 node server.js --port 4793
 *   (the script prints the ready line)
 */
const fs = require('fs');
const path = require('path');
const { eventFromApi, pendingDecisionFromApi } = require('../legacy-records.js');

const TMP = path.join(__dirname, 'tmp');
const args = process.argv.slice(2);
const hostile = args.includes('--hostile');
const folderArg = args.find((a) => !a.startsWith('--'));
const root = path.resolve(folderArg || path.join(TMP, 'mock-root'));
if (!root.startsWith(TMP + path.sep)) {
  console.error(`A raiz falsa precisa ficar dentro de ${TMP.replace(/\\/g, '/')}.`);
  process.exit(2);
}

const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-state.json'), 'utf8'));
const det = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-details.json'), 'utf8'));

fs.rmSync(root, { recursive: true, force: true });
const write = (rel, content) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
};
const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const spDay = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));

// registro/agentes.json (old model registry)
const agents = state.agents.map((a) => ({
  slug: a.slug, nome: a.name, tipo: a.type, cor: a.color, responsabilidade: a.responsibility, terminal_id: null,
  diretorios: [], modelo: a.model, nivel: a.effort, conectado_a: a.connected_to, skills: a.skills, status: a.status,
  desde: a.since || '2026-10-08', observacao: a.remark || null,
}));
write('registro/agentes.json', { workspace: { id: 'mock', nome: state.workspace.name, raiz: state.workspace.root }, padrao: { modelo: 'claude-opus-5-5[1m]', nivel: 'xhigh' }, agentes: agents });

// events by month
const events = det.events.slice();
const pending = state.pending_decisions.slice();
if (hostile) {
  const ts = '2026-10-09T10:24:00-03:00';
  events.push({
    id: 'EV-20261009-102400-beef', ts, agent: 'coordenador', flow_id: 'F-20261008-0002', origin: 'agente:<b>x</b>', type: 'execucao', project: '<i>D</i>',
    summary: '<script>document.title="XSS"</script> resumo com HTML', direction: '<img src=x onerror="document.title=\'XSS\'"> ' + 'longa '.repeat(200),
    steps: ['<a href="javascript:alert(1)">passo</a>'], commands: ['rm -rf / <b>'], changes: [{ arquivo: '<b>a</b>', antes: 1 }],
    result: 'falhou', validation: '<svg onload=alert(1)>', next_step: '<iframe src=//x>', needs_owner: true, pending_decisions: ['P-0006', '<b>P-9</b>'], duration_s: 3725,
  });
  pending.unshift({
    id: 'P-0099', opened_at: ts, agent: 'cerebro', flow_id: 'F-20261008-0002', severity: 'critica', type: 'decisao',
    title: '<img src=x onerror="document.title=\'XSS\'"> pendência hostil', context: '<script>alert(1)</script>\nsegunda linha',
    options: ['<b>A</b>', 'B: javascript:alert(1)'], recommendation: '<u>sublinhado</u>',
    status: 'aberta', answer: null, answered_at: null, resolved_at: null, note: null, reason: null, test: false, updated_at: ts,
  });
}
const byMonth = new Map();
for (const e of events) {
  const month = spDay(e.ts).slice(0, 7);
  if (!byMonth.has(month)) byMonth.set(month, []);
  byMonth.get(month).push(eventFromApi(e));
}
for (const [month, list] of byMonth) {
  list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  write(`logs/eventos/${month}.jsonl`, jsonl(list));
}

// raw log by agent and day (hook format)
const raw = new Map();
for (const b of det.raw_commands) {
  const folder = String(b.agent).replace(':', '-');
  const k = `logs/raw/${folder}/${spDay(b.ts)}.jsonl`;
  if (!raw.has(k)) raw.set(k, []);
  raw.get(k).push(b);
}
for (const [k, list] of raw) write(k, jsonl(list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))));

// old model state files
const records = pending.map((p) => {
  const r = pendingDecisionFromApi(p);
  delete r.age_min;
  return r;
});
const maxP = Math.max(0, ...records.map((p) => Number(String(p.id).replace(/\D/g, '')) || 0));
write('estado/pendencias.json', { proximo: maxP + 1, pendencias: records });
const days = {};
const flows = {};
for (const [id, f] of Object.entries(det.flows || {})) {
  const m = /^F-(\d{8})-(\d{4})$/.exec(id);
  if (m) days[m[1]] = { ultimo: Math.max(Number(m[2]), (days[m[1]] && days[m[1]].ultimo) || 0) };
  flows[id] = { titulo: f.title, agente: f.agent, criado_em: f.created_at };
}
write('estado/contador-fluxos.json', { dias: days, fluxos: flows });
if (state.usage) write('state/usage.json', state.usage);

const rel = root.replace(/\\/g, '/');
console.log(`Raiz falsa montada em ${rel}${hostile ? ' (com dados hostis)' : ''}`);
console.log(`Para subir: MAESTRO_DIR=${rel} PANEL_NOW=${state.generated_at} PANEL_COLLECTOR=0 node ${path.join(__dirname, '..', 'server.js').replace(/\\/g, '/')} --port 4793`);
