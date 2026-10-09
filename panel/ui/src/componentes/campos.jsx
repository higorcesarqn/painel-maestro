// Campos de formulário no padrão da marca (filtros do Log e afins).
import { Icone, Search, ChevronDown } from './Icone.jsx';

export function Campo({ rotulo, children, oculto }) {
  return (
    <label class="campo" hidden={oculto}>
      <span class="rot">{rotulo}</span>
      {children}
    </label>
  );
}

/** opcoes: [[valor, nome]] */
export function Selecao({ valor, opcoes, aoMudar, rotuloAria, largura }) {
  return (
    <span class="selecao-caixa" style={largura ? { width: `${largura}px` } : undefined}>
      <select class="selecao" value={valor} aria-label={rotuloAria} onChange={(e) => aoMudar(e.currentTarget.value)}>
        {opcoes.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
      </select>
      <Icone de={ChevronDown} tamanho={14} class="seta-selecao" />
    </span>
  );
}

export function Busca({ valor, aoMudar, placeholder, rotuloAria, largura }) {
  return (
    <span class="busca">
      <Icone de={Search} tamanho={15} />
      <input type="search" value={valor} placeholder={placeholder} aria-label={rotuloAria} style={largura ? { width: `${largura}px` } : undefined}
        onInput={(e) => aoMudar(e.currentTarget.value)} />
    </span>
  );
}

export function CampoData({ valor, aoMudar, rotuloAria }) {
  return (
    <span class="data">
      <input type="date" value={valor} aria-label={rotuloAria} onChange={(e) => aoMudar(e.currentTarget.value)} />
    </span>
  );
}

export function Alternador({ marcado, aoMudar, children }) {
  return (
    <label class="alternador">
      <input type="checkbox" checked={marcado} onChange={(e) => aoMudar(e.currentTarget.checked)} />
      <span class="trilho" aria-hidden="true" />
      {children}
    </label>
  );
}
