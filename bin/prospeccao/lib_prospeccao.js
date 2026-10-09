'use strict';
/**
 * lib_prospeccao.js · núcleo da operação de prospecção (Node 22, CommonJS, só biblioteca padrão).
 * Regra técnica: _maestro/conhecimento/prospeccao/contrato.md.
 *
 * Seções: caminhos · operação · banco de leads · telefone e normalização · deduplicação · opt-out · chips ·
 * sinais da vigia · envios · janelas · fila · follow-up · agenda · ciclo do qualificador · aviso ao humano.
 *
 * Todo JSON de estado é gravado com atualizarJson (trava + gravação atômica) do lib_maestro.
 * Datas: sempre isoSP (America/Sao_Paulo). MAESTRO_DIR e MAESTRO_AGORA valem aqui também.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('../lib_maestro');

// =============================================================================================
// Constantes
// =============================================================================================

const ETAPAS = ['novo', 'pesquisado', 'abordado', 'respondeu', 'qualificando', 'qualificado', 'reuniao_marcada',
  'passado_humano', 'sem_resposta', 'perdido', 'desqualificado'];
const ETAPAS_SAIDA = ['sem_resposta', 'perdido', 'desqualificado'];
const ETAPAS_FILA = ['novo', 'pesquisado'];
const ETAPAS_CONVERSA = ['respondeu', 'qualificando', 'qualificado'];
const STATUS = ['DISCOVERED', 'INVESTIGATING', 'READY_FOR_APPROACH', 'IN_APPROACH', 'CONTACTED', 'CONVERTED', 'QUALIFIED', 'DISCARDED'];
const TEMPERATURAS = ['frio', 'morno', 'quente'];
const TIPOS_ENVIO = ['abordagem', 'followup', 'resposta', 'confirmacao', 'aviso_humano'];
const TIPOS_FOLLOWUP = ['sem_resposta', 'parou_de_responder', 'agora_nao', 'encerrar'];
const STATUS_CHIP = ['ativo', 'pausado', 'desconectado', 'inativo'];
const CAMPOS_QUALIFICACAO = ['tempo_atuacao', 'qtd_produtos', 'canais_venda', 'vendas_semana', 'tem_loja_online',
  'decisor', 'dor_principal', 'servico_interesse', 'orcamento_sinal'];
const SINAL_VALIDO_MS = 3 * 60e3; // sinal da vigia mais velho que isso conta como desconhecido
const DIAS_PARA_ENCERRAR = 2; // depois do último follow-up sem resposta, espera isso e move para sem_resposta
const FOLGA_REUNIAO_MIN = 10; // folga entre reuniões, além da duração
const ANTECEDENCIA_MIN_MS = 2 * 3600e3; // horário oferecido nunca a menos de 2 h
const DIAS_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
// Domínios compartilhados por muitas lojas: não servem para deduplicar.
const DOMINIOS_COMPARTILHADOS = new Set(['instagram.com', 'facebook.com', 'fb.com', 'linktr.ee', 'wa.me', 'whatsapp.com',
  'api.whatsapp.com', 'google.com', 'goo.gl', 'maps.app.goo.gl', 'g.page', 'bit.ly', 'linkr.bio', 'beacons.ai',
  'tiktok.com', 'youtube.com', 'linkin.bio', 'taplink.cc', 'msha.ke']);
// DDDs válidos no Brasil.
const DDDS = new Set([11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44,
  45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86,
  87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99]);

/** Erro de regra (sai com 1): opt-out, lead com humano, chip errado etc. */
function erroRecusa(mensagem) {
  const e = new Error(mensagem);
  e.code = 'ERECUSA';
  return e;
}

// =============================================================================================
// Caminhos
// =============================================================================================

/** Caminhos da operação, recalculados a cada chamada (respeitam MAESTRO_DIR). */
function caminhos() {
  const base = lib.dirMaestro();
  const estado = path.join(base, 'estado', 'prospeccao');
  return {
    base,
    estado,
    leads: path.join(estado, 'leads.json'),
    optout: path.join(estado, 'optout.json'),
    chips: path.join(estado, 'chips.json'),
    operacao: path.join(estado, 'operacao.json'),
    sinais: path.join(estado, 'sinais.json'),
    envios: path.join(estado, 'envios.jsonl'),
    gatilho: path.join(estado, 'gatilho.json'),
    municipiosCobertos: path.join(estado, 'municipios-cobertos.json'),
    serperCache: path.join(estado, 'serper-cache'),
    serperChamadas: path.join(estado, 'serper-chamadas.jsonl'),
    serperChave: path.join(base, '.segredos', 'serper.key'),
    config: path.join(__dirname, 'config'),
  };
}

// =============================================================================================
// Datas
// =============================================================================================

/** Agora em ISO de São Paulo (texto). */
function agora() {
  return lib.isoSP(lib.agora());
}

/** Agora como Date (respeita MAESTRO_AGORA). */
function agoraData() {
  return lib.agora();
}

/** Soma dias (24 h) a uma data. */
function somarDias(data, dias) {
  return new Date(data.getTime() + dias * 86400e3);
}

/** Dia da semana (0 = domingo) da data no fuso de São Paulo. */
function diaDaSemanaSP(data) {
  const p = lib.partesSP(data);
  return new Date(Date.UTC(Number(p.ano), Number(p.mes) - 1, Number(p.dia))).getUTCDay();
}

/** "AAAA-MM-DD" da data em São Paulo. */
function diaSP(data) {
  return lib.carimbosSP(data).aaaammdd;
}

/** Date de um horário local de São Paulo (ano, mês 1-12, dia, "HH:MM"). */
function dataLocalSP(ano, mes, dia, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const palpite = new Date(Date.UTC(ano, mes - 1, dia, h + 3, m));
  const { offset } = lib.partesSP(palpite);
  const d2 = (n) => String(n).padStart(2, '0');
  return new Date(`${ano}-${d2(mes)}-${d2(dia)}T${d2(h)}:${d2(m)}:00${offset}`);
}

/** "HH:MM" -> minutos do dia. */
function minutosDe(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

// =============================================================================================
// Operação
// =============================================================================================

/** Padrões de operacao.json (contrato §4). */
function padraoOperacao() {
  return {
    qualificador: { ativo: false },
    captador: { ativo: false },
    modo_teste: true,
    numeros_teste: [],
    humano: { nome: 'Dono', whatsapp: '+5511900000001' }, // exemplo fictício: troque em estado/prospeccao/operacao.json
    ritmo: {
      limite_diario_por_chip: 20, intervalo_min_minutos: 15, intervalo_max_minutos: 40,
      digitacao_min_s: 2, digitacao_max_s: 6,
      janela_abordagem: { dias: [1, 2, 3, 4, 5, 6], inicio: '09:00', fim: '19:00' },
      janela_resposta: { dias: [0, 1, 2, 3, 4, 5, 6], inicio: '08:00', fim: '21:00' },
    },
    followup: { sem_resposta_dias: [2, 5, 10], parou_de_responder_dias: [2, 6], agora_nao_dias: 21 },
    agenda: {
      dias_uteis: [1, 2, 3, 4, 5], inicio: '09:00', fim: '21:00', preferencia_inicio: '18:00',
      duracao_min: 20, dias_a_frente: 3, integracao: 'manual',
      // Feriados (exemplo: nacionais, Carnaval e Corpus Christi): nunca oferecer reunião nesses dias.
      // Acrescente os feriados locais em estado/prospeccao/operacao.json.
      feriados: ['2026-10-12', '2026-11-02', '2026-11-20', '2026-12-25', '2027-01-01', '2027-02-08', '2027-02-09',
        '2027-03-26', '2027-04-21', '2027-05-27', '2027-09-07', '2027-10-12', '2027-11-02', '2027-11-15'],
    },
    fila: { dias_minimos: 2, score_minimo: 60, confianca_minima: 50 },
  };
}

function objetoSimples(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Mescla os padrões nas chaves ausentes (recursivo em objetos; listas e valores existentes ficam). */
function mesclarPadroes(padrao, atual) {
  if (!objetoSimples(atual)) return structuredClone(padrao);
  const r = { ...atual };
  for (const [k, v] of Object.entries(padrao)) {
    if (r[k] === undefined) r[k] = structuredClone(v);
    else if (objetoSimples(v) && objetoSimples(r[k])) r[k] = mesclarPadroes(v, r[k]);
  }
  return r;
}

/** Lê operacao.json com os padrões nas chaves ausentes. Cria o arquivo se faltar (criar: false só lê). */
function lerOperacao({ criar = true } = {}) {
  const arq = caminhos().operacao;
  let atual = lib.lerJson(arq, null);
  if (atual === null && criar) {
    atual = lib.atualizarJson(arq, null, (x) => (x === null ? padraoOperacao() : undefined));
  }
  return mesclarPadroes(padraoOperacao(), atual || {});
}

/** Altera operacao.json com trava (fn muta o objeto; devolver false não grava). */
function atualizarOperacao(fn) {
  let saida;
  lib.atualizarJson(caminhos().operacao, null, (atual) => {
    const op = mesclarPadroes(padraoOperacao(), atual || {});
    saida = fn(op);
    return saida === false ? undefined : op;
  });
  return saida;
}

// =============================================================================================
// Banco de leads
// =============================================================================================

const BANCO_INICIAL = { versao: 1, leads: {} };

function normalizarBanco(d) {
  const r = objetoSimples(d) ? d : structuredClone(BANCO_INICIAL);
  if (!r.versao) r.versao = 1;
  if (!objetoSimples(r.leads)) r.leads = {};
  return r;
}

/** Lê leads.json ({versao, leads:{id: lead}}). */
function lerLeads() {
  return normalizarBanco(lib.lerJson(caminhos().leads, BANCO_INICIAL));
}

/** Ler-alterar-gravar o banco com trava. fn(dados) muta e devolve um resultado; devolver false não grava. */
function atualizarLeads(fn) {
  let saida;
  lib.atualizarJson(caminhos().leads, BANCO_INICIAL, (d) => {
    const dados = normalizarBanco(d);
    saida = fn(dados);
    return saida === false ? undefined : dados;
  }, { backup: true });
  return saida;
}

/** Lista de leads a partir do banco, do mapa ou de uma lista. */
function listaLeads(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (objetoSimples(x.leads)) return Object.values(x.leads);
  return Object.values(x);
}

/** Id novo (uuid). */
function novoId() {
  return crypto.randomUUID();
}

/** Lead novo com todos os campos do contrato §3 (os informados por cima dos vazios). */
function modeloLead(campos = {}) {
  const iso = agora();
  const qualificacao = Object.fromEntries(CAMPOS_QUALIFICACAO.map((k) => [k, null]));
  const base = {
    id: novoId(), status: 'DISCOVERED', etapa: 'novo', origem: 'captador',
    telefone: null, whatsapp_confirmado: false, nome: null, empresa: null, instagram: null, instagram_url: null,
    site: null, dominio: null, cidade: null, estado: null, segmento: null, endereco: null, lat: null, lng: null,
    pesquisa: null, observacao_concreta: null, gancho: null, potencial_futuro: [], prospect_score: null,
    classificacao: null, data_confidence: null, score_reason: [], distancia_km_aprox: null,
    numero_whatsapp: null, nota_conversa: null, temperatura: null, qualificacao,
    historico: [], proximo_followup: null, followup_tipo: null, followups_feitos: 0,
    reuniao: { quando: null, link: null, confirmada: false }, notas_para_humano: '',
    humano: { ativo: false, motivo: null, desde: null, notificado_em: null, por: null },
    optout: false, abordado_em: null, ultimo_contato_em: null, ultima_mensagem_lead_em: null,
    criado_em: iso, atualizado_em: iso,
  };
  for (const [k, v] of Object.entries(campos)) if (v !== undefined) base[k] = v;
  return base;
}

/** Acha um lead por id, começo do id (6+ caracteres) ou telefone. */
function acharLead(dados, chave) {
  const leads = listaLeads(dados);
  const s = String(chave || '').trim();
  if (!s) return null;
  const direto = leads.find((l) => l.id === s);
  if (direto) return direto;
  const tel = normalizarTelefone(s);
  if (tel) {
    const porTel = leads.find((l) => l.telefone === tel.e164);
    if (porTel) return porTel;
  }
  if (s.length >= 6) {
    const prefixo = leads.filter((l) => String(l.id).startsWith(s));
    if (prefixo.length === 1) return prefixo[0];
  }
  return null;
}

// =============================================================================================
// Telefone e normalização
// =============================================================================================

/**
 * Normaliza telefone brasileiro para E.164. Aceita "11 90000-0001", "5511900000001", "+55 (11) 9 0000-0001",
 * "011 90000-0001", "0 15 11 90000-0001" (0 + operadora). Devolve {e164, tipo: 'celular'|'fixo', ddd, numero,
 * nono_digito_incluido} ou null se inválido. Celular = DDD + 9 dígitos começando com 9; um celular antigo de
 * 8 dígitos (6-9) ganha o 9 na frente. Fixo = DDD + 8 dígitos começando com 2-5.
 */
function normalizarTelefone(s) {
  if (s === undefined || s === null) return null;
  const bruto = String(s).trim();
  if (!bruto) return null;
  if (/[a-zA-Z]/.test(bruto.replace(/^tel:/i, ''))) return null;
  const mais = bruto.startsWith('+');
  let d = bruto.replace(/\D/g, '');
  if (!d) return null;
  let nacional;
  if (mais) {
    if (!d.startsWith('55')) return null; // só Brasil
    nacional = d.slice(2);
  } else if (d.startsWith('00')) {
    d = d.replace(/^00/, '');
    if (!d.startsWith('55')) return null;
    nacional = d.slice(2);
  } else if (d.startsWith('0')) {
    d = d.slice(1);
    if (d.length === 12 || d.length === 13) nacional = d.slice(2); // 0 + operadora + DDD + número
    else nacional = d;
  } else if ((d.length === 12 || d.length === 13) && d.startsWith('55')) {
    nacional = d.slice(2);
  } else {
    nacional = d;
  }
  if (nacional.length !== 10 && nacional.length !== 11) return null;
  const ddd = Number(nacional.slice(0, 2));
  if (!DDDS.has(ddd)) return null;
  let numero = nacional.slice(2);
  let tipo;
  let nono = false;
  if (numero.length === 9) {
    if (numero[0] !== '9') return null;
    tipo = 'celular';
  } else if (/^[2-5]/.test(numero)) {
    tipo = 'fixo';
  } else if (/^[6-9]/.test(numero)) {
    numero = `9${numero}`;
    tipo = 'celular';
    nono = true;
  } else {
    return null;
  }
  return { e164: `+55${ddd}${numero}`, tipo, ddd: String(ddd), numero, nono_digito_incluido: nono };
}

/** Só o E.164 (ou null). */
function telefoneE164(s) {
  const t = normalizarTelefone(s);
  return t ? t.e164 : null;
}

/** true se o E.164 é celular brasileiro (+55 DDD 9XXXXXXXX). */
function ehCelular(e164) {
  return typeof e164 === 'string' && /^\+55[1-9]{2}9\d{8}$/.test(e164) && DDDS.has(Number(e164.slice(3, 5)));
}

/** Nome para comparar: minúsculo, sem acento, sem "loja", "store", "ltda" e pontuação. */
function normalizarNome(s) {
  if (s === undefined || s === null) return '';
  return lib.tirarAcentos(String(s)).toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((p) => p && !['loja', 'lojas', 'store', 'ltda', 'me', 'eireli'].includes(p))
    .join(' ')
    .trim();
}

/** Cidade para comparar (sem acento, minúscula). */
function normalizarCidade(s) {
  if (s === undefined || s === null) return '';
  return lib.tirarAcentos(String(s)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Domínio de uma URL ("https://www.Loja.com.br/x" -> "loja.com.br"); null se inválido ou compartilhado (instagram, linktree...). */
function dominioDe(url) {
  if (url === undefined || url === null) return null;
  let s = String(url).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let host;
  try { host = new URL(s).hostname.toLowerCase(); } catch { return null; }
  host = host.replace(/^www\d?\./, '').replace(/\.$/, '');
  if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return null;
  for (const c of DOMINIOS_COMPARTILHADOS) if (host === c || host.endsWith(`.${c}`)) return null;
  return host;
}

const RESERVADOS_INSTAGRAM = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'tv', 'direct', 'about', 'developer', 'legal']);

/** "@handle" minúsculo a partir de "@Handle", "handle" ou URL do Instagram; null se inválido. */
function normalizarInstagram(s) {
  if (s === undefined || s === null) return null;
  let t = String(s).trim();
  if (!t) return null;
  const m = /instagram\.com\/([^?#]*)/i.exec(t);
  if (m) {
    const partes = m[1].split('/').filter(Boolean);
    if (!partes.length) return null;
    let i = 0;
    if (partes[0].toLowerCase() === 'stories' && partes[1]) i = 1;
    else if (RESERVADOS_INSTAGRAM.has(partes[0].toLowerCase())) return null;
    t = partes[i];
  }
  t = t.replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(t) || /^\.+$/.test(t)) return null;
  return `@${t}`;
}

// =============================================================================================
// Deduplicação
// =============================================================================================

/**
 * Procura um lead igual ao candidato, nesta ordem: instagram, domínio do site, telefone E.164, nome
 * normalizado (empresa ou nome) + cidade. Devolve {lead, chave} ou null.
 */
function acharDuplicado(leads, candidato) {
  const lista = listaLeads(leads);
  const c = candidato || {};
  const ig = normalizarInstagram(c.instagram || c.instagram_url);
  const dom = c.dominio ? dominioDe(c.dominio) : dominioDe(c.site);
  const tel = telefoneE164(c.telefone);
  const nome = normalizarNome(c.empresa || c.nome);
  const cidade = normalizarCidade(c.cidade);
  const regras = [
    ['instagram', ig, (l) => normalizarInstagram(l.instagram || l.instagram_url) === ig],
    ['dominio', dom, (l) => (l.dominio ? dominioDe(l.dominio) : dominioDe(l.site)) === dom],
    ['telefone', tel, (l) => telefoneE164(l.telefone) === tel],
    ['nome_cidade', nome && cidade ? `${nome}|${cidade}` : null,
      (l) => normalizarNome(l.empresa || l.nome) === nome && normalizarCidade(l.cidade) === cidade],
  ];
  for (const [chave, valor, igual] of regras) {
    if (!valor) continue;
    const achado = lista.find((l) => l && l.id !== c.id && igual(l));
    if (achado) return { lead: achado, chave };
  }
  return null;
}

/** Completa só os campos vazios do lead com os do candidato; devolve a lista de campos preenchidos. */
function completarVazios(lead, candidato, campos) {
  const preenchidos = [];
  for (const k of campos || Object.keys(candidato)) {
    const v = candidato[k];
    if (v === undefined || v === null || v === '') continue;
    const atual = lead[k];
    if (atual === undefined || atual === null || atual === '' || (Array.isArray(atual) && !atual.length)) {
      lead[k] = v;
      preenchidos.push(k);
    }
  }
  return preenchidos;
}

// =============================================================================================
// Opt-out (para sempre)
// =============================================================================================

const OPTOUT_INICIAL = { telefones: {}, instagram: {}, dominios: {} };

function normalizarOptout(o) {
  const r = objetoSimples(o) ? o : structuredClone(OPTOUT_INICIAL);
  for (const k of ['telefones', 'instagram', 'dominios']) if (!objetoSimples(r[k])) r[k] = {};
  return r;
}

/** Lê optout.json. */
function lerOptout() {
  return normalizarOptout(lib.lerJson(caminhos().optout, OPTOUT_INICIAL));
}

/** Motivo do bloqueio ("telefone", "instagram", "dominio") se algum dado estiver em opt-out; senão null. */
function emOptout(optout, { telefone, instagram, dominio, site } = {}) {
  const o = normalizarOptout(optout);
  const tel = telefoneE164(telefone);
  if (tel && o.telefones[tel]) return 'telefone';
  const ig = normalizarInstagram(instagram);
  if (ig && o.instagram[ig]) return 'instagram';
  const dom = dominio ? dominioDe(dominio) : dominioDe(site);
  if (dom && o.dominios[dom]) return 'dominio';
  return null;
}

/** Acrescenta ao optout.json (telefone, instagram e/ou domínio). Nunca remove. */
function adicionarOptout({ telefone, instagram, dominio, site, motivo, lead_id } = {}) {
  const tel = telefoneE164(telefone);
  const ig = normalizarInstagram(instagram);
  const dom = dominio ? dominioDe(dominio) : dominioDe(site);
  if (!tel && !ig && !dom) throw lib.erroArgs('opt-out sem telefone, instagram ou domínio válido');
  const registro = { quando: agora(), motivo: motivo || null, lead_id: lead_id || null };
  lib.atualizarJson(caminhos().optout, OPTOUT_INICIAL, (o) => {
    const r = normalizarOptout(o);
    if (tel && !r.telefones[tel]) r.telefones[tel] = { ...registro };
    if (ig && !r.instagram[ig]) r.instagram[ig] = { ...registro };
    if (dom && !r.dominios[dom]) r.dominios[dom] = { ...registro };
    return r;
  }, { backup: true });
  return { telefone: tel, instagram: ig, dominio: dom };
}

// =============================================================================================
// Chips
// =============================================================================================

const CHIPS_INICIAL = { chips: {} };

function normalizarChips(c) {
  const r = objetoSimples(c) ? c : structuredClone(CHIPS_INICIAL);
  if (!objetoSimples(r.chips)) r.chips = {};
  return r;
}

/** Lê chips.json. */
function lerChips() {
  return normalizarChips(lib.lerJson(caminhos().chips, CHIPS_INICIAL));
}

/** Ler-alterar-gravar chips.json com trava (devolver false não grava). */
function atualizarChips(fn) {
  let saida;
  lib.atualizarJson(caminhos().chips, CHIPS_INICIAL, (c) => {
    const dados = normalizarChips(c);
    saida = fn(dados);
    return saida === false ? undefined : dados;
  });
  return saida;
}

/** Status efetivo do chip: pausa vencida volta a "ativo". */
function statusEfetivoChip(chip, data = agoraData()) {
  if (!chip) return 'inativo';
  const st = STATUS_CHIP.includes(chip.status) ? chip.status : 'inativo';
  if (st === 'pausado') {
    const ate = lib.lerData(chip.pausado_ate);
    if (ate && ate.getTime() <= data.getTime()) return 'ativo';
  }
  return st;
}

/** Chips em uso agora (ativos e não pausados; pausa vencida conta como ativo): [{id, ...chip, status}]. */
function chipsAtivos(chipsDados, data = agoraData()) {
  const c = normalizarChips(chipsDados === undefined ? lerChips() : chipsDados);
  return Object.entries(c.chips)
    .map(([id, chip]) => ({ ...chip, id, status: statusEfetivoChip(chip, data) }))
    .filter((x) => x.status === 'ativo')
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Nome do portal do chip (chips.json ou "WhatsApp <id>"). */
function portalDoChip(chipsDados, id) {
  const c = normalizarChips(chipsDados);
  return (c.chips[id] && c.chips[id].portal) || `WhatsApp ${id}`;
}

// =============================================================================================
// Sinais da vigia
// =============================================================================================

/** Lê sinais.json ({chips:{id:{nao_lidas, titulo, url, conectado, visto_em, erro}}, atualizado_em}). */
function lerSinais() {
  const s = lib.lerJson(caminhos().sinais, { chips: {}, atualizado_em: null });
  if (!objetoSimples(s.chips)) s.chips = {};
  return s;
}

/** Sinal de um chip com idade: {nao_lidas, conectado, idade_s, fresco, erro}. Fresco = até 3 min. */
function sinalDoChip(sinais, id, data = agoraData()) {
  const s = sinais && sinais.chips ? sinais.chips[id] : null;
  if (!s) return { nao_lidas: null, conectado: null, idade_s: null, fresco: false, erro: null };
  const visto = lib.lerData(s.visto_em);
  const idade = visto ? Math.round((data.getTime() - visto.getTime()) / 1000) : null;
  const fresco = idade !== null && idade >= -60 && idade * 1000 <= SINAL_VALIDO_MS;
  return {
    nao_lidas: Number.isInteger(s.nao_lidas) ? s.nao_lidas : null,
    conectado: typeof s.conectado === 'boolean' ? s.conectado : null,
    idade_s: idade,
    fresco,
    erro: s.erro || null,
  };
}

// =============================================================================================
// Envios (envios.jsonl)
// =============================================================================================

/** Grava uma mensagem enviada em envios.jsonl. */
function registrarEnvio({ quando, chip, lead_id, telefone, tipo, texto } = {}) {
  if (!TIPOS_ENVIO.includes(tipo)) throw lib.erroArgs(`tipo de envio inválido: ${tipo} (use: ${TIPOS_ENVIO.join(', ')})`);
  const linha = { quando: quando || agora(), chip: chip || null, lead_id: lead_id || null, telefone: telefoneE164(telefone) || telefone || null, tipo, texto: texto || '' };
  lib.anexarJsonl(caminhos().envios, linha);
  return linha;
}

/** Envios do dia (São Paulo) por chip: {chip: {mensagens, abordagens (leads distintos), por_tipo}}. */
function enviosDoDia(data = agoraData(), linhas) {
  const dia = diaSP(data);
  const todos = linhas || lib.lerJsonl(caminhos().envios);
  const porChip = {};
  for (const e of todos) {
    const d = lib.lerData(e.quando);
    if (!d || diaSP(d) !== dia) continue;
    const id = e.chip || '(sem chip)';
    const c = porChip[id] || (porChip[id] = { mensagens: 0, abordagens: 0, por_tipo: {}, leads_abordados: new Set() });
    c.mensagens++;
    c.por_tipo[e.tipo] = (c.por_tipo[e.tipo] || 0) + 1;
    if (e.tipo === 'abordagem') c.leads_abordados.add(e.lead_id || e.telefone || `${c.mensagens}`);
  }
  for (const c of Object.values(porChip)) {
    c.abordagens = c.leads_abordados.size;
    delete c.leads_abordados;
  }
  return porChip;
}

// =============================================================================================
// Janelas
// =============================================================================================

/** true se a data (em São Paulo) cai na janela {dias, inicio, fim} (fim exclusivo). */
function janelaAberta(janela, data = agoraData()) {
  if (!janela || !Array.isArray(janela.dias)) return false;
  const p = lib.partesSP(data);
  const hhmm = `${p.hora}:${p.minuto}`;
  return janela.dias.includes(diaDaSemanaSP(data)) && hhmm >= janela.inicio && hhmm < janela.fim;
}

/** Janela que vale para cada tipo de envio (null = sem janela). */
function janelaDoTipo(operacao, tipo) {
  if (tipo === 'abordagem' || tipo === 'followup') return operacao.ritmo.janela_abordagem;
  if (tipo === 'aviso_humano') return null;
  return operacao.ritmo.janela_resposta;
}

// =============================================================================================
// Status e fila
// =============================================================================================

/** Status derivado da etapa (contrato §3). Com reunião marcada, passado_humano continua CONVERTED. */
function statusDaEtapa(etapa, lead) {
  switch (etapa) {
    case 'novo':
    case 'pesquisado': return 'READY_FOR_APPROACH';
    case 'abordado': return 'IN_APPROACH';
    case 'respondeu':
    case 'qualificando':
    case 'qualificado': return 'CONTACTED';
    case 'passado_humano': return lead && lead.reuniao && lead.reuniao.quando ? 'CONVERTED' : 'CONTACTED';
    case 'reuniao_marcada': return 'CONVERTED';
    case 'sem_resposta':
    case 'perdido':
    case 'desqualificado': return 'DISCARDED';
    default: return null;
  }
}

/** Temperatura pela nota: 0-39 frio, 40-69 morno, 70+ quente. */
function temperaturaDaNota(nota) {
  if (typeof nota !== 'number' || !Number.isFinite(nota)) return null;
  if (nota >= 70) return 'quente';
  if (nota >= 40) return 'morno';
  return 'frio';
}

function temScore(lead) {
  return typeof lead.prospect_score === 'number' && Number.isFinite(lead.prospect_score);
}

/** Faixa do lead na fila: "90+", "80-89", "70-79", "60-69", "sem_score" ou "<60". */
function faixaDoLead(lead) {
  if (!temScore(lead)) return 'sem_score';
  const s = lead.prospect_score;
  if (s >= 90) return '90+';
  if (s >= 80) return '80-89';
  if (s >= 70) return '70-79';
  if (s >= 60) return '60-69';
  return '<60';
}

/** Grupo de prioridade: >= 70, depois importados sem score, depois 60-69, depois o resto. */
function grupoDaFila(lead) {
  if (!temScore(lead)) return 1;
  if (lead.prospect_score >= 70) return 0;
  if (lead.prospect_score >= 60) return 2;
  return 3;
}

/** true se o lead pode entrar na fila de abordagem agora. */
function prontoParaAbordar(lead, optout) {
  if (!lead || lead.status !== 'READY_FOR_APPROACH') return false;
  if (lead.etapa && !ETAPAS_FILA.includes(lead.etapa)) return false;
  if (lead.optout || (lead.humano && lead.humano.ativo)) return false;
  if (!ehCelular(lead.telefone)) return false;
  if (optout && emOptout(optout, { telefone: lead.telefone, instagram: lead.instagram, dominio: lead.dominio, site: lead.site })) return false;
  return true;
}

/**
 * Fila do qualificador: READY_FOR_APPROACH, sem opt-out, com celular. Ordem: score >= 70, importados sem score,
 * 60-69, resto; dentro do grupo, score desc, data_confidence desc, distancia_km_aprox asc, criado_em asc.
 */
function filaOrdenada(leadsObj, { optout, apenasTelefones } = {}) {
  const filtroTel = apenasTelefones ? new Set(apenasTelefones.map(telefoneE164).filter(Boolean)) : null;
  const num = (v, padrao) => (typeof v === 'number' && Number.isFinite(v) ? v : padrao);
  return listaLeads(leadsObj)
    .filter((l) => prontoParaAbordar(l, optout) && (!filtroTel || filtroTel.has(l.telefone)))
    .sort((a, b) => (grupoDaFila(a) - grupoDaFila(b))
      || (num(b.prospect_score, -1) - num(a.prospect_score, -1))
      || (num(b.data_confidence, -1) - num(a.data_confidence, -1))
      || (num(a.distancia_km_aprox, Infinity) - num(b.distancia_km_aprox, Infinity))
      || String(a.criado_em || '').localeCompare(String(b.criado_em || ''))
      || String(a.id).localeCompare(String(b.id)));
}

/** Contagens da fila por faixa. */
function contagemPorFaixa(fila) {
  const r = { '90+': 0, '80-89': 0, '70-79': 0, '60-69': 0, sem_score: 0, '<60': 0, total: fila.length };
  for (const l of fila) r[faixaDoLead(l)]++;
  return r;
}

/**
 * Conta da fila do captador (03 §12), regra única de `captacao.js fila` e `gatilho.js captador`:
 * capacidade = chips ativos x limite_diario_por_chip; mínimo = capacidade x dias_minimos.
 * Com 0 chips ativos, a conta usa 1 chip como base (sem_chips: true).
 * Decisão: "rodar mais" abaixo do mínimo, "parar" acima do dobro, senão "ok".
 * Faixas acumuladas: 60+, 70+, 80+, 90+ (e sem_score, os importados).
 */
function contaDaFila({ operacao, chips, dados, optout, data = agoraData() } = {}) {
  const op = operacao || lerOperacao({ criar: false });
  const ativos = chipsAtivos(chips === undefined ? lerChips() : chips, data).length;
  const base = Math.max(1, ativos);
  const limite = op.ritmo.limite_diario_por_chip;
  const dias = op.fila.dias_minimos;
  const capacidade = base * limite;
  const minimo = capacidade * dias;
  const fila = filaOrdenada(dados === undefined ? lerLeads() : dados, { optout: optout === undefined ? lerOptout() : optout });
  const porFaixa = { '60+': 0, '70+': 0, '80+': 0, '90+': 0, sem_score: 0 };
  for (const l of fila) {
    if (!temScore(l)) { porFaixa.sem_score++; continue; }
    for (const f of [60, 70, 80, 90]) if (l.prospect_score >= f) porFaixa[`${f}+`]++;
  }
  const prontos = fila.length;
  return {
    chips_ativos: ativos,
    chips_base: base,
    sem_chips: ativos === 0,
    limite_diario_por_chip: limite,
    capacidade_diaria: capacidade,
    dias_minimos: dias,
    minimo,
    dobro: 2 * minimo,
    prontos,
    por_faixa: porFaixa,
    dias_de_fila: capacidade > 0 ? Math.round((prontos / capacidade) * 10) / 10 : null,
    decisao: prontos < minimo ? 'rodar mais' : (prontos > 2 * minimo ? 'parar' : 'ok'),
  };
}

/** Texto curto da conta: "1 chip(s) x 20 x 2 dias" ou "0 chips ativos, base de 1 chip x 20 x 2 dias". */
function textoContaDaFila(c) {
  const chips = c.sem_chips ? '0 chips ativos, base de 1 chip' : `${c.chips_ativos} chip(s)`;
  return `${chips} x ${c.limite_diario_por_chip} x ${c.dias_minimos} dias`;
}

// =============================================================================================
// Follow-up (02 §A4)
// =============================================================================================

const ETAPAS_SEM_FOLLOWUP = new Set(['novo', 'pesquisado', 'reuniao_marcada', 'passado_humano', 'sem_resposta', 'perdido', 'desqualificado']);

function ultimoDoHistorico(lead) {
  const h = Array.isArray(lead.historico) ? lead.historico : [];
  return h.length ? h[h.length - 1] : null;
}

/**
 * Próximo follow-up do lead: {quando (ISO), tipo, numero} ou null.
 *  - sem resposta: D+2, D+5, D+10 depois da abordagem; depois "encerrar" (move para sem_resposta) 2 dias após o último;
 *  - respondeu e parou: D+2 e D+6 depois da última mensagem do lead (ou da base da sequência);
 *  - "agora não": 21 dias depois da última mensagem do lead; depois segue como "parou de responder".
 * Sem follow-up quando a última mensagem é do lead (falta responder), em etapas finais, opt-out ou humano.
 */
function proximoFollowup(lead, operacao) {
  if (!lead || lead.optout || (lead.humano && lead.humano.ativo)) return null;
  const etapa = lead.etapa || 'novo';
  if (ETAPAS_SEM_FOLLOWUP.has(etapa)) return null;
  const ult = ultimoDoHistorico(lead);
  if (ult && ult.de === 'lead') return null;
  const fu = (operacao && operacao.followup) || padraoOperacao().followup;
  let seq = lead.followup_tipo;
  if (!TIPOS_FOLLOWUP.includes(seq)) seq = etapa === 'abordado' ? 'sem_resposta' : 'parou_de_responder';
  if (seq === 'encerrar') seq = 'sem_resposta';
  const n = Number.isInteger(lead.followups_feitos) && lead.followups_feitos > 0 ? lead.followups_feitos : 0;
  const quando = (base, dias) => lib.isoSP(somarDias(base, dias));
  if (seq === 'sem_resposta') {
    const base = lib.lerData(lead.followup_base) || lib.lerData(lead.abordado_em);
    if (!base) return null;
    const dias = fu.sem_resposta_dias;
    if (n < dias.length) return { quando: quando(base, dias[n]), tipo: 'sem_resposta', numero: n + 1 };
    return { quando: quando(base, dias[dias.length - 1] + DIAS_PARA_ENCERRAR), tipo: 'encerrar', numero: null };
  }
  if (seq === 'agora_nao') {
    const base = lib.lerData(lead.followup_base) || lib.lerData(lead.ultima_mensagem_lead_em) || lib.lerData(lead.ultimo_contato_em);
    if (!base) return null;
    if (n < 1) return { quando: quando(base, fu.agora_nao_dias), tipo: 'agora_nao', numero: 1 };
    return null;
  }
  const base = lib.lerData(lead.followup_base) || lib.lerData(lead.ultima_mensagem_lead_em) || lib.lerData(lead.ultimo_contato_em);
  if (!base) return null;
  const dias = fu.parou_de_responder_dias;
  if (n < dias.length) return { quando: quando(base, dias[n]), tipo: 'parou_de_responder', numero: n + 1 };
  return null;
}

/** Recalcula proximo_followup e followup_tipo do lead (muta). */
function recalcularFollowup(lead, operacao) {
  const p = proximoFollowup(lead, operacao);
  lead.proximo_followup = p ? p.quando : null;
  if (p) lead.followup_tipo = p.tipo;
  return p;
}

// =============================================================================================
// Agenda (02 §A5)
// =============================================================================================

function textoHorario(d) {
  const p = lib.partesSP(d);
  const min = p.minuto === '00' ? '' : p.minuto;
  return `${DIAS_SEMANA[diaDaSemanaSP(d)]}, ${p.dia}/${p.mes}, às ${Number(p.hora)}h${min}`;
}

/** Reuniões já marcadas no banco: lista de inícios (ms). */
function reunioesMarcadas(leads) {
  return listaLeads(leads)
    .filter((l) => l && l.reuniao && l.reuniao.quando && !ETAPAS_SAIDA.includes(l.etapa))
    .map((l) => lib.lerData(l.reuniao.quando))
    .filter(Boolean)
    .map((d) => d.getTime());
}

/**
 * Dois horários livres concretos (ou "quantidade"): dias úteis da agenda, entre inicio e fim, de preferência a
 * partir de preferencia_inicio, nos próximos dias_a_frente dias úteis (hoje conta, se útil), sem chocar com
 * reuniões do banco (duração + 10 min de folga), nunca no passado nem a menos de 2 h. Prefere dias diferentes.
 * Devolve [{quando, texto, dia}].
 */
function horariosLivres(operacao, leads, data = agoraData(), { quantidade = 2 } = {}) {
  const ag = (operacao && operacao.agenda) || padraoOperacao().agenda;
  const dur = ag.duracao_min;
  const bloco = (dur + FOLGA_REUNIAO_MIN) * 60e3;
  const reunioes = reunioesMarcadas(leads);
  const minimo = data.getTime() + ANTECEDENCIA_MIN_MS;
  const ini = minutosDe(ag.inicio);
  const fim = minutosDe(ag.fim);
  const pref = minutosDe(ag.preferencia_inicio || ag.inicio);
  const hoje = lib.partesSP(data);
  const base = Date.UTC(Number(hoje.ano), Number(hoje.mes) - 1, Number(hoje.dia));
  const livresDoDia = (y, m, d) => {
    const lista = [];
    for (let t = ini; t + dur <= fim; t += 30) {
      const hhmm = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      const quando = dataLocalSP(y, m, d, hhmm);
      const ms = quando.getTime();
      if (ms < minimo) continue;
      if (reunioes.some((r) => ms < r + bloco && r < ms + bloco)) continue;
      lista.push({ quando, preferido: t >= pref, minutos: t });
    }
    return lista;
  };
  // Tenta os dias_a_frente primeiro; se não achar o suficiente, estende até 10 dias úteis.
  for (const limiteUteis of [ag.dias_a_frente, Math.max(ag.dias_a_frente, 10)]) {
    const dias = [];
    let uteis = 0;
    for (let i = 0; i < 40 && uteis < limiteUteis; i++) {
      const u = new Date(base + i * 86400e3);
      if (!ag.dias_uteis.includes(u.getUTCDay())) continue;
      if ((ag.feriados || []).includes(u.toISOString().slice(0, 10))) continue;
      uteis++;
      dias.push(livresDoDia(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate()));
    }
    const escolhidos = [];
    const usado = (s) => escolhidos.some((e) => e.quando.getTime() === s.quando.getTime());
    const pega = (s) => { if (s && !usado(s) && escolhidos.length < quantidade) escolhidos.push(s); };
    // 1) primeiro horário preferido de cada dia, um por dia, variando a hora entre os dias
    for (const lista of dias) {
      if (escolhidos.length >= quantidade) break;
      const pre = lista.filter((s) => s.preferido);
      const outraHora = pre.find((s) => !escolhidos.some((e) => e.minutos === s.minutos));
      pega(outraHora || pre[0]);
    }
    // 2) outros preferidos; 3) não preferidos, do mais tarde para o mais cedo
    for (const lista of dias) for (const s of lista.filter((x) => x.preferido)) pega(s);
    for (const lista of dias) for (const s of lista.filter((x) => !x.preferido).reverse()) pega(s);
    if (escolhidos.length >= quantidade || limiteUteis >= 10) {
      return escolhidos
        .sort((a, b) => a.quando.getTime() - b.quando.getTime())
        .map((s) => ({ quando: lib.isoSP(s.quando), texto: textoHorario(s.quando), dia: DIAS_SEMANA[diaDaSemanaSP(s.quando)] }));
    }
  }
  return [];
}

// =============================================================================================
// Aviso ao humano
// =============================================================================================

/** Texto do aviso ao humano responsável (3 a 5 linhas curtas, sem emoji). */
function textoAvisoHumano(lead, chipsDados) {
  const empresa = lead.empresa || lead.nome || 'Lead sem nome';
  const nome = lead.nome && lead.nome !== empresa ? ` (${lead.nome})` : '';
  const chip = lead.numero_whatsapp || null;
  const portal = chip ? portalDoChip(chipsDados || { chips: {} }, chip) : null;
  const h = lead.humano || {};
  const etapa = h.etapa_anterior || lead.etapa || '?';
  const ultimaLead = (Array.isArray(lead.historico) ? lead.historico : []).filter((x) => x && x.de === 'lead').pop();
  const ultima = ultimaLead ? lib.truncar(String(ultimaLead.texto || '').replace(/\s+/g, ' ').trim(), 160) : '(o lead ainda não escreveu)';
  return [
    `Lead para você: ${empresa}${nome}, ${lead.telefone || 'sem telefone'}.`,
    `Chip ${chip || '(nenhum)'} · etapa ${etapa} · motivo: ${h.motivo || 'não informado'}.`,
    `Última mensagem do lead: "${ultima}"`,
    portal ? `Abra o portal ${portal} no Maestri e responda direto.` : 'Sem chip definido: responda pelo seu WhatsApp.',
  ].join('\n');
}

// =============================================================================================
// Ciclo do qualificador
// =============================================================================================

/** Lê tudo de que o ciclo precisa. */
function carregarContexto(data = agoraData(), { criarOperacao = true } = {}) {
  return {
    data,
    operacao: lerOperacao({ criar: criarOperacao }),
    dados: lerLeads(),
    chips: lerChips(),
    sinais: lerSinais(),
    optout: lerOptout(),
    envios: enviosDoDia(data),
  };
}

/** Telefones liberados no modo teste (numeros_teste + humano.whatsapp). null = modo teste desligado. */
function telefonesTeste(operacao) {
  if (!operacao.modo_teste) return null;
  const lista = [...(operacao.numeros_teste || []), operacao.humano && operacao.humano.whatsapp];
  return new Set(lista.map(telefoneE164).filter(Boolean));
}

/** Situação de cada chip agora (status efetivo, sinais, abordagens de hoje, se pode abordar). */
function situacaoDosChips(ctx) {
  const { data, operacao, chips, sinais, envios } = ctx;
  const limite = operacao.ritmo.limite_diario_por_chip;
  const janelaAbord = janelaAberta(operacao.ritmo.janela_abordagem, data);
  return Object.entries(chips.chips).sort((a, b) => a[0].localeCompare(b[0])).map(([id, chip]) => {
    const status = statusEfetivoChip(chip, data);
    const sinal = sinalDoChip(sinais, id, data);
    const hoje = envios[id] || { abordagens: 0, mensagens: 0 };
    const apos = lib.lerData(chip.proxima_abordagem_apos);
    let motivo = null;
    if (!operacao.qualificador.ativo) motivo = 'operação desligada';
    else if (status !== 'ativo') motivo = `chip ${status}`;
    else if (sinal.conectado === false) motivo = 'chip desconectado (sinal da vigia)';
    else if (sinal.fresco && sinal.erro && sinal.nao_lidas === null) motivo = `portal com erro na vigia: ${sinal.erro}`;
    else if (!janelaAbord) motivo = 'fora da janela de abordagem';
    else if (hoje.abordagens >= limite) motivo = 'limite diário atingido';
    else if (apos && apos.getTime() > data.getTime()) motivo = `intervalo: próxima abordagem após ${lib.horaBR(apos).slice(0, 5)}`;
    return {
      id,
      portal: chip.portal || `WhatsApp ${id}`,
      status,
      pausado_ate: chip.pausado_ate || null,
      nao_lidas: sinal.nao_lidas,
      sinal_idade_s: sinal.idade_s,
      sinal_fresco: sinal.fresco,
      conectado: sinal.conectado,
      erro_vigia: sinal.erro,
      abordagens_hoje: hoje.abordagens,
      mensagens_hoje: hoje.mensagens,
      limite,
      restante_hoje: Math.max(0, limite - hoje.abordagens),
      proxima_abordagem_apos: chip.proxima_abordagem_apos || null,
      pode_abordar_agora: motivo === null,
      motivo,
    };
  });
}

function chipUsavel(situacao) {
  return situacao && situacao.status === 'ativo' && situacao.conectado !== false;
}

/**
 * Monta a lista de trabalho do qualificador (puro: não grava nada).
 * Devolve {agora, operacao_ativa, modo_teste, janela, chips, responder, followups, encerrar, confirmacoes, abordar,
 * humano_pendente, fila_total, varredura_sugerida}.
 */
function montarCiclo(ctx) {
  const { data, operacao, dados, chips, optout } = ctx;
  const ativo = !!operacao.qualificador.ativo;
  const janela = {
    abordagem: janelaAberta(operacao.ritmo.janela_abordagem, data),
    resposta: janelaAberta(operacao.ritmo.janela_resposta, data),
  };
  const teste = telefonesTeste(operacao);
  const liberado = (l) => !teste || teste.has(l.telefone);
  const situacao = situacaoDosChips(ctx);
  const porId = Object.fromEntries(situacao.map((s) => [s.id, s]));
  const leads = listaLeads(dados);
  const agoraMs = data.getTime();

  const responder = janela.resposta
    ? situacao.filter((s) => s.sinal_fresco && s.nao_lidas > 0 && s.status !== 'inativo')
      .map((s) => ({ chip: s.id, portal: s.portal, nao_lidas: s.nao_lidas, sinal_idade_s: s.sinal_idade_s }))
    : [];

  const followups = [];
  const encerrar = [];
  for (const l of leads) {
    if (!l.proximo_followup || l.optout || (l.humano && l.humano.ativo) || ETAPAS_SEM_FOLLOWUP.has(l.etapa)) continue;
    const q = lib.lerData(l.proximo_followup);
    if (!q || q.getTime() > agoraMs) continue;
    if (l.followup_tipo === 'encerrar') { encerrar.push({ lead_id: l.id, empresa: l.empresa || null }); continue; }
    if (!janela.abordagem || !liberado(l)) continue;
    if (optout && emOptout(optout, { telefone: l.telefone })) continue;
    if (!chipUsavel(porId[l.numero_whatsapp])) continue;
    followups.push({
      lead_id: l.id, empresa: l.empresa || null, nome: l.nome || null, telefone: l.telefone, chip: l.numero_whatsapp,
      portal: porId[l.numero_whatsapp].portal, tipo: l.followup_tipo || null,
      numero: (Number.isInteger(l.followups_feitos) ? l.followups_feitos : 0) + 1, vencido_desde: l.proximo_followup,
    });
  }

  const confirmacoes = [];
  if (janela.resposta) {
    for (const l of leads) {
      if (l.etapa !== 'reuniao_marcada' || !l.reuniao || !l.reuniao.quando || l.reuniao.confirmacao_enviada_em) continue;
      if ((l.humano && l.humano.ativo) || l.optout || !liberado(l)) continue;
      if (optout && emOptout(optout, { telefone: l.telefone })) continue;
      const q = lib.lerData(l.reuniao.quando);
      if (!q || diaSP(q) !== diaSP(data)) continue;
      const falta = q.getTime() - agoraMs;
      if (falta <= 0 || falta > 2 * 3600e3) continue;
      if (!chipUsavel(porId[l.numero_whatsapp])) continue;
      confirmacoes.push({ lead_id: l.id, empresa: l.empresa || null, telefone: l.telefone, chip: l.numero_whatsapp, reuniao: l.reuniao.quando, link: l.reuniao.link || null });
    }
  }

  // Abordagens: no máximo 1 por chip; lead novo vai para o chip com mais capacidade restante hoje.
  const abordar = [];
  const fila = filaOrdenada(dados, { optout }).filter(liberado);
  if (ativo && janela.abordagem) {
    const livres = situacao.filter((s) => s.pode_abordar_agora);
    const usados = new Set();
    for (const l of fila) {
      if (usados.size >= livres.length) break;
      let candidatos = livres.filter((s) => !usados.has(s.id));
      if (l.numero_whatsapp) candidatos = candidatos.filter((s) => s.id === l.numero_whatsapp);
      if (!candidatos.length) continue;
      candidatos.sort((a, b) => (b.restante_hoje - a.restante_hoje) || a.id.localeCompare(b.id));
      const chip = candidatos[0];
      usados.add(chip.id);
      abordar.push({
        chip: chip.id, portal: chip.portal, lead_id: l.id, empresa: l.empresa || null, nome: l.nome || null,
        telefone: l.telefone, cidade: l.cidade || null, gancho: l.gancho || null,
        observacao_concreta: l.observacao_concreta || null, prospect_score: temScore(l) ? l.prospect_score : null,
        faixa: faixaDoLead(l), precisa_pesquisar: !l.pesquisa,
      });
    }
  }

  const humanoPendente = leads
    .filter((l) => l.humano && l.humano.ativo && !l.humano.notificado_em)
    .map((l) => ({ lead_id: l.id, empresa: l.empresa || null, motivo: l.humano.motivo || null, para: operacao.humano.whatsapp, aviso: textoAvisoHumano(l, chips) }));

  return {
    agora: lib.isoSP(data),
    operacao_ativa: ativo,
    modo_teste: !!operacao.modo_teste,
    janela,
    chips: situacao,
    responder,
    followups,
    encerrar,
    confirmacoes,
    abordar,
    humano_pendente: humanoPendente,
    fila_total: fila.length,
    varredura_sugerida: situacao.some((s) => s.status !== 'inativo' && !s.sinal_fresco),
  };
}

module.exports = {
  // constantes
  ETAPAS, ETAPAS_SAIDA, ETAPAS_FILA, ETAPAS_CONVERSA, STATUS, TEMPERATURAS, TIPOS_ENVIO, TIPOS_FOLLOWUP, STATUS_CHIP,
  CAMPOS_QUALIFICACAO, SINAL_VALIDO_MS, DIAS_PARA_ENCERRAR, DIAS_SEMANA, erroRecusa,
  // caminhos e datas
  caminhos, agora, agoraData, somarDias, diaDaSemanaSP, diaSP, dataLocalSP,
  // operação
  padraoOperacao, mesclarPadroes, lerOperacao, atualizarOperacao,
  // banco
  lerLeads, atualizarLeads, listaLeads, novoId, modeloLead, acharLead,
  // normalização
  normalizarTelefone, telefoneE164, ehCelular, normalizarNome, normalizarCidade, dominioDe, normalizarInstagram,
  acharDuplicado, completarVazios,
  // opt-out
  lerOptout, emOptout, adicionarOptout,
  // chips e sinais
  lerChips, atualizarChips, statusEfetivoChip, chipsAtivos, portalDoChip, lerSinais, sinalDoChip,
  // envios e janelas
  registrarEnvio, enviosDoDia, janelaAberta, janelaDoTipo,
  // status e fila
  statusDaEtapa, temperaturaDaNota, faixaDoLead, prontoParaAbordar, filaOrdenada, contagemPorFaixa,
  contaDaFila, textoContaDaFila,
  // follow-up e agenda
  proximoFollowup, recalcularFollowup, horariosLivres, textoHorario,
  // ciclo
  textoAvisoHumano, carregarContexto, telefonesTeste, situacaoDosChips, montarCiclo,
};
