// Gráficos em SVG desenhados aqui (sem biblioteca): leves, nítidos e na cor da marca.
// Todos medem o espaço do próprio contêiner (ResizeObserver) e ocupam a largura e a altura disponíveis.
//   GraficoBarras  barras verticais empilhadas por série (ex.: eventos por dia e por agente)
//   GraficoLinhas  séries no tempo com mira e dica (ex.: evolução do quadro do Trello)
//   Rosca          participação de cada parte num total (ex.: resultados dos eventos)
//   Sparkline      tendência mínima dentro de um KPI
//   ListaBarras    ranking horizontal (ex.: consumo por agente)
//   BarraEmpilhada uma barra só, dividida pelas partes (ex.: status das tarefas)
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

/** Mede o elemento (largura e altura) e acompanha mudanças de tamanho. */
export function useMedida() {
  const ref = useRef(null);
  const [m, setM] = useState({ largura: 0, altura: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const medir = () => {
      const r = el.getBoundingClientRect();
      setM((a) => (Math.abs(a.largura - r.width) < 1 && Math.abs(a.altura - r.height) < 1 ? a : { largura: Math.floor(r.width), altura: Math.floor(r.height) }));
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, m];
}

export function passoBonito(max, divisoes = 4) {
  const bruto = max / divisoes;
  const p10 = Math.pow(10, Math.floor(Math.log10(Math.max(bruto, 1))));
  for (const m of [1, 2, 5, 10]) if (m * p10 >= bruto) return Math.max(1, m * p10);
  return 10 * p10;
}

function Dica({ x, y, largura, titulo, linhas }) {
  const esquerda = x + 14 + 190 > largura ? Math.max(0, x - 14 - 190) : x + 14;
  return (
    <div class="dica" style={{ left: `${esquerda}px`, top: `${y}px` }} role="presentation">
      {titulo && <div class="dica-tit">{titulo}</div>}
      {linhas.map((l) => (
        <div class="dica-linha" key={l.nome}>{l.cor && <i style={{ background: l.cor }} />}{l.nome}<b>{l.valor}</b></div>
      ))}
    </div>
  );
}

export function Legenda({ series }) {
  return (
    <div class="legenda">
      {series.map((s) => <span key={s.chave || s.nome}><i style={{ background: s.cor }} />{s.nome}</span>)}
    </div>
  );
}

/**
 * Barras verticais empilhadas.
 * dados: [{ chave, rotulo, titulo, valores: { [serie]: n } }] · series: [{ chave, nome, cor }]
 */
export function GraficoBarras({ dados, series, rotuloAria, formatar = String, destacarUltimo }) {
  const [ref, { largura: W, altura: H }] = useMedida();
  const [foco, setFoco] = useState(null);
  const m = { e: 30, d: 4, t: 8, b: 24 };
  const larg = Math.max(0, W - m.e - m.d);
  const alt = Math.max(0, H - m.t - m.b);
  const totais = dados.map((d) => series.reduce((s, x) => s + (Number(d.valores[x.chave]) || 0), 0));
  const vmax = Math.max(1, ...totais);
  const passo = passoBonito(vmax);
  const topo = Math.ceil(vmax / passo) * passo;
  const banda = dados.length ? larg / dados.length : 0;
  const barra = Math.min(38, banda * 0.58);
  const y = (v) => m.t + (1 - v / topo) * alt;
  const grade = [];
  for (let v = 0; v <= topo; v += passo) grade.push(v);
  return (
    <div class="grafico" ref={ref} onMouseLeave={() => setFoco(null)}>
      {W > 0 && H > 0 && (
        <svg width={W} height={H} role="img" aria-label={rotuloAria}>
          {grade.map((v) => (
            <g key={v}>
              <line class={v === 0 ? 'eixo' : 'grade'} x1={m.e} x2={m.e + larg} y1={y(v)} y2={y(v)} />
              <text x={m.e - 8} y={y(v) + 4} text-anchor="end">{v}</text>
            </g>
          ))}
          {dados.map((d, i) => {
            const x0 = m.e + i * banda + (banda - barra) / 2;
            let base = 0;
            const ativo = foco === i;
            return (
              <g key={d.chave} onMouseEnter={() => setFoco(i)}>
                <rect x={m.e + i * banda} y={m.t} width={banda} height={alt} fill={ativo ? '#141414' : 'transparent'} />
                {series.map((s) => {
                  const v = Number(d.valores[s.chave]) || 0;
                  if (!v) return null;
                  const y1 = y(base + v); const y0 = y(base);
                  base += v;
                  return <rect key={s.chave} x={x0} y={y1} width={barra} height={Math.max(1, y0 - y1 - 1)} rx="2" fill={s.cor} opacity={foco === null || ativo ? 1 : 0.55} />;
                })}
                <text x={m.e + i * banda + banda / 2} y={H - 6} text-anchor="middle" style={destacarUltimo && i === dados.length - 1 ? { fill: 'var(--texto)' } : undefined}>{d.rotulo}</text>
              </g>
            );
          })}
        </svg>
      )}
      {foco !== null && dados[foco] && (
        <Dica x={m.e + foco * banda + banda / 2} y={m.t} largura={W} titulo={dados[foco].titulo || dados[foco].rotulo}
          linhas={[...series.filter((s) => Number(dados[foco].valores[s.chave])).map((s) => ({ nome: s.nome, cor: s.cor, valor: formatar(Number(dados[foco].valores[s.chave])) })),
            { nome: 'Total', valor: formatar(totais[foco]) }]} />
      )}
    </div>
  );
}

/**
 * Séries no tempo. pontos: [{ t (ms), titulo, [serie]: n }] · series: [{ chave, nome, cor }]
 * rotuloX(t) escreve as marcas do eixo; os rótulos das séries ficam no fim de cada linha.
 */
export function GraficoLinhas({ pontos, series, rotuloAria, rotuloX, formatar = String, margemDireita = 118 }) {
  const [ref, { largura: W, altura: H }] = useMedida();
  const [foco, setFoco] = useState(null);
  if (!pontos.length) return <div class="grafico" ref={ref} />;
  const m = { e: 34, d: margemDireita, t: 12, b: 26 };
  const larg = Math.max(0, W - m.e - m.d);
  const alt = Math.max(0, H - m.t - m.b);
  const t0 = pontos[0].t; const t1 = pontos[pontos.length - 1].t;
  const vmax = Math.max(1, ...pontos.flatMap((p) => series.map((s) => (Number.isFinite(p[s.chave]) ? p[s.chave] : 0))));
  const passo = passoBonito(vmax);
  const topo = Math.ceil(vmax / passo) * passo;
  const x = (t) => m.e + (t1 === t0 ? larg / 2 : ((t - t0) / (t1 - t0)) * larg);
  const y = (v) => m.t + (1 - v / topo) * alt;
  const grade = [];
  for (let v = 0; v <= topo; v += passo) grade.push(v);
  // marcas do eixo x sem sobrepor (mín. 96 px); a última sempre aparece
  const marcas = [];
  for (const p of pontos) if (!marcas.length || x(p.t) - x(marcas[marcas.length - 1].t) >= 96) marcas.push(p);
  const ultimo = pontos[pontos.length - 1];
  if (marcas[marcas.length - 1] !== ultimo) {
    if (marcas.length > 1 && x(ultimo.t) - x(marcas[marcas.length - 1].t) < 96) marcas.pop();
    marcas.push(ultimo);
  }
  const rotulos = [];
  for (const s of series) {
    const validos = pontos.filter((p) => Number.isFinite(p[s.chave]));
    if (!validos.length) continue;
    const u = validos[validos.length - 1];
    rotulos.push({ y: y(u[s.chave]), texto: `${s.nome} ${formatar(u[s.chave])}`, x: x(u.t) + 10, chave: s.chave });
  }
  rotulos.sort((a, b) => a.y - b.y);
  for (let i = 1; i < rotulos.length; i++) if (rotulos[i].y - rotulos[i - 1].y < 15) rotulos[i].y = rotulos[i - 1].y + 15;
  const mover = (ev) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    let melhor = 0;
    for (let i = 0; i < pontos.length; i++) if (Math.abs(x(pontos[i].t) - mx) < Math.abs(x(pontos[melhor].t) - mx)) melhor = i;
    setFoco(melhor);
  };
  const pf = foco !== null ? pontos[foco] : null;
  return (
    <div class="grafico" ref={ref}>
      {W > 0 && H > 0 && (
        <svg width={W} height={H} role="img" aria-label={rotuloAria} onMouseMove={mover} onMouseLeave={() => setFoco(null)}>
          {grade.map((v) => (
            <g key={v}>
              <line class={v === 0 ? 'eixo' : 'grade'} x1={m.e} x2={m.e + larg} y1={y(v)} y2={y(v)} />
              <text x={m.e - 8} y={y(v) + 4} text-anchor="end">{v}</text>
            </g>
          ))}
          {marcas.map((p, i) => (
            <text key={p.t} x={x(p.t)} y={H - 6} text-anchor={marcas.length === 1 ? 'middle' : i === 0 ? 'start' : i === marcas.length - 1 ? 'end' : 'middle'}>{rotuloX(p.t)}</text>
          ))}
          {series.map((s) => {
            const validos = pontos.filter((p) => Number.isFinite(p[s.chave]));
            return (
              <g key={s.chave}>
                {validos.length > 1 && <path d={validos.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[s.chave]).toFixed(1)}`).join('')}
                  fill="none" stroke={s.cor} stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />}
                {validos.map((p) => <circle key={p.t} cx={x(p.t)} cy={y(p[s.chave])} r={validos.length > 40 ? 0 : 3} fill={s.cor} />)}
              </g>
            );
          })}
          {rotulos.map((r) => <text key={r.chave} class="rotulo-serie" x={r.x} y={Math.min(H - m.b, r.y) + 4}>{r.texto}</text>)}
          {pf && <line class="mira" x1={x(pf.t)} x2={x(pf.t)} y1={m.t} y2={m.t + alt} />}
          {pf && series.map((s) => Number.isFinite(pf[s.chave]) && <circle key={s.chave} cx={x(pf.t)} cy={y(pf[s.chave])} r="4.5" fill={s.cor} stroke="var(--cartao)" stroke-width="2" />)}
          <rect x={m.e - 8} y="0" width={larg + 16} height={H} fill="transparent" />
        </svg>
      )}
      {pf && <Dica x={x(pf.t)} y={m.t} largura={W} titulo={pf.titulo} linhas={series.map((s) => ({ nome: s.nome, cor: s.cor, valor: Number.isFinite(pf[s.chave]) ? formatar(pf[s.chave]) : '—' }))} />}
    </div>
  );
}

/** Rosca: fatias [{ chave, nome, valor, cor }]; o centro mostra o total ou a fatia sob o mouse. */
export function Rosca({ fatias, tamanho = 150, espessura = 14, rotuloAria, centro, sub }) {
  const [foco, setFoco] = useState(null);
  const total = fatias.reduce((s, f) => s + (f.valor || 0), 0);
  const r = (tamanho - espessura) / 2;
  const c = 2 * Math.PI * r;
  const visiveis = fatias.filter((f) => f.valor > 0);
  const vao = visiveis.length > 1 ? 3 : 0;
  let acumulado = 0;
  const ativa = foco !== null ? fatias.find((f) => f.chave === foco) : null;
  return (
    <div class="anel" style={{ width: `${tamanho}px`, height: `${tamanho}px` }} onMouseLeave={() => setFoco(null)}>
      <svg width={tamanho} height={tamanho} role="img" aria-label={rotuloAria}>
        <circle cx={tamanho / 2} cy={tamanho / 2} r={r} fill="none" stroke="var(--cartao-3)" stroke-width={espessura} />
        {total > 0 && visiveis.map((f) => {
          const comp = (f.valor / total) * c;
          const el = (
            <circle key={f.chave} cx={tamanho / 2} cy={tamanho / 2} r={r} fill="none" stroke={f.cor} stroke-width={foco === f.chave ? espessura + 3 : espessura}
              stroke-dasharray={`${Math.max(0.5, comp - vao)} ${c}`} stroke-dashoffset={-acumulado}
              transform={`rotate(-90 ${tamanho / 2} ${tamanho / 2})`} onMouseEnter={() => setFoco(f.chave)} style={{ cursor: 'default' }} />
          );
          acumulado += comp;
          return el;
        })}
      </svg>
      <div class="anel-centro" style={{ pointerEvents: 'none' }}>
        <span class="anel-valor grande">{ativa ? ativa.valor : centro}</span>
        <span class="minimo mudo">{ativa ? ativa.nome : sub}</span>
      </div>
    </div>
  );
}

/** Tendência mínima: barras finas (padrão) ou linha. */
export function Sparkline({ valores, largura = 120, altura = 32, cor = 'var(--azul)', tipo = 'barras', rotuloAria, destacarUltimo = true }) {
  const n = valores.length;
  if (!n) return null;
  const max = Math.max(1, ...valores);
  if (tipo === 'linha') {
    const x = (i) => (n === 1 ? largura / 2 : (i / (n - 1)) * (largura - 2) + 1);
    const y = (v) => altura - 2 - (v / max) * (altura - 4);
    return (
      <svg width={largura} height={altura} role="img" aria-label={rotuloAria}>
        <path d={valores.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')} fill="none" stroke={cor} stroke-width="1.5" stroke-linejoin="round" />
        <circle cx={x(n - 1)} cy={y(valores[n - 1])} r="2.5" fill={cor} />
      </svg>
    );
  }
  const banda = largura / n;
  const b = Math.max(1, banda - 2);
  return (
    <svg width={largura} height={altura} role="img" aria-label={rotuloAria}>
      {valores.map((v, i) => {
        const h = v ? Math.max(2, (v / max) * altura) : 1;
        return <rect key={i} x={i * banda} y={altura - h} width={b} height={h} rx="1" fill={v ? cor : 'var(--cartao-3)'} opacity={destacarUltimo && i !== n - 1 && v ? 0.5 : 1} />;
      })}
    </svg>
  );
}

/** Ranking horizontal: itens [{ chave, nome (nó), valor (0-100), rotuloValor, sub, cor }]. */
export function ListaBarras({ itens, maximo = 100 }) {
  return (
    <div class="lista-barras">
      {itens.map((it) => (
        <div class="barra-linha" key={it.chave}>
          <div class="barra-nome">{it.nome}</div>
          <div class="barra-valor">{it.rotuloValor}</div>
          <div class="barra-trilho" role="img" aria-label={it.rotuloAria}>
            <span style={{ width: `${Math.max(0, Math.min(100, (it.valor / (maximo || 1)) * 100))}%`, background: it.cor || 'var(--azul)' }} />
          </div>
          {it.sub && <div class="barra-sub">{it.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/** Uma barra dividida pelas partes: [{ chave, valor, cor, nome }]. formatar(v) escreve o valor na dica de cada parte. */
export function BarraEmpilhada({ partes, rotuloAria, formatar }) {
  const total = partes.reduce((s, p) => s + (p.valor || 0), 0);
  const parte = (p) => `${p.nome}: ${formatar ? formatar(p.valor) : p.valor} (${Math.round((p.valor / total) * 100)}%)`;
  return (
    <div class="barra-empilhada" role="img" aria-label={rotuloAria}>
      {total > 0 && partes.filter((p) => p.valor > 0).map((p) => <span key={p.chave} title={parte(p)} style={{ width: `${(p.valor / total) * 100}%`, background: p.cor }} />)}
    </div>
  );
}

/** Roda fn quando o elemento fica visível pela primeira vez (adiar trabalho fora da tela). */
export function useVisivel(ref) {
  const [visivel, setVisivel] = useState(false);
  useEffect(() => {
    if (visivel || !ref.current) return undefined;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setVisivel(true); io.disconnect(); } });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visivel]);
  return visivel;
}
