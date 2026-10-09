#!/usr/bin/env node
'use strict';
/*
 * checar-painel.js · skill "painel" do Cérebro Principal · SÓ LEITURA
 *
 * Diz, em poucas linhas, se o painel está no ar e se os dados estão frescos:
 *   - PID em estado/painel.pid e se o processo existe;
 *   - painel/index.html existe? (sem ele, GET / responde 503);
 *   - GET /api/estado: gerado_em, selo de saúde e cada motivo, idade do Trello, do último evento e do uso;
 *   - estado/trello/resumo.json: coletado_em (hora da última leitura do quadro).
 *
 * Uso: node skills/cerebro/painel/checar-painel.js [--porta 4777]   (da raiz do repositório, o MAESTRO_DIR)
 * Saída: 0 no ar e selo verde · 1 no ar com selo amarelo/vermelho · 2 fora do ar ou sem resposta · 3 uso inválido.
 * Não grava nada. Só biblioteca padrão do Node 22 (fetch embutido).
 */

const fs = require('fs');
const path = require('path');

const AJUDA = `checar-painel · skill "painel" do Cérebro Principal (só leitura)

Uso:
  node skills/cerebro/painel/checar-painel.js [--porta 4777]   (da raiz do repositório, o MAESTRO_DIR)

Mostra PID e processo, se o index.html existe, a última leitura do Trello e, da API, gerado_em,
selo de saúde, motivos e idades. Não grava nada.
Opções: --porta N (padrão: PAINEL_PORTA ou 4777) · --help
Saída: 0 no ar e selo verde · 1 no ar com selo amarelo/vermelho · 2 fora do ar ou sem resposta · 3 uso inválido`;

(function conferirArgs() {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--help' || a[i] === '--ajuda' || a[i] === '-h') { console.log(AJUDA); process.exit(0); }
    if (a[i] === '--porta' && /^\d+$/.test(a[i + 1] || '')) { i++; continue; }
    const msg = a[i] === '--porta' ? '--porta precisa de um número' : `opção desconhecida: ${a[i]}`;
    console.error(`Erro: ${msg}\n\n${AJUDA}`);
    process.exit(3);
  }
})();

const MAESTRO = path.resolve(process.env.MAESTRO_DIR || path.join(__dirname, '..', '..', '..'));
const barra = (p) => p.replace(/\\/g, '/');

function argPorta() {
  const i = process.argv.indexOf('--porta');
  if (i > -1 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return Number(process.env.PAINEL_PORTA || 4777);
}

function lerPid() {
  const arq = path.join(MAESTRO, 'estado', 'painel.pid');
  let txt;
  try { txt = fs.readFileSync(arq, 'utf8').trim(); } catch { return { linha: `PID: sem ${barra(arq)} (servidor nunca subiu ou saiu limpo)` }; }
  const pid = Number(txt.split(/\s+/)[0]);
  if (!Number.isInteger(pid) || pid <= 0) return { linha: `PID: conteúdo inesperado em ${barra(arq)}: ${txt.slice(0, 40)}` };
  let vivo = false;
  try { process.kill(pid, 0); vivo = true; } catch (e) { vivo = e.code === 'EPERM'; }
  return { pid, vivo, linha: `PID: ${pid} (${vivo ? 'processo existe' : 'processo NÃO existe: arquivo velho, provavelmente de um taskkill /F'})` };
}

function resumoTrello() {
  const arq = path.join(MAESTRO, 'estado', 'trello', 'resumo.json');
  try {
    const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
    return `Trello: última leitura do quadro em ${j.coletado_em || '(sem coletado_em)'}`;
  } catch (e) {
    return e.code === 'ENOENT' ? 'Trello: resumo.json ainda não existe (o Coordenador nunca leu o quadro)' : `Trello: resumo.json ilegível (${e.message})`;
  }
}

async function buscar(url, comoJson) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return { status: r.status, corpo: comoJson ? await r.json() : await r.text() };
}

async function main() {
  const porta = argPorta();
  const base = `http://127.0.0.1:${porta}`;
  const linhas = [];
  const pid = lerPid();
  linhas.push(pid.linha);
  const index = path.join(MAESTRO, 'painel', 'index.html');
  linhas.push(`Página: ${fs.existsSync(index) ? 'painel/index.html existe' : 'painel/index.html NÃO existe (GET / responde 503; rode npm run build em painel/ui)'}`);
  linhas.push(resumoTrello());

  let codigo = 2;
  try {
    const e = await buscar(`${base}/api/estado`, true);
    if (e.status !== 200) {
      linhas.push(`API: ${base}/api/estado respondeu HTTP ${e.status}`);
    } else {
      const j = e.corpo;
      const s = j.saude || {};
      linhas.push(`API: no ar em ${base} · gerado_em ${j.gerado_em}`);
      linhas.push(`Saúde: ${s.nivel || '?'} · Trello há ${s.trello_idade_min ?? '?'} min · último evento há ${s.ultimo_evento_idade_min ?? '?'} min · uso há ${s.uso_idade_min ?? '?'} min`);
      for (const m of s.motivos || []) linhas.push(`  - ${m}`);
      if (Array.isArray(j.avisos) && j.avisos.length) linhas.push(`Avisos de leitura: ${j.avisos.length} (veja /api/estado → avisos)`);
      codigo = s.nivel === 'verde' ? 0 : 1;
      try {
        const raiz = await buscar(`${base}/`, false);
        linhas.push(`GET /: HTTP ${raiz.status}${raiz.status === 503 ? ' (falta painel/index.html)' : ''}`);
      } catch { /* a API respondeu; a página é secundária */ }
    }
  } catch (err) {
    const motivo = err && err.cause && err.cause.code ? err.cause.code : (err && err.name === 'TimeoutError' ? 'sem resposta em 5 s' : String(err && err.message));
    linhas.push(`API: FORA DO AR em ${base} (${motivo})`);
  }
  console.log(linhas.join('\n'));
  return codigo;
}

main().then((c) => { process.exitCode = c; }, (e) => { console.error(`Erro inesperado: ${e && e.stack ? e.stack : e}`); process.exitCode = 2; });
