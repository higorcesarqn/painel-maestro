// Modo de teste (?mock=1): lê testes/mock-*.json e imita /api/estado, /api/eventos, /api/evento e /api/fluxo.
// Sirva com "node testes/servir-mock.js" e abra http://127.0.0.1:4795/?mock=1 (ou use o npm run dev).
import { arr, obj, diaSP, normalizar, txt, agora } from './formato.js';
import { precisaDono } from './dominio.js';

let carga = null;
function carregarMock() {
  if (!carga) {
    const pegar = (nome) => fetch(`testes/${nome}`, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`testes/${nome}: ${r.status}`);
      return r.json();
    });
    carga = Promise.all([pegar('mock-estado.json'), pegar('mock-detalhes.json').catch(() => null)])
      .then(([estado, det]) => ({ estado, det: det || { eventos: arr(estado.eventos), comandos_brutos: [], fluxos: {} } }))
      .catch((e) => {
        carga = null;
        throw new Error(`Modo de teste: não consegui ler testes/mock-estado.json (${e.message}). Sirva a pasta com "node testes/servir-mock.js" e abra a página com ?mock=1.`);
      });
  }
  return carga;
}

const CAMPOS_TABELA = ['id', 'ts', 'agente', 'projeto', 'trello', 'resumo', 'direcao', 'resultado', 'tipo', 'fluxo_id', 'precisa_dono', 'origem', 'teste'];
function camposTabela(e) {
  const r = {};
  for (const k of CAMPOS_TABELA) if (e[k] !== undefined) r[k] = e[k];
  return r;
}
function erro(msg, status) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

export async function mockApi(caminho, metodo, corpo) {
  if (String(caminho).startsWith('/api/prospeccao/')) return mockProspeccao(caminho, metodo, corpo);
  const { estado, det } = await carregarMock();
  const u = new URL(caminho, location.href);
  const p = u.pathname;
  const sp = u.searchParams;
  const evs = arr(det.eventos).slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const asc = evs.slice().reverse();
  if (p === '/api/estado' || (p === '/api/recalcular' && metodo === 'POST')) return JSON.parse(JSON.stringify(estado));
  if (p === '/api/eventos') {
    // Igual ao servidor: horas=N, vários valores por vírgula e contagens em que cada faceta ignora o próprio filtro.
    const conj = (n) => (sp.get(n) ? new Set(sp.get(n).split(',').map((x) => x.trim()).filter(Boolean)) : null);
    const ag = conj('agente'); const tp = conj('tipo'); const rs = conj('resultado');
    const pj = sp.get('projeto') ? new Set(sp.get('projeto').split(',').map((x) => x.trim().toLowerCase())) : null;
    const termos = normalizar(sp.get('q') || '').split(/\s+/).filter(Boolean);
    const desde = sp.get('desde'); const ate = sp.get('ate'); const fluxo = sp.get('fluxo');
    const horas = Number(sp.get('horas')) || 0; const desdeT = horas > 0 ? agora() - horas * 3600000 : null;
    const testes = sp.get('incluir_testes') === '1'; const soDono = sp.get('so_dono') === '1';
    const grupos = { resultado: new Map(), agente: new Map(), projeto: new Map(), tipo: new Map() };
    const somar = (g, k) => { if (typeof k === 'string' && k) g.set(k, (g.get(k) || 0) + 1); };
    let precisa = 0;
    const f = evs.filter((e) => {
      if (!testes && e.teste === true) return false;
      const d = diaSP(e.ts);
      if (desde && d < desde) return false;
      if (ate && d > ate) return false;
      if (desdeT !== null && !(Date.parse(e.ts) >= desdeT)) return false;
      if (fluxo && e.fluxo_id !== fluxo) return false;
      if (termos.length) {
        const t = normalizar([e.resumo, e.direcao, e.trello && e.trello.titulo, e.fluxo_id].map(txt).join(' '));
        if (!termos.every((x) => t.includes(x))) return false;
      }
      const proj = String(e.projeto || '');
      const okAg = !ag || ag.has(e.agente); const okPr = !pj || pj.has(proj.toLowerCase());
      const okTi = !tp || tp.has(e.tipo); const okRe = !rs || rs.has(e.resultado); const okJo = !soDono || precisaDono(e);
      if (okPr && okTi && okRe && okJo) somar(grupos.agente, e.agente);
      if (okAg && okTi && okRe && okJo) somar(grupos.projeto, proj.toUpperCase());
      if (okAg && okPr && okRe && okJo) somar(grupos.tipo, e.tipo);
      if (okAg && okPr && okTi && okJo) somar(grupos.resultado, e.resultado);
      if (okAg && okPr && okTi && okRe && precisaDono(e)) precisa++;
      return okAg && okPr && okTi && okRe && okJo;
    });
    const pg = Math.max(1, Number(sp.get('pagina')) || 1); const pp = Math.max(1, Number(sp.get('por_pagina')) || 50);
    const contagens = {
      resultado: Object.fromEntries(grupos.resultado), agente: Object.fromEntries(grupos.agente),
      projeto: Object.fromEntries(grupos.projeto), tipo: Object.fromEntries(grupos.tipo), precisa_dono: precisa,
    };
    return { total: f.length, pagina: pg, por_pagina: pp, paginas: Math.max(1, Math.ceil(f.length / pp)), eventos: f.slice((pg - 1) * pp, pg * pp).map(camposTabela), contagens };
  }
  const brutos = arr(det.comandos_brutos).slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const infoFluxo = (id, lista) => {
    const r = obj(det.fluxos) && det.fluxos[id];
    if (!r && !lista.length) return null;
    return { id, titulo: (r && r.titulo) || null, criado_em: (r && r.criado_em) || (lista[0] && lista[0].ts) || null, agente: (r && r.agente) || null };
  };
  const pedidoDe = (lista, id) => {
    const ev = lista.find((e) => e.tipo === 'pedido-recebido') || lista.find((e) => e.tipo_original === 'pedido-recebido');
    if (ev) return { texto: ev.pedido || ev.texto || ev.resumo, origem: ev.origem || null, ts: ev.ts, agente: ev.agente, fonte: 'evento' };
    const b = brutos.find((x) => typeof x.prompt === 'string' && id && x.prompt.includes(id));
    return b ? { texto: b.prompt, origem: null, ts: b.ts, agente: b.agente, fonte: 'prompt', origem_inferida: true } : null;
  };
  const fmtCmd = (b, corr) => ({ ts: b.ts, agente: b.agente, evento: b.evento, ferramenta: b.ferramenta || null, entrada: b.entrada || null, ok: typeof b.ok === 'boolean' ? b.ok : null, sessao: b.sessao || null, fluxo_id: b.fluxo_id || null, correlacao: corr, prompt: b.prompt, erro: b.erro });
  let m = /^\/api\/evento\/(.+)$/.exec(p);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const ev = evs.find((e) => e.id === id);
    if (!ev) throw erro(`Evento ${id} não encontrado.`, 404);
    const seq = ev.fluxo_id ? asc.filter((e) => e.fluxo_id === ev.fluxo_id && (ev.teste === true || e.teste !== true)) : [ev];
    const tEv = Date.parse(ev.ts);
    const anteriorDoAgente = asc.filter((e) => e.agente === ev.agente && Date.parse(e.ts) < tEv).pop();
    const ini = anteriorDoAgente ? Date.parse(anteriorDoAgente.ts) : tEv - 2 * 3600000;
    const cmds = brutos.filter((b) => (ev.fluxo_id && b.fluxo_id === ev.fluxo_id))
      .map((b) => fmtCmd(b, 'fluxo_id'))
      .concat(brutos.filter((b) => !b.fluxo_id && b.agente === ev.agente && Date.parse(b.ts) > ini && Date.parse(b.ts) <= tEv).map((b) => fmtCmd(b, 'janela')))
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const vis = asc.filter((e) => e.teste !== true || ev.teste === true);
    const i = vis.indexOf(ev);
    return {
      evento: ev, fluxo: ev.fluxo_id ? infoFluxo(ev.fluxo_id, seq) : null, pedido_inicial: pedidoDe(seq, ev.fluxo_id),
      sequencia: seq, comandos_brutos: cmds, comandos_truncados: 0,
      janela_sem_fluxo: { inicio: new Date(ini).toISOString(), fim: ev.ts, sessao: ev.sessao || null },
      anterior_id: i > 0 ? vis[i - 1].id : null, proximo_id: i >= 0 && i < vis.length - 1 ? vis[i + 1].id : null,
    };
  }
  m = /^\/api\/fluxo\/(.+)$/.exec(p);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const lista = asc.filter((e) => e.fluxo_id === id && e.teste !== true);
    const fl = infoFluxo(id, lista);
    if (!fl) throw erro(`Fluxo ${id} não encontrado.`, 404);
    return { fluxo: fl, eventos: lista, comandos_brutos: brutos.filter((b) => b.fluxo_id === id).map((b) => fmtCmd(b, 'fluxo_id')), comandos_truncados: 0, pedido_inicial: pedidoDe(lista, id) };
  }
  throw erro('Rota não existe no modo de teste.', 404);
}

// ---------- prospecção (?mock=1): testes/mock-prospeccao.json, gerado por testes/gerar-mock-prospeccao.js ----------
let cargaProspeccao = null;
function carregarMockProspeccao() {
  if (!cargaProspeccao) {
    cargaProspeccao = fetch('testes/mock-prospeccao.json', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`testes/mock-prospeccao.json: ${r.status}`); return r.json(); })
      .catch((e) => { cargaProspeccao = null; throw erro(`Modo de teste: não consegui ler testes/mock-prospeccao.json (${e.message}).`, 503); });
  }
  return cargaProspeccao;
}
const copia = (v) => JSON.parse(JSON.stringify(v));

/** Imita /api/prospeccao/estado, /lead/<id>, /assumir e /devolver. Assumir e devolver mudam só a memória da página. */
async function mockProspeccao(caminho, metodo, corpo) {
  const m = await carregarMockProspeccao();
  const p = new URL(caminho, location.href).pathname;
  if (p === '/api/prospeccao/estado' && metodo !== 'POST') return copia(m.estado);
  const ml = /^\/api\/prospeccao\/lead\/(.+)$/.exec(p);
  if (ml && metodo !== 'POST') {
    const r = m.leads[decodeURIComponent(ml[1])];
    if (!r) throw erro('Lead não encontrado.', 404);
    return copia(r);
  }
  if (metodo !== 'POST' || (p !== '/api/prospeccao/assumir' && p !== '/api/prospeccao/devolver')) throw erro('Rota não existe no modo de teste.', 404);
  const id = obj(corpo) ? corpo.lead_id : null;
  const r = id ? m.leads[id] : null;
  if (!r) throw erro(`Lead não encontrado: ${id}`, 404);
  const l = r.lead;
  const assumir = p.endsWith('/assumir');
  const comHumano = !!(obj(l.humano) && l.humano.ativo);
  if (assumir && comHumano) throw erro('O lead já está com o humano.', 409);
  if (!assumir && !comHumano) throw erro(`O lead ${id} não está com o humano.`, 409);
  const quali = m.estado.qualificacao;
  const kb = quali.kanban;
  const achar = (etapa) => arr(kb[etapa] && kb[etapa].leads).find((x) => x.id === id) || null;
  const tirar = (etapa) => { const c = kb[etapa]; if (!c) return; c.leads = c.leads.filter((x) => x.id !== id); c.total = Math.max(0, c.total - 1); };
  const por = (etapa, cartao) => { if (!kb[etapa]) kb[etapa] = { total: 0, leads: [] }; kb[etapa].leads.unshift(cartao); kb[etapa].total += 1; };
  const quando = new Date(agora()).toISOString();
  const de = l.etapa || 'novo';
  const cartao = achar(de);
  if (assumir) {
    l.humano = { ativo: true, motivo: 'O dono assumiu a conversa pelo painel', desde: quando, notificado_em: quando, por: 'painel', etapa_anterior: de };
    l.etapa = 'passado_humano';
    l.proximo_followup = null;
    if (cartao) {
      tirar(de);
      Object.assign(cartao, { etapa: 'passado_humano', proximo_followup: null, humano: { ativo: true, por: 'painel', motivo: l.humano.motivo, desde: quando, notificado_em: quando } });
      por('passado_humano', cartao);
      quali.para_voce.com_humano.unshift(cartao);
      quali.para_voce.quentes_sem_reuniao = quali.para_voce.quentes_sem_reuniao.filter((x) => x.id !== id);
    }
  } else {
    const volta = l.humano.etapa_anterior || 'qualificando';
    l.humano = { ativo: false, motivo: null, desde: null, notificado_em: null, por: null };
    l.etapa = volta;
    if (cartao) {
      tirar('passado_humano');
      Object.assign(cartao, { etapa: volta, humano: null });
      por(volta, cartao);
      quali.para_voce.com_humano = quali.para_voce.com_humano.filter((x) => x.id !== id);
    }
  }
  return { ok: true, acao: assumir ? 'assumir' : 'devolver', lead: cartao ? copia(cartao) : null };
}
