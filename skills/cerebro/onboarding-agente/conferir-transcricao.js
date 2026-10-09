#!/usr/bin/env node
'use strict';
/*
 * conferir-transcricao.js · skill "onboarding-agente" do Cérebro Principal · SÓ LEITURA
 *
 * Confere na transcrição do Claude Code de um agente (a resposta dele sobre si mesmo não prova nada):
 *   - modelo (attachment "model" e message.model das respostas) e esforço (campo effort);
 *   - quais CLAUDE.md foram carregados (attachment "instructions"): a raiz do workspace tem de aparecer;
 *   - se as skills esperadas aparecem na lista de skills da sessão (attachment "skill_listing").
 *
 * Uso:
 *   node skills/cerebro/onboarding-agente/conferir-transcricao.js --cwd "<raiz do workspace>/.maestri/roles/<id>" [--skills "a,b,c"]
 *   (da raiz do repositório, o MAESTRO_DIR; ou --pasta <pasta em ~/.claude/projects>; ou --arquivo <sessao.jsonl>)
 * A raiz do workspace é a pasta acima do MAESTRO_DIR (sem a variável, a pasta acima deste repositório).
 * Usa a transcrição mais recente da pasta. A pasta é o cwd com todo caractere não alfanumérico trocado por "-".
 * Saída: 0 tudo confere (Opus 5.5, xhigh, CLAUDE.md da raiz, skills) · 1 algo não confere · 2 sem transcrição · 3 uso inválido.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const AJUDA = `conferir-transcricao · skill "onboarding-agente" do Cérebro Principal (só leitura)

Uso:
  node skills/cerebro/onboarding-agente/conferir-transcricao.js --cwd "<raiz do workspace>/.maestri/roles/<id>" [--skills "a,b,c"]
  (da raiz do repositório, o MAESTRO_DIR; ou --pasta "<pasta em ~/.claude/projects>"; ou --arquivo "<sessao.jsonl>")

Confere na transcrição mais recente: modelo (claude-opus-5-5), esforço (xhigh), CLAUDE.md da raiz
do workspace (a pasta acima do MAESTRO_DIR) carregado e as skills esperadas na lista da sessão. Não grava nada.
Opções: --cwd · --pasta · --arquivo (um deles) · --skills "a,b,c" · --help
Saída: 0 tudo confere · 1 algo não confere · 2 sem transcrição · 3 uso inválido`;

(function conferirArgs() {
  const a = process.argv.slice(2);
  const comValor = new Set(['--cwd', '--pasta', '--arquivo', '--skills']);
  let alvo = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--help' || a[i] === '--ajuda' || a[i] === '-h') { console.log(AJUDA); process.exit(0); }
    let msg = null;
    if (comValor.has(a[i])) {
      if (a[i + 1] === undefined || a[i + 1].startsWith('--')) msg = `${a[i]} precisa de um valor`;
      else { if (a[i] !== '--skills') alvo++; i++; continue; }
    } else msg = `opção desconhecida: ${a[i]}`;
    console.error(`Erro: ${msg}\n\n${AJUDA}`);
    process.exit(3);
  }
  if (alvo !== 1) { console.error(`Erro: passe exatamente um entre --cwd, --pasta e --arquivo\n\n${AJUDA}`); process.exit(3); }
})();

// Raiz do workspace: a pasta acima do MAESTRO_DIR (sem a variável, a pasta acima deste repositório).
const RAIZ = path.resolve(process.env.MAESTRO_DIR || path.join(__dirname, '..', '..', '..'), '..').replace(/\\/g, '/');
const MODELO = 'claude-opus-5-5';
const ESFORCO = 'xhigh';

function arg(nome) { const i = process.argv.indexOf(nome); return i > -1 ? process.argv[i + 1] : undefined; }
const barra = (p) => String(p).replace(/\\/g, '/');

function acharArquivo() {
  if (arg('--arquivo')) return path.resolve(arg('--arquivo'));
  let pasta = arg('--pasta');
  if (!pasta && arg('--cwd')) {
    const projetos = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
    pasta = path.join(projetos, path.resolve(arg('--cwd')).replace(/[^A-Za-z0-9]/g, '-'));
  }
  if (!pasta) throw new Error('passe --cwd, --pasta ou --arquivo');
  let arquivos;
  try { arquivos = fs.readdirSync(pasta).filter((f) => f.endsWith('.jsonl')); } catch { return { erro: `pasta não existe: ${barra(pasta)} (o agente ainda não rodou ou o cwd é outro)` }; }
  if (!arquivos.length) return { erro: `nenhuma transcrição em ${barra(pasta)}` };
  arquivos.sort((a, b) => fs.statSync(path.join(pasta, b)).mtimeMs - fs.statSync(path.join(pasta, a)).mtimeMs);
  return path.join(pasta, arquivos[0]);
}

function main() {
  const alvo = acharArquivo();
  if (alvo && alvo.erro) { console.log(alvo.erro); return 2; }
  const linhas = fs.readFileSync(alvo, 'utf8').split('\n');
  const esperadas = (arg('--skills') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const modelos = new Set(); const esforcos = new Set(); let identidade = null;
  let instrucoes = null; let listaSkills = '';
  for (const l of linhas) {
    if (!l) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type === 'attachment' && j.attachment) {
      const a = j.attachment;
      if (a.type === 'model' && a.identity) identidade = a.identity.modelId;
      if (a.type === 'instructions' && Array.isArray(a.files) && !instrucoes) instrucoes = a.files.map((f) => barra(f.path));
      if (a.type === 'skill_listing' && typeof a.content === 'string') listaSkills += '\n' + a.content;
    }
    if (j.type === 'assistant') {
      if (j.message && j.message.model) modelos.add(j.message.model);
      if (j.effort) esforcos.add(j.effort);
    }
  }
  let ok = true;
  console.log(`Transcrição: ${barra(alvo)}`);
  const mods = [...modelos].filter((m) => m !== '<synthetic>');
  const modeloOk = (identidade === MODELO || mods.includes(MODELO)) && mods.every((m) => m === MODELO);
  console.log(`Modelo: ${identidade || '?'} · respostas: ${mods.join(', ') || '(nenhuma ainda)'} ${modeloOk ? '(ok)' : `(esperado ${MODELO})`}`);
  if (!modeloOk) ok = false;
  const esfOk = esforcos.size > 0 && [...esforcos].every((e) => e === ESFORCO);
  console.log(`Esforço: ${[...esforcos].join(', ') || '(nenhuma resposta ainda)'} ${esfOk ? '(ok)' : `(esperado ${ESFORCO})`}`);
  if (!esfOk) ok = false;
  console.log('Janela de 1M: a transcrição não mostra o [1m]; confira o comando do terminal (listar-terminais.js) e a tela (maestri check).');
  if (instrucoes) {
    const raizOk = instrucoes.some((p) => p.toLowerCase() === `${RAIZ}/CLAUDE.md`.toLowerCase());
    console.log(`CLAUDE.md carregados: ${instrucoes.join(' · ')}`);
    console.log(`CLAUDE.md da raiz: ${raizOk ? 'carregado (ok)' : 'NÃO carregado: a responsabilidade precisa mandar ler ' + RAIZ + '/CLAUDE.md'}`);
    if (!raizOk) ok = false;
  } else { console.log('CLAUDE.md carregados: (sem attachment "instructions" nesta transcrição)'); ok = false; }
  if (esperadas.length) {
    const faltando = esperadas.filter((s) => !new RegExp(`(^|\\n)- ${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`).test(listaSkills));
    console.log(`Skills esperadas: ${esperadas.length - faltando.length}/${esperadas.length} na lista da sessão${faltando.length ? ' · faltando: ' + faltando.join(', ') : ' (ok)'}`);
    if (faltando.length) ok = false;
  }
  return ok ? 0 : 1;
}

try { process.exitCode = main(); } catch (e) { console.error(`Erro: ${e.message}`); process.exitCode = 2; }
