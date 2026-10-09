// Visão geral: o que precisa do dono, o quadro, o plano, a atividade da semana, a prospecção e os agentes.
// No cartão fica o número e o sinal; a explicação de cada um fica no ícone (i) ao lado do rótulo.
import '../estilo/visao.css';
import { usePainel } from '../dados/contexto.js';
import { obj, objs, arr, numero, pct, idade, hora, hm, diaSP, agora, fDiaMes, quando, textoMin, txt, plural, horaSP, semanaCurta } from '../dados/formato.js';
import { SEVERIDADES, NOME_SEV, PLURAL_SEV, TOM_SEV, RESULTADOS, RESULTADOS_FALHA, precisaDono, infoAgente, nomeTipo, STATUS_TRELLO } from '../dados/dominio.js';
import { Cartao, Kpi, Selo, Ponto, Anel, Vazio, Esqueleto, InfoDica } from '../componentes/base.jsx';
import { GraficoBarras, Rosca, Sparkline, BarraEmpilhada, Legenda } from '../componentes/graficos.jsx';
import { Agente, Resultado } from '../componentes/dominio.jsx';
import { Icone, ArrowRight, Activity, MessageCircle, RefreshCw } from '../componentes/Icone.jsx';

export function Visao() {
  const { estado } = usePainel();
  if (!estado) return <VisaoEsqueleto />;
  return (
    <div class="tela tela-visao">
      <div class="visao-kpis">
        <KpiPendencias />
        <KpiTrello />
        <KpiAlertas />
        <KpiPlano tipo="5h" />
        <KpiPlano tipo="semanal" />
        <KpiEventosHoje />
      </div>
      <div class="visao-graficos">
        <AtividadeSemana />
        <ResultadosSemana />
        <ResumoProspeccao />
      </div>
      <div class="visao-baixo">
        <ListaAgentes />
        <AtividadeRecente />
      </div>
    </div>
  );
}

function VisaoEsqueleto() {
  const bloco = (n) => Array.from({ length: n }, (_, i) => <div class="cartao" key={i} style={{ padding: '18px' }}><Esqueleto largura="40%" altura={10} /><Esqueleto largura="55%" altura={30} estilo={{ marginTop: '16px' }} /></div>);
  return (
    <div class="tela tela-visao" aria-busy="true">
      <div class="visao-kpis">{bloco(6)}</div>
      <div class="visao-graficos">{bloco(3)}</div>
      <div class="visao-baixo">{bloco(2)}</div>
    </div>
  );
}

// Cor de cada severidade nos pontinhos do cartão de pendências (mesmas cores dos selos).
const COR_TOM = { perigo: 'var(--perigo)', atencao: 'var(--atencao)', azul: 'var(--azul-texto)', neutro: 'var(--mudo)' };

function KpiPendencias() {
  const { estado, irPara } = usePainel();
  const kp = (obj(estado.kpis) && obj(estado.kpis.pendencias)) || { total: 0 };
  const total = kp.total || 0;
  const partes = SEVERIDADES.filter((s) => kp[s]);
  const resumo = partes.map((s) => `${kp[s]} ${kp[s] === 1 ? NOME_SEV[s] : PLURAL_SEV[s]}`).join(' · ');
  return (
    <button type="button" class={`cartao kpi clicavel kpi-dono${kp.critica ? ' critico' : total ? ' destaque' : ''}`} onClick={() => irPara('pendencias')}
      aria-label={`Pendências do dono: ${total} abertas${resumo ? ` (${resumo})` : ''}. Abrir a tela Pendências.`}>
      <span class="rot-linha">
        <span class="rot">Pendências</span>
        <InfoDica titulo="Pendências do dono" texto={total ? `Esperando decisão sua: ${resumo}. Clique para ver e responder na tela Pendências.` : 'Nada esperando por você agora.'} />
      </span>
      <div class="linha-kpi">
        <span class="valor">{total}</span>
        {partes.length > 0 && (
          <span class="sev-mini" aria-hidden="true">
            {partes.map((s) => (
              <span key={s} title={`${kp[s]} ${kp[s] === 1 ? NOME_SEV[s] : PLURAL_SEV[s]}`}><i style={{ background: COR_TOM[TOM_SEV[s]] }} />{kp[s]}</span>
            ))}
          </span>
        )}
      </div>
      {total > 0 && <span class="filete" aria-hidden="true" style={kp.critica ? { background: 'var(--perigo)' } : undefined} />}
    </button>
  );
}

function KpiTrello() {
  const { estado, irPara } = usePainel();
  const kt = obj(estado.kpis) && obj(estado.kpis.trello);
  if (!kt) return <Kpi rotulo="Trello" valor="—" info="O quadro ainda não foi lido pelo Coordenador do Trello." onClick={() => irPara('trello')} />;
  const partes = [
    { chave: 'afazer', nome: STATUS_TRELLO.afazer.nome, valor: kt.a_fazer || 0, cor: STATUS_TRELLO.afazer.cor },
    { chave: 'andamento', nome: STATUS_TRELLO.andamento.nome, valor: kt.em_andamento || 0, cor: STATUS_TRELLO.andamento.cor },
    { chave: 'concluido', nome: STATUS_TRELLO.concluido.nome, valor: kt.concluido || 0, cor: STATUS_TRELLO.concluido.cor },
  ];
  const idadeTrello = estado.saude && estado.saude.trello_idade_min;
  return (
    <Kpi rotulo="Trello · abertas" valor={numero(kt.abertas)} onClick={() => irPara('trello')}
      info={`Tarefas abertas no quadro: ${numero(kt.a_fazer)} a fazer, ${numero(kt.em_andamento)} em andamento e ${numero(kt.concluido)} concluídas aguardando limpeza (a barra mostra a divisão). Leitura do Coordenador ${textoMin(idadeTrello)}.`}
      detalhe={`${numero(kt.a_fazer)} a fazer · ${numero(kt.em_andamento)} em andamento`}>
      <div class="kpi-barra"><BarraEmpilhada partes={partes} rotuloAria="Tarefas por status" /></div>
    </Kpi>
  );
}

function KpiAlertas() {
  const { estado, irPara } = usePainel();
  const kt = obj(estado.kpis) && obj(estado.kpis.trello);
  if (!kt) return <Kpi rotulo="Alertas" valor="—" info="Sem leitura do Trello." onClick={() => irPara('trello')} />;
  return (
    <button type="button" class="cartao kpi clicavel" onClick={() => irPara('trello')}
      aria-label={`Alertas do quadro: ${numero(kt.alertas_decisao)} pedem decisão, ${numero(kt.alertas_mecanicos)} mecânicos. Abrir a tela Trello.`}>
      <span class="rot-linha">
        <span class="rot">Alertas</span>
        <InfoDica titulo="Alertas do quadro" texto={`Consistência do quadro na última leitura: ${numero(kt.alertas_decisao)} pedem decisão sua (cada uma vira pendência) e ${numero(kt.alertas_mecanicos)} são correções mecânicas, que o Coordenador faz quando você liberar.`} />
      </span>
      <div class="kpi-par">
        <div><span class="valor medio">{numero(kt.alertas_decisao)}</span><span class="minimo mudo">decisão</span></div>
        <div><span class="valor medio texto-2">{numero(kt.alertas_mecanicos)}</span><span class="minimo mudo">mecânicos</span></div>
      </div>
    </button>
  );
}

/** "07:10" no mesmo dia; senão "seg 01:00". */
function quandoCurto(v) {
  const d = quando(v);
  if (!d) return '';
  return diaSP(d) === diaSP(agora()) ? hm(d) : `${semanaCurta(d).toLowerCase()} ${hm(d)}`;
}

function KpiPlano({ tipo }) {
  const { estado, irPara } = usePainel();
  const ku = (obj(estado.kpis) && obj(estado.kpis.uso)) || {};
  const valor = tipo === '5h' ? ku.janela_5h_pct : ku.semanal_pct;
  const reset = tipo === '5h' ? ku.reset_5h : ku.reset_semanal;
  const motivo = tipo === '5h' ? ku.janela_5h_motivo : ku.semanal_motivo;
  const tem = typeof valor === 'number';
  const rotulo = tipo === '5h' ? 'Uso 5 h' : 'Uso semanal';
  const nomeLongo = tipo === '5h' ? 'Uso do plano Claude na janela de 5 h' : 'Uso semanal do plano Claude';
  const info = tem
    ? `${nomeLongo}: ${pct(valor)}, lido do Maestri ${textoMin(ku.idade_min)}.${reset ? ` Reinicia ${txt(quandoCurto(reset))}.` : ''} Clique para ver o uso por agente.`
    : `${nomeLongo}: indisponível (${txt(motivo || ku.motivo) || 'sem dado do Maestri'}).`;
  return (
    <button type="button" class="cartao kpi clicavel" onClick={() => irPara('uso')} aria-label={`${nomeLongo}: ${tem ? pct(valor) : 'indisponível'}`}>
      <span class="rot-linha"><span class="rot">{rotulo}</span><InfoDica texto={info} /></span>
      <div class="linha-kpi" style={{ alignItems: 'center' }}>
        <div class="kpi-plano-texto">
          <span class="valor medio">{tem ? Math.round(valor) : '—'}{tem && <small>%</small>}</span>
          {tem && reset
            ? <span class="detalhe reinicio" title={`Reinicia ${quandoCurto(reset)}`}><Icone de={RefreshCw} tamanho={11} />{quandoCurto(reset)}</span>
            : <span class="detalhe">{tem ? 'sem reset' : 'indisponível'}</span>}
        </div>
        <Anel valor={tem ? valor : null} tamanho={54} espessura={5} rotulo={nomeLongo} centro="" />
      </div>
    </button>
  );
}

function KpiEventosHoje() {
  const { estado, analise: a, irPara } = usePainel();
  const ags = objs(estado.agentes);
  const hoje = ags.reduce((s, x) => s + (Number(x.eventos_hoje) || 0), 0);
  const fluxos = ags.reduce((s, x) => s + (Number(x.fluxos_abertos) || 0), 0);
  const horaAgora = horaSP(agora()) ?? 23;
  const serie = a ? a.horasHoje.slice(0, horaAgora + 1) : [];
  return (
    <Kpi rotulo="Eventos hoje" valor={numero(hoje)} onClick={() => irPara('log')}
      info={`Eventos registrados hoje por todos os agentes; as barras mostram as últimas horas. ${plural(fluxos, 'fluxo aberto', 'fluxos abertos')}. Clique para abrir o Log.`}>
      {serie.length > 0 && <Sparkline valores={serie.slice(-14)} largura={86} altura={30} rotuloAria="Eventos por hora hoje" />}
    </Kpi>
  );
}

/** Primeiro nome do agente (legenda curta); o nome inteiro fica na dica do gráfico. */
const curto = (nome) => txt(nome).split(/\s+/)[0] || txt(nome);

function AtividadeSemana() {
  const { estado, analise: a, analitico } = usePainel();
  const series = objs(estado.agentes).map((ag) => ({ chave: ag.slug, nome: ag.nome || ag.slug, cor: infoAgente(estado, ag.slug).cor || 'var(--mudo)' }));
  if (a) {
    const conhecidos = new Set(series.map((s) => s.chave));
    const outros = Object.keys(a.porAgente).filter((k) => !conhecidos.has(k));
    for (const k of outros) series.push({ chave: k, nome: infoAgente(estado, k).nome, cor: 'var(--fraco)' });
  }
  const legenda = series.filter((s) => !a || a.porAgente[s.chave]).map((s) => ({ ...s, nome: curto(s.nome) }));
  return (
    <Cartao rotulo="Atividade · 7 dias" info="Eventos registrados por dia e por agente nos últimos 7 dias. Passe o mouse numa barra para ver o dia."
      extra={a ? `${numero(a.total)} eventos` : analitico.erro ? `sem leitura (${analitico.erro.message})` : 'lendo…'}>
      {a ? (
        <>
          <GraficoBarras dados={a.dias.map((d) => ({ chave: d.dia, rotulo: d.rotulo, titulo: d.titulo, valores: d.valores }))} series={series}
            rotuloAria="Eventos por dia e por agente nos últimos 7 dias" destacarUltimo />
          <div class="legenda-baixo"><Legenda series={legenda} /></div>
        </>
      ) : <Esqueleto altura={200} estilo={{ marginTop: '8px' }} />}
    </Cartao>
  );
}

const ORDEM_RES = ['ok', 'em-andamento', 'parcial', 'aguardando-dono', 'bloqueado', 'falhou'];
function ResultadosSemana() {
  const { analise: a, irPara, setFiltros } = usePainel();
  const info = 'Resultado de cada evento registrado nos últimos 7 dias. Clique numa linha para ver esses eventos no Log.';
  if (!a) return <Cartao rotulo="Resultados · 7 dias" info={info}><Esqueleto altura={200} estilo={{ marginTop: '8px' }} /></Cartao>;
  const fatias = ORDEM_RES.map((r) => ({ chave: r, nome: RESULTADOS[r].rotulo, valor: a.resultados[r] || 0, cor: RESULTADOS[r].cor }));
  const total = fatias.reduce((s, f) => s + f.valor, 0);
  const verLog = (r) => { setFiltros({ resultado: r, periodo: '7d' }); irPara('log'); };
  return (
    <Cartao rotulo="Resultados · 7 dias" info={info} extra={`${numero(a.precisaDono)} pediram você`}>
      <div class="resultados">
        <Rosca fatias={fatias} tamanho={132} espessura={11} centro={numero(total)} sub="eventos" rotuloAria="Resultados dos eventos dos últimos 7 dias" />
        <ul class="legenda-lista">
          {fatias.map((f) => (
            <li key={f.chave}>
              <button type="button" class="link neutro" onClick={() => verLog(f.chave)}
                title={`${f.nome}: ${numero(f.valor)} (${total ? pct(Math.round((f.valor / total) * 1000) / 10) : '—'}). Ver no Log.`}>
                <i style={{ background: f.cor }} /><span class="corta">{f.nome}</span><b class={f.valor ? '' : 'fraco'}>{numero(f.valor)}</b>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Cartao>
  );
}

function ResumoProspeccao() {
  const { prospeccao, irPara } = usePainel();
  const d = prospeccao.dados;
  const info = 'Resumo da prospecção pelo WhatsApp: leads abordados hoje, % que respondeu, qualificados, reuniões marcadas, leads prontos na fila e números de WhatsApp conectados. Abra a tela Prospecção para o detalhe.';
  const abrir = <button type="button" class="link pequeno ir-link" onClick={() => irPara('prospeccao')}>Abrir <Icone de={ArrowRight} tamanho={13} /></button>;
  if (!d) {
    return (
      <Cartao rotulo="Prospecção" info={info} acoes={abrir}>
        {prospeccao.erro ? <Vazio icone={MessageCircle}>Sem dados da prospecção agora ({prospeccao.erro.message}).</Vazio> : <Esqueleto altura={200} estilo={{ marginTop: '8px' }} />}
      </Cartao>
    );
  }
  const op = obj(d.operacao) || {};
  const k = (obj(d.qualificacao) && obj(d.qualificacao.kpis)) || {};
  const kp = (obj(d.prospeccao) && obj(d.prospeccao.kpis)) || {};
  const chips = objs(d.chips);
  const conectados = chips.filter((c) => c.conectado === true).length;
  const desligada = !op.qualificador_ativo && !op.captador_ativo;
  const itens = [
    ['Leads hoje', numero(k.leads_hoje)],
    ['Respostas', typeof k.respostas_pct === 'number' ? `${k.respostas_pct}%` : '—'],
    ['Qualificados', numero(k.qualificados)],
    ['Reuniões', numero(k.reunioes_marcadas)],
    ['Fila pronta', numero(kp.fila)],
    ['WhatsApp', `${numero(conectados)}/${numero(chips.length)}`],
  ];
  return (
    <Cartao rotulo="Prospecção" info={info} acoes={abrir}>
      <div class="selos prosp-selos">
        {op.modo_teste && <Selo tom="azul" cheio>Modo teste</Selo>}
        {desligada ? <Selo>Desligada</Selo> : <>
          <Selo tom={op.qualificador_ativo ? 'ok' : 'neutro'}>Qualificador {op.qualificador_ativo ? 'ligado' : 'desligado'}</Selo>
          <Selo tom={op.captador_ativo ? 'ok' : 'neutro'}>Captador {op.captador_ativo ? 'ligado' : 'desligado'}</Selo>
        </>}
        {chips.length > conectados && <Selo tom="atencao">{chips.length - conectados} sem conexão</Selo>}
      </div>
      <div class="mini-kpis">
        {itens.map(([r, v]) => <div key={r}><span class="rot">{r}</span><span class="mini-valor">{v}</span></div>)}
      </div>
    </Cartao>
  );
}

function ListaAgentes() {
  const { estado, analise: a, abrirModal, irPara } = usePainel();
  const ags = objs(estado.agentes);
  const ids = arr(estado.eventos).map((e) => e && e.id);
  return (
    <Cartao rotulo="Agentes" rola semMargem
      info="O último evento de cada agente e a atividade dos últimos 7 dias (barras). Clique no evento para ver o detalhe; a tela Agentes tem tudo de cada um."
      acoes={<button type="button" class="link pequeno ir-link" onClick={() => irPara('agentes')}>Ver todos <Icone de={ArrowRight} tamanho={13} /></button>}>
      {!ags.length && <Vazio>Nenhum agente em registro/agentes.json.</Vazio>}
      <div class="agentes-linhas">
        {ags.map((ag) => {
          const u = obj(ag.ultimo_evento);
          const cor = infoAgente(estado, ag.slug).cor;
          const nHoje = Number(ag.eventos_hoje) || 0;
          return (
            <div class="agente-linha" key={ag.slug}>
              <div class="agente-cab">
                <Agente slug={ag.slug} tamanho={9} />
                {ag.status && ag.status !== 'ativo' && <Selo>{ag.status}</Selo>}
                <span class="espaco" />
                <span class="mudo minimo">{plural(nHoje, 'evento hoje', 'eventos hoje')}</span>
                {a && <Sparkline valores={a.serieAgente(ag.slug)} largura={70} altura={20} cor={cor || 'var(--mudo)'} rotuloAria={`Eventos de ${ag.nome} por dia, 7 dias`} />}
              </div>
              {u ? (
                <button type="button" class="link neutro agente-ultimo corta" disabled={!u.id} title={txt(u.resumo)}
                  onClick={() => u.id && abrirModal(u.id, ids)}>{txt(u.resumo) || '(sem resumo)'}</button>
              ) : <span class="mudo pequeno">Nenhum evento registrado ainda.</span>}
              {u && (
                <div class="agente-meta">
                  <span title={hora(u.ts)}>{idade(u.ts)} · {nomeTipo(u.tipo)}</span>
                  <Resultado valor={u.resultado} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Cartao>
  );
}

function AtividadeRecente() {
  const { estado, abrirModal, irPara } = usePainel();
  const recentes = objs(estado.eventos).slice(0, 40);
  const ids = recentes.map((e) => e.id);
  const hoje = diaSP(agora());
  return (
    <Cartao rotulo="Atividade recente" rola semMargem
      info="Os últimos eventos de todos os agentes. Fundo azul: precisa de você. Fundo vermelho: falhou ou está bloqueado. Clique para ver o detalhe."
      acoes={<button type="button" class="link pequeno ir-link" onClick={() => irPara('log')}>Abrir o log <Icone de={ArrowRight} tamanho={13} /></button>}>
      {!recentes.length && <Vazio icone={Activity} centro>Nenhum evento registrado ainda.</Vazio>}
      <div class="lista atividade">
        {recentes.map((e) => {
          const classe = RESULTADOS_FALHA.has(e.resultado) ? 'falha' : precisaDono(e) ? 'precisa' : '';
          const ag = infoAgente(estado, e.agente);
          return (
            <button type="button" key={e.id || e.ts} class={`item-lista ${classe}`} onClick={() => abrirModal(e.id, ids)}
              aria-label={`${hora(e.ts)} ${ag.nome}: ${txt(e.resumo)}`}>
              <span class="mudo pequeno" title={hora(e.ts)}>{diaSP(e.ts) === hoje ? hm(e.ts) : `${fDiaMes.format(quando(e.ts) || new Date(0))} ${hm(e.ts)}`}</span>
              <Ponto cor={ag.cor} titulo={ag.nome} />
              <span class="corta" title={txt(e.resumo)}>{txt(e.resumo) || '(sem resumo)'}</span>
              <Resultado valor={e.resultado} />
            </button>
          );
        })}
      </div>
    </Cartao>
  );
}
