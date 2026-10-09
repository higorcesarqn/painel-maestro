// Menu lateral: marca e as telas, em blocos por grupo (GRUPOS em dados/contexto.js: Workspace, Operações).
// Setas ↑ ↓ ← → percorrem todas as telas, de um grupo para o outro, com o foco no menu.
import '../estilo/menu.css';
import { usePainel, ABAS, GRUPOS } from '../dados/contexto.js';
import { obj, arr } from '../dados/formato.js';
import { Icone, LayoutDashboard, Inbox, ScrollText, SquareKanban, Bot, Gauge, MessageCircle } from '../componentes/Icone.jsx';

// Ícone de cada tela (tela nova: acrescente aqui).
const ICONES = { visao: LayoutDashboard, pendencias: Inbox, log: ScrollText, trello: SquareKanban, agentes: Bot, uso: Gauge, prospeccao: MessageCircle };

export function Lateral() {
  const { estado, aba, irPara, prospeccao } = usePainel();
  const kp = (estado && obj(estado.kpis) && obj(estado.kpis.pendencias)) || {};
  const ws = (estado && obj(estado.workspace)) || {};
  const pv = obj(prospeccao && prospeccao.dados && obj(prospeccao.dados.qualificacao) && prospeccao.dados.qualificacao.para_voce) || {};
  const comVoce = arr(pv.com_humano).length;
  // Contador ao lado do nome: { n, tom, rotulo }
  const contadores = {
    pendencias: kp.total ? { n: kp.total, tom: kp.critica ? 'forte' : 'azul', rotulo: `${kp.total} pendência(s) aberta(s)` } : null,
    prospeccao: comVoce ? { n: comVoce, tom: 'azul', rotulo: `${comVoce} lead(s) nas suas mãos` } : null,
  };
  const tecla = (ev) => {
    const delta = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    const ordem = GRUPOS.flatMap((g) => ABAS.filter((a) => a.grupo === g.id));
    const i = ordem.findIndex((a) => a.id === aba);
    const j = (i + delta + ordem.length) % ordem.length;
    irPara(ordem[j].id);
    const b = document.getElementById(`tab-${ordem[j].id}`);
    if (b) b.focus();
    ev.preventDefault();
  };
  return (
    <aside class="lateral">
      <div class="marca">
        <span class="marca-nome">painel<b>.</b>maestro</span>
        <span class="rot" title={ws.raiz || ''}>Workspace {ws.nome || '—'}</span>
      </div>
      <nav class="nav" role="tablist" aria-orientation="vertical" aria-label="Telas do painel" onKeyDown={tecla}>
        {GRUPOS.map((g, gi) => {
          const telas = ABAS.filter((a) => a.grupo === g.id);
          if (!telas.length) return null;
          return (
            <div class={`nav-bloco${gi ? ' separado' : ''}`} key={g.id} role="presentation">
              <span class="nav-grupo rot" aria-hidden="true">{g.nome}</span>
              {telas.map((a) => {
                const c = contadores[a.id];
                return (
                  <button type="button" key={a.id} class="nav-item" role="tab" id={`tab-${a.id}`} aria-controls="principal"
                    aria-selected={aba === a.id ? 'true' : 'false'} tabindex={aba === a.id ? 0 : -1} onClick={() => irPara(a.id)}
                    title={c ? c.rotulo : undefined}>
                    <Icone de={ICONES[a.id] || LayoutDashboard} tamanho={17} />
                    <span class="nome">{a.nome}</span>
                    {c ? <span class={`contador ${c.tom}`} aria-label={c.rotulo}>{c.n}</span> : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>
      <div class="lateral-pe">
        <span class="rot">Painel local</span>
        <span class="minimo fraco">127.0.0.1 · atualiza a cada 20 s</span>
      </div>
    </aside>
  );
}
