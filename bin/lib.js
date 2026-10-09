'use strict';
/**
 * lib.js · shared functions of the bin/ commands (standard library only, CommonJS).
 *
 * Sections: paths and text · dates (America/Sao_Paulo) · command line (InvalidData, parseOptions) · standard input ·
 * secret redaction and truncation · output.
 * Used by the flow CLI (flow.js, flow-admin.js), the hook (hook-log.js), install-skills.js, the usage collector and the
 * server (asDate, spParts, isoSP: the only implementation of the São Paulo dates).
 *
 * Environment variable:
 *   MAESTRO_NOW   fixed date/time in ISO 8601. Tests only.
 *
 * Dates always with isoSP() (São Paulo offset). Never toISOString() in the data.
 * Messages for people come from the pt-BR dictionary (bin/i18n, ADR 0004).
 */
const fs = require('fs');

// =============================================================================================
// Paths and text
// =============================================================================================

/** Path with forward slashes (to show and to store). */
function slashes(p) {
  return String(p).replace(/\\/g, '/');
}

/** Removes accents (NFD without combining marks), keeping upper and lower case. */
function stripAccents(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Sanitizes a session_id (only letters, digits, _ and -). */
function safeSessionId(sessionId) {
  return String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
}

// =============================================================================================
// Dates in the America/Sao_Paulo time zone (Intl/ICU: if daylight saving returns, the offset follows)
// =============================================================================================

const TIME_ZONE = 'America/Sao_Paulo';
// Created on first use: loading the ICU time zone data costs ~20-40 ms per process.
let spFormatter = null;
const formatterSP = () => spFormatter || (spFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23', // midnight comes out as "00", never "24"
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  timeZoneName: 'longOffset', // "GMT-03:00" ("GMT" when the offset is zero)
}));

/** Current date/time (or MAESTRO_NOW, tests only). */
function now() {
  const fixed = process.env.MAESTRO_NOW;
  if (fixed) {
    const d = new Date(fixed);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** Valid Date from a Date, a number (ms) or ISO text; null if invalid. */
function asDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date parts in São Paulo: {year, month, day, hour, minute, second, offset:'-03:00'}. */
function spParts(date = now()) {
  const p = {};
  for (const { type, value } of formatterSP().formatToParts(date)) p[type] = value;
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.slice(3);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second, offset };
}

/**
 * ISO 8601 with the São Paulo offset, without milliseconds: 2026-10-08T15:41:02-03:00. Takes a Date, a number (ms) or
 * ISO text (now when absent); null when the date is invalid.
 */
function isoSP(value = now()) {
  const date = asDate(value);
  if (!date) return null;
  const p = spParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.offset}`;
}

// =============================================================================================
// Command line: invalid data (exit 2) and a small option parser
// =============================================================================================

/** Invalid arguments or data: the command ends with exit 2 and this message (a key of the pt-BR dictionary). */
class InvalidData extends Error {
  constructor(key, params = {}) {
    super(require('./i18n').t(key, params));
    this.key = key;
  }
}

/**
 * Options of a command line. spec: { name: 'flag' | 'value' }; a value comes as "--name v" or "--name=v" and a
 * "-h" is "--help" when spec has help. Anything not starting with "--" is positional. errors: dictionary keys for an
 * unknown option and for a value option without value (params: { option, value }). → { opts, positional }.
 * The flow CLI keeps its own parser (repeatable options and options per subcommand).
 */
function parseOptions(argv, spec, errors) {
  const opts = {};
  const positional = [];
  const known = (name) => Object.prototype.hasOwnProperty.call(spec, name);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] === '-h' && known('help') ? '--help' : argv[i];
    if (!a.startsWith('--') || a.length === 2) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq >= 0 ? eq : undefined);
    if (!known(name) || (spec[name] === 'flag' && eq >= 0)) throw new InvalidData(errors.unknown, { option: a, value: a });
    if (spec[name] === 'flag') {
      opts[name] = true;
      continue;
    }
    let value = eq >= 0 ? a.slice(eq + 1) : argv[i + 1];
    if (eq < 0) {
      if (value === undefined || (value.startsWith('--') && value.length > 2)) value = undefined;
      else i++;
    }
    if (value === undefined || value === '') throw new InvalidData(errors.missing, { option: name, value: '' });
    opts[name] = value;
  }
  return { opts, positional };
}

// =============================================================================================
// Standard input and text decoding
// =============================================================================================

const waitCell = new Int32Array(new SharedArrayBuffer(4));

/** Sleeps without burning CPU (on Windows, in practice, at least ~11-16 ms). */
function sleep(ms) {
  Atomics.wait(waitCell, 0, 0, Math.max(1, Math.round(ms)));
}

/** Decodes text bytes: UTF-8 (with or without BOM) or UTF-16 with BOM (PowerShell 5 files). */
function decodeText(buf) {
  if (typeof buf === 'string') return buf.replace(/^\uFEFF/, '');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const c = Buffer.from(buf.subarray(2, 2 + Math.floor((buf.length - 2) / 2) * 2));
    c.swap16();
    return c.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

/** true if the standard input is an interactive terminal (no pipe nor redirection). */
function stdinIsInteractive() {
  try { return require('tty').isatty(0); } catch { return false; }
}

/** Reads the whole standard input synchronously and returns a Buffer (empty if there is nothing). */
function readStdinSync() {
  const parts = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') { sleep(5); continue; }
      if (e.code === 'EOF') break; // Windows: pipe closed
      throw e;
    }
    if (n === 0) break;
    parts.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(parts);
}

// =============================================================================================
// Secret redaction and truncation
// =============================================================================================

const REDACTED_MARK = '«redigido»';
const SECRET_WORDS = String.raw`(?:password|passwd|passphrase|senha|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|token|secret|segredo)`;
// Quotes may come escaped (\" or \\\") when the text is JSON inside JSON or a command with echo "{\"...\"}".
const SECRET_KEY = String.raw`(\b[\w.-]*?` + SECRET_WORDS + String.raw`\b(?:\\*["'])?\s*[:=]\s*)`;
const AUTH_KEY = String.raw`(\bauthorization\b(?:\\*["'])?\s*[:=]\s*)`;
const ESCAPED_VALUE = String.raw`(\\+)"[^"\r\n]*?\\+"`; // \"value\" (escaped quotes)
const RE_AUTH_ESCAPED = new RegExp(AUTH_KEY + ESCAPED_VALUE, 'gi');
const RE_AUTH_DOUBLE = new RegExp(AUTH_KEY + String.raw`"(?:\\.|[^"\\\r\n])*"`, 'gi');
const RE_AUTH_SINGLE = new RegExp(AUTH_KEY + String.raw`'(?:\\.|[^'\\\r\n])*'`, 'gi');
const RE_AUTH_BARE = new RegExp(AUTH_KEY + String.raw`(?!\\*["'«])[^\r\n"'\\]+`, 'gi');
const RE_BEARER = /\b(Bearer)\s+(?!«)[A-Za-z0-9._~+/=-]+/gi;
const RE_KV_ESCAPED = new RegExp(SECRET_KEY + ESCAPED_VALUE, 'gi');
const RE_KV_DOUBLE = new RegExp(SECRET_KEY + String.raw`"(?:\\.|[^"\\\r\n])*"`, 'gi');
const RE_KV_SINGLE = new RegExp(SECRET_KEY + String.raw`'(?:\\.|[^'\\\r\n])*'`, 'gi');
const RE_KV_BARE = new RegExp(SECRET_KEY + String.raw`(?!\\*["'«])[^\s"'&,;)}\]\\]+`, 'gi');
const RE_SECRET_FLAG = new RegExp(String.raw`(--?[\w-]*?` + SECRET_WORDS + String.raw`)(\s+)("[^"\r\n]*"|'[^'\r\n]*'|(?![-<>|«])\S+)`, 'gi');
// Credential embedded in a URL: scheme://user:password@host.
const RE_URL_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'\\]+:)[^\s@/"'\\]+@/gi;
// Password glued to the short flag of the MySQL/MariaDB client: mysql -u root -pS3cret (capital -P is the port).
const RE_MYSQL_P = /(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\r\n|;&]*?\s-p)(?=[^\s-])\S+/g;
const RE_LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;
const RE_LONG_BASE64 = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
// "Readable" piece of a path, slug or identifier: short, a word (lower case, Capitalized, CamelCase,
// ACRONYM), a number or hex. A random base64 piece with 9+ characters almost never matches this.
const RE_READABLE_PIECE = /^(?:[A-Za-z0-9]{0,8}|\d+|[0-9a-f]+|[0-9A-F]+|(?:[A-Z]+|[A-Z]?[a-z]+)(?:[A-Z][a-z]+)*[A-Z]*\d*)$/;
const RE_SECRET_VAR_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|SENHA|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;
const RE_NON_SECRET_VAR_NAME = /(_PATH|_FILE|_DIR|_URL|_SOCKET|_HOST|_PORT)$/i;

/** Values of environment variables with a secret-like name (includes CLAUDE_CODE_MESSAGING_TOKEN), longest first. */
function envSecrets(env = process.env) {
  const values = [];
  for (const [name, value] of Object.entries(env || {})) {
    if (typeof value !== 'string' || value.length < 8) continue;
    if (name === 'CLAUDE_CODE_MESSAGING_TOKEN' || (RE_SECRET_VAR_NAME.test(name) && !RE_NON_SECRET_VAR_NAME.test(name))) values.push(value);
  }
  return values.sort((x, y) => y.length - x.length);
}

/**
 * Heuristic for a base64/base64url run of 40+ characters, judged WHOLE: it is a secret if it mixes at
 * least 2 classes (lower, upper, digit) and some piece between - _ / + is not readable (path, slug,
 * CamelCase, uuid). With '+' and the 3 classes, it is always a secret (paths almost never have '+').
 */
function looksSecret(run) {
  const s = run.replace(/=+$/, '');
  const classes = Number(/[a-z]/.test(s)) + Number(/[A-Z]/.test(s)) + Number(/\d/.test(s));
  if (classes < 2) return false;
  if (classes === 3 && s.includes('+')) return true;
  return s.split(/[-_/+]/).some((p) => !RE_READABLE_PIECE.test(p));
}

/** Replaces secrets with «redigido»: Authorization, Bearer, key=value (token, password, senha, api key...; also with escaped quotes), secret --flag, user:password@ in a URL, mysql -pSECRET, hex >= 32, base64 >= 40 and environment values. */
function redact(text, { env = process.env } = {}) {
  if (text === undefined || text === null) return text;
  let s = String(text);
  for (const v of envSecrets(env)) if (s.includes(v)) s = s.split(v).join(REDACTED_MARK);
  return s
    .replace(RE_URL_CREDENTIAL, `$1${REDACTED_MARK}@`)
    .replace(RE_MYSQL_P, `$1${REDACTED_MARK}`)
    .replace(RE_AUTH_ESCAPED, `$1$2"${REDACTED_MARK}$2"`)
    .replace(RE_AUTH_DOUBLE, `$1"${REDACTED_MARK}"`)
    .replace(RE_AUTH_SINGLE, `$1'${REDACTED_MARK}'`)
    .replace(RE_AUTH_BARE, `$1${REDACTED_MARK}`)
    .replace(RE_BEARER, `$1 ${REDACTED_MARK}`)
    .replace(RE_KV_ESCAPED, `$1$2"${REDACTED_MARK}$2"`)
    .replace(RE_KV_DOUBLE, `$1"${REDACTED_MARK}"`)
    .replace(RE_KV_SINGLE, `$1'${REDACTED_MARK}'`)
    .replace(RE_KV_BARE, `$1${REDACTED_MARK}`)
    .replace(RE_SECRET_FLAG, `$1$2${REDACTED_MARK}`)
    .replace(RE_LONG_HEX, REDACTED_MARK)
    .replace(RE_LONG_BASE64, (m) => (looksSecret(m) ? REDACTED_MARK : m));
}

// Object key whose value is a secret (access_token, apiKey, password, Authorization...), but not max_tokens.
const RE_SECRET_OBJECT_KEY = new RegExp(String.raw`^[\w.-]*?(?:` + SECRET_WORDS.slice(3, -1) + String.raw`|authorization|cookie|credentials?)$`, 'i');

/**
 * Redacts any JSON value BEFORE serializing: replaces with «redigido» the value of secret keys and
 * applies redact() to every text (so JSON embedded in a text shows up raw, with normal quotes).
 * To save time, cuts each text at "maxText" and stops descending after "budget" characters.
 */
function redactValue(value, { env = process.env, maxText = 1600, budget = 4000, depth = 8 } = {}) {
  const count = { left: budget };
  const walk = (v, level) => {
    if (count.left <= 0) return '…';
    if (typeof v === 'string') {
      const cut = v.length > maxText ? v.slice(0, maxText) : v;
      count.left -= cut.length;
      return redact(cut, { env });
    }
    if (v === null || typeof v !== 'object') { count.left -= 8; return v; }
    if (level >= depth) return '…';
    if (Array.isArray(v)) {
      const r = [];
      for (const x of v) {
        if (count.left <= 0) { r.push('…'); break; }
        r.push(walk(x, level + 1));
      }
      return r;
    }
    const r = {};
    for (const [k, x] of Object.entries(v)) {
      if (count.left <= 0) { r['…'] = '…'; break; }
      count.left -= k.length;
      r[k] = (RE_SECRET_OBJECT_KEY.test(k) && (typeof x === 'string' || typeof x === 'number') && x !== '') ? REDACTED_MARK : walk(x, level + 1);
    }
    return r;
  };
  return walk(value, 0);
}

/** Cuts the text to at most "max" characters, ending in "…[+N]" when cut (without splitting an emoji). */
function truncate(text, max, { total } = {}) {
  if (text === undefined || text === null) return text;
  const s = String(text);
  const size = total !== undefined ? total : s.length;
  if (!(max > 0) || (s.length <= max && size <= s.length)) return s;
  let cut = Math.min(s.length, max - `…[+${size}]`.length);
  if (cut <= 0) return s.slice(0, max);
  const cc = s.charCodeAt(cut - 1);
  if (cc >= 0xd800 && cc <= 0xdbff) cut--; // does not leave half a surrogate pair (emoji)
  return `${s.slice(0, cut)}…[+${size - cut}]`;
}

/** Redacts and truncates (redacts before cutting, so half a secret never slips through); huge texts are pre-cut. */
function summarize(text, max, options) {
  if (text === undefined || text === null) return text;
  const s = String(text);
  const preLimit = max * 4 + 400;
  const preCut = s.length > preLimit;
  const r = redact(preCut ? s.slice(0, preLimit) : s, options);
  if (!preCut) return truncate(r, max);
  return truncate(r, max, { total: r.length + (s.length - preLimit) });
}

// =============================================================================================
// Output
// =============================================================================================

/** Writes a line to standard output. */
function print(text = '') {
  process.stdout.write(`${text}\n`);
}

/** Writes a warning to standard error (does not change the exit code). */
function warn(text) {
  process.stderr.write(`${text}\n`);
}

module.exports = {
  // paths and text
  slashes, stripAccents, safeSessionId,
  // dates
  TIME_ZONE, now, asDate, spParts, isoSP,
  // command line
  InvalidData, parseOptions,
  // standard input
  decodeText, stdinIsInteractive, readStdinSync,
  // redaction and truncation
  REDACTED_MARK, envSecrets, looksSecret, redact, redactValue, truncate, summarize,
  // output
  print, warn,
};
