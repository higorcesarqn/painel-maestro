// Modal do evento (§11.5): resumo e pedido, demanda do Trello, direção, sequência do fluxo, passos e
// comandos, alterações, validação, próximo passo e duração. ← (mais recente) e → (mais antigo) seguem a
// ordem da tabela filtrada do Log; aberto pela Visão geral ou pelos Agentes, seguem a ordem do tempo.
import { useEffect, useRef, useState } from 'preact/hooks';
import { usePainel } from '../dados/contexto.js';
import { lerEvento, lerEventos } from '../dados/api.js';
import { arr, obj, txt, hora, hm, diaSP, semana, dataHoraSeg, cabecalhoDia, fDiaMes, quando, truncar, duracao, numero } from '../dados/formato.js';
import { nomeTipo, nomeOrigem, infoAgente, urlDoCartao } from '../dados/dominio.js';
import { Modal } from '../componentes/Modal.jsx';
import { Selo, Recolhivel } from '../componentes/base.jsx';
import { Agente, Projeto, Resultado, StatusTrello, LinkTrello, Fluxo } from '../componentes/dominio.jsx';
import { Icone, ArrowLeft, ArrowRight, X, Check } from '../componentes/Icone.jsx';

export function ModalEvento() {
  const { estado, modal, setModal, fecharModal } = usePainel();
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  const seq = useRef(0);
  const seqPagina = useRef(0);
  const id = modal && modal.id;

  useEffect(() => {
    if (!id) return;
    const n = ++seq.current;
    setErro(null);
    lerEvento(id).then((d) => { if (n === seq.current) setDados(d); })
      .catch((e) => { if (n === seq.current) { setDados(null); setErro(e); } });
  }, [id]);

  /** {id} do vizinho ou, na borda de uma página do Log, {pagina, ponta}; null desabilita a seta. */
  const vizinho = (direcao) => {
    if (!id) return null;
    const lista = modal.lista || [];
    const tab = modal.tabela;
    const i = lista.indexOf(id);
    if (i >= 0) {
      const j = i + direcao;
      if (j >= 0 && j < lista.length) return { id: lista[j] };
      if (tab) {
        if (direcao > 0 && tab.pagina < tab.paginas) return { pagina: tab.pagina + 1, ponta: 'primeiro' };
        if (direcao < 0 && tab.pagina > 1) return { pagina: tab.pagina - 1, ponta: 'ultimo' };
        return null; // começo ou fim da tabela
      }
    }
    if (tab && tab.filtrado) return null; // fora da lista filtrada: não sai para eventos que a tabela não mostra
    if (!dados || dados.evento.id !== id) return null; // vizinhos do servidor só valem para o evento já carregado
    const v = direcao < 0 ? dados.proximo_id : dados.anterior_id;
    return typeof v === 'string' && v ? { id: v } : null;
  };
  const navegar = async (direcao) => {
    const alvo = vizinho(direcao);
    if (!alvo) return;
    if (alvo.id) { setModal((m) => ({ ...m, id: alvo.id })); return; }
    const tab = modal.tabela;
    const n = ++seqPagina.current;
    try {
      const sp = new URLSearchParams(tab.params);
      sp.set('pagina', String(alvo.pagina));
      const r = await lerEventos(sp);
      if (n !== seqPagina.current) return;
      const ids = arr(r.eventos).map((e) => e && e.id).filter((x) => typeof x === 'string' && x);
      if (!ids.length) return;
      setModal((m) => (m ? { id: alvo.ponta === 'ultimo' ? ids[ids.length - 1] : ids[0], lista: ids, tabela: { ...tab, pagina: r.pagina || alvo.pagina, paginas: r.paginas || tab.paginas } } : m));
    } catch (e) {
      console.error('Falha ao buscar a página vizinha do Log:', e);
    }
  };
  const navRef = useRef(navegar);
  navRef.current = navegar;
  useEffect(() => {
    const tecla = (ev) => {
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (ev.key === 'ArrowLeft') { navRef.current(-1); ev.preventDefault(); }
      else if (ev.key === 'ArrowRight') { navRef.current(1); ev.preventDefault(); }
    };
    document.addEventListener('keydown', tecla);
    return () => document.removeEventListener('keydown', tecla);
  }, []);

  const anterior = vizinho(-1);
  const proximo = vizinho(1);
  const carregado = dados && dados.evento && dados.evento.id === id ? dados : null;
  const fechar = <button type="button" class="botao icone-so" aria-label="Fechar (Esc)" title="Fechar (Esc)" onClick={fecharModal}><Icone de={X} /></button>;
  const nav = (
    <div class="modal-nav">
      <button type="button" class="botao icone-so" aria-label="Evento mais recente (seta para a esquerda)" title="Evento mais recente (←)" disabled={!anterior} onClick={() => navegar(-1)}><Icone de={ArrowLeft} /></button>
      <button type="button" class="botao icone-so" aria-label="Evento mais antigo (seta para a direita)" title="Evento mais antigo (→)" disabled={!proximo} onClick={() => navegar(1)}><Icone de={ArrowRight} /></button>
      {fechar}
    </div>
  );

  return (
    <Modal aoFechar={fecharModal} rotuloId="modal-titulo">
      {!carregado ? (
        <div class="modal-cab">
          <div class="info"><span id="modal-titulo" class="quando">
            {erro ? (erro.status === 404 ? `O evento ${id} não existe mais.` : `Não consegui abrir o evento: ${erro.message}`) : 'Carregando o evento…'}
          </span></div>
          {nav}
        </div>
      ) : <CorpoEvento d={carregado} estado={estado} nav={nav} />}
    </Modal>
  );
}

function Secao({ titulo, children, class: classe }) {
  return <section class={`secao-modal${classe ? ` ${classe}` : ''}`}><h3 class="rot">{titulo}</h3>{children}</section>;
}

function CorpoEvento({ d, estado, nav }) {
  const { abrirModal, irParaPendencia } = usePainel();
  const ev = d.evento;
  const fluxo = obj(d.fluxo);
  const tr = obj(ev.trello);
  const ped = obj(d.pedido_inicial);
  const seq = arr(d.sequencia);
  const lista = useRef(null);
  useEffect(() => {
    // sequência longa: rola só a lista até o evento atual
    const l = lista.current;
    const atual = l && l.querySelector('li.atual');
    if (l && atual && l.scrollHeight > l.clientHeight) l.scrollTop = Math.max(0, atual.offsetTop - l.clientHeight / 2 + atual.offsetHeight / 2);
  }, [ev.id]);

  const passos = arr(ev.passos);
  const comandos = arr(ev.comandos);
  const brutos = arr(d.comandos_brutos);
  const janela = obj(d.janela_sem_fluxo);
  const truncados = Number(d.comandos_omitidos) || (typeof d.comandos_truncados === 'number' ? d.comandos_truncados : 0);
  const avisoBrutos = typeof d.comandos_aviso === 'string' && d.comandos_aviso ? d.comandos_aviso : null;
  const alteracoes = arr(ev.alteracoes);
  const pend = arr(ev.pendencias);
  const dur = duracao(ev.duracao_s);

  let diaSeq = null;
  const itensSeq = [];
  for (const s of seq) {
    const dia = diaSP(s.ts);
    if (dia !== diaSeq && seq.length > 1) { itensSeq.push(<li class="dia-seq" key={`d-${dia}`}>{cabecalhoDia(s.ts)}</li>); diaSeq = dia; }
    const atual = s.id === ev.id;
    itensSeq.push(
      <li key={s.id || s.ts} class={atual ? 'atual' : ''} aria-current={atual ? 'true' : undefined} tabindex={atual ? undefined : '0'} role={atual ? undefined : 'button'}
        onClick={() => { if (!atual && s.id) abrirModal(s.id); }}
        onKeyDown={(k) => { if (!atual && s.id && (k.key === 'Enter' || k.key === ' ')) { k.preventDefault(); abrirModal(s.id); } }}>
        <span class="mudo">{hora(s.ts)}</span>
        <Agente slug={s.agente} />
        <span class="mudo corta">{nomeTipo(s.tipo)}</span>
        <span class="corta" title={txt(s.resumo)}>{txt(s.resumo)}</span>
        <Resultado valor={s.resultado} />
      </li>,
    );
  }

  return (
    <>
      <div class="modal-cab">
        <div class="info">
          <span class="quando" id="modal-titulo">{ev.ts ? `${semana(ev.ts)}, ${dataHoraSeg(ev.ts)}` : 'Sem data'}</span>
          <Agente slug={ev.agente} />
          <Selo>{nomeTipo(ev.tipo)}</Selo>
          <Resultado valor={ev.resultado} />
          <Fluxo id={ev.fluxo_id} titulo="Filtrar a tabela por este fluxo" />
          {fluxo && fluxo.titulo && <span class="texto-2">{txt(fluxo.titulo)}</span>}
          {ev.teste === true && <Selo tom="teste">teste</Selo>}
          <span class="mono mudo minimo">{txt(ev.id)}</span>
        </div>
        {nav}
      </div>
      <div class="modal-corpo">
        <div class="modal-grade">
          <div class="modal-col">
            <Secao titulo="Resumo e o que foi pedido">
              <p class="resumo-grande">{txt(ev.resumo) || '(sem resumo)'}</p>
              {ped && ped.texto && <p class="mudo pequeno">Origem deste evento: {nomeOrigem(estado, ev.origem)}</p>}
              {ped && ped.texto ? (
                <div class="pedido">
                  <div class="quem">Quem pediu: {ped.origem ? nomeOrigem(estado, ped.origem) : 'origem não informada'}{ped.origem_inferida ? ' (deduzido do prompt)' : ''}{ped.ts ? ` · ${dataHoraSeg(ped.ts)}` : ''}{ped.agente ? ` · recebido por ${infoAgente(estado, ped.agente).nome}` : ''}</div>
                  <div class="texto-pedido pre">{txt(ped.texto)}</div>
                </div>
              ) : (
                <div class="pedido"><div class="quem">Origem deste evento: {nomeOrigem(estado, ev.origem)}</div><div class="mudo">O texto do pedido que abriu o fluxo não foi encontrado.</div></div>
              )}
            </Secao>
            <Secao titulo="Direção tomada">
              {ev.direcao ? <div class="direcao pre">{txt(ev.direcao)}</div> : <p class="mudo">Sem direção registrada.</p>}
            </Secao>
            <Secao titulo={`Sequência do fluxo${seq.length ? ` (${seq.length} evento${seq.length === 1 ? '' : 's'})` : ''}`}>
              {seq.length ? <ol class="sequencia" ref={lista}>{itensSeq}</ol> : <p class="mudo">Sem outros eventos neste fluxo.</p>}
            </Secao>
          </div>
          <div class="modal-col">
            <Secao titulo="Demanda do Trello">
              {tr && (tr.titulo || tr.shortLink) ? (
                <div class="trello-demanda">
                  <Projeto prefixo={ev.projeto} />
                  <LinkTrello url={urlDoCartao(tr)}>{txt(tr.titulo || tr.shortLink)}</LinkTrello>
                  {(tr.status_antes || tr.status_depois) && <span class="trello-status"><StatusTrello status={tr.status_antes || '—'} /><Icone de={ArrowRight} tamanho={13} /><StatusTrello status={tr.status_depois || tr.status_antes || '—'} /></span>}
                </div>
              ) : <p class="mudo">{ev.projeto ? <>Sem cartão específico · projeto <Projeto prefixo={ev.projeto} /></> : 'Sem cartão do Trello ligado a este evento.'}</p>}
            </Secao>
            <Secao titulo="Validação">{ev.validacao ? <p>{txt(ev.validacao)}</p> : <p class="mudo">Sem validação registrada.</p>}</Secao>
            <Secao titulo="Próximo passo e pendências">
              {ev.proximo_passo ? <p>{txt(ev.proximo_passo)}</p> : <p class="mudo">Sem próximo passo registrado.</p>}
              {pend.length > 0 && <p style={{ marginTop: '6px' }}>Pendências: {pend.map((p, i) => <span key={i}>{i ? ', ' : ''}<button type="button" class="link mono" onClick={() => irParaPendencia(txt(p))}>{txt(p)}</button></span>)}</p>}
              {ev.precisa_dono === true && <p style={{ marginTop: '8px' }}><Selo tom="azul" cheio>Precisa do dono</Selo></p>}
            </Secao>
            <Secao titulo="Alterações">
              {alteracoes.length ? <ul class="lista-simples">{alteracoes.map((a, i) => <li key={i}>{txt(a)}</li>)}</ul> : <p class="mudo">Nenhuma alteração registrada.</p>}
            </Secao>
            <Secao titulo="Duração"><p>{dur || <span class="mudo">não informada</span>}</p></Secao>
          </div>
        </div>
        <Secao titulo="Passos e comandos" class="largo">
          <Recolhivel chave="modal-passos" resumo={`Passos (${passos.length})`} aberto>
            {passos.length ? <ol class="lista-simples">{passos.map((p, i) => <li key={i}>{txt(p)}</li>)}</ol> : <p class="mudo">Nenhum passo registrado.</p>}
          </Recolhivel>
          {comandos.length > 0 && (
            <Recolhivel chave="modal-comandos" resumo={`Comandos citados pelo agente (${comandos.length})`}>
              <ul class="lista-simples mono">{comandos.map((c, i) => <li key={i}>{txt(c)}</li>)}</ul>
            </Recolhivel>
          )}
          <Recolhivel chave="modal-brutos" resumo={`Comandos brutos correlacionados (${numero(brutos.length)}${truncados ? ` de ${numero(brutos.length + truncados)}` : ''})`}>
            {janela && <p class="mudo pequeno" style={{ marginBottom: '6px' }}>Entradas sem fluxo_id: janela de {dataHoraSeg(janela.inicio)} a {hora(janela.fim)}{janela.sessao ? ` na sessão ${truncar(janela.sessao, 12)}` : ''}.</p>}
            {brutos.length ? <TabelaBrutos brutos={brutos} diaEvento={diaSP(ev.ts)} /> : <p class="mudo">Nenhum comando bruto correlacionado (hooks sem registro para este fluxo ou janela).</p>}
            {truncados > 0 && <p class="mudo pequeno" style={{ marginTop: '6px' }}>{truncados} comando(s) mais distante(s) ficaram de fora; use "registrar fluxo {txt(ev.fluxo_id)}" para ver todos.</p>}
            {avisoBrutos && <p class="mudo pequeno" style={{ marginTop: '6px' }}>Leitura parcial do log bruto: {txt(avisoBrutos)}</p>}
          </Recolhivel>
        </Secao>
      </div>
    </>
  );
}

function TabelaBrutos({ brutos, diaEvento }) {
  return (
    <div class="brutos-caixa">
      <table class="tabela cmds">
        <colgroup><col style={{ width: '86px' }} /><col style={{ width: '176px' }} /><col style={{ width: '100px' }} /><col /><col style={{ width: '70px' }} /><col style={{ width: '70px' }} /></colgroup>
        <thead><tr>{['Hora', 'Agente', 'Ferramenta', 'Comando', 'Status', 'Ligação'].map((t) => <th scope="col" key={t}>{t}</th>)}</tr></thead>
        <tbody>
          {brutos.map((c, i) => {
            const texto = c.entrada !== null && c.entrada !== undefined ? txt(c.entrada) : typeof c.prompt === 'string' ? `prompt: ${c.prompt}` : txt(c.erro) || '';
            const ferramenta = c.ferramenta ? txt(c.ferramenta) : c.evento === 'UserPromptSubmit' ? 'prompt' : txt(c.evento) || '—';
            const falhou = c.ok === false || c.evento === 'PostToolUseFailure';
            return (
              <tr key={i} class={falhou ? 'falha' : ''}>
                <td title={dataHoraSeg(c.ts)}>{diaSP(c.ts) === diaEvento ? hora(c.ts) : `${fDiaMes.format(quando(c.ts) || new Date(0))} ${hm(c.ts)}`}</td>
                <td><Agente slug={c.agente} /></td>
                <td title={txt(c.evento)}>{ferramenta}</td>
                <td class="mono" title={truncar(texto, 2000)}>{truncar(texto, 220) || '—'}</td>
                <td>{c.ok === true ? <span class="res" style={{ color: 'var(--ok)' }}><Icone de={Check} tamanho={13} />ok</span> : falhou ? <span class="res" style={{ color: 'var(--perigo)' }}><Icone de={X} tamanho={13} />falha</span> : <span class="mudo">—</span>}</td>
                <td class="mudo" title={c.correlacao === 'janela' ? 'Sem fluxo_id: ligado pela janela de tempo do mesmo agente (§10.4)' : 'Mesmo fluxo_id'}>{c.correlacao === 'janela' ? 'janela' : 'fluxo'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
