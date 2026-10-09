'use strict';
// Testes do bin/janela-horario.js (filtro de horário do --pre-run das rotinas).

const path = require('path');
const { spawnSync } = require('child_process');
const { assert, MAESTRO, criarSuite } = require('./util');

const SCRIPT = path.join(MAESTRO, 'bin', 'janela-horario.js');
const janela = require(SCRIPT);
const suite = criarSuite('janela de horário (bin/janela-horario.js)');

function rodar(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, { MAESTRO_AGORA: '' }, env) });
}

const CASOS = [
  // [início, fim, agora, código esperado]
  ['8', '22', '2026-10-08T10:00:00-03:00', 0],
  ['8', '22', '2026-10-08T08:00:00-03:00', 0],
  ['8', '22', '2026-10-08T07:59:59-03:00', 1],
  ['8', '22', '2026-10-08T21:59:00-03:00', 0],
  ['8', '22', '2026-10-08T22:00:00-03:00', 1],
  ['8', '22', '2026-10-08T13:30:00Z', 0], // 10:30 em São Paulo
  ['8', '22', '2026-10-09T01:30:00Z', 1], // 22:30 do dia 8 em São Paulo
  ['08', '22:00', '2026-10-08T12:00:00-03:00', 0],
  ['8:30', '22', '2026-10-08T08:15:00-03:00', 1],
  ['8:30', '22', '2026-10-08T08:30:00-03:00', 0],
  ['22', '6', '2026-10-08T23:00:00-03:00', 0],
  ['22', '6', '2026-10-08T05:59:00-03:00', 0],
  ['22', '6', '2026-10-08T06:00:00-03:00', 1],
  ['22', '6', '2026-10-08T12:00:00-03:00', 1],
  ['0', '24', '2026-10-08T23:59:00-03:00', 0],
  ['0', '24', '2026-10-08T00:00:00-03:00', 0],
];

suite.teste('dentro da janela sai 0, fora sai 1, sem nada no stdout', () => {
  for (const [ini, fim, agora, esperado] of CASOS) {
    const r = rodar([ini, fim, '--agora', agora]);
    assert.strictEqual(r.status, esperado, `${ini} ${fim} às ${agora}: saiu ${r.status} (${r.stderr})`);
    assert.strictEqual(r.stdout, '', 'nada no stdout');
    assert.strictEqual(r.stderr, '');
  }
});

suite.teste('relógio real: código coerente com a hora de São Paulo, sem stdout', () => {
  const r = rodar(['8', '22']);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' });
  const hora = Number(fmt.format(new Date()));
  assert.ok(r.status === 0 || r.status === 1, r.stderr);
  if (hora >= 9 && hora <= 20) assert.strictEqual(r.status, 0);
  if (hora <= 6 || hora === 23) assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
});

suite.teste('MAESTRO_AGORA também fixa o relógio', () => {
  assert.strictEqual(rodar(['8', '22'], { MAESTRO_AGORA: '2026-10-08T03:00:00-03:00' }).status, 1);
  assert.strictEqual(rodar(['8', '22'], { MAESTRO_AGORA: '2026-10-08T15:00:00-03:00' }).status, 0);
});

suite.teste('argumentos inválidos: saída 2, mensagem no stderr e stdout vazio', () => {
  for (const args of [[], ['8'], ['8', '22', '9'], ['a', 'b'], ['25', '3'], ['8', '25'], ['8:60', '22'], ['8', '8'], ['8', '22', '--agora', 'ontem'], ['8', '22', '--xyz']]) {
    const r = rodar(args);
    assert.strictEqual(r.status, 2, `${args.join(' ')} deveria sair 2 (saiu ${r.status})`);
    assert.strictEqual(r.stdout, '');
    assert.ok(r.stderr.startsWith('janela-horario: '), r.stderr);
  }
});

suite.teste('funções exportadas', () => {
  assert.strictEqual(janela.dentroDaJanela(8 * 60, 8 * 60, 22 * 60), true);
  assert.strictEqual(janela.dentroDaJanela(22 * 60, 8 * 60, 22 * 60), false);
  assert.strictEqual(janela.dentroDaJanela(23 * 60, 22 * 60, 6 * 60), true);
  assert.strictEqual(janela.minutoDoDiaSP(new Date('2026-10-08T15:42:00-03:00')), 15 * 60 + 42);
  assert.strictEqual(janela.main(['8', '22', '--agora=2026-10-08T09:00:00-03:00'], {}), 0);
});

suite.rodar();
