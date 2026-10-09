// Lucide icons (monoline, stroke 1.75, as the brand asks). Import the icons the screens use from here:
// only the imported ones go into the build.
export {
  LayoutDashboard, Inbox, ScrollText, SquareKanban, Bot, Gauge, ArrowUpRight, MessageCircle, RefreshCw, Send,
  Activity, Check, X, TriangleAlert, Pause, LoaderCircle, Square, ChevronLeft, ChevronRight, ChevronsLeft,
  ChevronsRight, ChevronDown, Search, ExternalLink, Clock, Calendar, CircleAlert, Info, Workflow, Users, Smartphone,
  CircleCheck, Ban, Hourglass, Terminal, ListChecks, ArrowRight, ArrowLeft, GitBranch, Plug, CornerDownRight,
  FileText, Layers, CircleDashed,
  MapPin, UserCheck, Undo2,
  GitMerge,
} from 'lucide-preact';

/** <Icon of={Clock} /> draws the icon in the brand style (16 px, stroke 1.75). */
export function Icon({ of: Component, size = 16, class: className, title, ...rest }) {
  return (
    <Component
      size={size}
      strokeWidth={1.75}
      class={`icon${className ? ` ${className}` : ''}`}
      aria-hidden={title ? undefined : 'true'}
      aria-label={title}
      {...rest}
    />
  );
}
