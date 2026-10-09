// Cabeçalho: título da tela, hora da última leitura, selo de saúde (com detalhes), Recalcular e o botão
// da Fase B (Pedir ao Cérebro), que fica desabilitado e explica por quê.
import { useState } from 'preact/hooks';
import { usePainel, ABAS } from '../dados/contexto.js';
import { hora, textoMin, dataHora, arr, obj, objs, txt } from '../dados/formato.js';
import { Popover } from '../componentes/Modal.jsx';
import { Ponto } from '../componentes/base.jsx';
import { Agente } from '../componentes/dominio.jsx';
import { Icone, RefreshCw, Send, Clock, TriangleAlert, CircleCheck, CircleAlert } from '../componentes/Icone.jsx';

const NIVEIS = {
  verde: { rotulo: 'Tudo certo', cor: 'var(--ok)' },
  amarelo: { rotulo: 'Atenção', cor: 'var(--atencao)' },
  vermelho: { rotulo: 'Problema', cor: 'var(--perigo)' },
  cinza: { rotulo: 'Sem dado', cor: 'var(--fraco)' },
};

export function Topo() {
  const { estado, erroConexao, falhaDesde, aba, statusAcao, recalcular, recalculando } = usePainel();
  const [pop, setPop] = useState(null);
  const tela = ABAS.find((a) => a.id === aba) || ABAS[0];
  const s = (estado && obj(estado.saude)) || {};
  const nivel = NIVEIS[s.nivel] ? s.nivel : 'cinza';
  const motivos = arr(s.motivos).map(txt);
  const alternar = (qual) => setPop((p) => (p === qual ? null : qual));

  let atualizado = 'Carregando…';
  if (erroConexao) atualizado = estado ? `Sem resposta desde ${hora(falhaDesde)} · dados de ${hora(estado.gerado_em)}` : 'Sem resposta do servidor';
  else if (estado) atualizado = `Atualizado às ${hora(estado.gerado_em)}`;

  return (
    <header class="topo">
      <div class="topo-titulo">
        <span class="rot">Painel{estado && estado.workspace && estado.workspace.nome ? ` · ${estado.workspace.nome}` : ''}</span>
        <h1>{tela.titulo}</h1>
      </div>
      <span class="espaco" />
      {statusAcao && <span class="status-acao corta" aria-live="polite" title={statusAcao}>{statusAcao}</span>}
      <span class={`atualizado${erroConexao ? ' erro' : ''}`} aria-live="polite"><Icone de={Clock} tamanho={14} />{atualizado}</span>
      <button type="button" class="botao" data-abre-popover aria-expanded={pop === 'saude' ? 'true' : 'false'} aria-controls="pop-saude"
        title={motivos.length ? motivos.join('\n') : 'Nenhum problema detectado.'}
        aria-label={`Saúde: ${NIVEIS[nivel].rotulo}. ${motivos.length ? motivos.join('. ') : 'Nenhum problema detectado.'} Clique para detalhes.`}
        onClick={() => alternar('saude')}>
        <Ponto cor={NIVEIS[nivel].cor} />
        Saúde: {NIVEIS[nivel].rotulo.toLowerCase()}{motivos.length && nivel !== 'verde' ? ` (${motivos.length})` : ''}
      </button>
      <button type="button" class="botao primario" disabled={recalculando} onClick={recalcular}
        title="Roda o coletor de uso agora e atualiza o painel (grátis, sem agente)">
        <Icone de={RefreshCw} tamanho={15} />{recalculando ? 'Recalculando…' : 'Recalcular'}
      </button>
      <button type="button" class="botao inativo" data-abre-popover aria-disabled="true" aria-expanded={pop === 'cerebro' ? 'true' : 'false'} aria-controls="pop-cerebro"
        title="Fase B: exige o Maestri Wire (ver §11.7). Por enquanto, fale com o Cérebro direto no canvas." onClick={() => alternar('cerebro')}>
        <Icone de={Send} tamanho={15} />Pedir ao Cérebro…
      </button>
      {pop === 'saude' && <PopSaude aoFechar={() => setPop(null)} />}
      {pop === 'cerebro' && (
        <Popover aoFechar={() => setPop(null)} id="pop-cerebro" papel="note" direita={24}>
          <h3>Pedir ao Cérebro… (Fase B)</h3>
          <p class="texto-2">Desabilitado: exige o Maestri Wire (ver §11.7). Quando o Wire estiver ligado e pareado, este botão vai mandar pedidos prontos ao Cérebro (atualizar o Trello agora, resumo do dia, revisar pendências) e uma mensagem livre. Até lá, fale com o Cérebro direto no canvas do Maestri.</p>
        </Popover>
      )}
    </header>
  );
}

function PopSaude({ aoFechar }) {
  const { estado } = usePainel();
  const s = (estado && obj(estado.saude)) || {};
  const motivos = arr(s.motivos).map(txt);
  const hooks = objs(s.hooks);
  const avisos = arr(estado && estado.avisos);
  const linhas = [
    ['Leitura do Trello', s.trello_idade_min === null || s.trello_idade_min === undefined ? 'nunca lida' : textoMin(s.trello_idade_min)],
    ['Último evento', textoMin(s.ultimo_evento_idade_min)],
    ['Dado de uso do plano', textoMin(s.uso_idade_min)],
    ['Maestri Wire', s.wire ? 'configurado' : 'não configurado (Fase B)'],
  ];
  return (
    <Popover aoFechar={aoFechar} id="pop-saude" direita={300}>
      <h3>Saúde do painel</h3>
      {motivos.length
        ? <ul>{motivos.map((m) => <li key={m}><Icone de={TriangleAlert} tamanho={14} class="azul" />{m}</li>)}</ul>
        : <p class="texto-2" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}><Icone de={CircleCheck} tamanho={14} />Nenhum problema detectado.</p>}
      <table><tbody>{linhas.map(([a, b]) => <tr key={a}><th scope="row">{a}</th><td>{b}</td></tr>)}</tbody></table>
      {hooks.length > 0 && (
        <table>
          <thead><tr><th>Hooks (log bruto)</th><th>Último registro</th><th>Idade</th></tr></thead>
          <tbody>{hooks.map((x) => (
            <tr key={x.agente}><td><Agente slug={x.agente} /></td><td>{x.ultimo_bruto ? dataHora(x.ultimo_bruto) : 'nunca'}</td><td>{x.ultimo_bruto ? textoMin(x.idade_min) : '—'}</td></tr>
          ))}</tbody>
        </table>
      )}
      {avisos.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <span class="rot">Avisos de leitura ({avisos.length})</span>
          <ul style={{ marginTop: '6px' }}>{avisos.slice(0, 8).map((a, i) => <li key={i} class="pequeno mudo"><Icone de={CircleAlert} tamanho={13} />{txt(a)}</li>)}</ul>
        </div>
      )}
    </Popover>
  );
}
