'use strict';
// Tests for the page dictionary (ui/src/i18n), without a browser (ADR 0004):
//   1. the active language is a single configuration point, fixed in pt-BR;
//   2. t(key, params) interpolates, chooses the plural and never breaks on a missing key;
//   3. every code the server can return ({code, ...params}) has a translation, with the same texts as before;
//   4. every key the source uses exists in the dictionary, and every key in the dictionary is used;
//   5. no visible text is written straight into a component or screen: it all comes from the dictionary.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { assert, createSuite } = require('./util');

const REPO = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(REPO, 'panel', 'ui', 'src');
const I18N = path.join(SOURCE, 'i18n');
const suite = createSuite('i18n (pt-BR dictionary)');

/** .js/.jsx files of the app source: { relative path: text }. */
function readSource(dir = SOURCE, acc = {}) {
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) readSource(p, acc);
    else if (/\.(js|jsx)$/.test(n.name)) acc[path.relative(SOURCE, p).replace(/\\/g, '/')] = fs.readFileSync(p, 'utf8');
  }
  return acc;
}
const source = readSource();
const screensAndCode = Object.entries(source).filter(([f]) => !f.startsWith('i18n/'));

/** Leaf keys of a nested dictionary: ['app.loading', 'codes.hook_stale', ...]. */
function leafKeys(o, prefix = '', acc = []) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const isPlural = v && typeof v === 'object' && !Array.isArray(v) && typeof v.other === 'string';
    if (v && typeof v === 'object' && !isPlural) leafKeys(v, key, acc);
    else acc.push(key);
  }
  return acc;
}

/** Codes the server writes ({code: '...'}) in the API (pending decisions included) and the usage collector. */
function serverCodes() {
  const files = ['panel/server.js', 'panel/api-pending-decisions.js', 'panel/api-log.js', 'panel/api-projects.js', 'panel/api-overview.js', 'panel/health.js', 'bin/collect-usage.js'];
  const codes = new Set();
  for (const f of files) {
    for (const m of fs.readFileSync(path.join(REPO, f), 'utf8').matchAll(/\bcode: '([a-z][a-z0-9_]*)'/g)) codes.add(m[1]);
  }
  return codes;
}

/** Source without comments (a line comment only when it starts the line or follows a space). */
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

let i18n = null;
let dictionary = null;

suite.test('loads the dictionary module', async () => {
  i18n = await import(pathToFileURL(path.join(I18N, 'index.js')).href);
  dictionary = (await import(pathToFileURL(path.join(I18N, 'pt-BR.js')).href)).default;
  assert.strictEqual(typeof i18n.t, 'function');
  assert.strictEqual(typeof i18n.translateCode, 'function');
  assert.ok(dictionary && typeof dictionary === 'object');
});

suite.test('the active language is a single configuration point, fixed in pt-BR', async () => {
  const { LOCALE } = await import(pathToFileURL(path.join(I18N, 'locale.js')).href);
  assert.strictEqual(LOCALE, 'pt-BR');
  assert.strictEqual(i18n.LOCALE, 'pt-BR');
  // Only the configuration (locale.js) and the dictionary registry (index.js) name a language.
  const naming = Object.entries(source).filter(([, text]) => /['"`](pt-BR|en-US|en)['"`]/.test(text)).map(([f]) => f).sort();
  assert.deepStrictEqual(naming, ['i18n/index.js', 'i18n/locale.js']);
  // Dates and numbers follow the same configuration (Brazilian format).
  assert.ok(/import \{ LOCALE \} from '\.\.\/i18n\/locale\.js'/.test(source['data/format.js']), 'format.js reads the locale');
  const format = await import(pathToFileURL(path.join(SOURCE, 'data', 'format.js')).href);
  assert.strictEqual(format.number(1234567), '1.234.567');
  assert.strictEqual(format.pct(12.34), '12,3%');
  assert.strictEqual(format.date('2026-10-09T13:00:00Z'), '09/10/2026');
  assert.strictEqual(format.dateTime('2026-10-09T13:05:00Z'), '09/10/2026 10:05');
});

suite.test('t() interpolates parameters, chooses the plural and keeps a missing key visible', () => {
  const { t } = i18n;
  assert.strictEqual(t('log.page', { page: 2, pages: 7 }), 'Página 2 de 7');
  assert.strictEqual(t('log.eventCount', { count: 1 }), '1 evento');
  assert.strictEqual(t('log.eventCount', { count: 1500 }), '1.500 eventos');
  assert.strictEqual(t('time.ago.hoursMinutes', { hours: 2, minutes: 5 }), 'há 2 h 5 min');
  assert.strictEqual(t('no.such.key'), 'no.such.key');
  assert.strictEqual(i18n.has('log.page'), true);
  assert.strictEqual(i18n.has('no.such.key'), false);
});

suite.test('the relative times and durations keep the texts of before', async () => {
  const format = await import(pathToFileURL(path.join(SOURCE, 'data', 'format.js')).href);
  assert.strictEqual(format.elapsedText(0.2), 'agora');
  assert.strictEqual(format.elapsedText(4), 'há 4 min');
  assert.strictEqual(format.elapsedText(144), 'há 2 h 24 min');
  assert.strictEqual(format.elapsedText(120), 'há 2 h');
  assert.strictEqual(format.elapsedText(3 * 1440), 'há 3 d');
  assert.strictEqual(format.duration(42), '42 s');
  assert.strictEqual(format.duration(125), '2 min 5 s');
  assert.strictEqual(format.duration(3720), '1 h 02 min');
});

suite.test('every code the server can return has a pt-BR translation', () => {
  const codes = [...serverCodes()];
  assert.ok(codes.length >= 50, `codes found in the server: ${codes.length}`);
  const missing = codes.filter((c) => !i18n.has(`codes.${c}`));
  assert.deepStrictEqual(missing, [], `codes without translation: ${missing.join(', ')}`);
  // A code made only of other codes needs them to say anything.
  const params = { plan_windows_unavailable: { window_5h_reason: { code: 'plan_no_pct' } } };
  for (const code of codes) {
    const text = i18n.translateCode({ code, ...params[code] });
    assert.ok(typeof text === 'string' && text && text !== code, `translation of ${code}: ${text}`);
  }
  // Unknown codes come back as the code itself; anything that is not a code passes through.
  assert.strictEqual(i18n.translateCode({ code: 'brand_new_code' }), 'brand_new_code');
  assert.strictEqual(i18n.translateCode('texto livre'), 'texto livre');
  assert.strictEqual(i18n.display({ code: 'plan_no_pct' }), 'Sem percentual do plano.');
  assert.strictEqual(i18n.display(null), '');
});

suite.test('server codes keep the texts the page showed before', () => {
  const c = i18n.translateCode;
  // health of the new model (#14)
  assert.strictEqual(c({ code: 'hook_stale', last_raw_at: '2026-10-08T11:00:00-03:00', last_event_at: '2026-10-08T12:30:00-03:00', minutes: 1500 }),
    'Hook parado: nenhum registro no log bruto há 25 h, mas os agentes registraram trabalho em 08/10 12:30');
  assert.strictEqual(c({ code: 'hook_stale', last_raw_at: 'x', last_event_at: '2026-10-05T09:00:00-03:00', minutes: 3 * 1440 }),
    'Hook parado: nenhum registro no log bruto há 3 dias, mas os agentes registraram trabalho em 05/10 09:00');
  assert.strictEqual(c({ code: 'hook_never', last_event_at: '2026-10-05T09:00:00-03:00' }),
    'O hook nunca gravou no log bruto, mas os agentes registraram trabalho em 05/10 09:00 (hooks instalados?)');
  assert.strictEqual(c({ code: 'projects_unassigned', count: 1, projects: ['scratch'] }), '1 projeto em "Sem empresa" (scratch): escolha a empresa na tela Itens');
  assert.strictEqual(c({ code: 'projects_unassigned', count: 2, projects: ['scratch', 'bi'] }), '2 projetos em "Sem empresa" (scratch, bi): escolha a empresa na tela Itens');
  assert.strictEqual(c({ code: 'database_unreadable', file: 'bruto.db', detail: 'file is not a database' }), 'Não consegui ler o bruto.db (file is not a database)');
  assert.strictEqual(c({ code: 'file_unreadable', file: 'estado/pendencias.json', error: { code: 'invalid_json', detail: 'x' } }),
    'estado/pendencias.json ilegível (JSON inválido (x))');
  assert.strictEqual(c({ code: 'invalid_param', param: 'since', value: 'lixo', expected: 'date' }), 'Parâmetro "desde" inválido: "lixo" (use AAAA-MM-DD).');
  assert.strictEqual(c({ code: 'invalid_param', param: 'per_page', value: '0', expected: 'positive_integer' }),
    'Parâmetro "por_pagina" inválido: "0" (use um inteiro a partir de 1).');
  assert.strictEqual(c({ code: 'method_not_allowed', method: 'PUT', allowed: ['GET', 'POST'] }), 'Método PUT não aceito aqui (use GET ou POST).');
  assert.strictEqual(c({ code: 'plan_windows_unavailable', window_5h_reason: { code: 'window_missing', window: '5h' }, weekly_reason: { code: 'window_without_pct', window: 'weekly' } }),
    'O Maestri não trouxe a janela de 5 h. A janela semanal veio sem o percentual usado.');
  assert.strictEqual(c({ code: 'plan_read_failed', state: 'error', error: 'timeout' }), 'O Maestri não conseguiu ler o uso do Claude (estado "error": timeout).');
  assert.strictEqual(c({ code: 'event_lines_ignored', file: 'logs/eventos/2026-10.jsonl', count: 2 }),
    'logs/eventos/2026-10.jsonl: 2 linha(s) ilegível(is) ou sem id válido ignorada(s)');
  assert.strictEqual(c({ code: 'maestri_claude_provider' }), 'provedor Claude do Maestri');
  assert.strictEqual(c({ code: 'invalid_filter', param: 'severity', value: 'alta', allowed: ['critical', 'high', 'normal', 'low'] }),
    'Filtro "severity" inválido: "alta" (use critical, high, normal ou low).');
  // company and project (#6) by the names the person knows; the others (#10) as they are
  assert.strictEqual(c({ code: 'invalid_filter', param: 'project', value: 'X Y', allowed: null }), 'Filtro "projeto" inválido: "X Y".');
  assert.strictEqual(c({ code: 'invalid_filter', param: 'company', value: 'X Y' }), 'Filtro "empresa" inválido: "X Y".');
  assert.ok(/^Host não permitido\. Abra o painel em http:\/\/127\.0\.0\.1:4777\.$/.test(c({ code: 'host_not_allowed', port: 4777 })));
});

suite.test('every key the source uses exists, and every key of the dictionary is used', () => {
  const used = new Set();
  const prefixes = new Set();
  for (const [, text] of Object.entries(source)) {
    for (const m of text.matchAll(/\b(?:t|has)\(\s*'([^']+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/\b(?:t|has)\(\s*`([^`$]*)\$\{/g)) prefixes.add(m[1]);
  }
  const keys = leafKeys(dictionary);
  const known = new Set(keys);
  const missing = [...used].filter((k) => !known.has(k));
  assert.deepStrictEqual(missing, [], `keys used but missing in pt-BR: ${missing.join(', ')}`);
  const codes = serverCodes();
  const unused = keys.filter((k) => !used.has(k) && ![...prefixes].some((p) => p && k.startsWith(p))
    && !(k.startsWith('codes.') && codes.has(k.slice(6))));
  assert.deepStrictEqual(unused, [], `keys nobody uses: ${unused.join(', ')}`);
});

suite.test('no visible text is written straight into a component or screen', () => {
  const problems = [];
  for (const [file, raw] of screensAndCode) {
    // Identifiers and comments are in English: no Portuguese letter anywhere outside the dictionary.
    for (const m of raw.matchAll(/^.*[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÇ].*$/gm)) problems.push(`${file}: Portuguese letter: ${m[0].trim()}`);
    const code = withoutComments(raw);
    // Common Portuguese words inside string literals.
    for (const m of code.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      if (/\b(sem|para|com|da|dos|das|que|uma|ao|nao|nenhum|nenhuma)\b/i.test(m[2])) problems.push(`${file}: text in a string: ${m[0]}`);
    }
    if (!file.endsWith('.jsx')) continue;
    // JSX text right after a tag ("<span>Texto") or between expressions ("{a} de {b}").
    for (const m of code.matchAll(/(?<=["}\p{L}\d/])>([^<>{}\n]*)/gu)) {
      if (/\p{L}{2,}/u.test(m[1]) && !/^\s*(\)|,|;|&&|\|\||\?|:)/.test(m[1])) problems.push(`${file}: JSX text: >${m[1].trim()}`);
    }
    for (const m of code.matchAll(/\}([^<>{}\n;()=]*\p{L}{2,}[^<>{}\n;()=]*)</gu)) problems.push(`${file}: JSX text between expressions: }${m[1].trim()}<`);
    // Text props with a fixed string.
    for (const m of code.matchAll(/\b(title|label|info|placeholder|aria-label|extra|summary|sub|ariaLabel|heading|center)="([^"]*)"/g)) {
      if (/\p{L}/u.test(m[2])) problems.push(`${file}: fixed text in ${m[1]}="${m[2]}"`);
    }
  }
  assert.deepStrictEqual(problems, [], `\n${problems.join('\n')}`);
});

suite.test('the provisional bridge (compat.js) is gone and the old folders were renamed', () => {
  assert.ok(!fs.existsSync(path.join(SOURCE, 'dados')) && !fs.existsSync(path.join(SOURCE, 'data', 'compat.js')));
  for (const dir of ['telas', 'componentes', 'estilo']) assert.ok(!fs.existsSync(path.join(SOURCE, dir)), `ui/src/${dir} still exists`);
  for (const dir of ['app', 'components', 'data', 'i18n', 'screens', 'styles']) assert.ok(fs.existsSync(path.join(SOURCE, dir)), `ui/src/${dir}`);
});

suite.run();
