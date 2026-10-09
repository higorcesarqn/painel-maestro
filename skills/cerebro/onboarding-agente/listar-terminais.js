#!/usr/bin/env node
'use strict';
/*
 * listar-terminais.js · skill "onboarding-agente" do Cérebro Principal · SÓ LEITURA
 *
 * Lista os terminais do workspace como o Maestri os guarda (workspace.json), com o que o
 * registro precisa: terminal_id (= MAESTRI_TERMINAL_ID), nome, tipo de agente, Maestro,
 * responsabilidade (nome e pasta .maestri/roles/<id>/ que vira o cwd), diretório configurado,
 * e o slug em registro/agentes.json (ou "NÃO REGISTRADO").
 *
 * Uso: node skills/cerebro/onboarding-agente/listar-terminais.js [--nome "Parte do nome"]   (da raiz do repositório, o MAESTRO_DIR)
 * Saída: 0 ok · 1 erro ao ler os arquivos · 2 uso inválido.
 * Não grava nada. Só biblioteca padrão do Node 22.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const AJUDA = `listar-terminais · skill "onboarding-agente" do Cérebro Principal (só leitura)

Uso:
  node skills/cerebro/onboarding-agente/listar-terminais.js [--nome "Parte do nome"]   (da raiz do repositório, o MAESTRO_DIR)

Lista os terminais do workspace (workspace.json do Maestri): terminal_id, nome, agente, responsabilidade
e cwd do role, diretório, e o slug em registro/agentes.json (ou "NÃO REGISTRADO"). Não grava nada.
Opções: --nome "texto" (filtra pelo nome, sem diferenciar maiúsculas) · --help
Saída: 0 ok · 1 erro ao ler os arquivos · 2 uso inválido`;

(function conferirArgs() {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--help' || a[i] === '--ajuda' || a[i] === '-h') { console.log(AJUDA); process.exit(0); }
    if (a[i] === '--nome' && a[i + 1] !== undefined && !a[i + 1].startsWith('--')) { i++; continue; }
    const msg = a[i] === '--nome' ? '--nome precisa de um texto' : `opção desconhecida: ${a[i]}`;
    console.error(`Erro: ${msg}\n\n${AJUDA}`);
    process.exit(2);
  }
})();

const MAESTRO = path.resolve(process.env.MAESTRO_DIR || path.join(__dirname, '..', '..', '..'));
const DADOS = path.resolve(process.env.MAESTRI_DATA_DIR || path.join(os.homedir(), '.maestri'));
const barra = (p) => String(p).replace(/\\/g, '/');

function lerJson(arq) { return JSON.parse(fs.readFileSync(arq, 'utf8').replace(/^\uFEFF/, '')); }

function main() {
  const i = process.argv.indexOf('--nome');
  const filtro = i > -1 ? String(process.argv[i + 1] || '').toLowerCase() : '';

  const registro = lerJson(path.join(MAESTRO, 'registro', 'agentes.json'));
  const wsId = registro.workspace && registro.workspace.id;
  const raiz = (registro.workspace && registro.workspace.raiz) || barra(path.resolve(MAESTRO, '..'));
  if (!wsId) throw new Error('registro/agentes.json sem workspace.id');

  const ws = lerJson(path.join(DADOS, 'workspaces', wsId, 'workspace.json')).payload || {};
  let roles = [];
  try { roles = (lerJson(path.join(DADOS, 'preferences.json')).payload || {}).rolePresets || []; } catch { /* sem roles */ }
  const nomeRole = (id) => { const r = roles.find((x) => String(x.id).toLowerCase() === String(id).toLowerCase()); return r ? r.name : '(role desconhecido)'; };

  const nos = [...(ws.nodes || [])];
  for (const f of ws.floors || []) for (const n of f.nodes || []) nos.push({ ...n, _andar: f.name || f.id });
  const slugPorId = new Map((registro.agentes || []).filter((a) => a.terminal_id).map((a) => [String(a.terminal_id).toLowerCase(), a.slug]));

  let n = 0;
  for (const no of nos) {
    const t = no.content && no.content.terminal && no.content.terminal._0;
    if (!t) continue;
    if (filtro && !String(t.name || '').toLowerCase().includes(filtro)) continue;
    n++;
    const dirProjeto = barra(t.workingDirectory || ws.workingDirectory || raiz);
    const role = t.assignedRoleId ? `${nomeRole(t.assignedRoleId)} · cwd ${dirProjeto}/.maestri/roles/${String(t.assignedRoleId).toLowerCase()}` : '(sem responsabilidade)';
    console.log(`${t.name}`);
    console.log(`  terminal_id: ${t.id}`);
    console.log(`  agente: ${t.agentType || '?'}${t.isManager ? ' · Maestro' : ''}${no._andar ? ' · andar ' + no._andar : ''}`);
    console.log(`  responsabilidade: ${role}`);
    console.log(`  diretório configurado: ${t.workingDirectory ? barra(t.workingDirectory) : '(vazio = o do workspace, ' + dirProjeto + ')'}`);
    console.log(`  comando: ${t.command || '(o do preset)'}`);
    console.log(`  registro: ${slugPorId.get(String(t.id).toLowerCase()) || 'NÃO REGISTRADO em agentes.json'}`);
  }
  if (!n) console.log(filtro ? `Nenhum terminal com "${filtro}" no nome.` : 'Nenhum terminal no workspace.');
  console.log('\nObs.: o workspace.json é gravado pelo Maestri com atraso (autosave); terminal recém-criado pode demorar a aparecer.');
}

try { main(); } catch (e) { console.error(`Erro: ${e.message}`); process.exitCode = 1; }
