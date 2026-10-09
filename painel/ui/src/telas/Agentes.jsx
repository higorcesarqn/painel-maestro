// Agentes: à esquerda, um cartão resumido por agente (registro/agentes.json + eventos, log bruto e consumo);
// clicar abre os detalhes num modal (← → passam de agente). À direita, os resultados de 7 dias de cada
// agente e a última gravação do log bruto (saúde dos hooks).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { usePainel } from '../dados/contexto.js';
import { obj, objs, arr, txt, numero, pct, idade, hm, dataHora, data, diaSP, agora, fDiaMes, quando, tempo } from '../dados/formato.js';
import { corSegura, nomeTipo, infoAgente, RESULTADOS } from '../dados/dominio.js';
import { ultimosDias } from '../dados/consultas.js';
import { Cartao, Selo, Ponto, Vazio, Esqueleto } from '../componentes/base.jsx';
import { Sparkline, GraficoBarras, BarraEmpilhada, Legenda } from '../componentes/graficos.jsx';
import { Agente, Resultado } from '../componentes/dominio.jsx';
import { Modal } from '../componentes/Modal.jsx';
import { Icone, Bot, ChevronRight, ArrowLeft, ArrowRight, X } from '../componentes/Icone.jsx';
import '../estilo/agentes.css';

// Ordem e cores dos resultados nas barras (as mesmas do resto do painel).
const ORDEM_RES = ['ok', 'em-andamento', 'aguardando-dono', 'parcial', 'bloqueado', 'falhou'];
const SERIES_RES = ORDEM_RES.map((r) => ({ chave: r, nome: RESULTADOS[r].rotulo, cor: RESULTADOS[r].cor }));
// Agente ativo sem log bruto há mais de 24 h deixa a saúde amarela (mesma regra do servidor.js).
const BRUTO_ATRASADO_MIN = 24 * 60;
const MAX_EVENTOS_MODAL = 30;

const nomeDe = (a) => txt(a.nome || a.slug);
const minutosDesde = (v) => { const d = quando(v); return d ? (agora() - d.getTime()) / 60000 : null; };

export function Agentes() {
  const { estado, analise, analitico } = usePainel();
  const [aberto, setAberto] = useState(null); // slug do agente no modal de detalhes
  const eventos7d = analitico && analitico.eventos;
  // eventos dos últimos 7 dias de cada agente, do mais recente para o mais antigo
  const porAgente = useMemo(() => {
    const m = new Map();
    for (const e of arr(eventos7d)) {
      if (!e || !e.agente) continue;
      if (!m.has(e.agente)) m.set(e.agente, []);
      m.get(e.agente).push(e);
    }
    for (const l of m.values()) l.sort((a, b) => tempo(b.ts) - tempo(a.ts));
    return m;
  }, [eventos7d]);
  if (!estado) return null;

  const ags = objs(estado.agentes);
  const ativos = ags.filter((a) => a.status === 'ativo').length;
  const hooks = objs(estado.saude && estado.saude.hooks);
  const extras = hooks.filter((x) => !ags.some((a) => a.slug === x.agente));
  const carregando = !eventos7d;
  const agenteAberto = aberto && ags.find((a) => a.slug === aberto);
  return (
    <div class="tela tela-agentes">
      <Cartao rotulo="Agentes" extra={`${numero(ags.length)} registrados · ${numero(ativos)} ativos`} rola semMargem class="ag-lista-cartao"
        info={`${ags.length} agente(s) em registro/agentes.json. O estado ao vivo dos terminais chega com o Maestri Wire (Fase B). Clique num agente para ver a ficha completa, as conexões, as skills e os últimos eventos.`}>
        {!ags.length && <Vazio icone={Bot} centro>Nenhum agente em registro/agentes.json.</Vazio>}
        {ags.length > 0 && (
          <div class="ag-lista">
            {ags.map((a) => <ItemAgente key={a.slug} a={a} serie={analise ? analise.serieAgente(a.slug) : null} aoAbrir={() => setAberto(a.slug)} />)}
          </div>
        )}
      </Cartao>
      <div class="ag-lado">
        <ResultadosPorAgente ags={ags} porAgente={porAgente} carregando={carregando} />
        <LogBruto ags={ags} hooks={hooks} extras={extras} />
      </div>
      {agenteAberto && (
        <ModalAgente ags={ags} a={agenteAberto} porAgente={porAgente} carregando={carregando}
          aoTrocar={setAberto} aoFechar={() => setAberto(null)} />
      )}
    </div>
  );
}

/** Participação do agente no consumo de um período (janela_5h, hoje, 7d), ou "—". */
function pctUso(a, k) {
  const u = obj(a.uso) && obj(a.uso[k]);
  return u && typeof u.pct_consumo === 'number' ? pct(u.pct_consumo) : '—';
}

function Numero({ valor, rotulo, titulo }) {
  return <span class="ag-num" title={titulo}><b>{valor}</b><span class="rot">{rotulo}</span></span>;
}

/** Cartão resumido: nome, status, modelo, o último evento numa linha, quatro números e os 7 dias. */
function ItemAgente({ a, serie, aoAbrir }) {
  const cor = corSegura(a.cor);
  const ue = obj(a.ultimo_evento);
  return (
    <button type="button" class="ag-item" onClick={aoAbrir} style={cor ? { '--cor-agente': cor } : undefined}
      aria-label={`${nomeDe(a)}: abrir os detalhes`}>
      <span class="ag-cima">
        <span class="ag-topo">
          <Ponto cor={cor} tamanho={10} />
          <span class="ag-nome">{nomeDe(a)}</span>
          {a.status && <Selo tom={a.status === 'ativo' ? 'ok' : 'neutro'}>{txt(a.status)}</Selo>}
          <span class="espaco" />
          <span class="mono mudo minimo ag-modelo" title="Modelo e nível">{txt(a.modelo) || '—'}{a.nivel ? ` · ${txt(a.nivel)}` : ''}</span>
        </span>
        {ue ? (
          <span class="ag-evento">
            <span class="ag-ev-meta">Último evento · {hm(ue.ts)} · {idade(ue.ts)} · {nomeTipo(ue.tipo)}<Resultado valor={ue.resultado} /></span>
            <span class="ag-ev-resumo duas-linhas" title={txt(ue.resumo)}>{txt(ue.resumo) || '(sem resumo)'}</span>
          </span>
        ) : <span class="ag-evento mudo">Nenhum evento registrado ainda.</span>}
      </span>
      <span class="ag-numeros">
        <Numero valor={numero(a.eventos_hoje)} rotulo="eventos hoje" />
        <Numero valor={numero(a.fluxos_abertos)} rotulo="fluxos abertos" />
        <Numero valor={pctUso(a, 'janela_5h')} rotulo={'consumo 5 h'} titulo="Participação estimada do agente no consumo da janela de 5 h atual" />
        <Numero valor={pctUso(a, '7d')} rotulo={'consumo 7 d'} titulo="Participação estimada do agente no consumo dos últimos 7 dias" />
        <span class="ag-num ag-spark">
          {serie
            ? <Sparkline valores={serie} largura={112} altura={28} cor={cor || 'var(--mudo)'} rotuloAria={`Eventos por dia, 7 dias: ${serie.join(', ')}`} />
            : <Esqueleto largura={112} altura={28} />}
          <span class="rot">{'7 dias'}</span>
        </span>
        <span class="ag-detalhes" aria-hidden="true">Detalhes<Icone de={ChevronRight} tamanho={14} /></span>
      </span>
    </button>
  );
}

/** Conta os resultados de uma lista de eventos. */
function contarResultados(evs) {
  const c = {};
  for (const e of evs) { const r = RESULTADOS[e.resultado] ? e.resultado : 'outro'; c[r] = (c[r] || 0) + 1; }
  return c;
}

/** Uma barra por agente, dividida pelos resultados dos 7 dias; o comprimento acompanha o volume. */
function ResultadosPorAgente({ ags, porAgente, carregando }) {
  const linhas = ags.map((a) => {
    const evs = porAgente.get(a.slug) || [];
    return { a, total: evs.length, c: contarResultados(evs) };
  });
  const max = Math.max(1, ...linhas.map((l) => l.total));
  return (
    <Cartao rotulo="Resultados · 7 dias" rola class="ag-resultados"
      info="Eventos de cada agente nos últimos 7 dias, por resultado (logs/eventos, sem os de teste). O comprimento da barra acompanha o agente com mais eventos; passe o mouse num trecho para ver o número.">
      {carregando ? (
        <div class="ag-res-lista">{ags.map((a) => <Esqueleto key={a.slug} altura={30} />)}</div>
      ) : (
        <>
          <div class="ag-res-lista">
            {linhas.map((l) => (
              <div class="ag-res" key={l.a.slug}>
                <span class="ag-res-cab"><Agente slug={l.a.slug} /><b>{l.total ? numero(l.total) : <span class="mudo">sem eventos</span>}</b></span>
                <span class="ag-res-trilho">
                  <span style={{ width: `${(l.total / max) * 100}%` }}>
                    <BarraEmpilhada partes={ORDEM_RES.map((r) => ({ chave: r, valor: l.c[r] || 0, cor: RESULTADOS[r].cor, nome: RESULTADOS[r].rotulo }))}
                      rotuloAria={`${nomeDe(l.a)}: ${ORDEM_RES.filter((r) => l.c[r]).map((r) => `${l.c[r]} ${RESULTADOS[r].rotulo}`).join(', ') || 'nenhum evento'}`} />
                  </span>
                </span>
                {l.total > 0 && (
                  <span class="ag-res-sub">
                    {ORDEM_RES.filter((r) => l.c[r]).map((r) => (
                      <span key={r}><i style={{ background: RESULTADOS[r].cor }} />{numero(l.c[r])} {RESULTADOS[r].rotulo}</span>
                    ))}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div class="ag-res-legenda"><Legenda series={SERIES_RES} /></div>
        </>
      )}
    </Cartao>
  );
}

/** Última gravação dos hooks de cada agente e os terminais que gravam sem agente registrado. */
function LogBruto({ ags, hooks, extras }) {
  const porSlug = new Map(hooks.map((h) => [h.agente, h]));
  return (
    <Cartao rotulo="Log bruto" rola class="ag-bruto"
      info="Último comando gravado pelos hooks de cada agente (logs/bruto). Agente ativo sem log bruto há mais de 24 h deixa a saúde do painel amarela. Um terminal que grava sem agente registrado indica terminal_id ausente ou errado em registro/agentes.json.">
      <ul class="ag-bruto-lista">
        {ags.map((a) => {
          const h = porSlug.get(a.slug);
          const ub = (h && h.ultimo_bruto) || a.ultimo_bruto || null;
          const min = minutosDesde(ub);
          const atrasado = a.status === 'ativo' && (!ub || (min !== null && min > BRUTO_ATRASADO_MIN));
          return (
            <li key={a.slug}>
              <Agente slug={a.slug} />
              <span class="mudo pequeno">{ub ? dataHora(ub) : 'nenhum registro'}</span>
              <span class="ag-bruto-idade" style={atrasado ? { color: 'var(--atencao)' } : undefined}>
                <Ponto cor={atrasado ? 'var(--atencao)' : 'var(--ok)'} tamanho={7} />{ub ? idade(ub) : 'nunca'}
              </span>
            </li>
          );
        })}
      </ul>
      {extras.length > 0 && (
        <>
          <span class="rot ag-bruto-sub">Sem agente registrado</span>
          <ul class="ag-bruto-lista">
            {extras.map((x) => (
              <li key={x.agente}>
                <span class="mono pequeno corta" title={txt(x.agente)}>{txt(x.agente)}</span>
                <span class="mudo pequeno">{x.ultimo_bruto ? dataHora(x.ultimo_bruto) : 'nunca'}</span>
                <span class="ag-bruto-idade mudo"><Ponto cor="var(--fraco)" tamanho={7} />{x.ultimo_bruto ? idade(x.ultimo_bruto) : '—'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Cartao>
  );
}

/** "portal:trello.com" → selo "portal · trello.com"; slug de agente vira o nome com a cor dele. */
function Conexao({ c }) {
  const { estado } = usePainel();
  const s = txt(c);
  const m = /^(portal|nota|agente|terminal):(.+)$/.exec(s);
  if (m) return <Selo><span class="fraco">{m[1]}</span>{m[2]}</Selo>;
  const ag = objs(estado && estado.agentes).find((x) => x.slug === s);
  if (ag) { const i = infoAgente(estado, s); return <Selo><Ponto cor={i.cor} tamanho={7} />{i.nome}</Selo>; }
  return <Selo>{s}</Selo>;
}

/** Consumo do agente num período: participação no consumo e, quando há, a fatia estimada do plano. */
function linhaConsumo(a, k, nome) {
  const u = obj(a.uso) && obj(a.uso[k]);
  if (!u || typeof u.pct_consumo !== 'number') return null;
  const plano = typeof u.pct_plano_estimado === 'number' ? ` · ≈ ${pct(u.pct_plano_estimado)} do plano` : '';
  return <span key={k}>{nome}: {pct(u.pct_consumo)} do consumo{plano}</span>;
}

/** Ficha completa do agente: último evento, últimos eventos, 7 dias por resultado, ficha, conexões e skills. */
function ModalAgente({ ags, a, porAgente, carregando, aoTrocar, aoFechar }) {
  const { estado, abrirModal } = usePainel();
  const i = ags.findIndex((x) => x.slug === a.slug);
  const anterior = i > 0 ? ags[i - 1] : null;
  const seguinte = i >= 0 && i < ags.length - 1 ? ags[i + 1] : null;
  const vizinhos = useRef({ anterior, seguinte });
  vizinhos.current = { anterior, seguinte };
  useEffect(() => {
    const tecla = (ev) => {
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const alvo = ev.key === 'ArrowLeft' ? vizinhos.current.anterior : ev.key === 'ArrowRight' ? vizinhos.current.seguinte : null;
      if (!alvo) return;
      aoTrocar(alvo.slug);
      ev.preventDefault();
    };
    document.addEventListener('keydown', tecla);
    return () => document.removeEventListener('keydown', tecla);
  }, []);

  const cor = corSegura(a.cor);
  const ue = obj(a.ultimo_evento);
  // Sem a análise de 7 dias ainda, usa os eventos recentes do /api/estado.
  const evs = carregando ? objs(estado.eventos).filter((e) => e.agente === a.slug) : (porAgente.get(a.slug) || []);
  const lista = evs.slice(0, MAX_EVENTOS_MODAL);
  const ids = lista.map((e) => e.id).filter((x) => typeof x === 'string' && x);
  const abrirEvento = (id) => {
    if (!id) return;
    aoFechar();
    abrirModal(id, ids.includes(id) ? ids : arr(estado.eventos).map((e) => e && e.id));
  };
  const dias = useMemo(() => {
    const ds = ultimosDias(7).map((d) => ({ chave: d.dia, rotulo: d.rotulo, titulo: d.titulo, valores: {} }));
    const pos = new Map(ds.map((d, j) => [d.chave, j]));
    for (const e of evs) {
      const j = pos.get(diaSP(e.ts));
      if (j === undefined) continue;
      const r = RESULTADOS[e.resultado] ? e.resultado : 'outro';
      ds[j].valores[r] = (ds[j].valores[r] || 0) + 1;
    }
    return ds;
  }, [evs]);
  const hoje = diaSP(agora());
  const conexoes = arr(a.conectado_a);
  const skills = arr(a.skills);
  const consumo = [linhaConsumo(a, 'janela_5h', 'Janela de 5 h'), linhaConsumo(a, 'hoje', 'Hoje'), linhaConsumo(a, '7d', '7 dias')].filter(Boolean);
  const terminal = txt(a.terminal_id || a.terminal);

  return (
    <Modal aoFechar={aoFechar} rotuloId="ag-modal-titulo" largura={1080}>
      <div class="modal-cab ag-modal-cab" style={cor ? { '--cor-agente': cor } : undefined}>
        <div class="info">
          <Ponto cor={cor} tamanho={11} />
          <span id="ag-modal-titulo" class="quando">{nomeDe(a)}</span>
          {a.status && <Selo tom={a.status === 'ativo' ? 'ok' : 'neutro'}>{txt(a.status)}</Selo>}
          <span class="mono mudo minimo">{txt(a.modelo) || '—'}{a.nivel ? ` · ${txt(a.nivel)}` : ''}</span>
          <span class="fraco minimo">{i + 1} de {ags.length}</span>
        </div>
        <div class="modal-nav">
          <button type="button" class="botao icone-so" aria-label={anterior ? `Agente anterior: ${nomeDe(anterior)} (seta para a esquerda)` : 'Agente anterior'}
            title={anterior ? `${nomeDe(anterior)} (←)` : 'Primeiro agente'} disabled={!anterior} onClick={() => anterior && aoTrocar(anterior.slug)}><Icone de={ArrowLeft} /></button>
          <button type="button" class="botao icone-so" aria-label={seguinte ? `Próximo agente: ${nomeDe(seguinte)} (seta para a direita)` : 'Próximo agente'}
            title={seguinte ? `${nomeDe(seguinte)} (→)` : 'Último agente'} disabled={!seguinte} onClick={() => seguinte && aoTrocar(seguinte.slug)}><Icone de={ArrowRight} /></button>
          <button type="button" class="botao icone-so" aria-label="Fechar (Esc)" title="Fechar (Esc)" onClick={aoFechar}><Icone de={X} /></button>
        </div>
      </div>
      <div class="modal-corpo">
        <div class="ag-modal-grade">
          <div class="modal-col">
            <section class="secao-modal">
              <h3 class="rot">Último evento</h3>
              {ue ? (
                <>
                  <span class="ag-ev-meta">{dataHora(ue.ts)} · {idade(ue.ts)} · {nomeTipo(ue.tipo)} <Resultado valor={ue.resultado} /></span>
                  {ue.id
                    ? <button type="button" class="link neutro ag-modal-resumo" onClick={() => abrirEvento(ue.id)}>{txt(ue.resumo) || '(sem resumo)'}</button>
                    : <span class="ag-modal-resumo">{txt(ue.resumo) || '(sem resumo)'}</span>}
                </>
              ) : <span class="mudo pequeno">Nenhum evento registrado ainda.</span>}
            </section>
            <section class="secao-modal">
              <h3 class="rot">Eventos por dia · 7 dias</h3>
              <div class="ag-modal-grafico">
                {carregando
                  ? <Esqueleto altura={150} />
                  : <GraficoBarras dados={dias} series={SERIES_RES} destacarUltimo rotuloAria={`Eventos de ${nomeDe(a)} por dia nos últimos 7 dias`} />}
              </div>
            </section>
            <section class="secao-modal">
              <h3 class="rot">Últimos eventos{evs.length > lista.length ? ` · ${lista.length} de ${evs.length}` : ''}</h3>
              {!lista.length && <span class="mudo pequeno">{carregando ? 'Carregando os eventos dos últimos 7 dias…' : 'Nenhum evento nos últimos 7 dias.'}</span>}
              {lista.length > 0 && (
                <ul class="ag-modal-eventos">
                  {lista.map((e) => (
                    <li key={e.id || e.ts}>
                      <button type="button" disabled={!e.id} onClick={() => abrirEvento(e.id)} title={txt(e.resumo)}>
                        <span class="mudo">{diaSP(e.ts) === hoje ? hm(e.ts) : `${fDiaMes.format(quando(e.ts) || new Date(0))} ${hm(e.ts)}`}</span>
                        <span class="corta">{txt(e.resumo) || '(sem resumo)'}</span>
                        <Resultado valor={e.resultado} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <div class="modal-col">
            <section class="secao-modal">
              <h3 class="rot">Ficha</h3>
              <dl class="ag-modal-dl">
                <dt>Responsabilidade</dt><dd>{txt(a.responsabilidade) || '—'}</dd>
                <dt>Tipo</dt><dd>{txt(a.tipo) || '—'}</dd>
                {a.desde && <><dt>Desde</dt><dd>{data(`${a.desde}T12:00:00-03:00`)}</dd></>}
                {terminal && <><dt>Terminal</dt><dd class="mono">{terminal}</dd></>}
                <dt>Log bruto</dt>
                <dd>{a.ultimo_bruto ? `${dataHora(a.ultimo_bruto)} (${idade(a.ultimo_bruto)})` : <span style={{ color: 'var(--atencao)' }}>nenhum registro ainda</span>}</dd>
                <dt>Hoje</dt><dd>{numero(a.eventos_hoje)} evento(s) · {numero(a.fluxos_abertos)} fluxo(s) aberto(s)</dd>
                <dt>Consumo</dt><dd>{consumo.length ? <span class="ag-modal-consumo">{consumo}</span> : '—'}</dd>
              </dl>
            </section>
            <section class="secao-modal">
              <h3 class="rot">Conectado a ({conexoes.length})</h3>
              {conexoes.length ? <div class="selos">{conexoes.map((c) => <Conexao key={txt(c)} c={c} />)}</div> : <span class="mudo pequeno">Nenhuma conexão registrada.</span>}
            </section>
            <section class="secao-modal">
              <h3 class="rot">Skills ({skills.length})</h3>
              {skills.length ? <div class="selos">{skills.map((s) => <Selo key={txt(s)} mono>{txt(s)}</Selo>)}</div> : <span class="mudo pequeno">Nenhuma skill registrada.</span>}
            </section>
            {a.observacao && (
              <section class="secao-modal">
                <h3 class="rot">Observação</h3>
                <p class="texto-2 ag-modal-obs">{txt(a.observacao)}</p>
              </section>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
