// Peças do domínio do workspace: agente, projeto, resultado, status do Trello, fluxo e o único link externo (Trello).
import { usePainel } from '../dados/contexto.js';
import { RESULTADOS, STATUS_TRELLO, classeStatus, infoAgente, projetosConhecidos, corDoFluxo, urlTrello, NOME_SEV, TOM_SEV } from '../dados/dominio.js';
import { Ponto, Quadrado, Selo } from './base.jsx';
import { Icone, Check, X, Square, Pause, LoaderCircle, CircleDashed } from './Icone.jsx';

export function Agente({ slug, tamanho = 8 }) {
  const { estado } = usePainel();
  const a = infoAgente(estado, slug);
  return <span class="agente" title={a.nome}><Ponto cor={a.cor} tamanho={tamanho} /><span>{a.nome}</span></span>;
}

export function Projeto({ prefixo }) {
  const { estado } = usePainel();
  if (prefixo === null || prefixo === undefined || prefixo === '') return <span class="mudo">—</span>;
  const p = projetosConhecidos(estado).get(String(prefixo).toUpperCase());
  return <span class="projeto" title={p ? `${p.prefixo} · ${p.nome}` : String(prefixo)}><Quadrado cor={p && p.cor} />{String(prefixo)}</span>;
}

const ICONE_RESULTADO = { ok: Check, parcial: CircleDashed, falhou: X, bloqueado: Square, 'aguardando-dono': Pause, 'em-andamento': LoaderCircle };
export function Resultado({ valor }) {
  const info = RESULTADOS[valor];
  if (!info) return <span class="res mudo">{valor ? String(valor) : '—'}</span>;
  return <span class="res" style={{ color: info.cor }}><Icone de={ICONE_RESULTADO[valor]} tamanho={14} />{info.rotulo}</span>;
}

export function StatusTrello({ status }) {
  const c = classeStatus(status);
  const info = c && STATUS_TRELLO[c];
  return <span class="selo" style={info ? { color: info.cor, borderColor: `${info.cor}55` } : undefined}>{status ? String(status) : 'sem status'}</span>;
}

export function SeloSeveridade({ sev, cheio }) {
  return <Selo tom={TOM_SEV[sev] || 'neutro'} cheio={cheio}>{NOME_SEV[sev] || sev}</Selo>;
}

/** Só https://trello.com/... vira link (abre fora); qualquer outra coisa vira texto. */
export function LinkTrello({ url, children, class: classe, titulo, aoClicar }) {
  const seguro = urlTrello(url);
  if (!seguro) return <span class={classe} title={titulo}>{children}</span>;
  return <a href={seguro} target="_blank" rel="noopener noreferrer" class={classe} title={titulo} onClick={aoClicar}>{children}</a>;
}

/** Id do fluxo com a cor dele; clicar filtra o Log por esse fluxo. */
export function Fluxo({ id, titulo }) {
  const { filtrarPorFluxo } = usePainel();
  if (!id) return <span class="mudo">sem fluxo</span>;
  return (
    <button type="button" class="link neutro mono" title={titulo || 'Filtrar o Log por este fluxo'} onClick={(e) => { e.stopPropagation(); filtrarPorFluxo(id); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      <Ponto cor={corDoFluxo(id)} />{id}
    </button>
  );
}
