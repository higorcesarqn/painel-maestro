// Prospecção: a operação do WhatsApp dentro do painel (grupo Operações do menu).
// Sub-abas: Qualificação (#prospeccao: números do funil, kanban por etapa, "Para você agora" e os números
// de WhatsApp) e Captação (#prospeccao/captacao: o que o Captador descobre e pontua, faixas, sem contato
// e Serper). Dados de /api/prospeccao/estado, relidos pelo App a cada 30 s enquanto a tela está aberta.
import '../estilo/prospeccao.css';
import { useMemo, useRef, useState } from 'preact/hooks';
import { usePainel } from '../dados/contexto.js';
import { obj, objs, numero, compacto, hora, txt } from '../dados/formato.js';
import { Cartao, Kpi, Selo, Segmentado, Vazio, Esqueleto, InfoDica } from '../componentes/base.jsx';
import { Selecao } from '../componentes/campos.jsx';
import { Icone, Clock, Calendar, Smartphone, TriangleAlert, X, MessageCircle, Info } from '../componentes/Icone.jsx';
import {
  ETAPAS_PRINCIPAIS, ETAPAS_SAIDA, NOME_ETAPA, NOME_GANCHO, NOME_ORIGEM, NOME_STATUS, NOME_QUALIDADE,
  nomeDe, relativo, curto, comDia, ecommerce, avaliacoes, NotaBarra, Temperatura, Score,
} from './ProspeccaoComum.jsx';
import { ModalLead } from './ProspeccaoLead.jsx';

const FILTRO_VAZIO = { segmento: '', chip: '', temperatura: '', origem: '' };
let filtrosGuardados = FILTRO_VAZIO; // os filtros do funil sobrevivem à troca de tela
const COMANDO_IMPORTAR = 'node bin/prospeccao/leads.js importar <arquivo.csv>';
const COMANDO_CHIP = 'node bin/prospeccao/chips.js adicionar chip-01 --portal "WhatsApp chip-01"';

export function Prospeccao() {
  const { prospeccao, subrota, irPara, carregarProspeccao } = usePainel();
  const sub = subrota === 'captacao' ? 'captacao' : 'qualificacao';
  const d = obj(prospeccao.dados);
  const [aberto, setAberto] = useState(null); // { id, origem }
  const abrir = (id, origem) => { if (id) setAberto({ id, origem }); };

  let corpo;
  if (d) corpo = sub === 'captacao' ? <Captacao d={d} abrir={abrir} /> : <Qualificacao d={d} abrir={abrir} />;
  else if (prospeccao.erro) {
    corpo = (
      <Cartao rotulo="Prospecção" class="pp-erro">
        <Vazio icone={MessageCircle} centro>Não consegui ler a prospecção ({prospeccao.erro.message}). Tento de novo a cada 30 s.</Vazio>
      </Cartao>
    );
  } else corpo = <Carregando sub={sub} />;

  return (
    <div class="tela tela-prosp">
      <Barra d={d} sub={sub} erro={prospeccao.erro} aoTrocar={(id) => irPara('prospeccao', id === 'captacao' ? 'captacao' : '')} />
      {corpo}
      {aberto && <ModalLead id={aberto.id} origem={aberto.origem} aoFechar={() => setAberto(null)} aoMudar={carregarProspeccao} />}
    </div>
  );
}

// ---------- barra: sub-abas, situação da operação, leitura ----------

function Barra({ d, sub, erro, aoTrocar }) {
  const op = d && obj(d.operacao);
  const kb = d && obj(d.qualificacao) && obj(d.qualificacao.kanban);
  const noFunil = kb ? Object.values(kb).reduce((s, c) => s + ((obj(c) && Number(c.total)) || 0), 0) : undefined;
  const naCaptacao = d && obj(d.prospeccao) && obj(d.prospeccao.tabela) ? Number(d.prospeccao.tabela.total) || 0 : undefined;
  const vigia = d && obj(d.vigia);
  return (
    <div class="pp-barra">
      <Segmentado rotulo="Sub-abas da prospecção" valor={sub} aoMudar={aoTrocar}
        opcoes={[{ id: 'qualificacao', nome: 'Qualificação', n: noFunil }, { id: 'captacao', nome: 'Captação', n: naCaptacao }]} />
      {op && <SelosOperacao op={op} />}
      <span class="espaco" />
      {d && (
        <span class={`pp-lido${erro ? ' erro' : ''}`} title={erro ? `Sem resposta: ${erro.message}` : undefined}>
          <Icone de={Clock} tamanho={14} />
          {erro ? `Sem resposta · mostrando a leitura das ${hora(d.gerado_em)}` : `Lido às ${hora(d.gerado_em)}`}
          {vigia && <span class="mudo"> · vigia {vigia.atualizado_em ? relativo(vigia.atualizado_em) : 'sem leitura'}</span>}
        </span>
      )}
    </div>
  );
}

function SelosOperacao({ op }) {
  const janela = obj(op.janela) || {};
  const selos = [];
  if (op.modo_teste) selos.push(<Selo key="teste" tom="azul" titulo={`Só envia para os ${op.numeros_teste || 0} número(s) de teste e para o humano responsável.`}>Modo teste</Selo>);
  if (!op.qualificador_ativo && !op.captador_ativo) selos.push(<Selo key="op" titulo="Qualificador e Captador desligados em operacao.json">Operação desligada</Selo>);
  else {
    if (op.qualificador_ativo && op.captador_ativo) selos.push(<Selo key="op" tom="ok">Operação ligada</Selo>);
    if (!op.qualificador_ativo) selos.push(<Selo key="q">Qualificador desligado</Selo>);
    if (!op.captador_ativo) selos.push(<Selo key="c">Captador desligado</Selo>);
  }
  if (op.existe === false) selos.push(<Selo key="arq" tom="teste" titulo="estado/prospeccao/operacao.json ainda não existe: valem os padrões do contrato">Sem operacao.json</Selo>);
  if (janela.abordagem_texto) {
    selos.push(
      <Selo key="janela" tom={janela.abordagem ? 'ok' : undefined} titulo="Janela de abordagem (mensagem nova) do contrato; respostas têm janela própria">
        Abordagem {txt(janela.abordagem_texto)} · {janela.abordagem ? 'aberta' : 'fechada'}
      </Selo>,
    );
  }
  return <div class="selos pp-selos">{selos}</div>;
}

function Carregando({ sub }) {
  const n = sub === 'captacao' ? 6 : 5;
  return (
    <>
      <div class={`pp-kpis${n === 6 ? ' seis' : ''}`} aria-hidden="true">
        {Array.from({ length: n }, (_, i) => (
          <div class="cartao kpi" key={i}><Esqueleto largura="55%" altura={10} /><Esqueleto largura={64} altura={30} /><Esqueleto largura="70%" altura={10} /></div>
        ))}
      </div>
      <div class="pp-meio" aria-busy="true">
        <div class="cartao pp-esqueleto"><Esqueleto altura={0} estilo={{ height: '100%' }} /></div>
        <div class="pp-lado">
          <div class="cartao pp-esqueleto" style={{ flex: 1 }}><Esqueleto altura={0} estilo={{ height: '100%' }} /></div>
          <div class="cartao pp-esqueleto" style={{ height: '220px', flex: 'none' }}><Esqueleto altura={0} estilo={{ height: '100%' }} /></div>
        </div>
      </div>
    </>
  );
}

// ---------- Qualificação ----------

function Qualificacao({ d, abrir }) {
  const q = obj(d.qualificacao) || {};
  const k = obj(q.kpis) || {};
  const chips = objs(d.chips);
  const temPct = typeof k.respostas_pct === 'number';
  return (
    <>
      <div class="pp-kpis">
        <Kpi rotulo="Leads hoje" medio valor={numero(k.leads_hoje)} detalhe={`${numero(k.novos_hoje)} novos na base`}
          info="Leads que receberam a primeira mensagem hoje. Novos na base: leads que entraram hoje (captador ou importação)." />
        <Kpi rotulo="Respostas" medio valor={temPct ? numero(k.respostas_pct) : '—'} unidade={temPct ? '%' : undefined}
          detalhe={`${numero(k.responderam_total)} de ${numero(k.abordados_total)} abordados`} info="Quantos dos leads já abordados responderam pelo menos uma vez." />
        <Kpi rotulo="Qualificados" medio valor={numero(k.qualificados)} detalhe="nota 60+"
          info="Nota 60 ou mais com a dor identificada. Reunião marcada também conta." />
        <Kpi rotulo="Reuniões" medio valor={numero(k.reunioes_marcadas)} detalhe={`${numero(k.reunioes_48h)} nas próximas 48 h`} destaque={k.reunioes_48h > 0}
          info="Reuniões marcadas com leads ainda ativos na conversa." />
        <Kpi rotulo="WhatsApp ativos" medio valor={numero(k.chips_ativos)} unidade={`/ ${numero(k.chips_total)}`} detalhe="números prontos para abordar"
          info="Números ativos (não pausados) sobre o total cadastrado em chips.json." />
      </div>
      <div class="pp-meio">
        <Funil kanban={obj(q.kanban) || {}} chips={chips} abrir={abrir} />
        <div class="pp-lado">
          <ParaVoce pv={obj(q.para_voce) || {}} abrir={abrir} />
          <Chips chips={chips} />
        </div>
      </div>
    </>
  );
}

/** Kanban do qualificador: as 8 etapas do funil e uma coluna "Saídas" (sem resposta, perdido, desqualificado). */
function Funil({ kanban, chips, abrir }) {
  const [f, setF] = useState(filtrosGuardados);
  const mudar = (campo, v) => { const n = { ...f, [campo]: v }; filtrosGuardados = n; setF(n); };
  const limpar = () => { filtrosGuardados = FILTRO_VAZIO; setF(FILTRO_VAZIO); };
  const caixa = useRef(null);

  const colunas = useMemo(() => {
    const col = (e) => obj(kanban[e]) || { total: 0, leads: [] };
    const extras = Object.keys(kanban).filter((e) => !ETAPAS_PRINCIPAIS.includes(e) && !ETAPAS_SAIDA.includes(e));
    const principais = [...ETAPAS_PRINCIPAIS, ...extras].map((e) => ({
      id: e, nome: nomeDe(NOME_ETAPA, e), total: Number(col(e).total) || 0, leads: objs(col(e).leads), saida: false,
    }));
    const saidas = ETAPAS_SAIDA.map((e) => ({ id: e, total: Number(col(e).total) || 0, leads: objs(col(e).leads) }));
    return [...principais, {
      id: 'saidas', nome: 'Saídas', saida: true, partes: saidas,
      total: saidas.reduce((s, c) => s + c.total, 0), leads: saidas.flatMap((c) => c.leads),
    }];
  }, [kanban]);

  const leads = colunas.flatMap((c) => c.leads);
  const distintos = (fn) => [...new Set(leads.map(fn).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'));
  const segmentos = distintos((l) => l.segmento);
  const numeros = [...new Set([...chips.map((c) => c.id), ...distintos((l) => l.chip)])].filter(Boolean).sort();
  const origens = [...new Set(['captador', 'importado', ...distintos((l) => l.origem)])];
  const filtrando = Object.values(f).some(Boolean);
  const passa = (l) => (!f.segmento || l.segmento === f.segmento) && (!f.chip || l.chip === f.chip)
    && (!f.temperatura || l.temperatura === f.temperatura) && (!f.origem || l.origem === f.origem);
  const total = colunas.reduce((s, c) => s + c.total, 0);
  const irEtapa = (id) => {
    const el = caixa.current && caixa.current.querySelector(`[data-etapa="${id}"]`);
    if (el) caixa.current.scrollTo({ left: el.offsetLeft - caixa.current.offsetLeft - 18, behavior: 'smooth' });
  };

  const filtros = (
    <div class="pp-filtros">
      <Selecao valor={f.segmento} aoMudar={(v) => mudar('segmento', v)} rotuloAria="Filtrar por segmento" largura={168}
        opcoes={[['', 'Segmento: todos'], ...segmentos.map((s) => [s, s])]} />
      <Selecao valor={f.chip} aoMudar={(v) => mudar('chip', v)} rotuloAria="Filtrar por número de WhatsApp" largura={150}
        opcoes={[['', 'Número: todos'], ...numeros.map((n) => [n, n])]} />
      <Selecao valor={f.temperatura} aoMudar={(v) => mudar('temperatura', v)} rotuloAria="Filtrar por temperatura" largura={168}
        opcoes={[['', 'Temperatura: todas'], ['frio', 'Frio'], ['morno', 'Morno'], ['quente', 'Quente']]} />
      <Selecao valor={f.origem} aoMudar={(v) => mudar('origem', v)} rotuloAria="Filtrar por origem" largura={150}
        opcoes={[['', 'Origem: todas'], ...origens.map((o) => [o, nomeDe(NOME_ORIGEM, o)])]} />
      {filtrando && <button type="button" class="botao pequeno" onClick={limpar}><Icone de={X} tamanho={13} />Limpar</button>}
    </div>
  );

  return (
    <Cartao rotulo="Funil" class="pp-funil" corpoClass="pp-funil-corpo" acoes={filtros}
      info="Cada lead na etapa em que o Qualificador está com ele. Clique numa etapa para ir até a coluna e num cartão para abrir o lead.">
      <div class="pp-etapas" role="list" aria-label="Etapas do funil">
        {colunas.map((c) => {
          const n = filtrando ? c.leads.filter(passa).length : c.total;
          return (
            <button type="button" role="listitem" key={c.id} class={`pp-etapa${c.saida ? ' saida' : ''}${n ? '' : ' zero'}`} onClick={() => irEtapa(c.id)}
              title={c.saida ? c.partes.map((p) => `${nomeDe(NOME_ETAPA, p.id)}: ${p.total}`).join(' · ') : `Ir para ${c.nome}`}>
              {c.nome}<b>{numero(n)}</b>
            </button>
          );
        })}
      </div>
      {!total && (
        <div class="pp-sem-leads">
          <Icone de={Info} tamanho={15} />
          <span>Nenhum lead com o Qualificador ainda.</span>
          <InfoDica titulo="Como os leads entram aqui">
            O Captador põe na fila quem tem score 60+ e celular. Você também pode importar uma lista com <span class="mono">{COMANDO_IMPORTAR}</span>.
          </InfoDica>
        </div>
      )}
      <div class="pp-kanban" ref={caixa} aria-label="Leads por etapa">
        {colunas.map((c) => {
          const visiveis = c.leads.filter(passa);
          return (
            <section class={`pp-coluna${c.saida ? ' saida' : ''}`} key={c.id} data-etapa={c.id} aria-label={`${c.nome}: ${c.total}`}>
              <header class="pp-coluna-cab">
                <span class="rot">{c.nome}</span>
                <span class="n">{filtrando ? `${visiveis.length} de ${c.total}` : numero(c.total)}</span>
              </header>
              <div class="pp-coluna-lista">
                {visiveis.length
                  ? visiveis.map((l) => <CartaoLead key={l.id} l={l} saida={c.saida} abrir={abrir} />)
                  : <div class="pp-coluna-vazia">{c.total ? 'Nenhum com esses filtros' : 'Vazio'}</div>}
                {c.total > c.leads.length && <div class="pp-mais">mostrando {numero(c.leads.length)} de {numero(c.total)}</div>}
              </div>
            </section>
          );
        })}
      </div>
    </Cartao>
  );
}

function CartaoLead({ l, saida, abrir }) {
  const humano = obj(l.humano);
  const reuniao = obj(l.reuniao);
  return (
    <button type="button" class={`pp-lead${humano ? ' humano' : ''}`} onClick={() => abrir(l.id, 'qualificacao')}>
      <span class="pp-lead-topo">
        <span class="pp-empresa duas-linhas">{txt(l.empresa) || 'Sem nome'}</span>
        <Temperatura t={l.temperatura} />
      </span>
      {saida && <span class="pp-saida-nome">{nomeDe(NOME_ETAPA, l.etapa)}</span>}
      {typeof l.nota_conversa !== 'number' && typeof l.prospect_score === 'number'
        ? <NotaBarra nota={l.prospect_score} rotulo="Score" />
        : <NotaBarra nota={l.nota_conversa} />}
      {l.gancho && <span class="pp-gancho">{nomeDe(NOME_GANCHO, l.gancho)}</span>}
      <span class="pp-meta">
        {l.ultimo_contato_em && <span title={`Último contato: ${curto(l.ultimo_contato_em)}`}><Icone de={Clock} tamanho={12} />{relativo(l.ultimo_contato_em)}</span>}
        {reuniao && reuniao.quando
          ? <span title="Reunião"><Icone de={Calendar} tamanho={12} />reunião {comDia(reuniao.quando)}</span>
          : l.proximo_followup && <span title="Próximo follow-up"><Icone de={Calendar} tamanho={12} />follow-up {curto(l.proximo_followup)}</span>}
        {l.chip && <span><Icone de={Smartphone} tamanho={12} />{l.chip}</span>}
      </span>
      {humano && <span class="pp-com-voce">{humano.por === 'painel' ? 'Você assumiu' : 'Passado para você'}</span>}
    </button>
  );
}

/** "Para você agora": reuniões das próximas 48 h, quentes sem reunião e os leads nas mãos do humano. */
function ParaVoce({ pv, abrir }) {
  const secoes = [
    {
      id: 'reunioes', nome: 'Reuniões nas próximas 48 h', itens: objs(pv.reunioes_48h), vazio: 'Nenhuma reunião nas próximas 48 h.',
      linha2: (l) => `${comDia(obj(l.reuniao) && l.reuniao.quando)}${obj(l.reuniao) && l.reuniao.confirmada ? ' · confirmada' : ' · a confirmar'}`,
    },
    {
      id: 'quentes', nome: 'Quentes sem reunião', itens: objs(pv.quentes_sem_reuniao), vazio: 'Nenhum lead quente sem reunião.',
      linha2: (l) => `${nomeDe(NOME_ETAPA, l.etapa)} · último contato ${relativo(l.ultimo_contato_em)}`,
    },
    {
      id: 'humano', nome: 'Passados para você', itens: objs(pv.com_humano), vazio: 'Nenhum lead nas suas mãos.',
      linha2: (l) => { const h = obj(l.humano) || {}; return `${h.por === 'painel' ? 'Você assumiu' : txt(h.motivo) || 'Passado pelo agente'} · ${relativo(h.desde)}`; },
    },
  ];
  return (
    <Cartao rotulo="Para você agora" rola class="pp-para-voce"
      info="O que pede você: reuniões que vêm aí, leads quentes ainda sem reunião e as conversas que o agente passou (ou que você assumiu).">
      {secoes.map((s) => (
        <div class="pp-pv-secao" key={s.id}>
          <span class="rot">{s.nome}{s.itens.length ? <b class="pp-pv-n">{s.itens.length}</b> : null}</span>
          {s.itens.length
            ? (
              <ul class="lista">
                {s.itens.map((l) => (
                  <li key={l.id}>
                    <button type="button" class="item-lista pp-item" onClick={() => abrir(l.id, 'qualificacao')}>
                      <span class="pp-item-l1">
                        <span class="corta">{txt(l.empresa) || 'Sem nome'}</span>
                        {typeof l.nota_conversa === 'number' && <span class={l.nota_conversa >= 70 ? 'azul' : 'mudo'}>{l.nota_conversa}</span>}
                      </span>
                      <span class="pp-item-l2 corta">{s.linha2(l)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
            : <p class="pp-pv-vazio">{s.vazio}</p>}
        </div>
      ))}
    </Cartao>
  );
}

/** Números de WhatsApp: conexão (vigia), não lidas, abordagens de hoje e avisos. */
function Chips({ chips }) {
  return (
    <Cartao rotulo="WhatsApp" class="pp-chips-cartao"
      info="Situação de cada número: conexão e não lidas vêm da Vigia WhatsApp (a cada 30 s); abordagens e mensagens são as de hoje.">
      {!chips.length
        ? (
          <Vazio icone={Smartphone}>
            <span>Nenhum número cadastrado. <InfoDica titulo="Cadastrar um número"><span class="mono">{COMANDO_CHIP}</span></InfoDica></span>
          </Vazio>
        )
        : (
          <div class="pp-chips">
            {chips.map((c) => {
              const on = c.status === 'ativo' && c.conectado !== false;
              const conexao = c.conectado === true ? 'conectado' : c.conectado === false ? 'desconectado' : 'sem sinal da vigia';
              const desconectado = c.conectado === false;
              const avisos = [];
              if (c.status === 'pausado') avisos.push(`Pausado${c.pausado_ate ? ` até ${curto(c.pausado_ate)}` : ''}${c.motivo_pausa ? `: ${c.motivo_pausa}` : ''}`);
              else if (c.status !== 'ativo' && !(c.status === 'desconectado' && desconectado)) avisos.push(`Chip ${c.status}`);
              if (desconectado) avisos.push('WhatsApp desconectado: abra o portal e leia o QR.');
              if (c.erro_vigia && c.sinal_fresco) avisos.push(`Vigia: ${c.erro_vigia}`);
              const tom = c.status === 'ativo' ? (desconectado ? 'perigo' : 'ok') : c.status === 'pausado' ? 'atencao' : 'perigo';
              return (
                <div class="pp-chip" key={c.id}>
                  <span class="pp-chip-topo">
                    <span class={`pp-on${on ? ' on' : ''}`} aria-hidden="true" />
                    <Icone de={Smartphone} tamanho={14} />
                    <span class="pp-chip-id">{c.id}</span>
                    <Selo tom={tom}>{c.status}</Selo>
                    <span class="espaco" />
                    {conexao !== c.status && <span class="pp-chip-conexao">{conexao}</span>}
                  </span>
                  <span class="pp-chip-linha">
                    <span>Abordagens <b>{numero(c.abordagens_hoje)}/{numero(c.limite)}</b></span>
                    <span>{numero(c.mensagens_hoje)} msg</span>
                    {c.nao_lidas !== null && c.nao_lidas !== undefined && <span class={c.nao_lidas ? 'azul' : ''}>{numero(c.nao_lidas)} não lida(s)</span>}
                  </span>
                  {avisos.map((a) => <span class="pp-aviso" key={a}><Icone de={TriangleAlert} tamanho={13} />{a}</span>)}
                  {!avisos.length && c.motivo && <span class="pp-chip-motivo">{c.motivo}</span>}
                </div>
              );
            })}
          </div>
        )}
    </Cartao>
  );
}

// ---------- Captação ----------

function Captacao({ d, abrir }) {
  const p = obj(d.prospeccao) || {};
  const k = obj(p.kpis) || {};
  const dias = typeof k.dias_fila === 'number' ? k.dias_fila : null;
  const meta = typeof k.dias_minimos === 'number' ? k.dias_minimos : null;
  return (
    <>
      <div class="pp-kpis seis">
        <Kpi rotulo="Descobertos" medio valor={numero(k.descobertos_hoje)} detalhe="hoje" info="Lojas novas que o Captador achou hoje pelo Serper." />
        <Kpi rotulo="Investigados" medio valor={numero(k.investigados_hoje)} detalhe="hoje" info="Lojas que o Captador avaliou hoje (Instagram, site e Google)." />
        <Kpi rotulo="Aprovados 60+" medio valor={numero(k.aprovados)} detalhe={`${numero(k.aprovados_hoje)} hoje`} info="Score 60 ou mais. Com celular, entram na fila do Qualificador." />
        <Kpi rotulo="Descartados" medio valor={numero(k.descartados)} detalhe={`${numero(k.descartados_hoje)} hoje`} info="Descartados pelo Captador: score abaixo de 60 ou fora do perfil." />
        <Kpi rotulo="Prontos na fila" medio valor={numero(k.fila)} detalhe={`mínimo ${numero(k.fila_minima)}`}
          info="Leads com score 60+ e celular esperando a primeira mensagem. Mínimo: capacidade diária × dias de fila da meta." />
        <Kpi rotulo="Dias de fila" medio valor={dias === null ? '—' : numero(dias)} detalhe={dias === null ? 'sem chip ativo' : `meta: ${numero(meta)} dias`}
          destaque={dias !== null && meta !== null && dias >= meta} info="Quantos dias de abordagem a fila pronta garante no ritmo atual (fila ÷ capacidade diária)." />
      </div>
      <div class="pp-meio">
        <TabelaCaptador t={obj(p.tabela) || {}} abrir={abrir} />
        <div class="pp-lado">
          <Faixas k={k} />
          <SemContato sc={obj(p.sem_contato) || {}} abrir={abrir} />
          <Serper s={obj(p.serper) || {}} />
        </div>
      </div>
    </>
  );
}

function TabelaCaptador({ t, abrir }) {
  const leads = objs(t.leads);
  const total = Number(t.total) || 0;
  const extra = total > leads.length ? `mostrando ${numero(leads.length)} de ${numero(total)}` : `${numero(total)} candidato(s)`;
  const tecla = (ev, id) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); abrir(id, 'captacao'); } };
  return (
    <Cartao rotulo="Candidatos" extra={extra} rola semMargem class="pp-candidatos"
      info="Tudo o que o Captador descobriu e pontuou, do maior score para o menor (empate: confiança, depois distância). Clique numa linha para abrir.">
      {!leads.length
        ? <Vazio icone={MessageCircle} centro>Nenhum candidato ainda. O Captador começa pela cidade-base e segue em anéis de distância.</Vazio>
        : (
          <table class="tabela pp-tabela">
            <colgroup>
              <col style={{ width: '100px' }} /><col /><col style={{ width: '136px' }} /><col style={{ width: '104px' }} />
              <col style={{ width: '112px' }} /><col style={{ width: '84px' }} /><col style={{ width: '126px' }} /><col style={{ width: '118px' }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Score</th><th scope="col">Empresa</th><th scope="col">Cidade</th><th scope="col">WhatsApp</th>
                <th scope="col">Loja online</th><th scope="col">Google</th><th scope="col">Gancho</th><th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => {
                const ig = [l.instagram, typeof l.followers === 'number' ? `${compacto(l.followers)} seguidores` : null].filter(Boolean).join(' · ');
                const qualidade = l.instagram_quality ? `Instagram ${nomeDe(NOME_QUALIDADE, l.instagram_quality).toLowerCase()}` : null;
                return (
                  <tr key={l.id} class="clicavel" tabindex="0" onClick={() => abrir(l.id, 'captacao')} onKeyDown={(ev) => tecla(ev, l.id)}>
                    <td title={typeof l.data_confidence === 'number' ? `Confiança dos dados: ${l.data_confidence}` : undefined}>
                      <span class="pp-l1"><Score v={l.prospect_score} /></span>
                      <span class="pp-l2">{txt(l.classificacao) || '—'}</span>
                    </td>
                    <td title={[txt(l.empresa), ig, qualidade].filter(Boolean).join(' · ')}>
                      <span class="pp-l1">{txt(l.empresa) || 'Sem nome'}</span>
                      <span class="pp-l2">{ig || '—'}</span>
                    </td>
                    <td>
                      <span class="pp-l1">{txt(l.cidade) || '—'}</span>
                      <span class="pp-l2">{typeof l.distancia_km_aprox === 'number' ? `${numero(l.distancia_km_aprox)} km` : '—'}</span>
                    </td>
                    <td><span class={`pp-l1${l.whatsapp_confirmado ? ' azul' : l.tem_celular ? '' : ' mudo'}`}>{l.whatsapp_confirmado ? 'Confirmado' : l.tem_celular ? 'Celular' : 'Sem celular'}</span></td>
                    <td><span class="pp-l1">{ecommerce(l)}</span></td>
                    <td>
                      <span class="pp-l1">{avaliacoes(l).split(' · ')[0]}</span>
                      <span class="pp-l2">{typeof l.google_rating === 'number' ? `nota ${String(l.google_rating).replace('.', ',')}` : ''}</span>
                    </td>
                    <td><span class="pp-l1">{nomeDe(NOME_GANCHO, l.gancho)}</span></td>
                    <td><span class="pp-l1 mudo">{nomeDe(NOME_STATUS, l.status)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
    </Cartao>
  );
}

function Faixas({ k }) {
  const fx = obj(k.faixas) || {};
  return (
    <Cartao rotulo="Aprovados por faixa" class="pp-faixas-cartao"
      info="Leads com score em cada faixa. Cada faixa inclui as de cima (60+ conta também os de 70+, 80+ e 90+).">
      <div class="pp-faixas">
        {['60+', '70+', '80+', '90+'].map((x) => (
          <div key={x}><span class="rot">{x}</span><b>{numero(fx[x])}</b></div>
        ))}
      </div>
      <span class="pp-capacidade">{numero(k.chips_ativos)} chip(s) ativo(s) · {numero(k.capacidade_diaria)} abordagens por dia</span>
    </Cartao>
  );
}

function SemContato({ sc, abrir }) {
  const leads = objs(sc.leads);
  const total = Number(sc.total) || leads.length;
  return (
    <Cartao rotulo="Score alto sem contato" extra={total ? numero(total) : undefined} rola class="pp-sem-contato"
      info="Score 60 ou mais, mas sem celular: vale procurar o WhatsApp à mão.">
      {!leads.length
        ? <p class="pp-pv-vazio">Nenhum lead com score alto sem contato.</p>
        : (
          <ul class="lista">
            {leads.map((l) => (
              <li key={l.id}>
                <button type="button" class="item-lista pp-item" onClick={() => abrir(l.id, 'captacao')}>
                  <span class="pp-item-l1"><span class="corta">{txt(l.empresa) || 'Sem nome'}</span><Score v={l.prospect_score} /></span>
                  <span class="pp-item-l2 corta">{[l.cidade, l.instagram].filter(Boolean).join(' · ') || '—'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </Cartao>
  );
}

function Serper({ s }) {
  const numeros = [['Chamadas', s.total], ['Pagas', s.pagas], ['Do cache', s.cache], ['Com erro', s.erros]];
  return (
    <Cartao rotulo="Serper hoje" class="pp-serper-cartao"
      info="Buscas do Captador no Serper hoje. Do cache: repetidas em até 30 dias, sem custo. Só as pagas gastam crédito.">
      <div class="pp-serper">
        {numeros.map(([n, v]) => <div key={n}><span class="rot">{n}</span><b class={n === 'Com erro' && v ? 'pp-erro-num' : ''}>{numero(v)}</b></div>)}
      </div>
      {s.disponivel === false
        ? <span class="pp-chave mudo">Uso do Serper indisponível agora.</span>
        : s.tem_chave
          ? <span class="pp-chave mudo">Chave configurada.</span>
          : (
            <span class="pp-chave azul">
              Falta a chave do Serper.
              <InfoDica titulo="Onde criar a chave"><span class="mono">.segredos/serper.key</span></InfoDica>
            </span>
          )}
    </Cartao>
  );
}
