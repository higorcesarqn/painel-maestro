'use strict';
// Server performance with a lot of data: 50 thousand events in 2 months and a big raw log.
// Checks times with slack (machine with antivirus) and that the second read is incremental.
// HEAVY_TEST=1 multiplies the raw log by 5.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, writeJson, freePort, request, waitFor, kill } = require('./util');

const SERVER = path.join(REPO, 'panel', 'server.js');
const suite = createSuite('server performance (50 thousand events, big raw log)');
const HEAVY = process.env.HEAVY_TEST === '1';
const N_EVENTS = 50000;
const RAW_PER_DAY = HEAVY ? 50000 : 10000;
const NOW = '2026-10-08T15:50:00-03:00';
const LONG_FLOW = 'F-20260908-0001';
const LONG_PER_DAY = HEAVY ? 8000 : 2000;
let root;
let S;

function pad(n, t = 2) {
  return String(n).padStart(t, '0');
}

function build() {
  root = tmpDir('performance');
  const m = path.join(root, 'maestro');
  writeJson(path.join(m, 'registro', 'agentes.json'), {
    workspace: { nome: 'Exemplo', raiz: 'C:/teste' }, padrao: { modelo: 'x', nivel: 'xhigh' },
    agentes: [{ slug: 'cerebro', nome: 'Cérebro Principal', status: 'ativo' }, { slug: 'coordenador', nome: 'Coordenador', status: 'ativo' }],
  });
  // Old-model events (bin/registrar.js format).
  const dir = path.join(m, 'logs', 'eventos');
  fs.mkdirSync(dir, { recursive: true });
  const base = Date.parse('2026-09-01T00:00:00-03:00');
  const step = (Date.parse(NOW) - base) / N_EVENTS;
  const byMonth = { '2026-09': [], '2026-10': [] };
  for (let i = 0; i < N_EVENTS; i++) {
    const t = new Date(base + i * step - 3 * 3600000);
    const ts = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}-03:00`;
    const day = ts.slice(0, 10).replace(/-/g, '');
    const flow = `F-${day}-${pad(1 + (i % 40), 4)}`;
    const ev = {
      id: `EV-${day}-${ts.slice(11, 19).replace(/:/g, '')}-${i.toString(16).padStart(4, '0')}`, ts, agente: i % 3 ? 'cerebro' : 'coordenador',
      fluxo_id: flow, origem: 'cerebro', tipo: i % 7 ? 'execucao' : 'decisao', projeto: 'HNMSTG'[i % 6],
      resumo: `Executada a etapa número ${i} do fluxo ${flow}, com acentuação`, direcao: `Escolhi o caminho ${i % 5} porque é o mais simples; ${'detalhe '.repeat(10)}`,
      passos: ['a', 'b', 'c'], comandos: ['node x.js'], alteracoes: [], resultado: i % 50 ? 'ok' : 'falhou', validacao: 'conferido',
      precisa_dono: i % 97 === 0, pendencias: [], duracao_s: i % 120, teste: i % 1000 === 0,
    };
    byMonth[ts.slice(0, 7)].push(JSON.stringify(ev));
  }
  // Long and open flow (09/08 until today) with raw log every day: the raw index avoids reading it all again.
  byMonth['2026-09'].push(JSON.stringify({ id: 'EV-20260908-090000-f001', ts: '2026-09-08T09:00:00-03:00', agente: 'cerebro', fluxo_id: LONG_FLOW, origem: 'dono-direto', tipo: 'pedido-recebido', resumo: 'Fluxo longo', resultado: 'em-andamento', sessao: 's1' }));
  byMonth['2026-10'].push(JSON.stringify({ id: 'EV-20261008-150000-f002', ts: '2026-10-08T15:00:00-03:00', agente: 'cerebro', fluxo_id: LONG_FLOW, origem: 'cerebro', tipo: 'execucao', resumo: 'Fluxo longo segue', resultado: 'em-andamento', sessao: 's1' }));
  for (const [month, lines] of Object.entries(byMonth)) fs.writeFileSync(path.join(dir, `${month}.jsonl`), `${lines.join('\n')}\n`);
  for (const ag of ['cerebro', 'coordenador']) {
    for (const day of ['2026-10-07', '2026-10-08']) {
      const lines = [];
      const start = Date.parse(`${day}T00:00:00-03:00`);
      for (let i = 0; i < RAW_PER_DAY; i++) {
        const t = new Date(start + i * (86400000 / RAW_PER_DAY) - 3 * 3600000);
        const ts = `${day}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}-03:00`;
        lines.push(JSON.stringify({
          ts, agent: ag, terminal: 't', session: 's1', flow_id: i % 2 ? `F-${day.replace(/-/g, '')}-0001` : undefined,
          hook_event: 'PostToolUse', tool: 'Bash', input: `comando ${i} ${'arg '.repeat(60)}`, ok: true, output_summary: 'x'.repeat(200), cwd: 'C:/x',
        }));
      }
      const file = path.join(m, 'logs', 'raw', ag, `${day}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${lines.join('\n')}\n`);
    }
  }
  for (const ag of ['cerebro', 'coordenador']) {
    for (let d = Date.parse('2026-09-08T12:00:00Z'); d < Date.parse('2026-10-07T00:00:00Z'); d += 86400000) {
      const day = new Date(d).toISOString().slice(0, 10);
      const lines = [];
      for (let i = 0; i < LONG_PER_DAY; i++) {
        const sec = Math.floor(i * 86400 / LONG_PER_DAY);
        const ts = `${day}T${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}-03:00`;
        lines.push(JSON.stringify({ ts, agent: ag, terminal: 't', session: 's1', flow_id: i % 3 ? LONG_FLOW : undefined, hook_event: 'PostToolUse', tool: 'Bash', input: `comando ${i} ${'arg '.repeat(80)}`, ok: true, output_summary: 'y'.repeat(200), cwd: 'C:/x' }));
      }
      const file = path.join(m, 'logs', 'raw', ag, `${day}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${lines.join('\n')}\n`);
    }
  }
  return m;
}

async function time(fn) {
  const t0 = process.hrtime.bigint();
  const r = await fn();
  return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

function memoryMb(pid) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const m = /"([\d.,\s]+) K"/.exec(r.stdout || '');
  return m ? Math.round(Number(m[1].replace(/[^\d]/g, '')) / 1024) : null;
}

const stillPending = (body) => (body.raw_commands_warnings || []).some((w) => w.code === 'raw_files_pending');

suite.test('generates 50 thousand events and the raw log and starts the server', async () => {
  const m = build();
  const port = await freePort();
  const env = Object.assign({}, process.env, { MAESTRO_DIR: m, PANEL_NOW: NOW, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(root, 'x.html'), MAESTRI_DATA_DIR: path.join(root, 'maestri') });
  const child = spawn(process.execPath, [SERVER, '--port', String(port)], { env, windowsHide: true });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const mm = await waitFor(() => /\(PID (\d+)\)/.exec(out), 15000);
  S = { port, pid: Number(mm[1]) };
});

suite.test('/api/state: first read < 8 s, the next ones < 1 s (incremental)', async () => {
  const cold = await time(() => request(S.port, '/api/state'));
  assert.strictEqual(cold.r.status, 200);
  assert.strictEqual(cold.r.json.events.length, 200);
  const warm = await time(() => request(S.port, '/api/state'));
  console.log(`        /api/state: cold ${cold.ms.toFixed(0)} ms, warm ${warm.ms.toFixed(0)} ms, ${(cold.r.buf.length / 1024).toFixed(0)} KB`);
  assert.ok(cold.ms < 8000, `slow cold read: ${cold.ms} ms`);
  assert.ok(warm.ms < 1000, `slow warm read: ${warm.ms} ms`);
  // A new event at the end of the month enters without reading the whole file again.
  const added = { id: 'EV-20261008-155000-ffff', ts: '2026-10-08T15:50:00-03:00', agente: 'cerebro', fluxo_id: 'F-20261008-0001', origem: 'cerebro', tipo: 'aviso', resumo: 'Evento novíssimo', resultado: 'ok' };
  fs.appendFileSync(path.join(root, 'maestro', 'logs', 'eventos', '2026-10.jsonl'), `${JSON.stringify(added)}\n`);
  const after = await time(() => request(S.port, '/api/state'));
  assert.strictEqual(after.r.json.events[0].id, 'EV-20261008-155000-ffff');
  assert.ok(after.ms < 1500, `after the append: ${after.ms} ms`);
});

suite.test('/api/events with search and filters over every month < 2 s', async () => {
  const q = await time(() => request(S.port, `/api/events?q=${encodeURIComponent('ACENTUAÇÃO 4999')}&owner_only=0&page=1`));
  assert.strictEqual(q.r.status, 200);
  assert.ok(q.r.json.total >= 1);
  const f = await time(() => request(S.port, '/api/events?agent=coordenador&type=decisao&since=2026-09-10&until=2026-10-05&per_page=500'));
  console.log(`        /api/events: search ${q.ms.toFixed(0)} ms, filters ${f.ms.toFixed(0)} ms (${f.r.json.total} events)`);
  assert.ok(q.ms < 2000 && f.ms < 2000);
});

suite.test('/api/event/<id> with thousands of raw commands in the flow < 4 s, limited answer', async () => {
  const list = (await request(S.port, '/api/events?since=2026-10-08&until=2026-10-08&q=F-20261008-0001&per_page=1')).json;
  const id = list.events[0].id;
  const d = await time(() => request(S.port, `/api/event/${id}`));
  assert.strictEqual(d.r.status, 200);
  assert.ok(d.r.json.raw_commands.length <= 1500);
  assert.strictEqual(d.r.json.raw_commands_truncated, true);
  const f = await time(() => request(S.port, '/api/flow/F-20261008-0001'));
  console.log(`        /api/event: ${d.ms.toFixed(0)} ms (${(d.r.buf.length / 1024).toFixed(0)} KB) · /api/flow: ${f.ms.toFixed(0)} ms · server memory: ${memoryMb(S.pid)} MB`);
  assert.ok(d.ms < 4000 && f.ms < 4000);
});

suite.test('long and open flow (31 days of raw log): the 2nd and 3rd queries read nothing again', async () => {
  const f1 = await time(() => request(S.port, `/api/flow/${LONG_FLOW}`));
  assert.strictEqual(f1.r.status, 200);
  assert.ok(f1.r.json.raw_commands.length > 0 && f1.r.json.raw_commands.length <= 1500);
  assert.strictEqual(f1.r.json.raw_commands_truncated, true);
  assert.ok(f1.r.json.raw_commands_omitted > 0);
  // With the read ceiling per query, a huge raw log completes in a few queries.
  let queries = 1;
  for (let r = f1.r; stillPending(r.json) && queries < 8; queries++) r = await request(S.port, `/api/flow/${LONG_FLOW}`);
  assert.ok(queries < 8, 'the index should complete');
  if (queries > 1) console.log(`        index complete after ${queries} query(ies)`);
  const f2 = await time(() => request(S.port, `/api/flow/${LONG_FLOW}`));
  assert.ok(!stillPending(f2.r.json));
  const f3 = await time(() => request(S.port, `/api/flow/${LONG_FLOW}`));
  const e1 = await time(() => request(S.port, '/api/event/EV-20261008-150000-f002'));
  assert.strictEqual(e1.r.status, 200);
  const mb = memoryMb(S.pid);
  console.log(`        long /api/flow: ${f1.ms.toFixed(0)} ms, then ${f2.ms.toFixed(0)} and ${f3.ms.toFixed(0)} ms · /api/event ${e1.ms.toFixed(0)} ms (${(e1.r.buf.length / 1024).toFixed(0)} KB) · memory ${mb} MB`);
  // The warm query costs the same as building ~670 KB of answer: /api/event (same index, same size)
  // measures that cost on the current machine; reading the raw log again would cost much more.
  const ceiling = Math.max(800, f1.ms / 3, e1.ms * 1.5);
  assert.ok(f2.ms < ceiling && f3.ms < ceiling, `the following queries should use the index (ceiling ${ceiling.toFixed(0)} ms)`);
  assert.ok(e1.ms < 1500);
  if (mb !== null) assert.ok(mb < 700, `high memory: ${mb} MB`);
});

suite.run().then(() => {
  if (S) kill(S.pid);
  if (!process.env.KEEP_TMP && root) remove(root);
});
