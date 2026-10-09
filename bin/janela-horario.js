#!/usr/bin/env node
'use strict';
// janela-horario.js · filtro de horário para o --pre-run das rotinas do Maestri
//
// Uso: node bin/janela-horario.js <início> <fim> [--agora <ISO>]
//   Sai 0 se o horário atual de São Paulo está dentro de [início, fim) e 1 se está fora.
//   Horas como 8, 08, 8:30 ou 22:00. O fim é exclusivo: "8 22" aceita de 08:00 até 21:59
//   (use 24 para ir até 23:59). Com início maior que o fim, a janela atravessa a meia-noite:
//   "22 6" vale das 22:00 às 05:59.
//   Não escreve nada no stdout. Argumento inválido: mensagem no stderr e saída 2.
//   --agora fixa o relógio (testes); a variável MAESTRO_AGORA faz o mesmo.

const FUSO = 'America/Sao_Paulo';
const FMT = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

class ErroUso extends Error {}

/** "8", "08", "8:30", "22:00" → minutos desde 00:00. */
function lerHora(texto, nome, maximo) {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(texto === undefined ? '' : texto).trim());
  if (!m) throw new ErroUso(`${nome} inválido: "${texto === undefined ? '' : texto}" (use H, HH ou HH:MM, ex.: 8 ou 22:30).`);
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const total = h * 60 + min;
  if (min > 59 || total > maximo) throw new ErroUso(`${nome} fora do intervalo: "${texto}".`);
  return total;
}

/** Minutos desde 00:00 no relógio de São Paulo. */
function minutoDoDiaSP(data) {
  const p = {};
  for (const x of FMT.formatToParts(data)) p[x.type] = x.value;
  return Number(p.hour) * 60 + Number(p.minute);
}

/** true se o minuto do dia está em [inicio, fim), com janela que pode atravessar a meia-noite. */
function dentroDaJanela(minuto, inicio, fim) {
  return inicio < fim ? minuto >= inicio && minuto < fim : minuto >= inicio || minuto < fim;
}

function lerArgs(argv, env) {
  const posicionais = [];
  let agora = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agora' || a.startsWith('--agora=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      agora = new Date(v);
      if (!v || Number.isNaN(agora.getTime())) throw new ErroUso(`--agora inválido: "${v === undefined ? '' : v}" (use ISO, ex.: 2026-10-08T15:50:00-03:00).`);
    } else if (a.startsWith('--')) {
      throw new ErroUso(`Opção desconhecida: ${a}.`);
    } else posicionais.push(a);
  }
  if (posicionais.length !== 2) throw new ErroUso('Informe início e fim, ex.: node janela-horario.js 8 22');
  const inicio = lerHora(posicionais[0], 'Início', 23 * 60 + 59);
  const fim = lerHora(posicionais[1], 'Fim', 24 * 60);
  if (inicio === fim) throw new ErroUso('Início e fim iguais: a janela ficaria vazia.');
  if (!agora && env.MAESTRO_AGORA) {
    agora = new Date(env.MAESTRO_AGORA);
    if (Number.isNaN(agora.getTime())) agora = null;
  }
  return { inicio, fim, agora: agora || new Date() };
}

function main(argv, env = process.env) {
  const { inicio, fim, agora } = lerArgs(argv, env);
  return dentroDaJanela(minutoDoDiaSP(agora), inicio, fim) ? 0 : 1;
}

module.exports = { main, dentroDaJanela, minutoDoDiaSP, lerHora };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`janela-horario: ${e instanceof ErroUso ? e.message : (e && e.stack) || e}\n`);
    process.exitCode = 2;
  }
}
