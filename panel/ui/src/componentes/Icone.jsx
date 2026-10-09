// Ícones Lucide (monoline, stroke 1.75, como pede a marca). Importe daqui os ícones usados nas telas:
// só os importados entram no build.
export {
  LayoutDashboard, Inbox, ScrollText, SquareKanban, Bot, Gauge, ArrowUpRight, MessageCircle, RefreshCw, Send,
  Activity, Check, X, TriangleAlert, Pause, LoaderCircle, Square, ChevronLeft, ChevronRight, ChevronsLeft,
  ChevronsRight, ChevronDown, Search, ExternalLink, Clock, Calendar, CircleAlert, Info, Workflow, Users, Smartphone,
  CircleCheck, Ban, Hourglass, Terminal, ListChecks, ArrowRight, ArrowLeft, GitBranch, Plug, CornerDownRight,
  FileText, Layers, CircleDashed,
  MapPin, UserCheck, Undo2,
} from 'lucide-preact';

/** <Icone de={Clock} /> desenha o ícone no padrão da marca (16 px, traço 1,75). */
export function Icone({ de: Componente, tamanho = 16, class: classe, titulo, ...resto }) {
  return (
    <Componente
      size={tamanho}
      strokeWidth={1.75}
      class={`icone${classe ? ` ${classe}` : ''}`}
      aria-hidden={titulo ? undefined : 'true'}
      aria-label={titulo}
      {...resto}
    />
  );
}
