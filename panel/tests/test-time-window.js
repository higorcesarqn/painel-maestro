'use strict';
// Tests for bin/time-window.js (time filter for the routines' --pre-run).

const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite } = require('./util');

const SCRIPT = path.join(REPO, 'bin', 'time-window.js');
const timeWindow = require(SCRIPT);
const suite = createSuite('time window (bin/time-window.js)');

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, { MAESTRO_NOW: '' }, env) });
}

const CASES = [
  // [start, end, now, expected exit code]
  ['8', '22', '2026-10-08T10:00:00-03:00', 0],
  ['8', '22', '2026-10-08T08:00:00-03:00', 0],
  ['8', '22', '2026-10-08T07:59:59-03:00', 1],
  ['8', '22', '2026-10-08T21:59:00-03:00', 0],
  ['8', '22', '2026-10-08T22:00:00-03:00', 1],
  ['8', '22', '2026-10-08T13:30:00Z', 0], // 10:30 in São Paulo
  ['8', '22', '2026-10-09T01:30:00Z', 1], // 22:30 on the 8th in São Paulo
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

suite.test('inside the window exits 0, outside exits 1, nothing on stdout', () => {
  for (const [start, end, now, expected] of CASES) {
    const r = run([start, end, '--now', now]);
    assert.strictEqual(r.status, expected, `${start} ${end} at ${now}: exited ${r.status} (${r.stderr})`);
    assert.strictEqual(r.stdout, '', 'nothing on stdout');
    assert.strictEqual(r.stderr, '');
  }
});

suite.test('real clock: exit code consistent with São Paulo time, no stdout', () => {
  const r = run(['8', '22']);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' });
  const hour = Number(fmt.format(new Date()));
  assert.ok(r.status === 0 || r.status === 1, r.stderr);
  if (hour >= 9 && hour <= 20) assert.strictEqual(r.status, 0);
  if (hour <= 6 || hour === 23) assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
});

suite.test('MAESTRO_NOW also pins the clock', () => {
  assert.strictEqual(run(['8', '22'], { MAESTRO_NOW: '2026-10-08T03:00:00-03:00' }).status, 1);
  assert.strictEqual(run(['8', '22'], { MAESTRO_NOW: '2026-10-08T15:00:00-03:00' }).status, 0);
});

suite.test('invalid arguments: exit 2, message on stderr and empty stdout', () => {
  for (const args of [[], ['8'], ['8', '22', '9'], ['a', 'b'], ['25', '3'], ['8', '25'], ['8:60', '22'], ['8', '8'], ['8', '22', '--now', 'yesterday'], ['8', '22', '--xyz']]) {
    const r = run(args);
    assert.strictEqual(r.status, 2, `${args.join(' ')} should exit 2 (exited ${r.status})`);
    assert.strictEqual(r.stdout, '');
    assert.ok(r.stderr.startsWith('time-window: '), r.stderr);
  }
});

suite.test('exported functions', () => {
  assert.strictEqual(timeWindow.isInsideWindow(8 * 60, 8 * 60, 22 * 60), true);
  assert.strictEqual(timeWindow.isInsideWindow(22 * 60, 8 * 60, 22 * 60), false);
  assert.strictEqual(timeWindow.isInsideWindow(23 * 60, 22 * 60, 6 * 60), true);
  assert.strictEqual(timeWindow.spMinuteOfDay(new Date('2026-10-08T15:42:00-03:00')), 15 * 60 + 42);
  assert.strictEqual(timeWindow.main(['8', '22', '--now=2026-10-08T09:00:00-03:00'], {}), 0);
});

suite.run();
