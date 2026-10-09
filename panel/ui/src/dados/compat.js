// Provisional bridge between the English API (task #3) and the screens, which still read the old
// Portuguese field names. It renames the fields back and translates the server codes ({code, ...params})
// into the same Portuguese texts the server used to send. Task #4 moves the screens to English and
// replaces this file with the pt-BR dictionary.
import { agora, diaSP, fHM, fDiaMes } from './formato.js';

// API field (English) → field the screens read (Portuguese).
const FIELDS = {
  generated_at: 'gerado_em', name: 'nome', root: 'raiz', health: 'saude', level: 'nivel', reasons: 'motivos',
  last_event_age_min: 'ultimo_evento_idade_min', usage_age_min: 'uso_idade_min', agent: 'agente', active: 'ativo',
  registered: 'registrado', last_raw: 'ultimo_bruto', age_min: 'idade_min', pending_decisions: 'pendencias',
  usage: 'uso', available: 'disponivel', window_5h_pct: 'janela_5h_pct', weekly_pct: 'semanal_pct',
  weekly_reset: 'reset_semanal', updated_at: 'atualizado_em', reason: 'motivo', window_5h_reason: 'janela_5h_motivo',
  weekly_reason: 'semanal_motivo', source: 'fonte', collected_at: 'coletado_em', agents: 'agentes', type: 'tipo',
  color: 'cor', responsibility: 'responsabilidade', model: 'modelo', effort: 'nivel', connected_to: 'conectado_a',
  since: 'desde', remark: 'observacao', last_event: 'ultimo_evento', summary: 'resumo', result: 'resultado',
  flow_id: 'fluxo_id', events_today: 'eventos_hoje', open_flows: 'fluxos_abertos', window_5h: 'janela_5h',
  today: 'hoje', input: 'entrada', output: 'saida', cache_write: 'cache_escrita', cache_read: 'cache_leitura',
  messages: 'mensagens', relative_consumption: 'consumo_relativo', consumption_pct: 'pct_consumo',
  estimated_plan_pct: 'pct_plano_estimado', plan_week_consumption_pct: 'pct_consumo_semana_plano',
  opened_at: 'aberta_em', severity: 'severidade', title: 'titulo', context: 'contexto', options: 'opcoes',
  recommendation: 'recomendacao', answer: 'resposta', answered_at: 'respondida_em', resolved_at: 'resolvida_em',
  note: 'nota', test: 'teste', plan: 'plano', file: 'arquivo', window_5h_duration_s: 'janela_5h_duracao_s',
  weekly_duration_s: 'semanal_duracao_s', state: 'estado', warnings: 'avisos', periods: 'periodos', start: 'inicio',
  end: 'fim', basis: 'base', plan_basis: 'base_plano', by_agent: 'por_agente', totals: 'totais', collection: 'coleta',
  sessions: 'sessoes', sessions_without_owner: 'sessoes_sem_dono', unreadable_sessions: 'sessoes_ilegiveis',
  sessions_without_transcript: 'sessoes_sem_transcricao', transcripts: 'transcricoes',
  missing_transcripts: 'transcricoes_ausentes', old_transcripts: 'transcricoes_antigas',
  restarted_transcripts: 'transcricoes_recomecadas', bytes_read: 'bytes_lidos', lines_with_usage: 'linhas_com_uso',
  invalid_lines: 'linhas_invalidas', duration_ms: 'duracao_ms', events: 'eventos', project: 'projeto',
  direction: 'direcao', needs_owner: 'precisa_dono', origin: 'origem', collector: 'coletor', interval_min: 'intervalo_min',
  last: 'ultima', at: 'em', trigger: 'motivo', running: 'em_andamento', answers: 'respostas', brain_notice: 'aviso_cerebro',
  recalculation: 'recalculo', error: 'erro', page: 'pagina', per_page: 'por_pagina', pages: 'paginas', counts: 'contagens',
  event: 'evento', flow: 'fluxo', created_at: 'criado_em', initial_request: 'pedido_inicial', text: 'texto',
  event_id: 'evento_id', session: 'sessao', origin_inferred: 'origem_inferida', sequence: 'sequencia',
  raw_commands: 'comandos_brutos', hook_event: 'evento', tool: 'ferramenta', correlation: 'correlacao',
  raw_commands_truncated: 'comandos_truncados', raw_commands_omitted: 'comandos_omitidos',
  raw_commands_warnings: 'comandos_aviso', window_without_flow: 'janela_sem_fluxo', previous_id: 'anterior_id',
  next_id: 'proximo_id', steps: 'passos', commands: 'comandos', changes: 'alteracoes', validation: 'validacao',
  next_step: 'proximo_passo', duration_s: 'duracao_s', original_type: 'tipo_original', imported_from: 'importado_de',
  request: 'pedido', pending_decision: 'pendencia', sent: 'enviado', to: 'para', output_summary: 'saida_resumo',
  version: 'versao', detail: 'detalhe', interval: 'intervalo',
};

// Server codes that are values (not texts) the screens compare.
const VALUES = {
  level: { green: 'verde', yellow: 'amarelo', red: 'vermelho' },
  correlation: { flow_id: 'fluxo_id', window: 'janela' },
  cache: { new: 'novo', reused: 'reaproveitado', recreated: 'recriado' },
  trigger: { startup: 'inicio', periodic: 'periodico', recalculate: 'recalcular' },
};
const REQUEST_SOURCES = { event_prompt: 'prompt-do-evento', event: 'evento', prompt: 'prompt' };

// Query parameters of /api/events: the screens build them in Portuguese.
const EVENT_PARAMS = {
  desde: 'since', ate: 'until', horas: 'hours', agente: 'agent', projeto: 'project', tipo: 'type', resultado: 'result',
  q: 'q', so_dono: 'owner_only', incluir_testes: 'include_tests', fluxo: 'flow', pagina: 'page', por_pagina: 'per_page',
};
const PARAM_NAMES = Object.fromEntries(Object.entries(EVENT_PARAMS).map(([pt, en]) => [en, pt]));

/** "13:00" on the same day as now; otherwise "10/10 13:00". */
function shortTime(v) {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return '?';
  return diaSP(t) === diaSP(agora()) ? fHM.format(t) : `${fDiaMes.format(t)} ${fHM.format(t)}`;
}

function durationText(min) {
  const m = Math.round(min);
  if (m < 1) return 'menos de 1 min';
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  }
  return `${Math.floor(m / (24 * 60))} dias`;
}

const windowName = (w) => (w === '5h' ? 'de 5 h' : 'semanal');
const sub = (x) => (x && typeof x === 'object' ? traduzir(x) : x);

const TEXTS = {
  // health and warnings
  hook_never: (c) => `${c.name}: nenhum log bruto ainda (hooks instalados?)`,
  hook_stale: (c) => `${c.name} sem log bruto há ${durationText(c.minutes)}`,
  registry_missing: (c) => `${c.file} não existe`,
  file_unreadable: (c) => `${c.file} ilegível (${sub(c.error)})`,
  read_failed: (c) => `não consegui ler (${c.detail})`,
  empty_file: () => 'arquivo vazio',
  invalid_json: (c) => `JSON inválido (${c.detail})`,
  unexpected_format: () => 'formato inesperado',
  missing_list: (c) => `sem a lista "${c.list}"`,
  collector_not_run: () => 'O coletor de uso ainda não rodou (sem state/usage.json).',
  usage_unreadable: (c) => `${c.file} ilegível (${sub(c.error)}).`,
  event_lines_ignored: (c) => `${c.file}: ${c.count} linha(s) ilegível(is) ou sem id válido ignorada(s)`,
  event_file_incomplete: (c) => `${c.file}: leitura incompleta (${c.error}); tento de novo na próxima atualização`,
  // plan and usage collector
  maestri_claude_provider: (c) => (c.file ? `provedor Claude do Maestri (${c.file})` : 'provedor Claude do Maestri'),
  usage_note: () => 'o % por agente é estimado; o % do plano vem do Maestri/Claude',
  usage_formula: () => 'consumo relativo = entrada + 5 × saída + 1,25 × escrita de cache + 0,1 × leitura de cache',
  usage_source: () => 'plano: provedor Claude do Maestri (usage/providers/.status.json) · por agente: transcrições do Claude Code (projects/*.jsonl), atribuídas pelas sessões em state/sessions',
  last_5h_no_reset: () => 'últimas 5 h (sem reset válido do plano)',
  since_5h_window_start: () => 'desde o início da janela de 5 h do plano (reset − 5 h)',
  since_midnight: () => 'desde 00:00 (São Paulo)',
  last_7_days: () => 'últimos 7 dias',
  plan_week: () => 'semana do plano (reset semanal − 7 dias)',
  plan_file_missing: (c) => `O Maestri ainda não gravou o uso do plano (${c.file} não existe). Ligue o uso dos agentes no Maestri (Configurações → Agentes → Uso) e deixe os anéis visíveis.`,
  plan_file_unreadable: (c) => `Não consegui ler ${c.file}: ${sub(c.error)}.`,
  plan_provider_missing: () => 'O arquivo de uso do Maestri não tem o provedor "claude".',
  plan_provider_off: () => 'O provedor Claude está desligado no Maestri (Configurações → Agentes → Uso).',
  plan_read_failed: (c) => `O Maestri não conseguiu ler o uso do Claude (estado "${c.state}"${c.error ? `: ${c.error}` : ''}).`,
  plan_windows_missing: () => 'O Maestri ainda não trouxe as janelas do plano (5 h e semanal).',
  plan_windows_unavailable: (c) => [sub(c.window_5h_reason), sub(c.weekly_reason)].filter(Boolean).join(' '),
  plan_no_pct: () => 'Sem percentual do plano.',
  plan_last_read_failed: (c) => `A última consulta do Maestri falhou (estado "${c.state}"${c.error ? `: ${c.error}` : ''}); os valores são da leitura${c.read_at ? ` de ${shortTime(c.read_at)}` : ''}.`,
  window_missing: (c) => `O Maestri não trouxe a janela ${windowName(c.window)}.`,
  window_without_pct: (c) => `A janela ${windowName(c.window)} veio sem o percentual usado.`,
  window_reset: (c) => `A janela ${windowName(c.window)} reiniciou às ${shortTime(c.reset_at)}, depois da última leitura do Maestri${c.read_at ? ` (${shortTime(c.read_at)})` : ''}; o % novo aparece na próxima leitura.`,
  window_reset_since_read: (c) => `A janela ${windowName(c.window)} reiniciou às ${shortTime(c.reset_at)}; o % novo aparece na próxima leitura do Maestri.`,
  sessions_without_agent: (c) => `${c.count} sessão(ões) sem agente em state/sessions ficaram de fora.`,
  invalid_transcript_lines: (c) => `${c.count} linha(s) de transcrição ilegível(is) ignorada(s).`,
  transcript_unreadable: (c) => `Não consegui ler ${c.file}: ${c.error}`,
  transcript_read_interrupted: (c) => `Leitura interrompida em ${c.file}: ${c.error}`,
  registry_unreadable: (c) => `registro/agentes.json: ${sub(c.error)}`,
  // raw commands of the modal
  long_flow_days_cut: (c) => `fluxo com ${c.days} dias: o log bruto de ${c.cut} dia(s) do meio ficou de fora`,
  raw_files_pending: (c) => `${c.count} arquivo(s) do log bruto ainda não foram lidos (teto de leitura por consulta); abra de novo em instantes para completar`,
  // brain notice (pending decision answer)
  brain_notice_off: (c) => (c.variable ? `aviso desligado (${c.variable}=0)` : 'desligado'),
  brain_notice_no_terminal: () => 'o servidor não está rodando num terminal do Maestri',
  brain_notice_fixed_clock: () => 'relógio fixo (teste)',
  maestri_not_found: (c) => `não achei o maestri (${c.cli})`,
  spawn_failed: (c) => c.detail || 'falha ao chamar o maestri',
  mock_mode: () => 'modo de teste (?mock=1): nada foi gravado nem enviado',
  // request errors
  // The address is joined at run time: the build check refuses any literal URL in the page.
  host_not_allowed: (c) => `Host não permitido. Abra o painel em ${['http', `//127.0.0.1:${c.port}`].join(':')}.`,
  missing_panel_header: (c) => `POST exige o cabeçalho ${c.header}: 1.`,
  origin_not_allowed: () => 'Origem não permitida.',
  route_not_found: () => 'Rota não encontrada.',
  method_not_allowed: (c) => `Método ${c.method} não aceito aqui (use ${(c.allowed || []).join(' ou ')}).`,
  event_not_found: (c) => `Evento não encontrado: ${c.id}`,
  flow_not_found: (c) => `Fluxo não encontrado: ${c.id}`,
  not_implemented: () => 'Fase B: exige o Maestri Wire (ver §11.7)',
  body_too_large: (c) => `Corpo grande demais ou incompleto (até ${c.limit_kb} KB).`,
  internal_error: () => 'Erro interno do painel (detalhes no terminal do servidor).',
  invalid_param: (c) => `Parâmetro "${PARAM_NAMES[c.param] || c.param}" inválido: "${c.value}" (${c.expected === 'date' ? 'use AAAA-MM-DD' : 'use um inteiro a partir de 1'}).`,
  invalid_body: () => 'Corpo inválido: envie JSON {"option": "A", "text": "..."}.',
  invalid_option: () => 'Opção inválida: use a letra da opção (ex.: "A").',
  answer_too_long: (c) => `Resposta longa demais (até ${c.max} caracteres).`,
  answer_empty: () => 'Escolha uma opção ou escreva a resposta.',
  invalid_pending_decision_id: () => 'Id de pendência inválido (use P-NNNN).',
  pending_decision_not_found: (c) => `Pendência não encontrada: ${c.id}`,
  pending_decision_not_open: (c) => `${c.id} já está ${c.status}. Para mudar a resposta, fale com o Cérebro.`,
  option_not_found: (c) => `${c.id} não tem a opção ${c.option}.`,
  answer_command_failed: (c) => `pendencia.js responder falhou: ${c.detail}`,
};

const isCode = (v) => !!(v && typeof v === 'object' && !Array.isArray(v) && typeof v.code === 'string');

/** Portuguese text of a server code ({code, ...params}); unknown codes come back as the code itself. */
export function traduzir(c) {
  if (!isCode(c)) return c;
  const f = TEXTS[c.code];
  return f ? f(c) : c.code;
}

// Fields whose Portuguese name depends on the record (a pending decision is "atualizada", the plan "atualizado").
const PENDING_DECISION_FIELDS = { updated_at: 'atualizada_em' };

function adapt(v, key) {
  if (Array.isArray(v)) {
    const list = v.map((x) => adapt(x, key === 'pending_decisions' ? 'pending_decision' : null));
    return key === 'raw_commands_warnings' ? `${list.join('; ')}.` : list;
  }
  if (isCode(v) && TEXTS[v.code]) return traduzir(v);
  if (!v || typeof v !== 'object') {
    if (typeof v === 'string' && VALUES[key] && VALUES[key][v]) return VALUES[key][v];
    return v;
  }
  const out = {};
  const own = key === 'pending_decision' ? PENDING_DECISION_FIELDS : {};
  for (const [k, x] of Object.entries(v)) {
    let value;
    if (key === 'counts' && x && typeof x === 'object') value = { ...x }; // the facet keys are data (agents, types...)
    else if (k === 'source' && typeof x === 'string') value = REQUEST_SOURCES[x] || x;
    else value = adapt(x, k);
    const has = (m) => Object.prototype.hasOwnProperty.call(m, k);
    const name = has(own) ? own[k] : has(FIELDS) ? FIELDS[k] : k;
    Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** An API answer in the shape the screens read. */
export function paraTelas(resposta) {
  const r = adapt(resposta, null);
  // The pending decision KPI is grouped by severity in the API; the screens read it flat.
  const kp = r && r.kpis && r.kpis.pendencias;
  if (kp && kp.by_severity) {
    const { by_severity: porSeveridade, ...resto } = kp;
    r.kpis.pendencias = { ...resto, ...porSeveridade };
  }
  return r;
}

/** Query parameters built by the screens (Portuguese names) → the API's names. */
export function parametrosDaApi(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(params)) sp.set(EVENT_PARAMS[k] || k, v);
  return sp;
}
