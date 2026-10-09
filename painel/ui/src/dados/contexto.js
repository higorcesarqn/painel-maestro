// Contexto do painel: estado lido do servidor, navegação entre telas, filtros do Log e o modal do evento.
//
// Regra do menu: o painel é um app só. Tela nova = um item em ABAS (id, nome,
// titulo, grupo) + o componente dela em TELAS (app/App.jsx) + o ícone em ICONES (app/Lateral.jsx). Nada de
// página separada. O grupo decide em que bloco do menu ela aparece (GRUPOS, na ordem do menu); a URL é
// #<id> e, se a tela tiver sub-abas, #<id>/<sub> (o App entrega a sub-aba em `subrota`).
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

export const PainelContexto = createContext(null);
export const usePainel = () => useContext(PainelContexto);

export const GRUPOS = [
  { id: 'workspace', nome: 'Workspace' },
  { id: 'operacoes', nome: 'Operações' },
];

export const ABAS = [
  { id: 'visao', nome: 'Visão geral', titulo: 'Visão geral', grupo: 'workspace' },
  { id: 'pendencias', nome: 'Pendências', titulo: 'Pendências do dono', grupo: 'workspace' },
  { id: 'log', nome: 'Log', titulo: 'Log de eventos', grupo: 'workspace' },
  { id: 'trello', nome: 'Trello', titulo: 'Trello', grupo: 'workspace' },
  { id: 'agentes', nome: 'Agentes', titulo: 'Agentes', grupo: 'workspace' },
  { id: 'uso', nome: 'Uso', titulo: 'Uso do Claude', grupo: 'workspace' },
  { id: 'prospeccao', nome: 'Prospecção', titulo: 'Prospecção', grupo: 'operacoes' },
];

export function novoFiltro() {
  return { periodo: 'todos', desde: '', ate: '', agente: '', projeto: '', tipo: '', resultado: '', so_dono: false, incluir_testes: false, q: '', fluxo: '' };
}
