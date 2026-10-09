// Pendências do dono: números no topo (abertas por severidade, respondidas, fechadas, a mais antiga), a lista à
// esquerda, a pendência no meio e, à direita, a resposta: escolher a opção, comentar e enviar. O servidor grava a
// resposta na pendência (pendencia.js responder) e manda para o terminal do Cérebro, que devolve a decisão ao
// agente de origem. Cabe na tela sem rolar a página: cada coluna rola por dentro.
import { useEffect, useRef, useState } from 'preact/hooks';
import { usePainel } from '../dados/contexto.js';
import { objs, arr, txt, idade, dataHora, tempo, numero, agora } from '../dados/formato.js';
import { SEVERIDADES, PLURAL_SEV, TIPO_PEND, ORD_SEV, sevDe, urlDoCartao, urlTrello } from '../dados/dominio.js';
import { responderPendencia } from '../dados/api.js';
import { Cartao, Kpi, Selo, Segmentado, Vazio, InfoDica } from '../componentes/base.jsx';
import { Agente, Fluxo, SeloSeveridade, LinkTrello } from '../componentes/dominio.jsx';
import { Icone, Inbox, ExternalLink, Send, CircleCheck, TriangleAlert, X, LoaderCircle } from '../componentes/Icone.jsx';
import '../estilo/pendencias.css';

const COR_SEV = { critica: 'var(--perigo)', alta: 'var(--atencao)', normal: 'var(--azul-texto)', baixa: 'var(--fraco)' };
const INFO_SEV = {
  critica: 'Travam o trabalho de algum agente agora. O Cérebro também manda notificação.',
  alta: 'Importantes para o andamento; responda primeiro.',
  normal: 'Decisões do dia a dia.',
  baixa: 'Podem esperar.',
};
const idDom = (id) => `pend-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}`;

// Respostas dadas nesta tela que o /api/estado ainda não trouxe (ele é lido a cada 20 s).
const respondidasAqui = new Map();

function grupos(estado) {
  const todas = objs(estado && estado.pendencias).map((p) => {
    const local = respondidasAqui.get(p.id);
    if (!local) return p;
    if (p.status && p.status !== 'aberta') { respondidasAqui.delete(p.id); return p; }
    return local;
  });
  const porSev = (a, b) => ORD_SEV[sevDe(a)] - ORD_SEV[sevDe(b)] || tempo(a.aberta_em) - tempo(b.aberta_em);
  return {
    abertas: todas.filter((p) => !p.status || p.status === 'aberta').sort(porSev),
    respondidas: todas.filter((p) => p.status === 'respondida').sort(porSev),
    fechadas: todas.filter((p) => p.status && p.status !== 'aberta' && p.status !== 'respondida')
      .sort((a, b) => tempo(b.resolvida_em || b.atualizada_em || b.aberta_em) - tempo(a.resolvida_em || a.atualizada_em || a.aberta_em)),
  };
}

/** "21 h", "3 d", "40 min": a idade sem o "há", para caber no número grande. */
function idadeCurta(v) {
  const ms = agora() - tempo(v);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h`;
  return `${Math.floor(min / 1440)} d`;
}

/** Letra e texto de cada opção ("A: Aprovar..." vira { letra: 'A', texto: 'Aprovar...' }). */
function opcoesDe(p) {
  return arr(p.opcoes).map(txt).filter(Boolean).map((o, i) => {
    const m = /^\s*(?:op[çc][aã]o\s+)?([A-Z])\s*[:).\-–]\s*/i.exec(o);
    return m ? { letra: m[1].toUpperCase(), texto: o.slice(m[0].length) || o } : { letra: String.fromCharCode(65 + i), texto: o };
  });
}

/** Letra recomendada, quando a recomendação começa por ela ("A, porque...", "Opção B: ..."). */
function letraRecomendada(p, opcoes) {
  const m = /^\s*(?:op[çc][aã]o\s+)?([A-Z])\b/i.exec(txt(p.recomendacao));
  const l = m ? m[1].toUpperCase() : null;
  return l && opcoes.some((o) => o.letra === l) ? l : null;
}

export function Pendencias() {
  const { estado, pendenciaAlvo, setStatusAcao } = usePainel();
  const [, forcar] = useState(0);
  const g = grupos(estado);
  const [segmento, setSegmento] = useState('abertas');
  const [filtroSev, setFiltroSev] = useState(null);
  const [escolhida, setEscolhida] = useState(null);
  const [aviso, setAviso] = useState(null); // { id, tom, texto }
  const detalhe = useRef(null);

  // Vindo de um link P-NNNN (modal ou auditoria): abre o grupo certo e mostra a pendência.
  useEffect(() => {
    if (!pendenciaAlvo) return;
    const grupo = Object.keys(g).find((k) => g[k].some((p) => p.id === pendenciaAlvo.id));
    if (!grupo) { setStatusAcao(`A pendência ${pendenciaAlvo.id} não está na lista atual.`); return; }
    setSegmento(grupo);
    setFiltroSev(null);
    setEscolhida(pendenciaAlvo.id);
    requestAnimationFrame(() => {
      const el = document.getElementById(idDom(pendenciaAlvo.id));
      if (el) el.scrollIntoView({ block: 'nearest' });
      if (detalhe.current) detalhe.current.focus({ preventScroll: true });
    });
  }, [pendenciaAlvo]);

  useEffect(() => {
    if (!aviso) return undefined;
    const t = setTimeout(() => setAviso(null), 9000);
    return () => clearTimeout(t);
  }, [aviso]);

  const mudar = (seg, sev = null) => { setSegmento(seg); setFiltroSev(sev); setEscolhida(null); };
  const lista = segmento === 'abertas' && filtroSev ? g.abertas.filter((p) => sevDe(p) === filtroSev) : g[segmento];
  const atual = lista.find((p) => p.id === escolhida) || lista[0] || null;
  const contSev = Object.fromEntries(SEVERIDADES.map((s) => [s, g.abertas.filter((p) => sevDe(p) === s).length]));
  const maisAntiga = g.abertas.reduce((m, p) => (!m || tempo(p.aberta_em) < tempo(m.aberta_em) ? p : m), null);

  // Depois de responder: a próxima aberta (na ordem da lista) fica escolhida, para responder em sequência.
  const respondeu = (r, antes) => {
    respondidasAqui.set(antes.id, r.pendencia);
    const i = lista.findIndex((p) => p.id === antes.id);
    const resto = lista.filter((p) => p.id !== antes.id);
    const proxima = resto[Math.min(Math.max(i, 0), resto.length - 1)] || null;
    setEscolhida(proxima ? proxima.id : null);
    const a = r.aviso_cerebro || {};
    setAviso(a.enviado
      ? { id: antes.id, tom: 'ok', texto: `${antes.id} respondida e enviada ao ${a.para || 'Cérebro'}.` }
      : { id: antes.id, tom: 'atencao', texto: `${antes.id} respondida e gravada. O aviso ao terminal do Cérebro não saiu (${a.motivo || 'motivo desconhecido'}): ele vê na próxima leitura das pendências.` });
    forcar((n) => n + 1);
  };

  return (
    <div class="tela tela-pendencias">
      <div class="pend-kpis">
        <Kpi rotulo="Abertas" valor={numero(g.abertas.length)} destaque={segmento === 'abertas' && !filtroSev}
          onClick={() => mudar('abertas')} info="Pendências esperando a sua resposta. Clique para ver todas." />
        {SEVERIDADES.map((s) => (
          <Kpi key={s} rotulo={PLURAL_SEV[s]} valor={numero(contSev[s])} class={`pend-kpi-sev sev-${s}${contSev[s] ? '' : ' zerado'}`}
            destaque={segmento === 'abertas' && filtroSev === s} info={`${INFO_SEV[s]} Clique para filtrar a lista.`}
            onClick={() => mudar('abertas', filtroSev === s ? null : s)} />
        ))}
        <Kpi rotulo="Respondidas" valor={numero(g.respondidas.length)} destaque={segmento === 'respondidas'}
          onClick={() => mudar('respondidas')} info="Você já respondeu; o agente de origem ainda está executando. Fecham quando ele concluir." />
        <Kpi rotulo="Fechadas" valor={numero(g.fechadas.length)} destaque={segmento === 'fechadas'}
          onClick={() => mudar('fechadas')} info="Resolvidas ou canceladas." />
        <Kpi rotulo="Mais antiga" valor={maisAntiga ? idadeCurta(maisAntiga.aberta_em) : '—'}
          info={maisAntiga ? `${maisAntiga.id} · ${txt(maisAntiga.titulo)} (aberta em ${dataHora(maisAntiga.aberta_em)}). Clique para abrir.` : 'Nenhuma pendência aberta.'}
          onClick={maisAntiga ? () => { mudar('abertas'); setEscolhida(maisAntiga.id); } : undefined} />
      </div>

      <Cartao rola semMargem class="pend-col-lista" aria-label="Lista de pendências"
        acoes={<Segmentado rotulo="Grupo de pendências" valor={segmento} aoMudar={(v) => mudar(v)}
          opcoes={[{ id: 'abertas', nome: 'Abertas', n: g.abertas.length }, { id: 'respondidas', nome: 'Respondidas', n: g.respondidas.length }, { id: 'fechadas', nome: 'Fechadas', n: g.fechadas.length }]} />}>
        {segmento === 'abertas' && filtroSev && (
          <div class="pend-filtro">
            <button type="button" class="chip-filtro" onClick={() => setFiltroSev(null)} aria-label={`Tirar o filtro: só ${PLURAL_SEV[filtroSev]}`}>
              Só {PLURAL_SEV[filtroSev]} <Icone de={X} tamanho={12} />
            </button>
          </div>
        )}
        {!lista.length && (
          <Vazio icone={Inbox} centro>
            {segmento === 'abertas' ? (filtroSev ? `Nenhuma pendência ${PLURAL_SEV[filtroSev]} aberta.` : 'Nenhuma pendência aberta. Quando um agente precisar de você, ela aparece aqui.')
              : segmento === 'respondidas' ? 'Nenhuma resposta esperando execução.' : 'Nenhuma pendência fechada recentemente.'}
          </Vazio>
        )}
        <div class="lista pend-lista" role="listbox" aria-label="Pendências">
          {lista.map((p) => {
            const sev = sevDe(p);
            return (
              <button type="button" key={p.id} id={idDom(p.id)} role="option"
                aria-selected={atual && atual.id === p.id ? 'true' : 'false'} class="pend-item" onClick={() => setEscolhida(p.id)}>
                <span class="pend-barra" style={{ background: COR_SEV[sev] }} aria-hidden="true" />
                <span class="pend-topo">
                  <span class="mono">{txt(p.id)}</span>
                  <span class="mudo minimo">{TIPO_PEND[p.tipo] || txt(p.tipo)}</span>
                  <span class="espaco" />
                  <span class="mudo minimo" title={dataHora(p.aberta_em)}>{idade(p.aberta_em)}</span>
                </span>
                <span class="pend-titulo duas-linhas">{txt(p.titulo) || '(sem título)'}</span>
                <span class="pend-pe"><Agente slug={p.agente} tamanho={7} /></span>
              </button>
            );
          })}
        </div>
      </Cartao>

      <section class="cartao pend-detalhe" tabindex="-1" ref={detalhe} aria-live="polite">
        {atual ? <DetalhePendencia p={atual} /> : <Vazio icone={Inbox} centro>Escolha uma pendência à esquerda.</Vazio>}
      </section>

      <section class="cartao pend-painel" aria-label="Resposta">
        {atual
          ? ((!atual.status || atual.status === 'aberta')
            ? <FormResposta key={atual.id} p={atual} aoResponder={respondeu} />
            : <RespostaDada p={atual} />)
          : <Vazio centro>A resposta aparece aqui.</Vazio>}
      </section>

      {aviso && (
        <div class={`pend-aviso ${aviso.tom}`} role="status">
          <Icone de={aviso.tom === 'ok' ? CircleCheck : TriangleAlert} tamanho={16} />
          <span>{aviso.texto}</span>
          <button type="button" class="botao pequeno icone-so" onClick={() => setAviso(null)} aria-label="Fechar o aviso"><Icone de={X} tamanho={14} /></button>
        </div>
      )}
    </div>
  );
}

function DetalhePendencia({ p }) {
  const sev = sevDe(p);
  const status = p.status || 'aberta';
  const urlCartao = urlTrello(urlDoCartao(p.trello));
  return (
    <div class="pend-conteudo">
      <div class="pend-cab">
        <span class="mono pend-id">{txt(p.id)}</span>
        <SeloSeveridade sev={sev} cheio={sev === 'critica'} />
        {p.tipo && <Selo>{TIPO_PEND[p.tipo] || txt(p.tipo)}</Selo>}
        {status !== 'aberta' && <Selo tom={status === 'resolvida' ? 'ok' : status === 'respondida' ? 'azul' : 'neutro'}>{status}</Selo>}
        <Agente slug={p.agente} />
        <span class="mudo" title={dataHora(p.aberta_em)}>aberta {idade(p.aberta_em)}</span>
        {p.fluxo_id && <Fluxo id={p.fluxo_id} />}
      </div>
      <h2 class="pend-h">{txt(p.titulo) || '(sem título)'}</h2>
      {p.contexto && <p class="pend-contexto pre">{txt(p.contexto)}</p>}
      {urlCartao && (
        <div class="pend-rodape">
          <LinkTrello url={urlCartao}>Abrir o cartão no Trello <Icone de={ExternalLink} tamanho={13} /></LinkTrello>
        </div>
      )}
    </div>
  );
}

/** Formulário de resposta: opção (quando há) + comentário. Ctrl+Enter envia. */
function FormResposta({ p, aoResponder }) {
  const { estado } = usePainel();
  const opcoes = opcoesDe(p);
  const recomendada = letraRecomendada(p, opcoes);
  const [opcao, setOpcao] = useState(null);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState(null);
  const resp = (estado && estado.respostas) || null;
  const avisoLigado = !!(resp && resp.aviso_cerebro);
  const pronto = !enviando && (!!opcao || !!texto.trim());

  const enviar = async () => {
    if (!pronto) return;
    setEnviando(true);
    setErro(null);
    try {
      const r = await responderPendencia(p, { opcao, texto: texto.trim() });
      aoResponder(r, p);
    } catch (e) {
      setErro(e.message || String(e));
      setEnviando(false);
    }
  };
  const tecla = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enviar(); } };
  // ↑ ↓ trocam a opção com o foco no grupo (padrão de radio)
  const setas = (e) => {
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!d || !opcoes.length) return;
    e.preventDefault();
    const i = Math.max(0, opcoes.findIndex((o) => o.letra === opcao));
    const j = opcao ? (i + d + opcoes.length) % opcoes.length : 0;
    setOpcao(opcoes[j].letra);
    const b = document.getElementById(`opcao-${p.id}-${opcoes[j].letra}`);
    if (b) b.focus();
  };

  return (
    <div class="pend-form" onKeyDown={tecla}>
      <div class="pend-form-cab">
        <h2 class="rot">Sua resposta</h2>
        <InfoDica titulo="Para onde vai">
          {avisoLigado
            ? 'A resposta fica gravada na pendência (status respondida, com evento no log) e vai direto para o terminal do Cérebro, que devolve a decisão ao agente de origem no mesmo fluxo.'
            : `A resposta fica gravada na pendência (status respondida, com evento no log). O aviso no terminal do Cérebro está desligado${resp && resp.motivo ? ` (${resp.motivo})` : ''}: ele vê na próxima leitura das pendências.`}
        </InfoDica>
      </div>

      {p.recomendacao && (
        <div class="pend-recomendacao"><span class="rot azul">Recomendação</span><p>{txt(p.recomendacao)}</p></div>
      )}

      {opcoes.length > 0 && (
        <div class="pend-opcoes" role="radiogroup" aria-label="Opções" onKeyDown={setas}>
          {opcoes.map((o, i) => {
            const marcada = opcao === o.letra;
            return (
              <button type="button" key={o.letra} id={`opcao-${p.id}-${o.letra}`} role="radio" aria-checked={marcada ? 'true' : 'false'}
                tabindex={marcada || (!opcao && i === 0) ? 0 : -1} class="pend-opcao" onClick={() => setOpcao(marcada ? null : o.letra)}>
                <span class="pend-letra" aria-hidden="true">{o.letra}</span>
                <span class="pend-opcao-texto">{o.texto}</span>
                {recomendada === o.letra && <Selo tom="azul" class="pend-reco">recomendada</Selo>}
              </button>
            );
          })}
        </div>
      )}

      <label class="pend-comentario">
        <span class="rot">{opcoes.length ? 'Comentário (opcional)' : 'Resposta'}</span>
        <textarea rows={opcoes.length ? 3 : 6} maxLength={2000} value={texto} onInput={(e) => setTexto(e.currentTarget.value)}
          placeholder={opcoes.length ? 'Algum ajuste, condição ou detalhe para o agente.' : 'Escreva a sua resposta.'} />
      </label>

      {erro && <p class="pend-erro" role="alert"><Icone de={TriangleAlert} tamanho={14} />{erro}</p>}

      <div class="pend-enviar">
        <span class="mudo minimo">{opcao ? `Opção ${opcao}${texto.trim() ? ' + comentário' : ''}` : texto.trim() ? 'Só o comentário' : 'Escolha uma opção ou escreva'} · Ctrl+Enter envia</span>
        <button type="button" class="botao primario" disabled={!pronto} onClick={enviar}>
          <Icone de={enviando ? LoaderCircle : Send} tamanho={15} class={enviando ? 'gira' : undefined} />
          {enviando ? 'Enviando…' : avisoLigado ? 'Responder e enviar ao Cérebro' : 'Responder'}
        </button>
      </div>
    </div>
  );
}

/** Pendência já respondida ou fechada: a resposta dada e as datas. */
function RespostaDada({ p }) {
  const status = p.status || 'aberta';
  return (
    <div class="pend-form">
      <div class="pend-form-cab"><h2 class="rot">Resposta</h2></div>
      {p.resposta
        ? <div class="pend-resposta"><span class="rot">Resposta do dono{p.respondida_em ? ` · ${dataHora(p.respondida_em)}` : ''}</span><p>{txt(p.resposta)}</p></div>
        : <p class="mudo">Sem resposta registrada.</p>}
      {p.nota && <div class="pend-resposta"><span class="rot">Nota de quem fechou</span><p>{txt(p.nota)}</p></div>}
      {p.motivo && <div class="pend-resposta"><span class="rot">Motivo do cancelamento</span><p>{txt(p.motivo)}</p></div>}
      <dl class="pend-datas">
        <dt>Aberta</dt><dd>{dataHora(p.aberta_em)}</dd>
        {p.respondida_em && <><dt>Respondida</dt><dd>{dataHora(p.respondida_em)}</dd></>}
        {p.resolvida_em && <><dt>{status === 'cancelada' ? 'Cancelada' : 'Resolvida'}</dt><dd>{dataHora(p.resolvida_em)}</dd></>}
      </dl>
      {status === 'respondida' && <p class="mudo minimo">O agente de origem está executando. A pendência fecha quando ele concluir; para mudar a resposta, fale com o Cérebro.</p>}
    </div>
  );
}
