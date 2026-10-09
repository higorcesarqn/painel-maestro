// Lead aberto da Prospecção (modal): quem é, a conversa, a qualificação, o score e a pesquisa do Captador,
// e os botões "Assumir conversa" (pausa o agente neste lead) e "Devolver ao agente" (POST com X-Painel: 1).
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { obj, objs, arr, txt, numero } from '../dados/formato.js';
import { lerLeadProspeccao, alterarLeadProspeccao } from '../dados/api.js';
import { Modal } from '../componentes/Modal.jsx';
import { Selo, Esqueleto } from '../componentes/base.jsx';
import { Icone, X, MapPin, Smartphone, UserCheck, Undo2, Calendar } from '../componentes/Icone.jsx';
import {
  NOME_ETAPA, NOME_STATUS, NOME_GANCHO, NOME_QUALIDADE, NOME_ORIGEM, NOME_TEMPERATURA, CAMPOS_QUALIFICACAO,
  nomeDe, doQualificador, relativo, curto, comDia, valorCampo, linkMeet, ecommerce, avaliacoes, NotaBarra, Score,
} from './ProspeccaoComum.jsx';

const QUEM = { agente: 'Agente', lead: 'Lead', humano: 'Você' };

/** id: lead · origem: 'qualificacao' | 'captacao' (muda a ordem das seções) · aoMudar: relê a prospecção. */
export function ModalLead({ id, origem, aoFechar, aoMudar }) {
  const [r, setR] = useState({ dados: null, erro: null });
  const [acao, setAcao] = useState({ andando: false, msg: '' });
  const vivo = useRef(true);
  useEffect(() => () => { vivo.current = false; }, []);
  const carregar = useCallback(async () => {
    try {
      const dados = await lerLeadProspeccao(id);
      if (vivo.current) setR({ dados, erro: null });
    } catch (e) {
      if (vivo.current) setR((x) => ({ ...x, erro: e }));
    }
  }, [id]);
  useEffect(() => { setR({ dados: null, erro: null }); setAcao({ andando: false, msg: '' }); carregar(); }, [id]);

  const alterar = async (qual) => {
    setAcao({ andando: true, msg: qual === 'assumir' ? 'Pausando o agente neste lead…' : 'Devolvendo ao agente…' });
    try {
      await alterarLeadProspeccao(qual, id);
      await carregar();
      if (vivo.current) setAcao({ andando: false, msg: qual === 'assumir' ? 'Pronto: o agente não fala mais com este lead.' : 'Pronto: o agente voltou a cuidar deste lead.' });
      if (aoMudar) aoMudar();
    } catch (e) {
      if (vivo.current) setAcao({ andando: false, msg: `Não deu: ${e.message}` });
      carregar();
    }
  };

  const l = r.dados && obj(r.dados.lead);
  return (
    <Modal aoFechar={aoFechar} rotuloId="pp-lead-titulo" largura={1080}>
      <div class="modal-cab pp-modal-cab">
        <div class="pp-modal-titulo">
          <span class="rot">{l ? (origem === 'captacao' ? 'Candidato do captador' : `Lead · ${nomeDe(NOME_ETAPA, l.etapa || 'novo')}`) : 'Lead'}</span>
          <h2 id="pp-lead-titulo">{l ? txt(l.empresa) || txt(l.nome) || 'Sem nome' : r.erro ? 'Não consegui abrir o lead' : 'Carregando…'}</h2>
          {l && <Meta l={l} portal={r.dados.portal} />}
        </div>
        <button type="button" class="botao icone-so" aria-label="Fechar" title="Fechar (Esc)" onClick={aoFechar}><Icone de={X} /></button>
      </div>
      {l && doQualificador(l) && <Acoes l={l} acao={acao} alterar={alterar} />}
      <div class="modal-corpo">
        {r.erro && !l && <p class="mudo">{r.erro.message}</p>}
        {!l && !r.erro && (
          <div class="pp-modal-grade" aria-busy="true">
            <div class="modal-col"><Esqueleto altura={18} largura="40%" /><Esqueleto altura={90} estilo={{ marginTop: '12px' }} /><Esqueleto altura={160} estilo={{ marginTop: '18px' }} /></div>
            <div class="modal-col"><Esqueleto altura={18} largura="50%" /><Esqueleto altura={120} estilo={{ marginTop: '12px' }} /></div>
          </div>
        )}
        {l && <Corpo l={l} origem={origem} />}
      </div>
    </Modal>
  );
}

function Meta({ l, portal }) {
  const itens = [
    l.cidade && <span key="cid"><Icone de={MapPin} tamanho={13} />{txt(l.cidade)}{l.estado ? `/${txt(l.estado)}` : ''}</span>,
    l.segmento && <span key="seg">{txt(l.segmento)}</span>,
    l.telefone && <span key="tel"><Icone de={Smartphone} tamanho={13} />{txt(l.telefone)}{l.whatsapp_confirmado ? ' · WhatsApp confirmado' : ''}</span>,
    l.numero_whatsapp && <span key="chip">chip {txt(l.numero_whatsapp)}{portal ? ` (${txt(portal)})` : ''}</span>,
    l.instagram && <span key="ig">{txt(l.instagram)}</span>,
    l.origem && <span key="org">origem: {nomeDe(NOME_ORIGEM, l.origem)}</span>,
  ].filter(Boolean);
  return (
    <div class="pp-modal-meta">
      <Selo>{nomeDe(NOME_STATUS, l.status)}</Selo>
      {itens}
    </div>
  );
}

function Acoes({ l, acao, alterar }) {
  const h = obj(l.humano);
  const comHumano = !!(h && h.ativo);
  return (
    <div class="pp-acoes">
      <button type="button" class="botao primario" disabled={comHumano || acao.andando} onClick={() => alterar('assumir')}
        title={comHumano ? 'O lead já está com você' : 'Pausa o agente neste lead: ele não manda mais nada até você devolver'}>
        <Icone de={UserCheck} tamanho={15} />Assumir conversa
      </button>
      <button type="button" class="botao" disabled={!comHumano || acao.andando} onClick={() => alterar('devolver')}
        title={comHumano ? 'O agente volta a cuidar deste lead' : 'O lead está com o agente'}>
        <Icone de={Undo2} tamanho={15} />Devolver ao agente
      </button>
      <span class="pp-acao-status" aria-live="polite">
        {acao.msg || (comHumano ? `Com você desde ${curto(h.desde)} (${relativo(h.desde)})${h.motivo ? ` · ${txt(h.motivo)}` : ''}` : '')}
      </span>
    </div>
  );
}

function Secao({ titulo, children }) {
  return (
    <section class="secao-modal">
      <h3 class="rot">{titulo}</h3>
      {children}
    </section>
  );
}

function Paragrafo({ texto, vazio }) {
  return txt(texto) ? <p class="pp-paragrafo">{txt(texto)}</p> : <p class="mudo pequeno">{vazio}</p>;
}

function Campos({ pares }) {
  return (
    <dl class="pp-campos">
      {pares.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

function Corpo({ l, origem }) {
  const doQ = doQualificador(l);
  const q = obj(l.qualificacao) || {};
  const preenchidos = CAMPOS_QUALIFICACAO.map(([k, rot]) => [rot, valorCampo(q[k])]).filter(([, v]) => v !== null);
  const reuniao = obj(l.reuniao) && l.reuniao.quando ? l.reuniao : null;
  const link = reuniao && linkMeet(reuniao.link);
  const historico = objs(l.historico);
  const temScore = typeof l.prospect_score === 'number';

  const score = temScore && (
    <Secao titulo="Score do captador" key="score">
      <div class="pp-score-linha">
        <Score v={l.prospect_score} grande />
        {l.classificacao && <span>{txt(l.classificacao)}</span>}
        {typeof l.data_confidence === 'number' && <span class="mudo">confiança {numero(l.data_confidence)}</span>}
        {typeof l.distancia_km_aprox === 'number' && <span class="mudo">{numero(l.distancia_km_aprox)} km aprox.</span>}
      </div>
      {arr(l.score_reason).length
        ? <ul class="pp-razoes">{arr(l.score_reason).map((x, i) => <li key={i}>{txt(x)}</li>)}</ul>
        : <p class="mudo pequeno">Sem motivos registrados.</p>}
      {l.discard_reason && <p class="mudo pequeno">Descarte: {txt(l.discard_reason)}</p>}
    </Secao>
  );
  const pesquisa = (
    <Secao titulo="Pesquisa" key="pesquisa">
      <Paragrafo texto={l.pesquisa} vazio="Sem pesquisa." />
      <span class="rot pp-subrot">Observação concreta</span>
      <Paragrafo texto={l.observacao_concreta} vazio="Nenhuma observação concreta." />
      <Campos pares={[
        ['Gancho', nomeDe(NOME_GANCHO, l.gancho)],
        ['Potencial futuro', valorCampo(arr(l.potencial_futuro).map((x) => nomeDe(NOME_GANCHO, x))) || '—'],
        ['Seguidores', numero(l.followers)],
        ['Qualidade do Instagram', nomeDe(NOME_QUALIDADE, l.instagram_quality)],
        ['E-commerce', ecommerce(l)],
        ['Avaliações no Google', avaliacoes(l)],
      ]} />
    </Secao>
  );

  // Lead só do Captador (sem conversa): o score de um lado e a pesquisa do outro.
  if (!doQ && origem === 'captacao') {
    if (!score) return <div class="pp-modal-grade uma"><div class="modal-col">{pesquisa}</div></div>;
    return <div class="pp-modal-grade"><div class="modal-col">{score}</div><div class="modal-col">{pesquisa}</div></div>;
  }
  return (
    <div class="pp-modal-grade">
      <div class="modal-col">
        <Secao titulo="Qualificação">
          <div class="pp-quali-linha">
            <NotaBarra nota={l.nota_conversa} />
            <span><span class="mudo">Temperatura </span>{nomeDe(NOME_TEMPERATURA, l.temperatura)}</span>
            <span><span class="mudo">Próximo follow-up </span>{l.proximo_followup ? `${curto(l.proximo_followup)} (${relativo(l.proximo_followup)})` : '—'}</span>
          </div>
          {preenchidos.length ? <Campos pares={preenchidos} /> : <p class="mudo pequeno">Nada preenchido ainda.</p>}
        </Secao>
        {reuniao && (
          <Secao titulo="Reunião">
            <p class="pp-reuniao">
              <Icone de={Calendar} tamanho={14} />{comDia(reuniao.quando)} ({relativo(reuniao.quando)}){reuniao.confirmada ? ' · confirmada' : ' · a confirmar'}
              {link
                ? <a href={link} target="_blank" rel="noopener noreferrer">{link}</a>
                : reuniao.link ? <span class="mudo">{txt(reuniao.link)}</span> : null}
            </p>
          </Secao>
        )}
        <Secao titulo="Notas para você"><Paragrafo texto={l.notas_para_humano} vazio="Nenhuma nota ainda." /></Secao>
        <Secao titulo={`Conversa (${historico.length})`}>
          {historico.length
            ? (
              <div class="pp-conversa">
                {historico.map((m, i) => {
                  const de = ['agente', 'lead', 'humano'].includes(m.de) ? m.de : 'lead';
                  return (
                    <div class={`pp-msg ${de}`} key={i}>
                      <span class="quem">{QUEM[de]} · {curto(m.quando)}{m.chip ? ` · ${txt(m.chip)}` : ''}</span>
                      <span class="texto">{txt(m.texto)}</span>
                    </div>
                  );
                })}
              </div>
            )
            : <p class="mudo pequeno">Nenhuma mensagem ainda.</p>}
        </Secao>
      </div>
      <div class="modal-col">
        {origem === 'captacao' ? [score, pesquisa].filter(Boolean) : [pesquisa, score].filter(Boolean)}
      </div>
    </div>
  );
}
