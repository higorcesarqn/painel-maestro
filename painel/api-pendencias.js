'use strict';
// POST /api/pendencias/<P-NNNN>/responder: o dono responde uma pendência pelo painel.
// 1. Grava a resposta pelo comando canônico (pendencia.js responder): status "respondida" e evento
//    "decisao" com origem dono-direto, no fluxo da própria pendência. É isso que vincula a resposta.
// 2. Avisa o Cérebro no terminal dele (maestri ask), numa linha só, sem barra invertida (a CLI do Maestri estraga \n e \t) e sem
//    aspas retas, para ele seguir a skill pendencias (devolver a decisão ao agente de origem e fechar).
//    O aviso não espera o Cérebro ficar livre: o ask entra na fila do terminal dele e o painel responde na hora.
// Só pendência "aberta" aceita resposta por aqui; corrigir uma resposta é conversa com o Cérebro.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PENDENCIA_JS = path.join(__dirname, '..', 'bin', 'pendencia.js');
const RE_PEND = /^P-\d{4,6}$/;
const LIMITE_TEXTO = 2000;
const LIMITE_AVISO = 1800;

class ErroPendencia extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const txt = (v) => (typeof v === 'string' ? v : '');

/** Aceita "P-0002", "p-2" ou "2" (como o pendencia.js); devolve "P-0002" ou null. */
function normalizarId(bruto) {
  const m = /^(?:p-)?(\d{1,6})$/i.exec(String(bruto || '').trim());
  if (!m) return null;
  const id = `P-${m[1].padStart(4, '0')}`;
  return RE_PEND.test(id) ? id : null;
}

function lerJson(arquivo) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new ErroPendencia(500, `${path.basename(arquivo)} ilegível: ${e.message}`);
  }
}

function acharPendencia(cfg, id) {
  const d = lerJson(path.join(cfg.maestroDir, 'estado', 'pendencias.json'));
  return arr(obj(d) && d.pendencias).find((p) => obj(p) && p.id === id) || null;
}

/** Nome do Cérebro no canvas (registro/agentes.json, slug "cerebro"); é o alvo do maestri ask. */
function nomeDoCerebro(cfg) {
  const d = lerJson(path.join(cfg.maestroDir, 'registro', 'agentes.json'));
  const a = arr(obj(d) && d.agentes).find((x) => obj(x) && x.slug === 'cerebro');
  return (a && txt(a.nome).trim()) || 'Cérebro Principal';
}

/** Corpo: {"opcao": "A", "texto": "..."}; pelo menos um dos dois. */
function lerPedido(corpo) {
  let o = null;
  try {
    o = JSON.parse(corpo && corpo.length ? corpo.toString('utf8') : '');
  } catch (_) {
    throw new ErroPendencia(400, 'Corpo inválido: envie JSON {"opcao": "A", "texto": "..."}.');
  }
  if (!obj(o)) throw new ErroPendencia(400, 'Corpo inválido: envie JSON {"opcao": "A", "texto": "..."}.');
  const opcao = o.opcao === undefined || o.opcao === null || o.opcao === '' ? null : String(o.opcao).trim().toUpperCase();
  const texto = txt(o.texto).trim();
  if (opcao !== null && !/^[A-Z]$/.test(opcao)) throw new ErroPendencia(400, 'Opção inválida: use a letra da opção (ex.: "A").');
  if (texto.length > LIMITE_TEXTO) throw new ErroPendencia(400, `Resposta longa demais (até ${LIMITE_TEXTO} caracteres).`);
  if (!opcao && !texto) throw new ErroPendencia(400, 'Escolha uma opção ou escreva a resposta.');
  return { opcao, texto };
}

/** Texto da opção escolhida: a que começa com "A:" (ou "A)", "A -"), senão a de mesma posição. */
function textoDaOpcao(p, letra) {
  const opcoes = arr(p.opcoes).map(txt).filter(Boolean);
  const re = new RegExp(`^\\s*(?:opç[aã]o\\s+)?${letra}\\s*[:).\\-–]`, 'i');
  const achada = opcoes.find((o) => re.test(o));
  if (achada) return achada.trim();
  const i = letra.charCodeAt(0) - 65;
  return opcoes[i] ? `${letra}: ${opcoes[i].trim()}` : null;
}

/** Roda o pendencia.js na mesma raiz do painel; devolve {codigo, saida, erro}. */
function rodarPendencia(cfg, agora, args) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: cfg.maestroDir, MAESTRO_AGORA: cfg.agoraFixa ? agora.toISOString() : '' });
  delete env.CLAUDE_CODE_SESSION_ID; // o servidor não é uma sessão do Claude Code
  return new Promise((resolve) => {
    execFile(process.execPath, [PENDENCIA_JS, ...args], { env, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }, (e, stdout, stderr) => {
      const codigo = e ? (typeof e.code === 'number' ? e.code : -1) : 0;
      resolve({ codigo, saida: String(stdout || ''), erro: String(stderr || '').trim() });
    });
  });
}

const linha = (s, n) => String(s)
  .replace(/\\/g, '/')
  .replace(/["“”]/g, (c) => (c === '"' ? '”' : c))
  .replace(/[\u0000-\u001f\u007f]+/g, ' ')
  .replace(/\s{2,}/g, ' ')
  .trim()
  .slice(0, n);

function mensagemAoCerebro(p, resposta, quando) {
  return linha(
    `[RESPOSTA DO DONO PELO PAINEL] ${p.id}${p.fluxo_id ? ` · fluxo ${p.fluxo_id}` : ''}${p.agente ? ` · aberta por ${p.agente}` : ''}`
    + ` · ${txt(p.titulo)} · Resposta: ${resposta} · Já gravada às ${quando} com pendencia.js responder (status respondida).`
    + ' Siga a skill pendencias: devolva a decisão ao agente de origem com [PEDIDO] no mesmo fluxo e feche a pendência quando concluir.',
    LIMITE_AVISO,
  );
}

/** Dispara o maestri ask sem esperar a resposta do Cérebro. Resolve quando o processo nasce (ou falha ao nascer). */
function avisarCerebro(cfg, mensagem) {
  const a = cfg.avisoCerebro || { ativo: false, motivo: 'desligado' };
  if (!a.ativo) return Promise.resolve({ enviado: false, motivo: a.motivo || 'desligado' });
  const nome = nomeDoCerebro(cfg);
  const ehJs = /\.[cm]?js$/i.test(a.cli);
  const cmd = ehJs ? process.execPath : a.cli;
  const args = [...(ehJs ? [a.cli] : []), 'ask', nome, mensagem];
  return new Promise((resolve) => {
    let filho;
    try {
      filho = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    } catch (e) {
      resolve({ enviado: false, motivo: e.message });
      return;
    }
    filho.once('spawn', () => { filho.unref(); resolve({ enviado: true, para: nome }); });
    filho.once('error', (e) => resolve({ enviado: false, motivo: e.code === 'ENOENT' ? `não achei o maestri (${a.cli})` : e.message }));
  });
}

async function responderPendencia(cfg, agora, idBruto, corpo) {
  const id = normalizarId(idBruto);
  if (!id) throw new ErroPendencia(400, 'Id de pendência inválido (use P-NNNN).');
  const pedido = lerPedido(corpo);
  const antes = acharPendencia(cfg, id);
  if (!antes) throw new ErroPendencia(404, `Pendência não encontrada: ${id}`);
  const status = antes.status || 'aberta';
  if (status !== 'aberta') throw new ErroPendencia(409, `${id} já está ${status}. Para mudar a resposta, fale com o Cérebro.`);

  let resposta = pedido.texto;
  if (pedido.opcao) {
    const opcao = textoDaOpcao(antes, pedido.opcao);
    if (!opcao) throw new ErroPendencia(400, `${id} não tem a opção ${pedido.opcao}.`);
    resposta = pedido.texto ? `${opcao} · Comentário do dono: ${pedido.texto}` : opcao;
  }

  const r = await rodarPendencia(cfg, agora, ['responder', id, '--resposta', resposta, '--agente', 'cerebro']);
  if (r.codigo !== 0) {
    const msg = (r.erro || r.saida).replace(/^erro:\s*/i, '').split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 400) || `o comando saiu com ${r.codigo}`;
    throw new ErroPendencia(r.codigo === 2 ? 400 : 500, `pendencia.js responder falhou: ${msg}`);
  }
  const depois = acharPendencia(cfg, id) || antes;
  const quando = txt(depois.respondida_em).slice(11, 16) || '';
  const aviso = await avisarCerebro(cfg, mensagemAoCerebro(depois, txt(depois.resposta) || resposta, quando));
  return { ok: true, pendencia: depois, aviso_cerebro: aviso };
}

module.exports = { responderPendencia, normalizarId, mensagemAoCerebro, textoDaOpcao, ErroPendencia, PENDENCIA_JS };
