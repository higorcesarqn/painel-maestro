'use strict';
// api-prospeccao.js · dados do dashboard /prospeccao (contrato da prospecção §1 "Dashboard").
//
// Lê o banco único pela lib_prospeccao (bin/prospeccao/lib_prospeccao.js) e altera leads só pelo
// comando canônico (bin/prospeccao/leads.js humano|devolver), para não duplicar regra.
// A lib calcula caminhos a partir de process.env.MAESTRO_DIR: cada leitura roda dentro de
// comAmbiente(), que aponta MAESTRO_DIR (e MAESTRO_AGORA) para a raiz do servidor só durante a
// chamada (tudo síncrono, então nenhuma outra requisição vê o ambiente trocado).
// Nada sensível sai daqui: nem a chave do Serper (só se ela existe), nem o WhatsApp do humano responsável,
// nem os números de teste (só a quantidade), nem o número dos chips.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin');
const PASTA = path.join(BIN, 'prospeccao');
const LEADS_JS = path.join(PASTA, 'leads.js');
const HORA_MS = 3600e3;
const LIMITE_POR_ETAPA = 200;
const LIMITE_TABELA = 300;
const LIMITE_LISTA = 50;
const RE_LEAD = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const ETAPAS_QUALIFICADO = new Set(['qualificado', 'reuniao_marcada']);
const ETAPAS_DO_CAPTADOR = new Set(['novo', 'pesquisado']);
const STATUS_DO_QUALIFICADOR = new Set(['READY_FOR_APPROACH', 'IN_APPROACH', 'CONTACTED', 'CONVERTED']);

class ErroProspeccao extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

// ---------- carga das bibliotecas (preguiçosa: o painel principal não depende delas) ----------

function carregar(nome) {
  try {
    return require(path.join(PASTA, nome));
  } catch (e) {
    throw new ErroProspeccao(503, `Não consegui carregar bin/prospeccao/${nome} (${e && e.message ? e.message.split('\n')[0] : e}).`);
  }
}

function libs() {
  return { P: carregar('lib_prospeccao.js'), lib: require(path.join(BIN, 'lib_maestro.js')) };
}

/** Roda fn (síncrona) com MAESTRO_DIR e MAESTRO_AGORA apontando para a raiz e o relógio do servidor. */
function comAmbiente(cfg, agora, fn) {
  const antes = { dir: process.env.MAESTRO_DIR, agora: process.env.MAESTRO_AGORA };
  process.env.MAESTRO_DIR = cfg.maestroDir;
  process.env.MAESTRO_AGORA = cfg.agoraFixa ? agora.toISOString() : '';
  try {
    return fn();
  } finally {
    if (antes.dir === undefined) delete process.env.MAESTRO_DIR;
    else process.env.MAESTRO_DIR = antes.dir;
    if (antes.agora === undefined) delete process.env.MAESTRO_AGORA;
    else process.env.MAESTRO_AGORA = antes.agora;
  }
}

// ---------- utilitários ----------

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const txt = (v) => (typeof v === 'string' && v.trim() ? v : null);

function etapaDe(l) {
  return typeof l.etapa === 'string' && l.etapa ? l.etapa : 'novo';
}

function comHumano(l) {
  return !!(obj(l.humano) && l.humano.ativo);
}

function respondeu(l) {
  if (txt(l.ultima_mensagem_lead_em)) return true;
  return Array.isArray(l.historico) && l.historico.some((h) => obj(h) && h.de === 'lead');
}

/** Lead na mão do qualificador (do READY_FOR_APPROACH em diante, ou saída dada por ele). */
function doQualificador(l, P) {
  if (STATUS_DO_QUALIFICADOR.has(l.status)) return true;
  return l.status === 'DISCARDED' && P.ETAPAS_SAIDA.includes(etapaDe(l));
}

/** Lead do lado do captador (tudo que ele descobriu, ou que já tem score). */
function doCaptador(l) {
  return l.origem === 'captador' || num(l.prospect_score) !== null;
}

function resumoQualificacao(l) {
  const h = obj(l.humano);
  const r = obj(l.reuniao);
  return {
    id: l.id,
    empresa: txt(l.empresa) || txt(l.nome),
    nome: txt(l.nome),
    cidade: txt(l.cidade),
    segmento: txt(l.segmento),
    origem: txt(l.origem),
    chip: txt(l.numero_whatsapp),
    etapa: etapaDe(l),
    status: txt(l.status),
    nota_conversa: num(l.nota_conversa),
    temperatura: txt(l.temperatura),
    gancho: txt(l.gancho),
    prospect_score: num(l.prospect_score),
    ultimo_contato_em: txt(l.ultimo_contato_em),
    proximo_followup: txt(l.proximo_followup),
    followup_tipo: txt(l.followup_tipo),
    humano: h && h.ativo ? { ativo: true, por: txt(h.por), motivo: txt(h.motivo), desde: txt(h.desde), notificado_em: txt(h.notificado_em) } : null,
    reuniao: r && txt(r.quando) ? { quando: r.quando, confirmada: !!r.confirmada } : null,
    atualizado_em: txt(l.atualizado_em),
  };
}

function resumoCaptador(l, P) {
  return {
    id: l.id,
    prospect_score: num(l.prospect_score),
    classificacao: txt(l.classificacao),
    empresa: txt(l.empresa) || txt(l.nome),
    instagram: txt(l.instagram),
    followers: num(l.followers),
    cidade: txt(l.cidade),
    distancia_km_aprox: num(l.distancia_km_aprox),
    whatsapp_confirmado: l.whatsapp_confirmado === true,
    tem_celular: P.ehCelular(l.telefone),
    has_ecommerce: typeof l.has_ecommerce === 'boolean' ? l.has_ecommerce : null,
    ecommerce_platform: txt(l.ecommerce_platform),
    google_reviews: num(l.google_reviews),
    google_rating: num(l.google_rating),
    instagram_quality: txt(l.instagram_quality),
    gancho: txt(l.gancho),
    data_confidence: num(l.data_confidence),
    status: txt(l.status),
    etapa: etapaDe(l),
    discard_reason: txt(l.discard_reason),
  };
}

/** Ordem do captador (03 §11): score desc, confiança desc, distância asc; sem score no fim. */
function ordemCaptador(a, b) {
  const s = (x, p) => (num(x) === null ? p : x);
  return (s(b.prospect_score, -1) - s(a.prospect_score, -1))
    || (s(b.data_confidence, -1) - s(a.data_confidence, -1))
    || (s(a.distancia_km_aprox, Infinity) - s(b.distancia_km_aprox, Infinity))
    || String(a.id).localeCompare(String(b.id));
}

function pct(parte, total) {
  return total ? Math.round((100 * parte) / total) : null;
}

// ---------- GET /api/prospeccao/estado ----------

function montarEstado(cfg, agora) {
  const { P, lib } = libs();
  return comAmbiente(cfg, agora, () => {
    const t = agora.getTime();
    const cam = P.caminhos();
    let ctxP;
    try {
      ctxP = P.carregarContexto(agora, { criarOperacao: false }); // lê leads.json uma vez
    } catch (e) {
      throw new ErroProspeccao(503, `Não consegui ler o estado da prospecção (${e && e.message ? e.message.split('\n')[0] : e}).`);
    }
    const { operacao, dados, chips, sinais, optout } = ctxP;
    const leads = P.listaLeads(dados).filter((l) => obj(l) && typeof l.id === 'string');
    const hoje = P.diaSP(agora);
    const data = (v) => lib.lerData(v);
    const ehHoje = (v) => {
      const d = data(v);
      return !!d && P.diaSP(d) === hoje;
    };
    const avisos = [];

    // Chips (sinais da vigia + envios de hoje)
    const situacao = P.situacaoDosChips(ctxP).map((s) => {
      const c = obj(chips.chips[s.id]) || {};
      return {
        id: s.id, portal: s.portal, status: s.status, pausado_ate: s.pausado_ate, motivo_pausa: txt(c.motivo),
        conectado: s.conectado, nao_lidas: s.nao_lidas, sinal_fresco: s.sinal_fresco, sinal_idade_s: s.sinal_idade_s,
        erro_vigia: s.erro_vigia, abordagens_hoje: s.abordagens_hoje, mensagens_hoje: s.mensagens_hoje, limite: s.limite,
        restante_hoje: s.restante_hoje, pode_abordar_agora: s.pode_abordar_agora, motivo: s.motivo,
      };
    });
    const ativos = P.chipsAtivos(chips, agora).length;
    const limite = operacao.ritmo.limite_diario_por_chip;
    const capacidade = ativos * limite;

    // Fila (contrato §3) e dias de fila (03 §12)
    const fila = P.filaOrdenada(dados, { optout });
    const minimo = capacidade * operacao.fila.dias_minimos;
    const diasFila = capacidade ? Math.round((fila.length / capacidade) * 10) / 10 : null;

    // Contagens gerais
    const porEtapa = Object.fromEntries(P.ETAPAS.map((e) => [e, 0]));
    const porStatus = Object.fromEntries(P.STATUS.map((s) => [s, 0]));
    for (const l of leads) {
      if (doQualificador(l, P)) porEtapa[etapaDe(l)] = (porEtapa[etapaDe(l)] || 0) + 1;
      if (txt(l.status)) porStatus[l.status] = (porStatus[l.status] || 0) + 1;
    }

    // ----- Qualificação (02 §A7)
    const quali = leads.filter((l) => doQualificador(l, P));
    const abordados = quali.filter((l) => txt(l.abordado_em));
    const qualificados = quali.filter((l) => {
      const e = etapaDe(l);
      if (ETAPAS_QUALIFICADO.has(e)) return true;
      if (e !== 'passado_humano') return false;
      const antes = obj(l.humano) && l.humano.etapa_anterior;
      return ETAPAS_QUALIFICADO.has(antes) || (num(l.nota_conversa) || 0) >= 60;
    });
    const ativosNaConversa = (l) => !P.ETAPAS_SAIDA.includes(etapaDe(l));
    const comReuniao = quali.filter((l) => obj(l.reuniao) && data(l.reuniao.quando) && ativosNaConversa(l));
    const reunioes48 = comReuniao
      .filter((l) => {
        const q = data(l.reuniao.quando).getTime();
        return q >= t - HORA_MS && q <= t + 48 * HORA_MS;
      })
      .sort((a, b) => data(a.reuniao.quando) - data(b.reuniao.quando))
      .map(resumoQualificacao);
    const quentesSemReuniao = quali
      .filter((l) => (l.temperatura === 'quente' || (num(l.nota_conversa) || 0) >= 70)
        && !(obj(l.reuniao) && txt(l.reuniao.quando)) && ativosNaConversa(l) && !comHumano(l))
      .sort((a, b) => (num(b.nota_conversa) || 0) - (num(a.nota_conversa) || 0))
      .slice(0, LIMITE_LISTA)
      .map(resumoQualificacao);
    const passados = leads.filter(comHumano)
      .sort((a, b) => String(b.humano.desde || '').localeCompare(String(a.humano.desde || '')))
      .slice(0, LIMITE_LISTA)
      .map(resumoQualificacao);

    const kanban = {};
    for (const e of P.ETAPAS) kanban[e] = { total: 0, leads: [] };
    const ordemCartao = (a, b) => (comHumano(b) - comHumano(a))
      || ((num(b.nota_conversa) ?? -1) - (num(a.nota_conversa) ?? -1))
      || ((num(b.prospect_score) ?? -1) - (num(a.prospect_score) ?? -1))
      || String(b.atualizado_em || '').localeCompare(String(a.atualizado_em || ''));
    const porColuna = new Map();
    for (const l of quali) {
      const e = etapaDe(l);
      if (!kanban[e]) kanban[e] = { total: 0, leads: [] };
      if (!porColuna.has(e)) porColuna.set(e, []);
      porColuna.get(e).push(l);
    }
    for (const [e, lista] of porColuna) {
      kanban[e].total = lista.length;
      kanban[e].leads = lista.sort(ordemCartao).slice(0, LIMITE_POR_ETAPA).map(resumoQualificacao);
    }

    const qualificacao = {
      kpis: {
        leads_hoje: quali.filter((l) => ehHoje(l.abordado_em)).length,
        novos_hoje: leads.filter((l) => ehHoje(l.criado_em)).length,
        respostas_pct: pct(abordados.filter(respondeu).length, abordados.length),
        abordados_total: abordados.length,
        responderam_total: abordados.filter(respondeu).length,
        qualificados: qualificados.length,
        reunioes_marcadas: comReuniao.length,
        reunioes_48h: reunioes48.length,
        chips_ativos: ativos,
        chips_total: situacao.length,
      },
      kanban,
      para_voce: { reunioes_48h: reunioes48, quentes_sem_reuniao: quentesSemReuniao, com_humano: passados },
    };

    // ----- Prospecção (03 §15)
    const capt = leads.filter(doCaptador);
    const comScore = capt.filter((l) => num(l.prospect_score) !== null);
    const aprovados = comScore.filter((l) => l.prospect_score >= 60);
    const descartados = capt.filter((l) => l.status === 'DISCARDED' && ETAPAS_DO_CAPTADOR.has(etapaDe(l)));
    // "Investigado hoje": avaliado_em de hoje; sem esse campo, score com a última alteração de hoje
    // ainda nas mãos do captador.
    const investigadoHoje = (l) => (txt(l.avaliado_em) ? ehHoje(l.avaliado_em)
      : num(l.prospect_score) !== null && ETAPAS_DO_CAPTADOR.has(etapaDe(l)) && ehHoje(l.atualizado_em));
    const tabela = capt.slice().sort(ordemCaptador);
    const semContato = capt.filter((l) => l.status === 'QUALIFIED').sort(ordemCaptador);
    const faixa = (min) => aprovados.filter((l) => l.prospect_score >= min).length;

    let serper = { disponivel: false, tem_chave: false, total: 0, pagas: 0, cache: 0, erros: 0, dia: hoje };
    try {
      serper.tem_chave = fs.existsSync(cam.serperChave); // só diz se existe; nunca lê o conteúdo aqui
      const uso = carregar('serper.js').uso(hoje);
      serper = Object.assign(serper, { disponivel: true, total: uso.total, pagas: uso.pagas, cache: uso.cache, erros: uso.erros, por_endpoint: uso.por_endpoint });
    } catch (e) {
      avisos.push(`uso do Serper indisponível (${e && e.message ? e.message.split('\n')[0] : e})`);
    }

    const prospeccao = {
      kpis: {
        descobertos_hoje: capt.filter((l) => l.origem === 'captador' && ehHoje(l.criado_em)).length,
        investigados_hoje: capt.filter(investigadoHoje).length,
        aprovados: aprovados.length,
        aprovados_hoje: aprovados.filter((l) => ehHoje(l.avaliado_em || l.criado_em)).length,
        descartados: descartados.length,
        descartados_hoje: descartados.filter((l) => ehHoje(l.atualizado_em)).length,
        faixas: { '60+': faixa(60), '70+': faixa(70), '80+': faixa(80), '90+': faixa(90) },
        chips_ativos: ativos,
        capacidade_diaria: capacidade,
        fila: fila.length,
        fila_minima: minimo,
        dias_fila: diasFila,
        dias_minimos: operacao.fila.dias_minimos,
      },
      fila_por_faixa: P.contagemPorFaixa(fila),
      tabela: { total: tabela.length, leads: tabela.slice(0, LIMITE_TABELA).map((l) => resumoCaptador(l, P)) },
      sem_contato: { total: semContato.length, leads: semContato.slice(0, LIMITE_LISTA).map((l) => resumoCaptador(l, P)) },
      serper,
    };

    const vigiaEm = data(sinais.atualizado_em);
    return {
      gerado_em: lib.isoSP(agora),
      operacao: {
        existe: fs.existsSync(cam.operacao),
        qualificador_ativo: !!operacao.qualificador.ativo,
        captador_ativo: !!operacao.captador.ativo,
        modo_teste: !!operacao.modo_teste,
        numeros_teste: Array.isArray(operacao.numeros_teste) ? operacao.numeros_teste.length : 0,
        limite_diario_por_chip: limite,
        janela: {
          abordagem: P.janelaAberta(operacao.ritmo.janela_abordagem, agora),
          resposta: P.janelaAberta(operacao.ritmo.janela_resposta, agora),
          abordagem_texto: `${operacao.ritmo.janela_abordagem.inicio} às ${operacao.ritmo.janela_abordagem.fim}`,
        },
      },
      vigia: { atualizado_em: vigiaEm ? sinais.atualizado_em : null, idade_s: vigiaEm ? Math.round((t - vigiaEm.getTime()) / 1000) : null },
      chips: situacao,
      contagens: { total: leads.length, por_etapa: porEtapa, por_status: porStatus },
      qualificacao,
      prospeccao,
      avisos,
    };
  });
}

// ---------- GET /api/prospeccao/lead/<id> ----------

function idValido(id) {
  return typeof id === 'string' && RE_LEAD.test(id);
}

function detalharLead(cfg, agora, id) {
  if (!idValido(id)) throw new ErroProspeccao(400, 'Id de lead inválido.');
  const { P, lib } = libs();
  return comAmbiente(cfg, agora, () => {
    const dados = P.lerLeads();
    const lead = Object.prototype.hasOwnProperty.call(dados.leads, id) && obj(dados.leads[id]) ? dados.leads[id] : null;
    if (!lead) return null;
    const chips = P.lerChips();
    return {
      gerado_em: lib.isoSP(agora),
      lead,
      portal: txt(lead.numero_whatsapp) ? P.portalDoChip(chips, lead.numero_whatsapp) : null,
    };
  });
}

// ---------- POST /api/prospeccao/assumir e /devolver ----------

/** Roda o comando canônico leads.js; devolve {codigo, saida, erro}. */
function rodarLeads(cfg, agora, args) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: cfg.maestroDir, MAESTRO_AGORA: cfg.agoraFixa ? agora.toISOString() : '' });
  return new Promise((resolve) => {
    execFile(process.execPath, [LEADS_JS, ...args], { env, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }, (e, stdout, stderr) => {
      const codigo = e ? (typeof e.code === 'number' ? e.code : -1) : 0;
      resolve({ codigo, saida: String(stdout || ''), erro: String(stderr || '').trim() });
    });
  });
}

function lerPedido(corpo) {
  let o = null;
  try {
    o = JSON.parse(corpo && corpo.length ? corpo.toString('utf8') : '');
  } catch (_) {
    throw new ErroProspeccao(400, 'Corpo inválido: envie JSON {"lead_id": "..."}.');
  }
  if (!obj(o) || !idValido(o.lead_id)) throw new ErroProspeccao(400, 'Falta "lead_id" válido no corpo.');
  return o;
}

function mensagemDoComando(r) {
  return (r.erro || r.saida).replace(/^erro:\s*/i, '').split('\n')[0].slice(0, 300) || `o comando saiu com ${r.codigo}`;
}

async function alterarLead(cfg, agora, acao, corpo) {
  const pedido = lerPedido(corpo);
  const id = pedido.lead_id;
  const antes = detalharLead(cfg, agora, id);
  if (!antes) throw new ErroProspeccao(404, `Lead não encontrado: ${id}`);
  let r;
  if (acao === 'assumir') {
    const motivo = 'O dono assumiu a conversa pelo painel';
    r = await rodarLeads(cfg, agora, ['humano', '--lead', id, '--motivo', motivo, '--por', 'painel', '--json']);
    // Quem assumiu foi o próprio dono: o aviso ao humano não precisa sair pelo WhatsApp.
    if (r.codigo === 0) await rodarLeads(cfg, agora, ['humano-notificado', '--lead', id, '--json']);
  } else {
    r = await rodarLeads(cfg, agora, ['devolver', '--lead', id, '--json']);
  }
  if (r.codigo === 1) throw new ErroProspeccao(409, mensagemDoComando(r));
  if (r.codigo === 2) throw new ErroProspeccao(400, mensagemDoComando(r));
  if (r.codigo !== 0) throw new ErroProspeccao(500, `leads.js ${acao === 'assumir' ? 'humano' : 'devolver'} falhou: ${mensagemDoComando(r)}`);
  const depois = detalharLead(cfg, agora, id);
  return { ok: true, acao, lead: depois ? resumoQualificacao(depois.lead) : null };
}

module.exports = { montarEstado, detalharLead, alterarLead, ErroProspeccao, idValido, comAmbiente, LEADS_JS };
