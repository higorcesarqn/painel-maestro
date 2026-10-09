// Trello: números do quadro, matriz projeto × status, evolução, cartões abertos e a auditoria,
// as mudanças e o RST num painel com abas. Tudo vem de estado/trello (leitura do Coordenador).
// Explicações ficam no ícone (i) de cada cartão; na tela, só números, status e os problemas.
import '../estilo/trello.css';
import { useState } from 'preact/hooks';
import { usePainel } from '../dados/contexto.js';
import { obj, objs, arr, txt, numero, dataHora, idade, data, quando, agora, diaMes, hm, normalizar, truncar, plural } from '../dados/formato.js';
import { corSegura, urlTrello, STATUS_TRELLO } from '../dados/dominio.js';
import { Cartao, Kpi, Selo, Quadrado, Segmentado, Vazio, InfoDica } from '../componentes/base.jsx';
import { GraficoLinhas } from '../componentes/graficos.jsx';
import { StatusTrello, LinkTrello } from '../componentes/dominio.jsx';
import { Icone, ExternalLink, ListChecks, Check, SquareKanban } from '../componentes/Icone.jsx';

const SERIES = [
  { chave: 'abertas', nome: 'Abertas', cor: '#F5F5F5' },
  { chave: 'em_andamento', nome: 'Em andamento', cor: STATUS_TRELLO.andamento.cor },
  { chave: 'concluido', nome: 'Concluídas', cor: STATUS_TRELLO.concluido.cor },
];

export function Trello() {
  const { estado } = usePainel();
  const tr = estado && obj(estado.trello);
  if (!estado) return null;
  if (!tr) {
    return (
      <div class="tela">
        <Cartao rotulo="Trello">
          <Vazio icone={SquareKanban} centro>O quadro ainda não foi lido: não existe estado/trello/resumo.json. A leitura é feita pelo Coordenador do Trello (rotina "Trello · leitura" ou a pedido do Cérebro).</Vazio>
        </Cartao>
      </div>
    );
  }
  const quadro = obj(tr.quadro) || {};
  const totais = obj(tr.totais) || {};
  const aud = obj(tr.auditoria) || {};
  const nDec = objs(aud.decisoes).length;
  const urlQuadro = urlTrello(quadro.url);
  return (
    <div class="tela tela-trello">
      <div class="trello-cab">
        <h2 class="leve">Quadro {txt(quadro.nome) || 'do Trello'}</h2>
        <span class="mudo pequeno">leitura {idade(tr.coletado_em)}</span>
        <InfoDica titulo="De onde vem" texto={`Leitura do quadro feita pelo Coordenador do Trello em ${dataHora(tr.coletado_em)}${tr.fluxo_id ? ` (fluxo ${txt(tr.fluxo_id)})` : ''}. O painel mostra estado/trello: resumo.json, serie.jsonl e rst.md.`} />
        <span class="espaco" />
        {urlQuadro && <LinkTrello url={urlQuadro} class="pequeno">Abrir o quadro <Icone de={ExternalLink} tamanho={13} /></LinkTrello>}
      </div>
      <div class="trello-kpis">
        <Kpi rotulo="Abertas" valor={numero(totais.abertas)} medio detalhe={<FileteStatus cor="var(--texto)" />}
          info="Tarefas abertas no quadro: a fazer, em andamento e concluídas que ainda não saíram na limpeza." />
        <Kpi rotulo="A fazer" valor={numero(totais.a_fazer)} medio detalhe={<FileteStatus cor={STATUS_TRELLO.afazer.cor} />} />
        <Kpi rotulo="Em andamento" valor={numero(totais.em_andamento)} medio detalhe={<FileteStatus cor={STATUS_TRELLO.andamento.cor} />} />
        <Kpi rotulo="Concluídas" valor={numero(totais.concluido)} medio detalhe={<FileteStatus cor={STATUS_TRELLO.concluido.cor} />}
          info="Na coluna Concluído, esperando a limpeza semanal arquivar." />
        <Kpi rotulo="Pedem decisão" valor={numero(nDec)} medio class={nDec > 0 ? 'kpi-alerta' : undefined}
          detalhe={<FileteStatus cor={nDec > 0 ? 'var(--atencao)' : 'var(--fraco)'} />}
          info="Alertas de consistência do quadro que pedem decisão sua. Cada um vira uma pendência (veja a aba Decisão em Consistência)." />
        <Kpi rotulo="Mecânicos" valor={numero(objs(aud.mecanicos).length)} medio detalhe={<FileteStatus cor="var(--mudo)" />}
          info="Correções mecânicas que o Coordenador do Trello faz sozinho quando você liberar a escrita no quadro." />
      </div>
      <div class="trello-meio">
        <Matriz tr={tr} />
        <Evolucao serie={estado.serie_trello} />
      </div>
      <div class="trello-baixo">
        <CartoesAbertos tr={tr} />
        <PainelAuditoria tr={tr} rst={estado.trello_rst} />
      </div>
    </div>
  );
}

function FileteStatus({ cor }) {
  return <span class="filete-status" style={{ background: cor }} />;
}

function Matriz({ tr }) {
  const projetos = objs(tr.projetos);
  const totais = obj(tr.totais) || {};
  const dec = objs(obj(tr.auditoria) && tr.auditoria.decisoes);
  const emDecisao = (p) => dec.some((d) => d.codigo === 'projeto-pendente' && [p.nome, p.prefixo, p.coluna].some((v) => v && normalizar(v) === normalizar(d.alvo)));
  const soma = (k) => projetos.reduce((n, p) => n + ((obj(p.contagem) || {})[k] || 0), 0);
  const nc = arr(tr.nao_classificados);
  const cel = (v, cor) => (v
    ? <td class="num"><span class="celula" style={{ color: cor, background: `${cor}1f` }}>{numero(v)}</span></td>
    : <td class="num fraco">0</td>);
  return (
    <Cartao rotulo="Projeto × status" rola semMargem extra={plural(totais.abertas || 0, 'aberta', 'abertas')}
      info="Tarefas abertas de cada projeto por status. Problemas: quantos alertas da auditoria caem nos cartões do projeto.">
      <table class="tabela matriz">
        <colgroup><col /><col style={{ width: '90px' }} /><col style={{ width: '108px' }} /><col style={{ width: '108px' }} /><col style={{ width: '72px' }} /><col style={{ width: '108px' }} /></colgroup>
        <thead><tr><th scope="col">Projeto</th><th scope="col" class="num">A fazer</th><th scope="col" class="num">Andamento</th><th scope="col" class="num">Concluído</th><th scope="col" class="num">Total</th><th scope="col" class="num">Problemas</th></tr></thead>
        <tbody>
          {projetos.map((p) => {
            const c = obj(p.contagem) || {};
            const cartoes = objs(p.cartoes);
            const nProb = cartoes.reduce((n, x) => n + objs(x.problemas).length, 0);
            const total = (c.a_fazer || 0) + (c.em_andamento || 0) + (c.concluido || 0);
            const nome = `${txt(p.prefixo)} · ${txt(p.nome)}`;
            return (
              <tr key={p.prefixo}>
                <td>
                  <span class="matriz-projeto">
                    <span class="projeto corta" title={nome}><Quadrado cor={corSegura(p.cor)} /><span class="corta">{nome}</span></span>
                    {emDecisao(p) && <Selo tom="atencao" titulo="Etiqueta, cor e prefixo deste projeto aguardam decisão do dono">em decisão</Selo>}
                  </span>
                </td>
                {cel(c.a_fazer, STATUS_TRELLO.afazer.cor)}{cel(c.em_andamento, STATUS_TRELLO.andamento.cor)}{cel(c.concluido, STATUS_TRELLO.concluido.cor)}
                <td class="num">{numero(total || cartoes.length)}</td>
                <td class={`num${nProb ? '' : ' fraco'}`}>{numero(nProb)}</td>
              </tr>
            );
          })}
          <tr class="total">
            <td>Total</td>
            <td class="num">{numero(totais.a_fazer ?? soma('a_fazer'))}</td><td class="num">{numero(totais.em_andamento ?? soma('em_andamento'))}</td>
            <td class="num">{numero(totais.concluido ?? soma('concluido'))}</td><td class="num">{numero(totais.abertas ?? (soma('a_fazer') + soma('em_andamento') + soma('concluido')))}</td><td />
          </tr>
        </tbody>
      </table>
      {nc.length > 0 && (
        <p class="mudo pequeno" style={{ padding: '10px 18px 0' }}>{nc.length} cartão(ões) fora de qualquer projeto: {nc.map((x, i) => <span key={i}>{i ? ', ' : ''}<LinkTrello url={x.url}>{txt(x.titulo || x.shortLink)}</LinkTrello></span>)}</p>
      )}
    </Cartao>
  );
}

function Evolucao({ serie }) {
  const [tabela, setTabela] = useState(false);
  const pts = arr(serie).map((l) => ({
    t: Date.parse(l && l.coletado_em), titulo: dataHora(l && l.coletado_em),
    abertas: Number(l && l.abertas), em_andamento: Number(l && l.em_andamento), concluido: Number(l && l.concluido),
  })).filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const info = pts.length
    ? `Abertas, em andamento e concluídas a cada leitura do quadro (${pts.length === 1 ? `1 leitura, em ${pts[0].titulo}; a linha aparece a partir da segunda` : `${pts.length} leituras, de ${pts[0].titulo} a ${pts[pts.length - 1].titulo}`}). Passe o mouse para ver cada leitura.`
    : 'Cada leitura do Trello acrescenta um ponto (estado/trello/serie.jsonl).';
  return (
    <Cartao rotulo="Evolução do quadro" info={info} extra={pts.length ? plural(pts.length, 'leitura', 'leituras') : ''}
      acoes={pts.length > 0 && <button type="button" class="link mudo pequeno" onClick={() => setTabela(!tabela)}>{tabela ? 'Ver gráfico' : 'Ver em tabela'}</button>}
      rola={tabela}>
      {!pts.length && <Vazio centro>Ainda não há série. Cada leitura do Trello acrescenta um ponto.</Vazio>}
      {pts.length > 0 && !tabela && (
        <GraficoLinhas pontos={pts} series={SERIES} rotuloX={(t) => `${diaMes(t)} ${hm(t)}`}
          rotuloAria={`Evolução do quadro: ${SERIES.map((s) => `${s.nome} ${Number.isFinite(pts[pts.length - 1][s.chave]) ? pts[pts.length - 1][s.chave] : 'sem dado'}`).join(', ')} na última leitura.`} />
      )}
      {pts.length > 0 && tabela && (
        <table class="tabela">
          <thead><tr><th>Leitura</th>{SERIES.map((s) => <th key={s.chave} class="num">{s.nome}</th>)}</tr></thead>
          <tbody>{pts.slice().reverse().map((p) => <tr key={p.t}><td>{p.titulo}</td>{SERIES.map((s) => <td key={s.chave} class="num">{Number.isFinite(p[s.chave]) ? numero(p[s.chave]) : '—'}</td>)}</tr>)}</tbody>
        </table>
      )}
    </Cartao>
  );
}

function CartoesAbertos({ tr }) {
  const projetos = objs(tr.projetos);
  const total = projetos.reduce((n, p) => n + objs(p.cartoes).length, 0);
  const agora_ = agora();
  return (
    <Cartao rotulo="Cartões abertos" semMargem extra={plural(total, 'cartão', 'cartões')}
      info="Cada cartão aberto, agrupado por projeto: status, checklist, prazo, se o espelho nas colunas de status está na coluna certa e os problemas achados na auditoria (decisão = pede você; mecânico = o Coordenador corrige quando liberado).">
      <div class="tabela-caixa">
        <table class="tabela cartoes">
          <colgroup><col style={{ width: '120px' }} /><col /><col style={{ width: '104px' }} /><col style={{ width: '96px' }} /><col style={{ width: '132px' }} /></colgroup>
          <thead><tr>{['Status', 'Cartão e problemas', 'Checklist', 'Prazo', 'Espelho'].map((t) => <th scope="col" key={t}>{t}</th>)}</tr></thead>
          <tbody>
            {projetos.map((p) => {
              const cartoes = objs(p.cartoes);
              return [
                <tr class="grupo" key={`g-${p.prefixo}`}><td colSpan={5}><span class="projeto"><Quadrado cor={corSegura(p.cor)} />{txt(p.prefixo)} · {txt(p.nome)} <span class="mudo">({cartoes.length})</span></span></td></tr>,
                !cartoes.length ? <tr key={`v-${p.prefixo}`}><td colSpan={5} class="mudo">Nenhum cartão aberto.</td></tr> : null,
                ...cartoes.map((c, i) => {
                  const ck = obj(c.checklist);
                  const prazo = quando(c.prazo);
                  const atrasado = prazo && prazo.getTime() < agora_ && !c.prazo_concluido;
                  const esp = obj(c.espelho);
                  const probs = objs(c.problemas);
                  return (
                    <tr key={`${p.prefixo}-${c.shortLink || i}`}>
                      <td><StatusTrello status={c.status} /></td>
                      <td class="quebra">
                        <div class="cartao-titulo">
                          <LinkTrello url={c.url}>{txt(c.titulo) || txt(c.shortLink)}</LinkTrello>
                          {c.tem_descricao === false && <Selo>sem descrição</Selo>}
                        </div>
                        {probs.length > 0 && (
                          <ul class="problemas">
                            {probs.map((x, j) => {
                              const texto = txt(x.texto || x.codigo);
                              return (
                                <li key={j}>
                                  <Selo tom={x.mecanico ? 'neutro' : 'atencao'}>{x.mecanico ? 'mecânico' : 'decisão'}</Selo>
                                  <span class="corta" title={texto}>{texto}</span>
                                  {texto.length > 46 && <InfoDica texto={texto} tamanho={13} />}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </td>
                      <td>{ck && ck.total ? <span class="res"><Icone de={ListChecks} tamanho={13} />{ck.feitos || 0}/{ck.total}</span> : <span class="mudo">—</span>}</td>
                      <td class="quebra" style={atrasado ? { color: 'var(--perigo)' } : undefined}>{prazo
                        ? <>{data(c.prazo)}{atrasado && <span class="minimo prazo-atrasado">atrasado</span>}</>
                        : <span class="mudo">sem prazo</span>}</td>
                      <td title={esp && esp.coluna ? txt(esp.coluna) : undefined}>{!esp ? <span class="mudo">—</span> : !esp.existe ? <span style={{ color: 'var(--perigo)' }}>sem espelho</span>
                        : esp.correto === false ? <span style={{ color: 'var(--atencao)' }}>em {txt(esp.coluna)}</span> : <span class="res" style={{ color: 'var(--ok)' }}><Icone de={Check} tamanho={13} />{txt(esp.coluna)}</span>}</td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </div>
    </Cartao>
  );
}

function PainelAuditoria({ tr, rst }) {
  const { irParaPendencia } = usePainel();
  const [aba, setAba] = useState('decisoes');
  const aud = obj(tr.auditoria) || {};
  const mec = objs(aud.mecanicos);
  const dec = objs(aud.decisoes);
  const mud = obj(tr.mudancas);
  const itensMud = [];
  if (mud) {
    for (const [k, n] of [['novos', 'Novo'], ['mudou_status', 'Mudou de status'], ['concluidos', 'Concluído'], ['arquivados', 'Arquivado']]) {
      for (const x of objs(mud[k])) itensMud.push({ n, x });
    }
  }
  const itemAud = (a, i) => (
    <li key={i}>
      <span>{txt(a.texto || a.codigo)}</span>
      {a.url && urlTrello(a.url) && <> · <LinkTrello url={a.url}>{a.titulo ? truncar(a.titulo, 60) : 'cartão'}</LinkTrello></>}
      {a.pendencia && <> · <button type="button" class="link mono" onClick={() => irParaPendencia(txt(a.pendencia))}>{txt(a.pendencia)}</button></>}
    </li>
  );
  return (
    <Cartao rotulo="Consistência" rola corpoClass="auditoria-corpo"
      info="Auditoria do quadro na última leitura. Decisão: pede você (cada item vira uma pendência). Mecânicos: o Coordenador corrige quando você liberar. Mudanças: o que mudou desde a leitura anterior. RST: o relatório de status completo.">
      <div class="auditoria-abas">
        <Segmentado rotulo="Detalhes do quadro" valor={aba} aoMudar={setAba}
          opcoes={[{ id: 'decisoes', nome: 'Decisão', n: dec.length }, { id: 'mecanicos', nome: 'Mecânicos', n: mec.length }, { id: 'mudancas', nome: 'Mudanças', n: itensMud.length }, { id: 'rst', nome: 'RST' }]} />
      </div>
      {aba === 'decisoes' && (dec.length ? <ul class="lista-auditoria">{dec.map(itemAud)}</ul> : <Vazio>Nada pedindo decisão.</Vazio>)}
      {aba === 'mecanicos' && (mec.length ? <ul class="lista-auditoria">{mec.map(itemAud)}</ul> : <Vazio>Nada mecânico.</Vazio>)}
      {aba === 'mudancas' && (!mud ? <Vazio>Sem comparação com a leitura anterior.</Vazio> : (
        <>
          {mud.desde && <p class="mudo pequeno" style={{ marginBottom: '8px' }}>Desde {dataHora(mud.desde)}</p>}
          {itensMud.length ? <ul class="lista-auditoria">{itensMud.map(({ n, x }, i) => (
            <li key={i}><span class="mudo">{n}:</span> <LinkTrello url={x.url}>{txt(x.titulo)}</LinkTrello>{x.antes && <span class="mudo"> (estava {txt(x.antes)}{x.depois ? `, agora ${txt(x.depois)}` : ''})</span>}</li>
          ))}</ul> : <Vazio>Nenhuma mudança.</Vazio>}
        </>
      ))}
      {aba === 'rst' && (rst ? <pre class="texto-pre">{txt(rst)}</pre> : <Vazio>Ainda não há estado/trello/rst.md.</Vazio>)}
    </Cartao>
  );
}
