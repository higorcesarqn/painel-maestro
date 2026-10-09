// Log (§11.4): cartões com o número de cada resultado (clicar filtra a tabela), filtros em duas faixas
// (busca com atalho "/", período, tipo, agentes e projetos), filtros ativos à vista e a tabela de 50 por
// página (rola por dentro do cartão). Clique ou Enter numa linha abre o modal; ← → no modal seguem a
// ordem desta tabela filtrada. Os números vêm de "contagens" do /api/eventos; sem elas (servidor antigo),
// saem da própria página quando ela tem o conjunto inteiro, e viram "—" quando não dá para saber.
import '../estilo/log.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import { usePainel, novoFiltro } from '../dados/contexto.js';
import { POR_PAGINA } from '../dados/api.js';
import { objs, obj, txt, numero, plural, data, hora, diaMes, diaSP, cabecalhoDia } from '../dados/formato.js';
import { TIPOS, RESULTADOS, RESULTADOS_FALHA, RESULTADOS_DONO, precisaDono, infoAgente, projetosConhecidos, corDoFluxo, urlDoCartao } from '../dados/dominio.js';
import { parametrosLog, listaFiltro, alternarFiltro } from '../dados/consultas.js';
import { Cartao, Selo, Ponto, Quadrado, Vazio, Segmentado, InfoDica } from '../componentes/base.jsx';
import { Selecao, CampoData, Alternador } from '../componentes/campos.jsx';
import { Agente, Projeto, Resultado, LinkTrello } from '../componentes/dominio.jsx';
import { Icone, X, Search, ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight, ScrollText } from '../componentes/Icone.jsx';

const PERIODOS = [
  { id: 'hoje', nome: 'Hoje' }, { id: '24h', nome: '24 h' }, { id: '7d', nome: '7 dias' },
  { id: '30d', nome: '30 dias' }, { id: 'todos', nome: 'Tudo' }, { id: 'personalizado', nome: 'Intervalo' },
];
// Cartões na ordem: o que andou, o que espera e o que deu errado. Rótulo curto para caber numa linha.
const ORDEM_RES = ['ok', 'em-andamento', 'aguardando-dono', 'parcial', 'bloqueado', 'falhou'];
const ROTULO_CURTO = { 'aguardando-dono': 'Aguardando' };
const NENHUMA = { resultado: null, agente: null, projeto: null, tipo: null, precisa: null };
const somaDe = (grupo) => Object.values(grupo).reduce((a, b) => a + (Number(b) || 0), 0);

/** Números do conjunto filtrado: os do servidor; sem eles, os da página quando ela tem tudo (e a faceta não tem filtro próprio). */
function contagensDe(r, eventos, f) {
  if (!r) return NENHUMA;
  const c = obj(r.contagens);
  if (c) {
    return {
      resultado: obj(c.resultado) || {}, agente: obj(c.agente) || {}, projeto: obj(c.projeto) || {}, tipo: obj(c.tipo) || {},
      precisa: typeof c.precisa_dono === 'number' ? c.precisa_dono : null,
    };
  }
  if ((r.total || 0) > eventos.length) return NENHUMA;
  const g = { resultado: Object.create(null), agente: Object.create(null), projeto: Object.create(null), tipo: Object.create(null) };
  const somar = (o, k) => { if (typeof k === 'string' && k) o[k] = (o[k] || 0) + 1; };
  let precisa = 0;
  for (const e of eventos) {
    somar(g.resultado, e.resultado); somar(g.agente, e.agente); somar(g.tipo, e.tipo);
    somar(g.projeto, e.projeto === null || e.projeto === undefined ? '' : String(e.projeto).toUpperCase());
    if (precisaDono(e)) precisa += 1;
  }
  return {
    resultado: listaFiltro(f.resultado).length ? null : g.resultado,
    agente: listaFiltro(f.agente).length ? null : g.agente,
    projeto: listaFiltro(f.projeto).length ? null : g.projeto,
    tipo: f.tipo ? null : g.tipo,
    precisa: f.so_dono ? null : precisa,
  };
}

export function Log() {
  const { estado, filtros: f, setFiltros, pagina, setPagina, log, abrirModal, modal } = usePainel();
  // busca com espera de 300 ms (o campo responde na hora); "/" foca a busca e Esc limpa
  const [q, setQ] = useState(f.q);
  const espera = useRef(null);
  const buscaRef = useRef(null);
  const modalRef = useRef(modal);
  modalRef.current = modal;
  useEffect(() => { setQ(f.q); }, [f.q]);
  useEffect(() => () => clearTimeout(espera.current), []);
  const digitar = (v) => { setQ(v); clearTimeout(espera.current); espera.current = setTimeout(() => setFiltros({ q: v }), 300); };
  const limparBusca = () => { clearTimeout(espera.current); setQ(''); setFiltros({ q: '' }); };
  useEffect(() => {
    const tecla = (ev) => {
      if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey || modalRef.current) return;
      const alvo = ev.target;
      if (alvo && (alvo.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(alvo.tagName))) return;
      ev.preventDefault();
      if (buscaRef.current) { buscaRef.current.focus(); buscaRef.current.select(); }
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, []);

  const r = log.resposta;
  const eventos = objs(r && r.eventos);
  const paginas = r ? r.paginas || Math.max(1, Math.ceil((r.total || 0) / (r.por_pagina || POR_PAGINA))) : 1;
  const ids = eventos.map((e) => e.id);
  const contexto = () => {
    const sp = parametrosLog(f, pagina);
    sp.delete('pagina');
    return { params: sp.toString(), pagina: (r && r.pagina) || pagina, paginas, filtrado: [...sp.keys()].some((k) => k !== 'por_pagina') };
  };
  const filtrando = JSON.stringify({ ...f, q }) !== JSON.stringify(novoFiltro());
  const cont = contagensDe(r, eventos, f);

  // Resultado: cartões (um de cada vez; clicar no ativo tira o filtro)
  const selRes = listaFiltro(f.resultado);
  const totalGeral = cont.resultado ? somaDe(cont.resultado) : !selRes.length && r ? r.total || 0 : null;
  const valorRes = (k) => (cont.resultado ? cont.resultado[k] || 0 : selRes.length === 1 && selRes[0] === k && r ? r.total || 0 : null);
  const clicarRes = (k) => setFiltros({ resultado: selRes.length === 1 && selRes[0] === k ? '' : k });

  // Agentes: os do registro, depois os que aparecem no log; nome curto quando a primeira palavra já distingue
  const selAg = listaFiltro(f.agente);
  const agentes = [];
  const vistos = new Set();
  const incluirAgente = (slug) => { if (slug && !vistos.has(slug)) { vistos.add(slug); agentes.push(infoAgente(estado, slug)); } };
  for (const a of objs(estado && estado.agentes)) incluirAgente(a.slug);
  if (cont.agente) for (const k of Object.keys(cont.agente)) incluirAgente(k);
  for (const s of selAg) incluirAgente(s);
  const primeiras = agentes.map((a) => String(a.nome).split(/\s+/)[0]);
  const nomesCurtos = new Set(primeiras).size === primeiras.length;

  // Projetos: os do quadro (ou do manual), mais os que aparecem no log
  const selPr = listaFiltro(f.projeto).map((x) => x.toUpperCase());
  const projetos = new Map(projetosConhecidos(estado));
  const incluirProjeto = (k) => { if (k && !projetos.has(k)) projetos.set(k, { prefixo: k, nome: k, cor: null }); };
  if (cont.projeto) for (const k of Object.keys(cont.projeto)) incluirProjeto(k);
  for (const s of selPr) incluirProjeto(s);

  // Tipo: um de cada vez, com a contagem de cada um
  const tipos = Object.entries(TIPOS);
  const extras = new Set([...(cont.tipo ? Object.keys(cont.tipo) : []), ...(f.tipo ? [f.tipo] : [])]);
  for (const k of extras) if (!TIPOS[k]) tipos.push([k, k]);
  const opcoesTipo = [['', 'Todos os tipos'], ...tipos.map(([k, n]) => [k, cont.tipo ? `${n} · ${numero(cont.tipo[k] || 0)}` : n])];

  // Filtros sem lugar fixo na tela (fluxo, busca, tipo, resultado): à vista, cada um com x para tirar
  const ativos = [];
  if (f.fluxo) {
    ativos.push(
      <FiltroAtivo key="fluxo" rotuloTirar={`Tirar o filtro do fluxo ${f.fluxo}`} aoTirar={() => setFiltros({ fluxo: '' })}>
        <Ponto cor={corDoFluxo(f.fluxo)} /><span class="t mono">Fluxo {f.fluxo}</span>
      </FiltroAtivo>,
    );
  }
  for (const k of selRes) {
    const nome = RESULTADOS[k] ? RESULTADOS[k].rotulo : k;
    ativos.push(
      <FiltroAtivo key={`res-${k}`} rotuloTirar={`Tirar o filtro de resultado ${nome}`} aoTirar={() => setFiltros({ resultado: alternarFiltro(f.resultado, k) })}>
        <span class="t">Resultado: {nome}</span>
      </FiltroAtivo>,
    );
  }
  if (f.tipo) {
    ativos.push(
      <FiltroAtivo key="tipo" rotuloTirar="Tirar o filtro de tipo" aoTirar={() => setFiltros({ tipo: '' })}>
        <span class="t">Tipo: {TIPOS[f.tipo] || f.tipo}</span>
      </FiltroAtivo>,
    );
  }
  if (f.q.trim()) {
    ativos.push(
      <FiltroAtivo key="q" rotuloTirar="Limpar a busca" aoTirar={limparBusca}>
        <span class="t">Busca: “{f.q.trim()}”</span>
      </FiltroAtivo>,
    );
  }

  const linhas = [];
  let diaAnterior = null;
  for (const e of eventos) {
    const dia = diaSP(e.ts);
    if (dia !== diaAnterior) {
      linhas.push(<tr class="dia" key={`dia-${dia}`}><td colSpan={8}>{e.ts ? cabecalhoDia(e.ts) : 'Sem data'}</td></tr>);
      diaAnterior = dia;
    }
    linhas.push(<LinhaLog key={e.id || e.ts} e={e} abrir={() => e.id && abrirModal(e.id, ids, contexto())} />);
  }

  return (
    <div class="tela tela-log">
      <div class={`log-kpis${selRes.length ? ' filtrando' : ''}`} role="group" aria-label="Eventos por resultado: clique para filtrar a tabela">
        <CartaoStatus rotulo="Eventos" valor={totalGeral} ativo={!selRes.length} aoClicar={() => setFiltros({ resultado: '' })}
          titulo="Mostrar todos os resultados"
          info="Quantos eventos os filtros de baixo deixam passar. Clique num status para ver só ele na tabela; clique de novo (ou aqui) para voltar a todos."
          barra={<Distribuicao grupo={cont.resultado} total={totalGeral} />} />
        {ORDEM_RES.map((k) => (
          <CartaoStatus key={k} rotulo={ROTULO_CURTO[k] || RESULTADOS[k].rotulo} titulo={`Filtrar: ${RESULTADOS[k].rotulo}`} cor={RESULTADOS[k].cor}
            valor={valorRes(k)} total={totalGeral} ativo={selRes.includes(k)} aoClicar={() => clicarRes(k)} />
        ))}
      </div>

      <div class="cartao log-filtros">
        <div class="log-linha">
          <span class={`busca log-busca${q ? ' cheia' : ''}`}>
            <Icone de={Search} tamanho={15} />
            <input ref={buscaRef} type="search" value={q} placeholder="Buscar no resumo, na direção, no cartão ou no fluxo"
              aria-label="Buscar no log (atalho: /)"
              onInput={(e) => digitar(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                if (q) { e.preventDefault(); limparBusca(); } else e.currentTarget.blur();
              }} />
            <kbd class="atalho" aria-hidden="true" title="Atalho: /">/</kbd>
          </span>
          <Segmentado opcoes={PERIODOS} valor={f.periodo} rotulo="Período" aoMudar={(v) => setFiltros({ periodo: v })} />
          {f.periodo === 'personalizado' && (
            <span class="log-datas">
              <CampoData valor={f.desde} rotuloAria="Desde" aoMudar={(v) => setFiltros({ desde: v })} />
              <span class="ate">até</span>
              <CampoData valor={f.ate} rotuloAria="Até" aoMudar={(v) => setFiltros({ ate: v })} />
            </span>
          )}
          <Selecao valor={f.tipo} opcoes={opcoesTipo} rotuloAria="Tipo de evento" aoMudar={(v) => setFiltros({ tipo: v })} largura={196} />
        </div>
        <div class="log-linha">
          <div class="log-grupo agentes">
            <span class="rot">Agentes</span>
            <div class="chips" role="group" aria-label="Agentes (vários ao mesmo tempo)">
              {agentes.map((a, i) => (
                <Chip key={a.slug} marcado={selAg.includes(a.slug)} n={cont.agente ? cont.agente[a.slug] || 0 : null} titulo={a.nome}
                  aoClicar={() => setFiltros({ agente: alternarFiltro(f.agente, a.slug) })}>
                  <Ponto cor={a.cor} /><span>{nomesCurtos ? primeiras[i] : a.nome}</span>
                </Chip>
              ))}
            </div>
          </div>
          <span class="log-sep" aria-hidden="true" />
          <div class="log-grupo">
            <span class="rot">Projetos</span>
            <div class="chips" role="group" aria-label="Projetos (vários ao mesmo tempo)">
              {[...projetos.entries()].map(([k, p]) => (
                <Chip key={k} classe="projeto-chip" marcado={selPr.includes(k)} n={cont.projeto ? cont.projeto[k] || 0 : null}
                  titulo={p.nome && p.nome !== k ? `${p.prefixo} · ${p.nome}` : String(p.prefixo)}
                  aoClicar={() => setFiltros({ projeto: alternarFiltro(selPr.join(','), k) })}>
                  <Quadrado cor={p.cor} /><span>{p.prefixo}</span>
                </Chip>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div class="log-info">
        <span class="contagem" aria-live="polite">
          {log.carregando && !r ? 'Carregando…' : r ? plural(r.total || 0, 'evento', 'eventos') : log.erro ? 'Erro ao carregar.' : ''}
          {log.erro && r ? ` · a última atualização falhou (${log.erro.message})` : ''}
        </span>
        {ativos.length > 0 && <span class="filtros-ativos">{ativos}</span>}
        <span class="espaco" />
        <Alternador marcado={f.so_dono} aoMudar={(v) => setFiltros({ so_dono: v })}>
          Só o que precisa de mim{typeof cont.precisa === 'number' && <span class="n">{numero(cont.precisa)}</span>}
        </Alternador>
        <Alternador marcado={f.incluir_testes} aoMudar={(v) => setFiltros({ incluir_testes: v })}>Mostrar testes</Alternador>
        <button type="button" class="botao pequeno" disabled={!filtrando} onClick={() => { clearTimeout(espera.current); setQ(''); setFiltros(() => novoFiltro()); }}>Limpar filtros</button>
      </div>

      <Cartao semMargem corpoClass="log-corpo">
        <div class="tabela-caixa">
          <table class="tabela log">
            <colgroup>
              <col style={{ width: '66px' }} /><col style={{ width: '86px' }} /><col style={{ width: '15%' }} /><col style={{ width: '94px' }} />
              <col style={{ width: '13%' }} /><col style={{ width: '26%' }} /><col /><col style={{ width: '150px' }} />
            </colgroup>
            <thead><tr>
              <th scope="col">Data</th><th scope="col">Hora</th><th scope="col">Agente</th><th scope="col">Projeto</th>
              <th scope="col">Demanda</th><th scope="col">Ação</th><th scope="col">Direção</th><th scope="col">Resultado</th>
            </tr></thead>
            <tbody>
              {log.erro && !r && <tr><td colSpan={8}><Vazio>Não consegui carregar o log: {log.erro.message}</Vazio></td></tr>}
              {r && !eventos.length && <tr><td colSpan={8}><Vazio icone={ScrollText} centro>Nenhum evento com esses filtros.</Vazio></td></tr>}
              {linhas}
            </tbody>
          </table>
        </div>
        <div class="log-rodape">
          <InfoDica titulo="Como ler a tabela"
            texto="Clique numa linha (ou Enter) para ver os detalhes; no detalhe, ← e → andam por esta tabela. Fundo azul: precisa de você. Fundo vermelho: falhou ou está bloqueado. O filete colorido à esquerda da data é o fluxo." />
          <span class="mudo pequeno">Como ler a tabela</span>
          <span class="espaco" />
          <div class="paginacao">
            <button type="button" class="botao pequeno icone-so" aria-label="Primeira página" disabled={pagina <= 1} onClick={() => setPagina(1)}><Icone de={ChevronsLeft} tamanho={15} /></button>
            <button type="button" class="botao pequeno icone-so" aria-label="Página anterior" disabled={pagina <= 1} onClick={() => setPagina(pagina - 1)}><Icone de={ChevronLeft} tamanho={15} /></button>
            <span class="pequeno">Página {(r && r.pagina) || pagina} de {paginas}</span>
            <button type="button" class="botao pequeno icone-so" aria-label="Próxima página" disabled={pagina >= paginas} onClick={() => setPagina(pagina + 1)}><Icone de={ChevronRight} tamanho={15} /></button>
            <button type="button" class="botao pequeno icone-so" aria-label="Última página" disabled={pagina >= paginas} onClick={() => setPagina(paginas)}><Icone de={ChevronsRight} tamanho={15} /></button>
          </div>
        </div>
      </Cartao>
    </div>
  );
}

/** Cartão de um status: número, parte do total e barra na cor do resultado; clicar filtra (aria-pressed). */
function CartaoStatus({ rotulo, titulo, cor, valor, total, ativo, aoClicar, info, barra }) {
  const conhecido = typeof valor === 'number';
  const parte = conhecido && total ? Math.round((valor / total) * 100) : null;
  return (
    <button type="button" class={`cartao kpi clicavel log-kpi${ativo ? ' destaque' : ''}`} aria-pressed={ativo ? 'true' : 'false'}
      title={titulo} onClick={aoClicar}>
      <span class="rot-linha">
        {cor && <span class="ponto-res" style={{ background: cor }} aria-hidden="true" />}
        <span class="rot">{rotulo}</span>
        {info && <InfoDica texto={info} />}
      </span>
      <span class="linha-kpi">
        <span class="valor medio">{conhecido ? numero(valor) : '—'}</span>
        {parte !== null && <span class="parte">{parte}%</span>}
      </span>
      {barra || (
        <span class="trilho" aria-hidden="true"><span style={{ width: `${parte || 0}%`, background: cor || 'var(--azul)' }} /></span>
      )}
    </button>
  );
}

/** Barra fina com a divisão do total entre os resultados (no cartão "Eventos"). */
function Distribuicao({ grupo, total }) {
  if (!grupo || !total) return <span class="trilho" aria-hidden="true" />;
  return (
    <span class="barra-empilhada" aria-hidden="true">
      {ORDEM_RES.map((k) => (grupo[k] ? <span key={k} style={{ width: `${(grupo[k] / total) * 100}%`, background: RESULTADOS[k].cor }} /> : null))}
    </span>
  );
}

/** Chip de filtro (vários ao mesmo tempo). n: quantos eventos aparecem com os outros filtros. */
function Chip({ marcado, aoClicar, titulo, n, classe, children }) {
  const zerado = n === 0 && !marcado;
  return (
    <button type="button" class={`chip${zerado ? ' zerado' : ''}${classe ? ` ${classe}` : ''}`} aria-pressed={marcado ? 'true' : 'false'}
      title={titulo} onClick={aoClicar}>
      {children}
      {typeof n === 'number' && <span class="n">{numero(n)}</span>}
    </button>
  );
}

function FiltroAtivo({ rotuloTirar, aoTirar, children }) {
  return (
    <span class="filtro-ativo">
      {children}
      <button type="button" aria-label={rotuloTirar} title={rotuloTirar} onClick={aoTirar}><Icone de={X} tamanho={13} /></button>
    </span>
  );
}

function LinhaLog({ e, abrir }) {
  const { estado } = usePainel();
  const classes = ['clicavel'];
  if (RESULTADOS_FALHA.has(e.resultado)) classes.push('falha');
  else if (precisaDono(e)) classes.push('precisa');
  if (e.teste === true) classes.push('teste');
  const tr = obj(e.trello);
  const nomeAg = infoAgente(estado, e.agente).nome;
  return (
    <tr class={classes.join(' ')} tabindex="0" data-id={e.id || ''} onClick={abrir}
      onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); abrir(); } }}
      aria-label={`${data(e.ts)} ${hora(e.ts)}, ${nomeAg}: ${txt(e.resumo)}. Resultado ${RESULTADOS[e.resultado] ? RESULTADOS[e.resultado].rotulo : txt(e.resultado)}.${precisaDono(e) ? ' Precisa de você.' : ''}`}>
      <td class="numerico" style={e.fluxo_id ? { boxShadow: `inset 3px 0 0 ${corDoFluxo(e.fluxo_id)}` } : undefined}
        title={`${data(e.ts)}${e.fluxo_id ? ` · fluxo ${e.fluxo_id}` : ''}`}>{diaMes(e.ts)}</td>
      <td class="numerico">{hora(e.ts)}</td>
      <td><Agente slug={e.agente} /></td>
      <td><Projeto prefixo={e.projeto} /></td>
      <td>{tr && (tr.titulo || tr.shortLink)
        ? <LinkTrello url={urlDoCartao(tr)} titulo={txt(tr.titulo)} aoClicar={(ev) => ev.stopPropagation()}>{txt(tr.titulo || tr.shortLink)}</LinkTrello>
        : <span class="mudo">—</span>}</td>
      <td class="quebra"><span class="duas-linhas" title={txt(e.resumo)}>{txt(e.resumo) || '—'}{e.teste === true && <> <Selo tom="teste">teste</Selo></>}</span></td>
      <td class="quebra texto-2" title={txt(e.direcao)}>{e.direcao ? <span class="duas-linhas">{txt(e.direcao)}</span> : <span class="mudo">—</span>}</td>
      <td><Resultado valor={e.resultado} />{e.precisa_dono === true && !RESULTADOS_DONO.has(e.resultado) && <> <Selo tom="azul">você</Selo></>}</td>
    </tr>
  );
}
