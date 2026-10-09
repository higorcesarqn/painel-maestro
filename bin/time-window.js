#!/usr/bin/env node
'use strict';
// time-window.js · time filter for the --pre-run of Maestri routines
//
// Usage: node bin/time-window.js <start> <end> [--now <ISO>]
//   Exits 0 if the current São Paulo time is inside [start, end) and 1 if it is outside.
//   Hours like 8, 08, 8:30 or 22:00. The end is exclusive: "8 22" accepts 08:00 to 21:59
//   (use 24 to go until 23:59). With start greater than end, the window crosses midnight:
//   "22 6" covers 22:00 to 05:59.
//   Writes nothing to stdout. Invalid argument: message on stderr and exit 2.
//   --now pins the clock (tests); the MAESTRO_NOW variable does the same.
// Messages for people stay in Portuguese (ADR 0004).

const TIME_ZONE = 'America/Sao_Paulo';
const FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

class UsageError extends Error {}

/** "8", "08", "8:30", "22:00" → minutes since 00:00. */
function parseHour(text, label, max) {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(text === undefined ? '' : text).trim());
  if (!m) throw new UsageError(`${label} inválido: "${text === undefined ? '' : text}" (use H, HH ou HH:MM, ex.: 8 ou 22:30).`);
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const total = h * 60 + min;
  if (min > 59 || total > max) throw new UsageError(`${label} fora do intervalo: "${text}".`);
  return total;
}

/** Minutes since 00:00 on the São Paulo clock. */
function spMinuteOfDay(date) {
  const p = {};
  for (const x of FMT.formatToParts(date)) p[x.type] = x.value;
  return Number(p.hour) * 60 + Number(p.minute);
}

/** true if the minute of the day is in [start, end), with a window that may cross midnight. */
function isInsideWindow(minute, start, end) {
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function parseArgs(argv, env) {
  const positional = [];
  let now = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--now' || a.startsWith('--now=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      now = new Date(v);
      if (!v || Number.isNaN(now.getTime())) throw new UsageError(`--now inválido: "${v === undefined ? '' : v}" (use ISO, ex.: 2026-10-08T15:50:00-03:00).`);
    } else if (a.startsWith('--')) {
      throw new UsageError(`Opção desconhecida: ${a}.`);
    } else positional.push(a);
  }
  if (positional.length !== 2) throw new UsageError('Informe início e fim, ex.: node time-window.js 8 22');
  const start = parseHour(positional[0], 'Início', 23 * 60 + 59);
  const end = parseHour(positional[1], 'Fim', 24 * 60);
  if (start === end) throw new UsageError('Início e fim iguais: a janela ficaria vazia.');
  if (!now && env.MAESTRO_NOW) {
    now = new Date(env.MAESTRO_NOW);
    if (Number.isNaN(now.getTime())) now = null;
  }
  return { start, end, now: now || new Date() };
}

function main(argv, env = process.env) {
  const { start, end, now } = parseArgs(argv, env);
  return isInsideWindow(spMinuteOfDay(now), start, end) ? 0 : 1;
}

module.exports = { main, isInsideWindow, spMinuteOfDay, parseHour };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`time-window: ${e instanceof UsageError ? e.message : (e && e.stack) || e}\n`);
    process.exitCode = 2;
  }
}
