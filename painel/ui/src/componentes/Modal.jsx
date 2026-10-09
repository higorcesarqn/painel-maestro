// Janela modal (diálogo): foco preso dentro, Esc fecha (aoFechar), clique fora fecha, devolve o foco ao sair.
import { useEffect, useRef } from 'preact/hooks';

export function Modal({ aoFechar, rotuloId, children, largura }) {
  const caixa = useRef(null);
  const fechar = useRef(aoFechar);
  fechar.current = aoFechar;
  useEffect(() => {
    const antes = document.activeElement;
    if (caixa.current) caixa.current.focus();
    const tecla = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); fechar.current(); return; }
      if (ev.key !== 'Tab' || !caixa.current) return;
      const foco = [...caixa.current.querySelectorAll('button:not([disabled]), a[href], [tabindex="0"], summary, input, select')]
        .filter((x) => x.offsetParent !== null);
      if (!foco.length) return;
      const pri = foco[0]; const ult = foco[foco.length - 1];
      if (ev.shiftKey && (document.activeElement === pri || document.activeElement === caixa.current)) { ult.focus(); ev.preventDefault(); }
      else if (!ev.shiftKey && document.activeElement === ult) { pri.focus(); ev.preventDefault(); }
    };
    document.addEventListener('keydown', tecla);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', tecla);
      document.body.style.overflow = '';
      if (antes && document.contains(antes) && typeof antes.focus === 'function') antes.focus();
    };
  }, []);
  return (
    <div class="modal-fundo" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) fechar.current(); }}>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby={rotuloId} tabindex="-1" ref={caixa}
        style={largura ? { width: `min(${largura}px, 100%)` } : undefined}>
        {children}
      </div>
    </div>
  );
}

/** Painel flutuante preso a um botão do cabeçalho (marcado com data-abre-popover); fecha com Esc ou clique fora. */
export function Popover({ aoFechar, children, direita = 0, id, papel }) {
  const caixa = useRef(null);
  const fechar = useRef(aoFechar);
  fechar.current = aoFechar;
  useEffect(() => {
    const fora = (ev) => {
      if (caixa.current && !caixa.current.contains(ev.target) && !(ev.target.closest && ev.target.closest('[data-abre-popover]'))) fechar.current();
    };
    const tecla = (ev) => { if (ev.key === 'Escape') fechar.current(); };
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', tecla);
    return () => { document.removeEventListener('mousedown', fora); document.removeEventListener('keydown', tecla); };
  }, []);
  return <div class="popover" id={id} role={papel} ref={caixa} style={{ right: `${direita}px` }}>{children}</div>;
}
