// Casca do painel: lê /api/state a cada 20 s, guarda a tela atual na URL (#visao, #log...),
// os filtros do Log e o modal do evento. Só a tela visível é desenhada.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { PainelContexto, ABAS, novoFiltro } from '../dados/contexto.js';
import { INTERVALO_MS, INTERVALO_ANALITICO_MS, MOCK, lerEstado, recalcularUso, lerEventos } from '../dados/api.js';
import { acertarRelogio, agora, diaSP, hora, txt, obj, arr } from '../dados/formato.js';
import { parametrosLog, analisar } from '../dados/consultas.js';
import { Lateral } from './Lateral.jsx';
import { Topo } from './Topo.jsx';
import { Visao } from '../telas/Visao.jsx';
import { Pendencias } from '../telas/Pendencias.jsx';
import { Log } from '../telas/Log.jsx';
import { Agentes } from '../telas/Agentes.jsx';
import { Uso } from '../telas/Uso.jsx';
import { ModalEvento } from '../telas/ModalEvento.jsx';
import { Icone, TriangleAlert, Info } from '../componentes/Icone.jsx';

// Uma tela por item de ABAS (dados/contexto.js). Tela nova: entra aqui e lá.
const TELAS = { visao: Visao, pendencias: Pendencias, log: Log, agentes: Agentes, uso: Uso };
// URL: #<tela> ou #<tela>/<sub-aba>.
const partesDoHash = () => {
  const [id, ...resto] = decodeURIComponent(location.hash.slice(1)).split('/');
  return ABAS.some((a) => a.id === id) ? { id, sub: resto.join('/') } : { id: 'visao', sub: '' };
};
const abaDoHash = () => partesDoHash().id;
const hashDe = (id, sub) => `#${id}${sub ? `/${sub}` : ''}`;

export function App() {
  const [estado, setEstado] = useState(null);
  const [erroConexao, setErroConexao] = useState(null);
  const [falhaDesde, setFalhaDesde] = useState(null);
  const [aba, setAba] = useState(abaDoHash);
  const [subrota, setSubrota] = useState(() => partesDoHash().sub);
  const [statusAcao, setStatusAcao] = useState('');
  const [recalculando, setRecalculando] = useState(false);
  const [modal, setModal] = useState(null); // { id, lista, tabela }
  const [pendenciaAlvo, setPendenciaAlvo] = useState(null);
  const abaRef = useRef(aba);
  abaRef.current = aba;

  // ---------- leitura do estado ----------
  const lendo = useRef(false);
  const atualizar = useCallback(async () => {
    if (lendo.current) return;
    lendo.current = true;
    try {
      const est = await lerEstado();
      if (est && typeof est === 'object') {
        acertarRelogio(est.gerado_em);
        setEstado(est);
      }
      setErroConexao(null);
      setFalhaDesde(null);
    } catch (e) {
      setErroConexao(e);
      setFalhaDesde((f) => f || Date.now());
    } finally {
      lendo.current = false;
    }
    if (abaRef.current === 'log') carregarLogRef.current(true);
  }, []);

  useEffect(() => {
    atualizar();
    const t = setInterval(atualizar, INTERVALO_MS);
    const vis = () => { if (document.visibilityState === 'visible') atualizar(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, []);

  // ---------- navegação ----------
  // irPara('log') troca de tela; irPara('<tela>', '<sub-aba>') abre a tela já na sub-aba.
  const irPara = useCallback((id, sub = '') => {
    const alvo = ABAS.some((a) => a.id === id) ? id : 'visao';
    const s = alvo === id ? String(sub || '') : '';
    setAba(alvo);
    setSubrota(s);
    if (location.hash !== hashDe(alvo, s)) history.replaceState(null, '', hashDe(alvo, s));
  }, []);
  useEffect(() => {
    const h = () => { const p = partesDoHash(); setAba(p.id); setSubrota(p.sub); };
    window.addEventListener('hashchange', h);
    if (location.hash !== hashDe(aba, subrota)) history.replaceState(null, '', hashDe(aba, subrota));
    return () => window.removeEventListener('hashchange', h);
  }, []);
  useEffect(() => {
    const t = ABAS.find((a) => a.id === aba);
    const ws = estado && obj(estado.workspace);
    document.title = `${t ? t.nome : 'Painel'} · ${ws && ws.nome ? `Painel ${ws.nome}` : 'Painel do workspace'}`;
  }, [aba, estado && estado.workspace && estado.workspace.nome]);

  // ---------- Log: filtros, página e leitura ----------
  const [filtros, setFiltrosBrutos] = useState(novoFiltro);
  const [pagina, setPagina] = useState(1);
  const [log, setLog] = useState({ resposta: null, erro: null, carregando: false });
  const seqLog = useRef(0);
  const filtrosRef = useRef(filtros); filtrosRef.current = filtros;
  const paginaRef = useRef(pagina); paginaRef.current = pagina;
  const carregarLog = useCallback(async (silencioso) => {
    const seq = ++seqLog.current;
    if (!silencioso) setLog((l) => ({ ...l, carregando: true }));
    try {
      const r = await lerEventos(parametrosLog(filtrosRef.current, paginaRef.current));
      if (seq !== seqLog.current) return;
      const paginas = r.paginas || Math.max(1, Math.ceil((r.total || 0) / (r.por_pagina || 50)));
      // a página pode ter sumido (menos eventos com o filtro): volta para a última que existe
      if (paginaRef.current > paginas && (r.total || 0) > 0) { setPagina(paginas); return; }
      setLog({ resposta: r, erro: null, carregando: false });
    } catch (e) {
      if (seq !== seqLog.current) return;
      setLog((l) => ({ ...l, erro: e, carregando: false }));
    }
  }, []);
  const carregarLogRef = useRef(carregarLog);
  useEffect(() => { if (aba === 'log' || log.resposta) carregarLog(false); }, [filtros, pagina]);
  useEffect(() => { if (aba === 'log' && !log.resposta) carregarLog(false); }, [aba]);
  const setFiltros = useCallback((mudar) => {
    setFiltrosBrutos((f) => (typeof mudar === 'function' ? mudar(f) : { ...f, ...mudar }));
    setPagina(1);
  }, []);

  // ---------- análise dos últimos 7 dias (Visão geral e Agentes) ----------
  const [analitico, setAnalitico] = useState({ eventos: null, em: 0, erro: null });
  const lendoAnalise = useRef(false);
  const lerAnalise = useCallback(async () => {
    if (lendoAnalise.current) return;
    lendoAnalise.current = true;
    try {
      const desde = diaSP(agora() - 6 * 86400000);
      let eventos = [];
      for (let p = 1; p <= 4; p++) {
        const sp = new URLSearchParams({ desde, pagina: String(p), por_pagina: '500' });
        const r = await lerEventos(sp);
        eventos = eventos.concat(arr(r.eventos));
        if (!r.paginas || p >= r.paginas) break;
      }
      setAnalitico({ eventos, em: Date.now(), erro: null });
    } catch (e) {
      setAnalitico((a) => ({ ...a, em: Date.now(), erro: e }));
    } finally {
      lendoAnalise.current = false;
    }
  }, []);
  useEffect(() => {
    if (!estado || (aba !== 'visao' && aba !== 'agentes')) return;
    if (Date.now() - analitico.em > INTERVALO_ANALITICO_MS) lerAnalise();
  }, [aba, estado]);

  const analise = useMemo(() => (analitico.eventos ? analisar(analitico.eventos) : null), [analitico.eventos]);

  // ---------- ações ----------
  const recalcular = useCallback(async () => {
    setRecalculando(true);
    setStatusAcao('');
    try {
      const est = await recalcularUso();
      acertarRelogio(est.gerado_em);
      setEstado(est);
      setErroConexao(null); setFalhaDesde(null);
      const r = obj(est.recalculo);
      setStatusAcao(r && r.ok === false ? `Coletor falhou: ${txt(r.erro)}` : `Uso recalculado às ${hora(est.gerado_em)}${MOCK ? ' (modo de teste)' : ''}`);
      if (abaRef.current === 'log') carregarLog(true);
    } catch (e) {
      setStatusAcao(`Não consegui recalcular: ${e.message}`);
    } finally {
      setRecalculando(false);
    }
  }, []);

  const abrirModal = useCallback((id, lista, tabela) => {
    if (!id) return;
    setModal((m) => (Array.isArray(lista)
      ? { id, lista: lista.filter((x) => typeof x === 'string' && x), tabela: tabela || null }
      : { id, lista: m ? m.lista : [], tabela: m ? m.tabela : null }));
  }, []);
  const fecharModal = useCallback(() => setModal(null), []);

  const filtrarPorFluxo = useCallback((id) => {
    setModal(null);
    setFiltrosBrutos((f) => ({ ...novoFiltro(), fluxo: id, incluir_testes: f.incluir_testes }));
    setPagina(1);
    irPara('log');
  }, []);
  const irParaPendencia = useCallback((id) => {
    setModal(null);
    irPara('pendencias');
    setPendenciaAlvo({ id, vez: Date.now() });
  }, []);

  const ctx = {
    estado, erroConexao, falhaDesde, aba, irPara, statusAcao, setStatusAcao, recalculando, recalcular,
    modal, abrirModal, fecharModal, setModal, filtrarPorFluxo, irParaPendencia, pendenciaAlvo,
    filtros, setFiltros, setFiltrosBrutos, pagina, setPagina, log, carregarLog,
    analitico, analise, subrota,
  };

  const Tela = TELAS[aba] || Visao;
  return (
    <PainelContexto.Provider value={ctx}>
      <div class="app">
        <Lateral />
        <div class="principal">
          <Topo />
          <div>
            {MOCK && (
              <div class="faixa mock"><Icone de={Info} />Modo de teste (?mock=1): dados fictícios de tests/mock-state.json e mock-details.json. Nada aqui vem do servidor.</div>
            )}
            {erroConexao && (
              <div class="faixa erro" role="alert"><Icone de={TriangleAlert} />
                Não consegui ler o painel ({erroConexao.message}). Tento de novo a cada 20 s.{estado ? ' O que está na tela é a última leitura boa.' : ''}
              </div>
            )}
          </div>
          <main class="conteudo" id="principal" role="tabpanel" aria-labelledby={`tab-${aba}`}>
            <Tela />
          </main>
        </div>
      </div>
      {modal && <ModalEvento />}
    </PainelContexto.Provider>
  );
}
