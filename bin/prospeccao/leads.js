#!/usr/bin/env node
'use strict';
// leads · banco único da prospecção (estado/prospeccao/leads.json). Regra: conhecimento/prospeccao/contrato.md §3 e §5.
// Subcomandos: importar, listar, mostrar, fila, ciclo, pode-enviar, registrar, humano, humano-notificado, devolver,
// optout, digitar, horarios. Códigos de saída: 0 ok · 1 sem trabalho ou recusado por regra · 2 uso errado · 3 trava esgotada.
const fs = require('fs');
const path = require('path');
const lib = require('../lib_maestro');
const P = require('./lib_prospeccao');

const CMD = `node ${lib.barras(path.join(__dirname, 'leads.js'))}`;
const CAMPOS_REGISTRAR = ['lead_id', 'chip', 'tipo', 'recebidas', 'enviadas', 'etapa', 'nota_conversa', 'temperatura',
  'qualificacao', 'proximo_followup', 'followup_tipo', 'notas_para_humano', 'reuniao', 'optout', 'motivo_saida', 'pesquisa'];
const TIPOS_REGISTRAR = ['abordagem', 'followup', 'resposta', 'confirmacao'];
const MAX_LINHAS_PESQUISA = 5; // o mesmo limite do captacao.js

const AJUDA = `leads · banco único da prospecção (estado/prospeccao/leads.json)

Forma canônica: ${CMD} <subcomando> [opções]
Saída para agente: use --json. Entrada estruturada: --json-arquivo <caminho> ou --json - (stdin).

SUBCOMANDOS
  importar <arquivo.csv|.json> [--teste] [--origem X] [--json]
      CSV com cabeçalho (separador , ou ;) ou JSON (lista ou {leads:[...]}). Campos: telefone (obrigatório),
      nome, empresa, instagram, site, cidade, segmento, origem. Normaliza para E.164, deduplica (instagram,
      domínio, telefone, nome+cidade; duplicado só completa campos vazios), ignora opt-out e fixo, e entra em
      READY_FOR_APPROACH. --teste: origem "teste" e os telefones vão para numeros_teste.
  listar [--status S] [--etapa E] [--chip C] [--json]
  mostrar <id|telefone> [--json]
  fila [--json]                 fila de abordagem ordenada, com contagem por faixa
  ciclo [--json]                lista de trabalho do qualificador agora (move para sem_resposta quem esgotou os follow-ups)
  pode-enviar --telefone +55... --tipo T [--chip C] [--json]
      T: abordagem | followup | resposta | confirmacao | aviso_humano. Sai 0 se pode; 1 com o motivo.
  registrar --json-arquivo f.json | --json -
      Aplica o resultado de uma interação. Campos: ${CAMPOS_REGISTRAR.join(', ')}.
      tipo (opcional): ${TIPOS_REGISTRAR.join(' | ')}; sem ele, é deduzido. Registre UMA vez depois de mandar
      todas as mensagens da vez. Recusa (saída 1) se o lead está com o humano.
      pesquisa (até ${MAX_LINHAS_PESQUISA} linhas, só fatos): grava só se o lead ainda não tem pesquisa (lead importado);
      a do Captador nunca é sobrescrita (a saída diz "gravada" ou "ignorada").
  humano --lead <id> --motivo "..." [--por agente|painel] [--json]
      Passa o lead ao humano responsável (passado_humano) e imprime o aviso pronto.
  humano-notificado --lead <id> [--chip C]     marca o aviso como enviado (com --chip, grava o envio)
  devolver --lead <id> [--etapa E]            tira o lead das mãos humanas e devolve ao agente
  optout --telefone +55... [--motivo "..."]   opt-out para sempre
  digitar                                     espera digitacao_min_s a digitacao_max_s segundos (pausa entre mensagens)
  horarios [--json]                           dois horários livres concretos para reunião

EXEMPLOS
  ${CMD} importar C:/dados/leads.csv --teste
  ${CMD} ciclo --json
  ${CMD} pode-enviar --telefone +5511900000001 --tipo abordagem --chip chip-01
  ${CMD} registrar --json-arquivo C:/Temp/interacao.json
`;

// ---------------------------------------------------------------------------------- utilidades

function imprimirJson(o) {
  lib.escrever(JSON.stringify(o, null, 2));
}

function lerEntradaJson(op) {
  if (op['json-arquivo'] !== undefined) return lib.lerJsonDeArquivo(op['json-arquivo']);
  if (op.json === '-') return lib.lerJsonDoStdin();
  if (typeof op.json === 'string' && op.json.trim().startsWith('{')) return lib.lerObjetoJson(op.json, '--json');
  throw lib.erroArgs('falta a entrada: --json-arquivo <caminho> ou --json - (stdin)');
}

function exigirLead(dados, chave) {
  if (!lib.textoPreenchido(chave)) throw lib.erroArgs('falta --lead <id>');
  const lead = P.acharLead(dados, chave);
  if (!lead) throw lib.erroArgs(`lead não encontrado: ${chave}`);
  return lead;
}

function linhaLead(l) {
  const score = typeof l.prospect_score === 'number' ? String(l.prospect_score).padStart(3) : '  -';
  return `${String(l.id).slice(0, 8)}  ${String(l.status || '-').padEnd(18)} ${String(l.etapa || '-').padEnd(15)} ${score}  ${l.empresa || l.nome || '(sem nome)'} · ${l.telefone || '-'}${l.numero_whatsapp ? ` · ${l.numero_whatsapp}` : ''}${l.cidade ? ` · ${l.cidade}` : ''}`;
}

// ---------------------------------------------------------------------------------- importar

/** Parser de CSV (aspas duplas com "" de escape; separador dado). */
function lerCsv(texto, sep) {
  const linhas = [];
  let campo = '';
  let linha = [];
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') aspas = true;
    else if (c === sep) { linha.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      linha.push(campo); campo = '';
      if (linha.some((x) => x.trim() !== '')) linhas.push(linha);
      linha = [];
    } else campo += c;
  }
  linha.push(campo);
  if (linha.some((x) => x.trim() !== '')) linhas.push(linha);
  return linhas;
}

const ALIASES = {
  telefone: 'telefone', whatsapp: 'telefone', celular: 'telefone', fone: 'telefone', phone: 'telefone', tel: 'telefone',
  nome: 'nome', contato: 'nome', empresa: 'empresa', loja: 'empresa', instagram: 'instagram', insta: 'instagram',
  site: 'site', website: 'site', url: 'site', cidade: 'cidade', municipio: 'cidade', segmento: 'segmento', origem: 'origem',
};

function nomeColuna(c) {
  const k = lib.tirarAcentos(String(c)).trim().toLowerCase().replace(/\s+/g, '_');
  return ALIASES[k] || k;
}

/** Linhas do arquivo de importação: [{linha, dados}]. */
function lerArquivoImportacao(arquivo) {
  let buf;
  try { buf = fs.readFileSync(arquivo); } catch (e) { throw lib.erroArgs(`não consegui ler ${arquivo}: ${e.code || e.message}`); }
  const texto = lib.decodificarTexto(buf);
  const t = texto.trim();
  if (/\.json$/i.test(arquivo) || t.startsWith('[') || t.startsWith('{')) {
    let o;
    try { o = JSON.parse(t); } catch (e) { throw lib.erroArgs(`JSON inválido em ${arquivo}: ${e.message}`); }
    const lista = Array.isArray(o) ? o : (o && Array.isArray(o.leads) ? o.leads : null);
    if (!lista) throw lib.erroArgs('o JSON precisa ser uma lista de leads ou {"leads": [...]}');
    return lista.map((x, i) => {
      const dados = {};
      if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) dados[nomeColuna(k)] = v;
      return { linha: i + 1, dados };
    });
  }
  const primeira = t.split(/\r?\n/)[0] || '';
  const sep = (primeira.match(/;/g) || []).length > (primeira.match(/,/g) || []).length ? ';' : ',';
  const linhas = lerCsv(t, sep);
  if (!linhas.length) throw lib.erroArgs(`${arquivo} está vazio`);
  const cab = linhas[0].map(nomeColuna);
  if (!cab.includes('telefone')) throw lib.erroArgs(`o CSV precisa da coluna "telefone" (cabeçalho lido: ${linhas[0].join(sep)})`);
  return linhas.slice(1).map((cols, i) => {
    const dados = {};
    cab.forEach((k, j) => { if (cols[j] !== undefined && String(cols[j]).trim() !== '') dados[k] = String(cols[j]).trim(); });
    return { linha: i + 2, dados };
  });
}

function textoOuNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
}

function cmdImportar(argv) {
  const { op, pos } = lib.lerArgumentos(argv, { texto: ['origem'], bool: ['teste', 'json'] }, { maxPosicionais: 1 });
  if (!pos[0]) throw lib.erroArgs('falta o arquivo: importar <arquivo.csv|.json>');
  const linhas = lerArquivoImportacao(pos[0]);
  const optout = P.lerOptout();
  const origem = op.origem || (op.teste ? 'teste' : 'importado');
  const res = { novos: [], completados: [], ignorados: [] };
  const telefonesTeste = [];
  P.atualizarLeads((dados) => {
    for (const { linha, dados: d } of linhas) {
      const tel = P.normalizarTelefone(d.telefone);
      if (!tel) { res.ignorados.push({ linha, telefone: d.telefone || null, motivo: 'telefone inválido' }); continue; }
      if (tel.tipo !== 'celular') { res.ignorados.push({ linha, telefone: tel.e164, motivo: 'telefone fixo (não serve para WhatsApp)' }); continue; }
      const igTexto = textoOuNull(d.instagram);
      const site = textoOuNull(d.site);
      const cand = {
        telefone: tel.e164,
        nome: textoOuNull(d.nome),
        empresa: textoOuNull(d.empresa),
        instagram: P.normalizarInstagram(igTexto),
        instagram_url: igTexto && /instagram\.com/i.test(igTexto) ? igTexto : null,
        site,
        dominio: P.dominioDe(site),
        cidade: textoOuNull(d.cidade),
        segmento: textoOuNull(d.segmento),
      };
      const bloqueio = P.emOptout(optout, cand);
      if (bloqueio) { res.ignorados.push({ linha, telefone: tel.e164, motivo: `opt-out (${bloqueio})` }); continue; }
      if (op.teste) telefonesTeste.push(tel.e164);
      const dup = P.acharDuplicado(dados, cand);
      if (dup) {
        const campos = P.completarVazios(dup.lead, cand, Object.keys(cand));
        if (campos.length) {
          dup.lead.atualizado_em = P.agora();
          res.completados.push({ linha, lead_id: dup.lead.id, chave: dup.chave, campos });
        } else res.ignorados.push({ linha, telefone: tel.e164, motivo: `duplicado (${dup.chave})`, lead_id: dup.lead.id });
        continue;
      }
      const lead = P.modeloLead({ ...cand, status: 'READY_FOR_APPROACH', etapa: 'novo', origem, origem_detalhe: textoOuNull(d.origem) });
      dados.leads[lead.id] = lead;
      res.novos.push({ linha, lead_id: lead.id, telefone: lead.telefone, empresa: lead.empresa });
    }
    return res.novos.length || res.completados.length ? true : false;
  });
  let adicionadosTeste = [];
  if (telefonesTeste.length) {
    adicionadosTeste = P.atualizarOperacao((o) => {
      const atuais = new Set((o.numeros_teste || []).map(P.telefoneE164).filter(Boolean));
      const novos = [...new Set(telefonesTeste)].filter((t) => !atuais.has(t));
      if (!novos.length) return false;
      o.numeros_teste = [...(o.numeros_teste || []), ...novos];
      return novos;
    }) || [];
  }
  const saida = { novos: res.novos.length, completados: res.completados.length, ignorados: res.ignorados.length, numeros_teste_adicionados: adicionadosTeste, detalhes: res };
  if (op.json) return imprimirJson(saida);
  lib.escrever(`Importação: ${saida.novos} novos, ${saida.completados} completados, ${saida.ignorados} ignorados.`);
  for (const x of res.ignorados) lib.escrever(`  linha ${x.linha}: ${x.motivo}${x.telefone ? ` (${x.telefone})` : ''}`);
  if (adicionadosTeste.length) lib.escrever(`numeros_teste: +${adicionadosTeste.join(', ')}`);
}

// ---------------------------------------------------------------------------------- listar, mostrar, fila

function cmdListar(argv) {
  const { op } = lib.lerArgumentos(argv, { texto: ['status', 'etapa', 'chip'], bool: ['json'] });
  let leads = P.listaLeads(P.lerLeads());
  if (op.status) leads = leads.filter((l) => l.status === op.status.toUpperCase());
  if (op.etapa) leads = leads.filter((l) => l.etapa === op.etapa);
  if (op.chip) leads = leads.filter((l) => l.numero_whatsapp === op.chip);
  leads.sort((a, b) => String(b.atualizado_em || '').localeCompare(String(a.atualizado_em || '')));
  if (op.json) return imprimirJson({ total: leads.length, leads });
  if (!leads.length) return lib.escrever('Nenhum lead.');
  for (const l of leads) lib.escrever(linhaLead(l));
  lib.escrever(`${leads.length} lead(s).`);
}

function cmdMostrar(argv) {
  const { op, pos } = lib.lerArgumentos(argv, { bool: ['json'] }, { maxPosicionais: 1 });
  if (!pos[0]) throw lib.erroArgs('falta o id ou telefone: mostrar <id|telefone>');
  const lead = P.acharLead(P.lerLeads(), pos[0]);
  if (!lead) throw lib.erroArgs(`lead não encontrado: ${pos[0]}`);
  if (op.json) return imprimirJson(lead);
  lib.escrever(linhaLead(lead));
  lib.escrever(`id: ${lead.id}`);
  for (const k of ['origem', 'instagram', 'site', 'segmento', 'gancho', 'classificacao', 'data_confidence', 'nota_conversa', 'temperatura', 'proximo_followup', 'followup_tipo']) {
    if (lead[k] !== null && lead[k] !== undefined && lead[k] !== '') lib.escrever(`${k}: ${lead[k]}`);
  }
  if (lead.pesquisa) lib.escrever(`pesquisa: ${lead.pesquisa}`);
  if (lead.reuniao && lead.reuniao.quando) lib.escrever(`reunião: ${lead.reuniao.quando}${lead.reuniao.link ? ` · ${lead.reuniao.link}` : ''}`);
  if (lead.humano && lead.humano.ativo) lib.escrever(`COM O HUMANO desde ${lead.humano.desde}: ${lead.humano.motivo || ''}`);
  const h = Array.isArray(lead.historico) ? lead.historico.slice(-10) : [];
  if (h.length) {
    lib.escrever('últimas mensagens:');
    for (const m of h) lib.escrever(`  ${m.quando} ${m.de}: ${lib.truncar(String(m.texto || '').replace(/\s+/g, ' '), 140)}`);
  }
}

function cmdFila(argv) {
  const { op } = lib.lerArgumentos(argv, { bool: ['json'] });
  const operacao = P.lerOperacao();
  const fila = P.filaOrdenada(P.lerLeads(), { optout: P.lerOptout() });
  const teste = P.telefonesTeste(operacao);
  const itens = fila.map((l, i) => ({
    posicao: i + 1, lead_id: l.id, empresa: l.empresa || l.nome || null, telefone: l.telefone, cidade: l.cidade || null,
    prospect_score: typeof l.prospect_score === 'number' ? l.prospect_score : null, data_confidence: l.data_confidence ?? null,
    distancia_km_aprox: l.distancia_km_aprox ?? null, faixa: P.faixaDoLead(l), origem: l.origem || null,
    liberado_no_teste: teste ? teste.has(l.telefone) : null,
  }));
  const saida = { total: fila.length, por_faixa: P.contagemPorFaixa(fila), modo_teste: !!operacao.modo_teste, liberados_no_teste: teste ? itens.filter((x) => x.liberado_no_teste).length : null, itens };
  if (op.json) return imprimirJson(saida);
  const f = saida.por_faixa;
  lib.escrever(`Fila: ${f.total} (90+: ${f['90+']} · 80-89: ${f['80-89']} · 70-79: ${f['70-79']} · sem score: ${f.sem_score} · 60-69: ${f['60-69']})${operacao.modo_teste ? ` · modo teste: ${saida.liberados_no_teste} liberado(s)` : ''}`);
  for (const x of itens.slice(0, 30)) lib.escrever(`${String(x.posicao).padStart(3)}. ${x.prospect_score ?? '  -'} ${x.empresa || '(sem nome)'} · ${x.telefone}${x.cidade ? ` · ${x.cidade}` : ''}`);
  if (itens.length > 30) lib.escrever(`... e mais ${itens.length - 30}`);
}

// ---------------------------------------------------------------------------------- ciclo

/** Move para sem_resposta os leads que esgotaram os follow-ups (tipo "encerrar" vencido). */
function aplicarEncerramentos(lista, data) {
  if (!lista.length) return [];
  const ids = new Set(lista.map((x) => x.lead_id));
  return P.atualizarLeads((dados) => {
    const feitos = [];
    for (const l of P.listaLeads(dados)) {
      if (!ids.has(l.id) || l.followup_tipo !== 'encerrar' || (l.humano && l.humano.ativo)) continue;
      const q = lib.lerData(l.proximo_followup);
      if (!q || q.getTime() > data.getTime()) continue;
      l.etapa = 'sem_resposta';
      l.status = P.statusDaEtapa('sem_resposta', l);
      l.discard_reason = 'sem resposta depois dos follow-ups';
      l.proximo_followup = null;
      l.followup_tipo = null;
      l.atualizado_em = P.agora();
      feitos.push({ lead_id: l.id, empresa: l.empresa || null });
    }
    return feitos.length ? feitos : false;
  }) || [];
}

function cmdCiclo(argv) {
  const { op } = lib.lerArgumentos(argv, { bool: ['json'] });
  const data = P.agoraData();
  const ctx = P.carregarContexto(data);
  const c = P.montarCiclo(ctx);
  c.encerrados = aplicarEncerramentos(c.encerrar, data);
  delete c.encerrar;
  if (op.json) return imprimirJson(c);
  lib.escrever(`Ciclo ${lib.dataHoraBR(data)} · operação ${c.operacao_ativa ? 'ligada' : 'DESLIGADA'}${c.modo_teste ? ' · modo teste' : ''} · janela abordagem ${c.janela.abordagem ? 'aberta' : 'fechada'}, resposta ${c.janela.resposta ? 'aberta' : 'fechada'}`);
  for (const s of c.chips) lib.escrever(`  ${s.id}: ${s.status} · não lidas ${s.nao_lidas ?? '?'}${s.sinal_fresco ? '' : ' (sem sinal recente)'} · abordagens ${s.abordagens_hoje}/${s.limite}${s.pode_abordar_agora ? ' · pode abordar' : ` · ${s.motivo}`}`);
  lib.escrever(`responder: ${c.responder.map((r) => `${r.chip} (${r.nao_lidas})`).join(', ') || '-'}`);
  lib.escrever(`follow-ups: ${c.followups.length} · confirmações: ${c.confirmacoes.length} · abordar: ${c.abordar.length} · humano pendente: ${c.humano_pendente.length} · fila: ${c.fila_total}`);
  for (const a of c.abordar) lib.escrever(`  abordar ${a.empresa || a.telefone} pelo ${a.chip}`);
  if (c.encerrados.length) lib.escrever(`movidos para sem_resposta: ${c.encerrados.length}`);
}

// ---------------------------------------------------------------------------------- pode-enviar

/** Confere se pode mandar mensagem agora: {pode, motivo, telefone, tipo, chip, lead_id}. */
function verificarEnvio(ctx, { telefone, tipo, chip }) {
  const { operacao, dados, chips, sinais, optout, envios, data } = ctx;
  if (!P.TIPOS_ENVIO.includes(tipo)) throw lib.erroArgs(`--tipo inválido: ${tipo} (use: ${P.TIPOS_ENVIO.join(', ')})`);
  const tel = P.telefoneE164(telefone);
  if (!tel) throw lib.erroArgs(`telefone inválido: ${telefone}`);
  const lead = P.listaLeads(dados).find((l) => l.telefone === tel) || null;
  const chipId = chip || (lead && lead.numero_whatsapp) || null;
  const r = (pode, motivo) => ({ pode, motivo, telefone: tel, tipo, chip: chipId, lead_id: lead ? lead.id : null });
  if (!operacao.qualificador.ativo) return r(false, 'operação do qualificador desligada');
  if (P.emOptout(optout, { telefone: tel }) || (lead && lead.optout)) return r(false, 'telefone em opt-out');
  if (lead && P.emOptout(optout, { instagram: lead.instagram, dominio: lead.dominio, site: lead.site })) return r(false, 'lead em opt-out (instagram ou site)');
  const teste = P.telefonesTeste(operacao);
  if (teste && !teste.has(tel)) return r(false, 'modo teste: telefone fora de numeros_teste');
  if (lead && lead.humano && lead.humano.ativo && tipo !== 'aviso_humano') return r(false, 'lead em mãos humanas');
  const janela = P.janelaDoTipo(operacao, tipo);
  if (janela && !P.janelaAberta(janela, data)) return r(false, `fora da janela de ${tipo === 'abordagem' || tipo === 'followup' ? 'abordagem' : 'resposta'}`);
  if (lead && lead.numero_whatsapp && chip && chip !== lead.numero_whatsapp) return r(false, `o lead pertence ao ${lead.numero_whatsapp}`);
  if (tipo === 'abordagem' && !chipId) throw lib.erroArgs('abordagem exige --chip');
  if (chipId) {
    const c = chips.chips[chipId];
    if (!c) return r(false, `chip ${chipId} não existe em chips.json`);
    const st = P.statusEfetivoChip(c, data);
    if (st !== 'ativo') return r(false, `chip ${st}`);
    if (P.sinalDoChip(sinais, chipId, data).conectado === false) return r(false, 'chip desconectado (sinal da vigia)');
    if (tipo === 'abordagem') {
      const hoje = (envios[chipId] || { abordagens: 0 }).abordagens;
      const abordadoHoje = lead && lead.abordado_em && lib.lerData(lead.abordado_em) && P.diaSP(lib.lerData(lead.abordado_em)) === P.diaSP(data);
      if (!abordadoHoje && hoje >= operacao.ritmo.limite_diario_por_chip) return r(false, `limite diário do ${chipId} atingido (${hoje})`);
      const apos = lib.lerData(c.proxima_abordagem_apos);
      if (!abordadoHoje && apos && apos.getTime() > data.getTime()) return r(false, `intervalo entre abordagens: ${chipId} só depois de ${lib.horaBR(apos).slice(0, 5)}`);
    }
  }
  return r(true, null);
}

function cmdPodeEnviar(argv) {
  const { op } = lib.lerArgumentos(argv, { texto: ['telefone', 'tipo', 'chip'], bool: ['json'] });
  if (!op.telefone) throw lib.erroArgs('falta --telefone +55...');
  if (!op.tipo) throw lib.erroArgs(`falta --tipo (${P.TIPOS_ENVIO.join(', ')})`);
  const data = P.agoraData();
  const r = verificarEnvio(P.carregarContexto(data), { telefone: op.telefone, tipo: op.tipo, chip: op.chip });
  if (op.json) imprimirJson(r);
  else lib.escrever(r.pode ? 'pode enviar' : `não pode: ${r.motivo}`);
  if (!r.pode) process.exitCode = 1;
}

// ---------------------------------------------------------------------------------- registrar

function validarRegistro(e) {
  const p = [];
  const iso = (v) => v === null || !!lib.lerData(v);
  for (const k of Object.keys(e)) if (!CAMPOS_REGISTRAR.includes(k)) p.push(`campo desconhecido "${k}" (aceitos: ${CAMPOS_REGISTRAR.join(', ')})`);
  if (!lib.textoPreenchido(e.lead_id)) p.push('falta "lead_id"');
  if (e.chip !== undefined && e.chip !== null && !lib.textoPreenchido(e.chip)) p.push('"chip" deve ser texto (ex.: chip-01)');
  if (e.tipo !== undefined && !TIPOS_REGISTRAR.includes(e.tipo)) p.push(`"tipo" inválido (use: ${TIPOS_REGISTRAR.join(', ')})`);
  if (e.recebidas !== undefined) {
    if (!Array.isArray(e.recebidas)) p.push('"recebidas" deve ser uma lista');
    else e.recebidas.forEach((r, i) => {
      if (typeof r === 'string') return;
      if (!r || typeof r !== 'object' || typeof r.texto !== 'string') p.push(`recebidas[${i}] deve ser texto ou {texto, quando?}`);
      else if (r.quando !== undefined && r.quando !== null && !lib.lerData(r.quando)) p.push(`recebidas[${i}].quando inválido (ISO com fuso)`);
    });
  }
  if (e.enviadas !== undefined && (!Array.isArray(e.enviadas) || e.enviadas.some((x) => !lib.textoPreenchido(x)))) p.push('"enviadas" deve ser uma lista de textos não vazios');
  if (e.etapa !== undefined && !P.ETAPAS.includes(e.etapa)) p.push(`"etapa" inválida (use: ${P.ETAPAS.join(', ')})`);
  if (e.nota_conversa !== undefined && e.nota_conversa !== null
    && !(typeof e.nota_conversa === 'number' && Number.isFinite(e.nota_conversa) && e.nota_conversa >= 0 && e.nota_conversa <= 100)) p.push('"nota_conversa" deve ser um número de 0 a 100');
  if (e.temperatura !== undefined && e.temperatura !== null && !P.TEMPERATURAS.includes(e.temperatura)) p.push(`"temperatura" inválida (use: ${P.TEMPERATURAS.join(', ')})`);
  if (e.qualificacao !== undefined) {
    if (!e.qualificacao || typeof e.qualificacao !== 'object' || Array.isArray(e.qualificacao)) p.push('"qualificacao" deve ser um objeto');
    else for (const k of Object.keys(e.qualificacao)) if (!P.CAMPOS_QUALIFICACAO.includes(k)) p.push(`qualificacao.${k} desconhecido (aceitos: ${P.CAMPOS_QUALIFICACAO.join(', ')})`);
  }
  if (e.proximo_followup !== undefined && !iso(e.proximo_followup)) p.push('"proximo_followup" deve ser ISO com fuso ou null');
  if (e.followup_tipo !== undefined && e.followup_tipo !== null && !['sem_resposta', 'parou_de_responder', 'agora_nao'].includes(e.followup_tipo)) p.push('"followup_tipo" inválido (use: sem_resposta, parou_de_responder, agora_nao)');
  if (e.notas_para_humano !== undefined && e.notas_para_humano !== null && typeof e.notas_para_humano !== 'string') p.push('"notas_para_humano" deve ser texto');
  if (e.reuniao !== undefined && e.reuniao !== null) {
    if (typeof e.reuniao !== 'object' || Array.isArray(e.reuniao)) p.push('"reuniao" deve ser {quando, link}');
    else {
      if (e.reuniao.quando !== undefined && !iso(e.reuniao.quando)) p.push('reuniao.quando deve ser ISO com fuso');
      if (e.reuniao.link !== undefined && e.reuniao.link !== null && typeof e.reuniao.link !== 'string') p.push('reuniao.link deve ser texto');
      if (e.reuniao.confirmada !== undefined && typeof e.reuniao.confirmada !== 'boolean') p.push('reuniao.confirmada deve ser true ou false');
    }
  }
  if (e.optout !== undefined && typeof e.optout !== 'boolean') p.push('"optout" deve ser true ou false');
  if (e.motivo_saida !== undefined && e.motivo_saida !== null && typeof e.motivo_saida !== 'string') p.push('"motivo_saida" deve ser texto');
  if (e.pesquisa !== undefined && e.pesquisa !== null) {
    if (typeof e.pesquisa !== 'string') p.push('"pesquisa" deve ser texto');
    else {
      const linhas = e.pesquisa.split(/\r?\n/).filter((l) => l.trim()).length;
      if (linhas > MAX_LINHAS_PESQUISA) p.push(`"pesquisa" tem ${linhas} linhas; o máximo é ${MAX_LINHAS_PESQUISA}, só com fatos observados`);
    }
  }
  return p;
}

/** Deduz o tipo do envio quando não vem. */
function deduzirTipo(lead, recebidas, data) {
  if (!lead.abordado_em && P.ETAPAS_FILA.includes(lead.etapa || 'novo')) return 'abordagem';
  if (recebidas.length) return 'resposta';
  const q = lib.lerData(lead.proximo_followup);
  if (q && q.getTime() <= data.getTime()) return 'followup';
  return 'resposta';
}

/** Aplica o registro ao lead (dentro da trava). Devolve o que precisa ser feito depois (envios, chip, opt-out). */
function aplicarRegistro(lead, e, { operacao, chips, data, optout }) {
  if (lead.humano && lead.humano.ativo) throw P.erroRecusa(`o lead ${lead.id} está com o humano (${lead.humano.motivo || 'sem motivo'}); use "devolver" antes`);
  if (lead.numero_whatsapp && e.chip && e.chip !== lead.numero_whatsapp) throw P.erroRecusa(`o lead pertence ao ${lead.numero_whatsapp} (veio ${e.chip})`);
  // Mensagem enviada a quem não podia receber: recusa e avisa (o pode-enviar deveria ter barrado antes).
  if ((e.enviadas || []).length) {
    if (lead.optout || (optout && P.emOptout(optout, { telefone: lead.telefone, instagram: lead.instagram, dominio: lead.dominio, site: lead.site }))) {
      throw P.erroRecusa(`o lead ${lead.id} está em opt-out: nenhuma mensagem pode ir para ele (nada foi gravado; avise o Cérebro)`);
    }
    const teste = P.telefonesTeste(operacao);
    if (teste && !teste.has(lead.telefone)) throw P.erroRecusa(`modo teste: ${lead.telefone} está fora de numeros_teste (nada foi gravado; avise o Cérebro)`);
  }
  const iso = lib.isoSP(data);
  const recebidas = (e.recebidas || []).map((r) => (typeof r === 'string' ? { texto: r, quando: null } : r));
  const enviadas = e.enviadas || [];
  const chip = e.chip || lead.numero_whatsapp || null;
  if (enviadas.length && !chip) throw lib.erroArgs('falta "chip" (o lead ainda não tem chip)');
  if (enviadas.length && !chips.chips[chip]) throw lib.erroArgs(`chip ${chip} não existe em chips.json`);
  const etapaAntes = lead.etapa || 'novo';
  const tipo = e.tipo || deduzirTipo(lead, recebidas, data);
  if (!Array.isArray(lead.historico)) lead.historico = [];

  // Mensagens recebidas e enviadas
  let ultimaLead = null;
  for (const r of recebidas) {
    const q = lib.lerData(r.quando) || data;
    lead.historico.push({ quando: lib.isoSP(q), de: 'lead', texto: r.texto, chip });
    if (!ultimaLead || q.getTime() > ultimaLead.getTime()) ultimaLead = q;
  }
  for (const t of enviadas) lead.historico.push({ quando: iso, de: 'agente', texto: t, chip });
  if (ultimaLead) {
    lead.ultima_mensagem_lead_em = lib.isoSP(ultimaLead);
    lead.followup_tipo = 'parou_de_responder';
    lead.followups_feitos = 0;
    lead.followup_base = lead.ultima_mensagem_lead_em;
  }
  if (recebidas.length || enviadas.length) lead.ultimo_contato_em = iso;
  let marcarIntervalo = false;
  if (enviadas.length) {
    if (!lead.numero_whatsapp) lead.numero_whatsapp = chip;
    if (tipo === 'abordagem') {
      if (!lead.abordado_em) {
        lead.abordado_em = iso;
        lead.followup_tipo = 'sem_resposta';
        lead.followups_feitos = 0;
        lead.followup_base = iso;
      }
      marcarIntervalo = true;
    } else if (tipo === 'followup') {
      if (lead.followup_tipo === 'agora_nao') {
        lead.followup_tipo = 'parou_de_responder';
        lead.followups_feitos = 0;
        lead.followup_base = iso;
      } else lead.followups_feitos = (Number.isInteger(lead.followups_feitos) ? lead.followups_feitos : 0) + 1;
    } else if (tipo === 'confirmacao' && lead.reuniao) {
      lead.reuniao.confirmacao_enviada_em = iso;
    }
  }

  // Campos da conversa
  if (e.nota_conversa !== undefined && e.nota_conversa !== null) {
    lead.nota_conversa = Math.round(e.nota_conversa);
    lead.temperatura = e.temperatura || P.temperaturaDaNota(lead.nota_conversa);
  } else if (e.temperatura) lead.temperatura = e.temperatura;
  if (e.qualificacao) lead.qualificacao = { ...(lead.qualificacao || {}), ...e.qualificacao };
  if (e.notas_para_humano !== undefined) lead.notas_para_humano = e.notas_para_humano || '';
  // Pesquisa do qualificador: só preenche lead sem pesquisa (importado); a do Captador fica.
  let pesquisa = null;
  if (typeof e.pesquisa === 'string' && e.pesquisa.trim()) {
    if (typeof lead.pesquisa === 'string' && lead.pesquisa.trim()) pesquisa = 'ignorada: o lead já tem pesquisa';
    else {
      lead.pesquisa = e.pesquisa.trim();
      pesquisa = 'gravada';
    }
  }
  if (e.reuniao) {
    const antes = lead.reuniao && lead.reuniao.quando;
    lead.reuniao = { quando: null, link: null, confirmada: false, ...(lead.reuniao || {}), ...e.reuniao };
    if (lead.reuniao.quando) lead.reuniao.quando = lib.isoSP(lib.lerData(lead.reuniao.quando));
    if (antes !== lead.reuniao.quando) delete lead.reuniao.confirmacao_enviada_em;
  }
  if (e.followup_tipo) {
    lead.followup_tipo = e.followup_tipo;
    lead.followups_feitos = 0;
    lead.followup_base = e.followup_tipo === 'sem_resposta' ? (lead.abordado_em || iso) : (lead.ultima_mensagem_lead_em || iso);
  }

  // Etapa e status
  let etapa = e.etapa;
  if (!etapa) {
    if (e.optout) etapa = 'perdido';
    else if (e.reuniao && e.reuniao.quando && !['reuniao_marcada', 'passado_humano'].includes(etapaAntes)) etapa = 'reuniao_marcada';
    else if (recebidas.length && P.ETAPAS_FILA.concat(['abordado']).includes(etapaAntes)) etapa = 'respondeu';
    else if (tipo === 'abordagem' && enviadas.length && P.ETAPAS_FILA.includes(etapaAntes)) etapa = 'abordado';
    else etapa = etapaAntes;
  }
  lead.etapa = etapa;
  lead.status = P.statusDaEtapa(etapa, lead);
  let precisaOptout = false;
  if (e.optout) {
    lead.optout = true;
    precisaOptout = true;
  }
  let aviso = null;
  if (P.ETAPAS_SAIDA.includes(etapa)) {
    lead.discard_reason = e.motivo_saida || lead.discard_reason || (e.optout ? 'pediu para parar' : etapa);
    lead.proximo_followup = null;
  } else if (etapa === 'passado_humano') {
    lead.humano = { ativo: true, motivo: e.motivo_saida || 'passado pelo agente', desde: iso, notificado_em: null, por: 'agente', etapa_anterior: etapaAntes };
    lead.proximo_followup = null;
    aviso = P.textoAvisoHumano(lead, chips);
  } else if (e.proximo_followup !== undefined) {
    lead.proximo_followup = e.proximo_followup ? lib.isoSP(lib.lerData(e.proximo_followup)) : null;
  } else {
    P.recalcularFollowup(lead, operacao);
  }
  lead.atualizado_em = iso;
  return { tipo, chip, enviadas, marcarIntervalo, precisaOptout, aviso, iso, pesquisa };
}

function cmdRegistrar(argv) {
  const { op } = lib.lerArgumentos(argv, { texto: ['json-arquivo', 'json'] });
  const e = lerEntradaJson(op);
  const problemas = validarRegistro(e);
  if (problemas.length) throw lib.erroValidacao(problemas, 'Registro inválido, nada foi gravado');
  const data = P.agoraData();
  const operacao = P.lerOperacao();
  const chips = P.lerChips();
  const optout = P.lerOptout();
  let lead;
  let r;
  P.atualizarLeads((dados) => {
    lead = P.acharLead(dados, e.lead_id);
    if (!lead) throw lib.erroArgs(`lead não encontrado: ${e.lead_id}`);
    r = aplicarRegistro(lead, e, { operacao, chips, data, optout });
    return true;
  });
  for (const texto of r.enviadas) P.registrarEnvio({ quando: r.iso, chip: r.chip, lead_id: lead.id, telefone: lead.telefone, tipo: r.tipo, texto });
  let proxima = null;
  if (r.marcarIntervalo) {
    const { intervalo_min_minutos: min, intervalo_max_minutos: max } = operacao.ritmo;
    const minutos = min + Math.random() * Math.max(0, max - min);
    proxima = lib.isoSP(new Date(data.getTime() + minutos * 60e3));
    P.atualizarChips((c) => { if (!c.chips[r.chip]) return false; c.chips[r.chip].proxima_abordagem_apos = proxima; return true; });
  }
  if (r.precisaOptout) {
    P.adicionarOptout({ telefone: lead.telefone, instagram: lead.instagram, dominio: lead.dominio, site: lead.site, motivo: e.motivo_saida || 'pediu para parar', lead_id: lead.id });
  }
  imprimirJson({
    ok: true, lead_id: lead.id, etapa: lead.etapa, status: lead.status, nota_conversa: lead.nota_conversa ?? null,
    temperatura: lead.temperatura ?? null, proximo_followup: lead.proximo_followup ?? null, followup_tipo: lead.followup_tipo ?? null,
    tipo_envio: r.enviadas.length ? r.tipo : null, envios: r.enviadas.length, proxima_abordagem_apos: proxima,
    optout: !!lead.optout, aviso_humano: r.aviso, pesquisa: r.pesquisa,
  });
}

// ---------------------------------------------------------------------------------- humano, devolver, optout

function cmdHumano(argv) {
  const { op } = lib.lerArgumentos(argv, { texto: ['lead', 'motivo', 'por'], bool: ['json'] });
  if (!lib.textoPreenchido(op.motivo)) throw lib.erroArgs('falta --motivo "..."');
  const por = op.por || 'agente';
  if (!['agente', 'painel'].includes(por)) throw lib.erroArgs('--por aceita agente ou painel');
  const chips = P.lerChips();
  const operacao = P.lerOperacao();
  const iso = P.agora();
  let aviso;
  let id;
  P.atualizarLeads((dados) => {
    const lead = exigirLead(dados, op.lead);
    id = lead.id;
    const jaAtivo = lead.humano && lead.humano.ativo;
    lead.humano = {
      ativo: true, motivo: op.motivo.trim(), desde: jaAtivo ? lead.humano.desde : iso, notificado_em: null, por,
      etapa_anterior: jaAtivo ? lead.humano.etapa_anterior : (lead.etapa || 'novo'),
    };
    lead.etapa = 'passado_humano';
    lead.status = P.statusDaEtapa('passado_humano', lead);
    lead.proximo_followup = null;
    lead.atualizado_em = iso;
    aviso = P.textoAvisoHumano(lead, chips);
    return true;
  });
  if (op.json) return imprimirJson({ ok: true, lead_id: id, para: operacao.humano.whatsapp, aviso });
  lib.escrever(aviso);
}

function cmdHumanoNotificado(argv) {
  const { op } = lib.lerArgumentos(argv, { texto: ['lead', 'chip'], bool: ['json'] });
  const operacao = P.lerOperacao();
  const chips = P.lerChips();
  const iso = P.agora();
  let lead;
  let aviso;
  P.atualizarLeads((dados) => {
    lead = exigirLead(dados, op.lead);
    if (!lead.humano || !lead.humano.ativo) throw P.erroRecusa(`o lead ${lead.id} não está com o humano`);
    lead.humano.notificado_em = iso;
    lead.atualizado_em = iso;
    aviso = P.textoAvisoHumano(lead, chips);
    return true;
  });
  if (op.chip) P.registrarEnvio({ quando: iso, chip: op.chip, lead_id: lead.id, telefone: operacao.humano.whatsapp, tipo: 'aviso_humano', texto: aviso });
  if (op.json) return imprimirJson({ ok: true, lead_id: lead.id, notificado_em: iso });
  lib.escrever(`aviso marcado como enviado (${lead.empresa || lead.id})`);
}

function cmdDevolver(argv) {
  const { op } = lib.lerArgumentos(argv, { texto: ['lead', 'etapa'], bool: ['json'] });
  if (op.etapa && !P.ETAPAS.includes(op.etapa)) throw lib.erroArgs(`--etapa inválida (use: ${P.ETAPAS.join(', ')})`);
  const operacao = P.lerOperacao();
  const iso = P.agora();
  let lead;
  P.atualizarLeads((dados) => {
    lead = exigirLead(dados, op.lead);
    if (!lead.humano || !lead.humano.ativo) throw P.erroRecusa(`o lead ${lead.id} não está com o humano`);
    let etapa = op.etapa || lead.humano.etapa_anterior || 'qualificando';
    if (etapa === 'passado_humano') etapa = 'qualificando';
    lead.humano = { ...lead.humano, ativo: false, devolvido_em: iso };
    lead.etapa = etapa;
    lead.status = P.statusDaEtapa(etapa, lead);
    P.recalcularFollowup(lead, operacao);
    lead.atualizado_em = iso;
    return true;
  });
  if (op.json) return imprimirJson({ ok: true, lead_id: lead.id, etapa: lead.etapa, status: lead.status, proximo_followup: lead.proximo_followup });
  lib.escrever(`lead devolvido ao agente: ${lead.empresa || lead.id} (etapa ${lead.etapa})`);
}

function cmdOptout(argv) {
  const { op } = lib.lerArgumentos(argv, { texto: ['telefone', 'motivo'], bool: ['json'] });
  const tel = P.telefoneE164(op.telefone);
  if (!tel) throw lib.erroArgs(`--telefone inválido: ${op.telefone || '(vazio)'}`);
  const motivo = op.motivo || 'pediu para não ser contatado';
  const iso = P.agora();
  const afetados = P.atualizarLeads((dados) => {
    const ids = [];
    for (const l of P.listaLeads(dados)) {
      if (l.telefone !== tel) continue;
      l.optout = true;
      if (!P.ETAPAS_SAIDA.includes(l.etapa)) l.etapa = 'perdido';
      l.status = P.statusDaEtapa(l.etapa, l);
      l.discard_reason = l.discard_reason || 'opt-out';
      l.proximo_followup = null;
      l.atualizado_em = iso;
      ids.push(l.id);
    }
    return ids.length ? ids : false;
  }) || [];
  const lead = afetados.length ? P.acharLead(P.lerLeads(), afetados[0]) : null;
  P.adicionarOptout({ telefone: tel, instagram: lead && lead.instagram, dominio: lead && lead.dominio, site: lead && lead.site, motivo, lead_id: lead ? lead.id : null });
  if (op.json) return imprimirJson({ ok: true, telefone: tel, leads: afetados });
  lib.escrever(`opt-out gravado: ${tel}${afetados.length ? ` (${afetados.length} lead(s) marcados como perdido)` : ''}`);
}

// ---------------------------------------------------------------------------------- digitar, horarios

function cmdDigitar(argv) {
  lib.lerArgumentos(argv, {});
  const { digitacao_min_s: min, digitacao_max_s: max } = P.lerOperacao().ritmo;
  const s = min + Math.random() * Math.max(0, max - min);
  lib.dormir(s * 1000);
  lib.escrever(`esperou ${s.toFixed(1)} s`);
}

function cmdHorarios(argv) {
  const { op } = lib.lerArgumentos(argv, { bool: ['json'] });
  const h = P.horariosLivres(P.lerOperacao(), P.lerLeads(), P.agoraData());
  if (op.json) imprimirJson({ horarios: h });
  else if (!h.length) lib.escrever('Nenhum horário livre na agenda.');
  else h.forEach((x, i) => lib.escrever(`${i + 1}) ${x.texto} (${x.quando})`));
  if (h.length < 2) process.exitCode = 1;
}

// ---------------------------------------------------------------------------------- principal

const SUBCOMANDOS = {
  importar: cmdImportar,
  listar: cmdListar,
  mostrar: cmdMostrar,
  fila: cmdFila,
  ciclo: cmdCiclo,
  'pode-enviar': cmdPodeEnviar,
  registrar: cmdRegistrar,
  humano: cmdHumano,
  'humano-notificado': cmdHumanoNotificado,
  devolver: cmdDevolver,
  optout: cmdOptout,
  digitar: cmdDigitar,
  horarios: cmdHorarios,
};

function principal() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.some((a) => a === '--help' || a === '-h') || ['ajuda', 'help'].includes(argv[0])) {
    lib.escrever(AJUDA);
    if (!argv.length) process.exitCode = 2;
    return;
  }
  const sub = SUBCOMANDOS[argv[0]];
  if (!sub) throw lib.erroArgs(`subcomando desconhecido: ${argv[0]} (use: ${Object.keys(SUBCOMANDOS).join(', ')}; veja --help)`);
  sub(argv.slice(1));
}

if (require.main === module) lib.executarComando(principal);

module.exports = { lerCsv, lerArquivoImportacao, verificarEnvio, validarRegistro, aplicarRegistro, deduzirTipo };
