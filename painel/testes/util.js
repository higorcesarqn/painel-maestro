'use strict';
// Utilitários dos testes do painel (sem framework). Tudo que é gravado fica em testes/tmp/.

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = path.join(__dirname, 'tmp');
const MAESTRO = path.resolve(__dirname, '..', '..');
const PORTAS = [4790, 4791, 4792, 4793, 4794, 4795, 4796, 4797, 4798, 4799];

/** Suíte simples: teste(nome, fn) em sequência e resumo() no fim (código de saída 1 se falhar). */
function criarSuite(titulo) {
  const casos = [];
  let oks = 0;
  let falhas = 0;
  return {
    teste(nome, fn) {
      casos.push({ nome, fn });
    },
    async rodar() {
      console.log(`\n== ${titulo}`);
      for (const c of casos) {
        const t0 = Date.now();
        try {
          await c.fn();
          oks++;
          console.log(`ok    ${c.nome} (${Date.now() - t0} ms)`);
        } catch (e) {
          falhas++;
          const pilha = String((e && e.stack) || e).split('\n').slice(0, 8).join('\n        ');
          console.log(`FALHA ${c.nome}\n        ${pilha}`);
        }
      }
      console.log(`-- ${titulo}: ${oks} ok · ${falhas} falha(s)`);
      process.exitCode = falhas ? 1 : 0;
      return { oks, falhas };
    },
  };
}

/** Pasta temporária própria do teste (apagada e recriada). */
function pastaTmp(nome) {
  const d = path.join(TMP, `${nome}-${process.pid}`);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function apagar(d) {
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (_) { /* antivírus segurando: fica para a próxima */ }
}

function escreverJson(arquivo, objeto) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, JSON.stringify(objeto, null, 2));
}

function escreverJsonl(arquivo, linhas, { semQuebraFinal = false } = {}) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const texto = linhas.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  fs.writeFileSync(arquivo, semQuebraFinal ? texto : `${texto}\n`);
}

function anexar(arquivo, texto) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.appendFileSync(arquivo, texto);
}

/** Linha "assistant" de transcrição do Claude Code com o uso dado. */
function linhaAssistente({ id, ts, e = 0, s = 0, cw = 0, cr = 0, sessao = 'sessao', sub = false, parar = 'end_turn' }) {
  return JSON.stringify({
    parentUuid: null, isSidechain: sub, type: 'assistant', uuid: `u-${id}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp: new Date(ts).toISOString(), sessionId: sessao, cwd: 'C:\\teste',
    message: {
      model: 'claude-opus-5-5', id, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: parar,
      usage: { input_tokens: e, output_tokens: s, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, service_tier: 'standard' },
    },
    requestId: `req-${id}`,
  });
}

function linhaUsuario(texto) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: texto }, timestamp: new Date().toISOString(), usage_hint: 'nada' });
}

/** Porta livre entre 4790 e 4799 (nunca a 4777). */
async function portaLivre() {
  const ordem = PORTAS.slice().sort(() => Math.random() - 0.5);
  for (const p of ordem) {
    const livre = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (livre) return p;
  }
  throw new Error('Nenhuma porta livre entre 4790 e 4799');
}

/** Requisição HTTP crua (sem gzip), com Host e cabeçalhos à escolha. */
function pedir(porta, caminho, { metodo = 'GET', host, cabecalhos = {}, corpo } = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ Host: host === undefined ? `127.0.0.1:${porta}` : host }, cabecalhos);
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers, agent: false }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(partes);
        const texto = buf.toString('utf8');
        let json = null;
        if (/json/.test(String(res.headers['content-type'] || '')) && !res.headers['content-encoding']) {
          try { json = JSON.parse(texto); } catch (_) { json = null; }
        }
        resolve({ status: res.statusCode, headers: res.headers, texto, buf, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error(`tempo esgotado em ${caminho}`)));
    if (corpo) req.write(corpo);
    req.end();
  });
}

/** Requisição crua pelo socket (para Host vazio, ausente ou duplicado). Devolve {status, texto}. */
function pedirCru(porta, texto) {
  return new Promise((resolve, reject) => {
    const s = net.connect(porta, '127.0.0.1', () => s.end(texto));
    const partes = [];
    s.on('data', (c) => partes.push(c));
    s.on('error', reject);
    s.on('close', () => {
      const t = Buffer.concat(partes).toString('utf8');
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(t);
      resolve({ status: m ? Number(m[1]) : null, texto: t });
    });
    s.setTimeout(15000, () => s.destroy(new Error('tempo esgotado')));
  });
}

async function esperarAte(fn, ms = 8000, passo = 50) {
  const fim = Date.now() + ms;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > fim) throw new Error('condição não atingida a tempo');
    await new Promise((x) => setTimeout(x, passo));
  }
}

/** Derruba um processo pelo PID do Windows (taskkill /F), sem shell. */
function derrubar(pid) {
  if (!pid) return;
  try { process.kill(pid); } catch (_) { /* já saiu */ }
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
}

function pidVivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

module.exports = {
  assert, TMP, MAESTRO, criarSuite, pastaTmp, apagar, escreverJson, escreverJsonl, anexar,
  linhaAssistente, linhaUsuario, portaLivre, pedir, pedirCru, esperarAte, derrubar, pidVivo,
};
