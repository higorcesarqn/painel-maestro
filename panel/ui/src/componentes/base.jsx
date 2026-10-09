// Componentes de base do painel (identidade visual do painel). Todo texto entra como filho JSX: o Preact
// sempre escreve texto como texto, nunca como HTML.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icone, ChevronRight, Info } from './Icone.jsx';

const cls = (...xs) => xs.filter(Boolean).join(' ');

let seqDica = 0;
/**
 * Ícone (i) que explica algo ao passar o mouse ou com o foco do teclado (Esc fecha). Use para tirar texto
 * explicativo de dentro dos cartões. texto: string · children: conteúdo rico · titulo: primeira linha.
 * O balão é position: fixed, calculado na hora: não é cortado por cartão que rola nem pela borda da tela.
 * É um <span> focável (não <button>) para poder ficar dentro de cartão clicável; o clique nele não vaza.
 */
export function InfoDica({ texto, titulo, children, tamanho = 14, rotulo = 'Mais informações', class: classe }) {
  const ref = useRef(null);
  const idRef = useRef(null);
  if (!idRef.current) idRef.current = `info-dica-${++seqDica}`;
  const [pos, setPos] = useState(null);
  const abrir = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const larg = 300;
    const left = Math.max(12, Math.min(window.innerWidth - larg - 12, r.left + r.width / 2 - larg / 2));
    // acima quando há espaço; senão, abaixo
    setPos(r.top > 170 ? { left, bottom: window.innerHeight - r.top + 8 } : { left, top: r.bottom + 8 });
  };
  const fechar = () => setPos(null);
  useEffect(() => {
    if (!pos) return undefined;
    const esc = (e) => { if (e.key === 'Escape') fechar(); };
    window.addEventListener('keydown', esc);
    window.addEventListener('scroll', fechar, true);
    window.addEventListener('resize', fechar);
    return () => {
      window.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', fechar, true);
      window.removeEventListener('resize', fechar);
    };
  }, [pos]);
  if (!texto && !children) return null;
  return (
    <span ref={ref} class={cls('info-dica', pos && 'aberta', classe)} tabindex="0" aria-label={rotulo}
      aria-describedby={pos ? idRef.current : undefined}
      onMouseEnter={abrir} onMouseLeave={fechar} onFocus={abrir} onBlur={fechar}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}>
      <Icone de={Info} tamanho={tamanho} />
      {pos && (
        <span class="info-balao" role="tooltip" id={idRef.current} style={{
          left: `${pos.left}px`, top: pos.top !== undefined ? `${pos.top}px` : undefined, bottom: pos.bottom !== undefined ? `${pos.bottom}px` : undefined,
        }}>
          {titulo && <span class="info-tit">{titulo}</span>}
          {texto}{children}
        </span>
      )}
    </span>
  );
}

/**
 * Cartão da marca: #101010, borda 1px #242424, raio 14px.
 * rotulo: título em caixa alta (.3em) · info: explicação no ícone (i) ao lado do título · extra: texto curto ao lado
 * acoes: botões à direita · rola: o corpo rola por dentro (para o cartão caber na altura da tela)
 * semMargem: corpo sem padding lateral
 */
export function Cartao({ rotulo, info, extra, acoes, rola, semMargem, class: classe, corpoClass, children, onClick, rotuloId, ...resto }) {
  const Tag = onClick ? 'button' : 'section';
  return (
    <Tag class={cls('cartao', onClick && 'clicavel', classe)} onClick={onClick} type={onClick ? 'button' : undefined} {...resto}>
      {(rotulo || acoes || extra) && (
        <div class="cartao-cab">
          {rotulo && <h2 class="rot" id={rotuloId}>{rotulo}</h2>}
          {info && <InfoDica texto={typeof info === 'string' ? info : undefined}>{typeof info === 'string' ? null : info}</InfoDica>}
          {extra && <span class="extra">{extra}</span>}
          {acoes && <div class="acoes">{acoes}</div>}
        </div>
      )}
      <div class={cls('cartao-corpo', rola && 'rola', semMargem && 'sem-margem', corpoClass)}>{children}</div>
    </Tag>
  );
}

/**
 * Número grande (KPI). Com onClick vira botão; filete azul embaixo quando destaque.
 * info: explicação no ícone (i) ao lado do rótulo (prefira isto a um "detalhe" longo: o rótulo fica numa linha só).
 */
export function Kpi({ rotulo, info, valor, unidade, detalhe, destaque, onClick, medio, children, class: classe, rotuloAria }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag class={cls('cartao kpi', onClick && 'clicavel', destaque && 'destaque', classe)} onClick={onClick} type={onClick ? 'button' : undefined} aria-label={rotuloAria}>
      <span class="rot-linha">
        <span class="rot" title={typeof rotulo === 'string' ? rotulo : undefined}>{rotulo}</span>
        {info && <InfoDica texto={typeof info === 'string' ? info : undefined}>{typeof info === 'string' ? null : info}</InfoDica>}
      </span>
      <div class="linha-kpi">
        <span class={cls('valor', medio && 'medio')}>{valor}{unidade && <small>{unidade}</small>}</span>
        {children}
      </div>
      {detalhe && <span class="detalhe">{detalhe}</span>}
      {destaque && <span class="filete" aria-hidden="true" />}
    </Tag>
  );
}

/** Selo (badge). tom: neutro | azul | ok | atencao | perigo | teste · cheio: fundo preenchido. */
export function Selo({ tom = 'neutro', cheio, mono, titulo, children, class: classe }) {
  return <span class={cls('selo', tom !== 'neutro' && tom, cheio && 'cheio', mono && 'mono', classe)} title={titulo}>{children}</span>;
}

export function Ponto({ cor, tamanho = 8, titulo }) {
  return <span class="ponto" style={{ background: cor || undefined, width: `${tamanho}px`, height: `${tamanho}px` }} title={titulo} aria-hidden="true" />;
}

export function Quadrado({ cor, titulo }) {
  return <span class="quadrado" style={cor ? { background: cor } : undefined} title={titulo} aria-hidden="true" />;
}

const tomDoValor = (v, limites) => (v >= limites[1] ? 'perigo' : v >= limites[0] ? 'atencao' : null);

/** Barra fina de 0 a 100 (azul; âmbar a partir de 70, vermelho a partir de 90). */
export function Medidor({ valor, rotulo, limites = [70, 90], cor }) {
  const v = Math.max(0, Math.min(100, Number(valor) || 0));
  return (
    <div class={cls('medidor', !cor && tomDoValor(v, limites))} role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow={String(v)} aria-label={rotulo}>
      <span style={{ width: `${v}%`, background: cor || undefined }} />
    </div>
  );
}

/** Anel de 0 a 100 (medidor circular), com o texto no centro. */
export function Anel({ valor, tamanho = 92, espessura = 6, rotulo, centro, sub, grande, limites = [70, 90] }) {
  const tem = typeof valor === 'number' && Number.isFinite(valor);
  const v = tem ? Math.max(0, Math.min(100, valor)) : 0;
  const r = (tamanho - espessura) / 2;
  const c = 2 * Math.PI * r;
  const tom = tomDoValor(v, limites);
  const cor = tom === 'perigo' ? 'var(--perigo)' : tom === 'atencao' ? 'var(--atencao)' : 'var(--azul)';
  return (
    <div class="anel" style={{ width: `${tamanho}px`, height: `${tamanho}px` }} role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow={tem ? String(v) : undefined} aria-label={rotulo}>
      <svg width={tamanho} height={tamanho} viewBox={`0 0 ${tamanho} ${tamanho}`}>
        <circle cx={tamanho / 2} cy={tamanho / 2} r={r} fill="none" stroke="var(--cartao-3)" stroke-width={espessura} />
        {tem && v > 0 && (
          <circle cx={tamanho / 2} cy={tamanho / 2} r={r} fill="none" stroke={cor} stroke-width={espessura} stroke-linecap="round"
            stroke-dasharray={`${(v / 100) * c} ${c}`} transform={`rotate(-90 ${tamanho / 2} ${tamanho / 2})`} />
        )}
      </svg>
      <div class="anel-centro">
        <span class={cls('anel-valor', grande && 'grande')}>{centro}</span>
        {sub && <span class="minimo mudo">{sub}</span>}
      </div>
    </div>
  );
}

/** Botões segmentados (escolha única). opcoes: [{ id, nome, n }] */
export function Segmentado({ opcoes, valor, aoMudar, rotulo }) {
  return (
    <div class="segmentado" role="group" aria-label={rotulo}>
      {opcoes.map((o) => (
        <button type="button" key={o.id} aria-pressed={valor === o.id ? 'true' : 'false'} onClick={() => aoMudar(o.id)}>
          {o.nome}{o.n !== undefined && <span class="n">{o.n}</span>}
        </button>
      ))}
    </div>
  );
}

export function Vazio({ icone, centro, children }) {
  return <div class={cls('vazio', centro && 'centro')}>{icone && <Icone de={icone} tamanho={22} />}{children}</div>;
}

// <details> que lembra se o usuário abriu ou fechou (sobrevive às atualizações e à troca de tela).
const lembrados = new Map();
export function Recolhivel({ chave, resumo, aberto = false, children, class: classe }) {
  const [abertoAgora, setAberto] = useState(lembrados.has(chave) ? lembrados.get(chave) : aberto);
  return (
    <details class={cls('recolhivel', classe)} open={abertoAgora}
      onToggle={(e) => { const v = e.currentTarget.open; lembrados.set(chave, v); setAberto(v); }}>
      <summary><Icone de={ChevronRight} tamanho={14} class="seta" />{resumo}</summary>
      {abertoAgora && children}
    </details>
  );
}

export function Esqueleto({ largura = '100%', altura = 14, estilo }) {
  return <span class="esqueleto" style={{ display: 'block', width: typeof largura === 'number' ? `${largura}px` : largura, height: `${altura}px`, ...estilo }} aria-hidden="true" />;
}
