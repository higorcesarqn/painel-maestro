// Uso do Claude (§12): o plano da conta (5 h e semanal, do Maestri) e a participação estimada de cada agente.
// As explicações (fórmula, de onde vem cada número) ficam no ícone (i) de cada cartão.
import '../estilo/uso.css';
import { useState } from 'preact/hooks';
import { usePainel } from '../dados/contexto.js';
import { obj, objs, arr, txt, numero, compacto, pct, hora, hm, idade, dataHora, textoMin, diaSP, diaMes, quando, agora, semanaCurta } from '../dados/formato.js';
import { PERIODOS_USO, infoAgente } from '../dados/dominio.js';
import { Cartao, Anel, Segmentado, Vazio } from '../componentes/base.jsx';
import { ListaBarras, BarraEmpilhada, Legenda } from '../componentes/graficos.jsx';
import { Agente } from '../componentes/dominio.jsx';
import { Icone, Info, RefreshCw } from '../componentes/Icone.jsx';

// Partes do consumo relativo (entrada + 5 × saída + 1,25 × escrita de cache + 0,1 × leitura de cache).
const PARTES = [
  { chave: 'entrada', nome: 'entrada', peso: 1, cor: '#F5F5F5' },
  { chave: 'saida', nome: 'saída × 5', peso: 5, cor: 'var(--azul-texto)' },
  { chave: 'cache_escrita', nome: 'cache escrito × 1,25', peso: 1.25, cor: 'var(--texto-2)' },
  { chave: 'cache_leitura', nome: 'cache lido × 0,1', peso: 0.1, cor: 'var(--fraco)' },
];

export function Uso() {
  const { estado, recalcular, recalculando } = usePainel();
  const [periodoTokens, setPeriodoTokens] = useState('janela_5h');
  if (!estado) return null;
  const ku = (obj(estado.kpis) && obj(estado.kpis.uso)) || {};
  const uso = obj(estado.uso);
  const plano = (uso && obj(uso.plano)) || {};
  const periodos = (uso && obj(uso.periodos)) || {};
  const porAgente = (uso && obj(uso.por_agente)) || {};
  const col = obj(estado.coletor);
  const ult = col && obj(col.ultima);
  const coleta = uso && obj(uso.coleta);
  const nota = (() => {
    const n = txt(uso && uso.nota).trim() || 'O % por agente é estimado; o % do plano vem do Maestri/Claude';
    return `${n.charAt(0).toUpperCase()}${n.slice(1)}${/[.!?]$/.test(n) ? '' : '.'}`;
  })();
  const avisos = arr(uso && uso.avisos);

  return (
    <div class="tela tela-uso">
      <div class="uso-topo">
        <CartaoPlano titulo="Janela de 5 h" valor={ku.janela_5h_pct} reset={ku.reset_5h} motivo={ku.janela_5h_motivo} ku={ku} />
        <CartaoPlano titulo="Semanal" valor={ku.semanal_pct} reset={ku.reset_semanal} motivo={ku.semanal_motivo} ku={ku} />
        <Cartao rotulo="Fonte e coletor"
          info="O % do plano vem do provedor Claude do Maestri (o mesmo dos anéis do app). O consumo por agente é calculado pelo coletor a partir das transcrições das sessões de cada agente."
          acoes={<button type="button" class="botao pequeno" disabled={recalculando} onClick={recalcular}><Icone de={RefreshCw} tamanho={13} />{recalculando ? 'Recalculando…' : 'Recalcular'}</button>}>
          <dl class="uso-dl">
            <dt>Fonte do plano</dt><dd>{txt(ku.fonte || plano.fonte) || 'provedor Claude do Maestri'}</dd>
            <dt>Dado do plano</dt><dd>{ku.idade_min !== null && ku.idade_min !== undefined ? textoMin(ku.idade_min) : 'sem idade'}{ku.atualizado_em ? ` (${dataHora(ku.atualizado_em)})` : ''}</dd>
            <dt>Consumo por agente</dt><dd>{uso ? `coletado às ${hora(uso.coletado_em)} (${idade(uso.coletado_em)})` : 'o coletor ainda não rodou'}</dd>
            <dt>Coletor</dt><dd>{col ? (col.ativo === false ? 'desligado' : `automático a cada ${col.intervalo_min || 5} min`) : 'sem informação'}{col && col.em_andamento ? ' · rodando agora' : ''}</dd>
            {ult && <><dt>Última rodada</dt><dd>{hora(ult.em)} · {ult.ok ? 'ok' : `falhou: ${txt(ult.erro)}`}{typeof ult.duracao_ms === 'number' ? ` · ${numero(ult.duracao_ms)} ms` : ''}</dd></>}
            {coleta && <><dt>Sessões</dt><dd>{numero(coleta.sessoes)} com dono · {numero(coleta.transcricoes)} transcrição(ões){coleta.sessoes_sem_dono ? ` · ${numero(coleta.sessoes_sem_dono)} sem dono` : ''}</dd></>}
          </dl>
        </Cartao>
      </div>
      {!ku.disponivel && (
        <div class="nota-faixa"><Icone de={Info} tamanho={15} />Plano indisponível: {(txt(ku.motivo) || 'sem dado do Maestri').trim().replace(/[.\s]+$/, '')}. O painel não inventa número: confira Configurações → Agentes → Uso no Maestri e ~/.maestri/usage/providers/.status.json.</div>
      )}
      <div class="uso-periodos">
        {PERIODOS_USO.map((p) => {
          const lista = objs(porAgente[p.id]).sort((a, b) => (b.consumo_relativo || 0) - (a.consumo_relativo || 0));
          const info = obj(periodos[p.id]);
          const pctPlano = p.plano ? ku[p.plano] : null;
          const comConsumo = lista.some((l) => (l.consumo_relativo || 0) > 0);
          const explica = [
            info && info.inicio ? `Período: ${dataHora(info.inicio)} a ${dataHora(info.fim)}${info.base ? ` (${txt(info.base)})` : ''}.` : '',
            'Barra: parte de cada agente no consumo do período.',
            p.plano
              ? (typeof pctPlano === 'number'
                ? `"≈ % do plano" = essa parte × ${pct(pctPlano)} usado do plano (Maestri)${info && obj(info.base_plano) && info.base_plano.inicio ? `, contado na semana do plano (desde ${dataHora(info.base_plano.inicio)})` : ''}.`
                : 'Sem % do plano para estimar a parte de cada agente.')
              : 'Sem % do plano aqui: o plano não tem uma janela "hoje".',
          ].filter(Boolean).join(' ');
          return (
            <Cartao key={p.id} rotulo={p.nome} info={explica} extra={info && info.inicio ? intervalo(info.inicio, info.fim) : ''} rola>
              {!uso ? <Vazio>Sem estado/uso.json: clique em Recalcular para rodar o coletor agora.</Vazio>
                : !comConsumo ? <Vazio>Sem consumo registrado neste período.</Vazio>
                  : <ListaBarras itens={lista.map((l) => {
                    const a = infoAgente(estado, l.agente);
                    return {
                      chave: l.agente, nome: <Agente slug={l.agente} />, valor: l.pct_consumo || 0, cor: a.cor || 'var(--mudo)',
                      rotuloValor: pct(l.pct_consumo), rotuloAria: `${a.nome}: ${pct(l.pct_consumo)} do consumo`,
                      sub: typeof l.pct_plano_estimado === 'number' ? `≈ ${pct(l.pct_plano_estimado)} do plano` : null,
                    };
                  })} />}
            </Cartao>
          );
        })}
      </div>
      <TabelaTokens periodo={periodoTokens} setPeriodo={setPeriodoTokens} porAgente={porAgente} totais={(uso && obj(uso.totais)) || {}}
        nota={nota} avisos={avisos} />
    </div>
  );
}

/** "02:10 – 03:48" no mesmo dia; senão "02/10 03:48 – 09/10 03:48". */
function intervalo(ini, fim) {
  if (diaSP(ini) === diaSP(fim)) return `${hm(ini)} – ${hm(fim)}`;
  return `${diaMes(ini)} ${hm(ini)} – ${diaMes(fim)} ${hm(fim)}`;
}

/** Quanto falta: "em 3 h 20 min", "em 2 d 21 h". */
function faltam(v) {
  const d = quando(v);
  if (!d) return '';
  const m = Math.max(0, Math.round((d.getTime() - agora()) / 60000));
  if (m < 60) return `em ${m} min`;
  if (m < 48 * 60) { const h = Math.floor(m / 60); const r = m % 60; return r ? `em ${h} h ${r} min` : `em ${h} h`; }
  const dd = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60);
  return h ? `em ${dd} d ${h} h` : `em ${dd} d`;
}

function CartaoPlano({ titulo, valor, reset, motivo, ku }) {
  const tem = typeof valor === 'number';
  const d = quando(reset);
  const quandoTxt = d ? (diaSP(d) === diaSP(agora()) ? hm(d) : `${semanaCurta(d).toLowerCase()} ${hm(d)}`) : null;
  return (
    <Cartao rotulo={titulo}
      info={`Quanto do plano Claude já foi usado ${titulo === 'Semanal' ? 'na semana' : 'na janela de 5 h'}, segundo o Maestri${ku.idade_min !== null && ku.idade_min !== undefined ? ` (lido ${textoMin(ku.idade_min)})` : ''}.${d ? ` Reinicia em ${dataHora(d)}.` : ''}`}>
      <div class="plano">
        <Anel valor={tem ? valor : null} tamanho={128} espessura={8} rotulo={`${titulo}: ${tem ? pct(valor) : 'indisponível'} usado`}
          centro={tem ? `${Math.round(valor)}%` : '—'} sub="usado" grande />
        <div class="plano-texto">
          {tem ? (
            <>
              <span class="rot">Reinicia</span>
              <span class="plano-quando">{quandoTxt || '—'}</span>
              {d && <span class="mudo pequeno">{faltam(d)}</span>}
            </>
          ) : <span class="mudo pequeno">{motivo || (ku.disponivel ? 'O Maestri não informou este percentual.' : 'Indisponível: veja o motivo abaixo.')}</span>}
        </div>
      </div>
    </Cartao>
  );
}

function TabelaTokens({ periodo, setPeriodo, porAgente, totais, nota, avisos }) {
  const { estado } = usePainel();
  const lista = objs(porAgente[periodo]).sort((a, b) => (b.consumo_relativo || 0) - (a.consumo_relativo || 0));
  const tot = obj(totais[periodo]);
  const somaPlano = lista.reduce((s, l) => (typeof l.pct_plano_estimado === 'number' ? s + l.pct_plano_estimado : s), 0);
  const temPlano = lista.some((l) => typeof l.pct_plano_estimado === 'number');
  const partes = (l) => PARTES.map((p) => ({ chave: p.chave, nome: p.nome, cor: p.cor, valor: (Number(l[p.chave]) || 0) * p.peso }));
  const info = (
    <>
      <b>Estimativa.</b> {nota} Consumo relativo = entrada + 5 × saída + 1,25 × escrita de cache + 0,1 × leitura de cache.
      {' '}A barra de composição mostra de onde vem o consumo de cada agente. O % do plano (5 h e semanal) vem do Maestri; a parte de cada agente é a participação dele × o % do plano da janela.
      {avisos.length > 0 && <> Avisos do coletor: {avisos.map((a) => txt(a)).join(' · ')}</>}
    </>
  );
  return (
    <div class="uso-baixo">
      <Cartao rotulo="Tokens por agente" semMargem info={info}
        extra={<Legenda series={PARTES.map((p) => ({ chave: p.chave, nome: p.nome, cor: p.cor }))} />}
        acoes={<Segmentado rotulo="Período" valor={periodo} aoMudar={setPeriodo} opcoes={PERIODOS_USO.map((p) => ({ id: p.id, nome: p.curto }))} />}>
        {lista.length ? (
          <div class="tabela-caixa">
            <table class="tabela tokens">
              <colgroup>
                <col /><col style={{ width: '190px' }} /><col style={{ width: '92px' }} /><col style={{ width: '210px' }} />
                <col style={{ width: '100px' }} /><col style={{ width: '100px' }} /><col style={{ width: '120px' }} /><col style={{ width: '120px' }} /><col style={{ width: '112px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Agente</th><th scope="col">Participação</th><th scope="col" class="num">% plano</th><th scope="col">Composição</th>
                  <th scope="col" class="num">Entrada</th><th scope="col" class="num">Saída</th><th scope="col" class="num">Cache esc.</th><th scope="col" class="num">Cache lido</th><th scope="col" class="num">Mensagens</th>
                </tr>
              </thead>
              <tbody>
                {lista.map((l) => {
                  const a = infoAgente(estado, l.agente);
                  return (
                    <tr key={l.agente}>
                      <td><Agente slug={l.agente} /></td>
                      <td><span class="participacao"><span class="barra-mini"><span style={{ width: `${Math.max(0, Math.min(100, l.pct_consumo || 0))}%`, background: a.cor || 'var(--mudo)' }} /></span><span>{pct(l.pct_consumo)}</span></span></td>
                      <td class="num">{typeof l.pct_plano_estimado === 'number' ? `≈ ${pct(l.pct_plano_estimado)}` : '—'}</td>
                      <td><div class="composicao" title={`Consumo relativo: ${numero(Math.round(l.consumo_relativo || 0))}`}><BarraEmpilhada partes={partes(l)} formatar={(v) => compacto(Math.round(v))} rotuloAria={`Composição do consumo de ${a.nome}`} /></div></td>
                      <td class="num" title={numero(l.entrada)}>{compacto(l.entrada)}</td><td class="num" title={numero(l.saida)}>{compacto(l.saida)}</td>
                      <td class="num" title={numero(l.cache_escrita)}>{compacto(l.cache_escrita)}</td><td class="num" title={numero(l.cache_leitura)}>{compacto(l.cache_leitura)}</td>
                      <td class="num">{typeof l.mensagens === 'number' ? numero(l.mensagens) : '—'}</td>
                    </tr>
                  );
                })}
                {tot && (
                  <tr class="total">
                    <td>Total</td>
                    <td><span class="participacao"><span class="barra-mini"><span style={{ width: '100%', background: 'var(--borda-forte)' }} /></span><span>100%</span></span></td>
                    <td class="num">{temPlano ? `≈ ${pct(Math.round(somaPlano * 10) / 10)}` : '—'}</td>
                    <td><div class="composicao" title={`Consumo relativo: ${numero(Math.round(tot.consumo_relativo || 0))}`}><BarraEmpilhada partes={partes(tot)} formatar={(v) => compacto(Math.round(v))} rotuloAria="Composição do consumo total" /></div></td>
                    <td class="num" title={numero(tot.entrada)}>{compacto(tot.entrada)}</td><td class="num" title={numero(tot.saida)}>{compacto(tot.saida)}</td>
                    <td class="num" title={numero(tot.cache_escrita)}>{compacto(tot.cache_escrita)}</td><td class="num" title={numero(tot.cache_leitura)}>{compacto(tot.cache_leitura)}</td>
                    <td class="num">{typeof tot.mensagens === 'number' ? numero(tot.mensagens) : '—'}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : <div style={{ padding: '0 18px' }}><Vazio>Sem dados neste período.</Vazio></div>}
      </Cartao>
    </div>
  );
}
