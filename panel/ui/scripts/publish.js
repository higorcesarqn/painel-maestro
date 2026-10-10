#!/usr/bin/env node
// Joins the Vite build (dist/) into a single file and writes ../index.html, which server.js serves.
// The server only serves "/", no files by name, and the CSP only accepts embedded script and style:
// the JS and the CSS go into the HTML itself and the fonts already come as data: inside the CSS.
//
//   node scripts/publish.js           joins dist/ and writes ../index.html
//   node scripts/publish.js --check   checks the current ../index.html (nothing external, a single script)
// The page id (#37): a hash of the joined page (16 hex characters of its sha256, with the line endings as LF, so a CRLF
// checkout gives the same id), written as <meta name="page-id"> in its <head>. The server answers the id of the
// current file in GET /api/state, and an open tab compares it with its own: a different id means a new page.
// An identical build gives the same id; removing the meta line gives back the hashed text.
// The messages are for whoever runs the build (CLI), in Portuguese like the other commands of the repository.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '..');
const DIST = path.join(UI, 'dist');
const TARGET = path.resolve(UI, '..', 'index.html');
const CHECK_ONLY = process.argv.includes('--check');

// URLs that may show up as text in the code (XML namespaces); none is loaded.
const ALLOWED_URLS = [/^http:\/\/www\.w3\.org\//];

const MESSAGES = {
  scripts: (n) => `esperava 1 <script>, achei ${n}`,
  scriptSrc: () => 'o <script> não pode ter src',
  externalLink: () => '<link> externo no HTML',
  externalCss: () => '@import ou url() externo no CSS',
  urls: (list) => `URLs inesperadas: ${list}`,
  evalUse: () => 'eval ou new Function no bundle',
  noScriptTag: () => 'não achei o <script> do bundle em dist/index.html',
  noCssTag: () => 'não achei o CSS do bundle em dist/index.html',
  scriptEnd: () => 'o bundle contém "</script": não dá para embutir',
  styleEnd: () => 'o CSS contém "</style": não dá para embutir',
  noHead: () => 'não achei o <head> em dist/index.html',
  pageId: (n) => `esperava 1 <meta name="page-id">, achei ${n}`,
  ok: (file, kb, jsKb) => `ok: ${file} · ${kb} KB (JS ${jsKb} KB)`,
  published: (file, kb, jsKb, cssKb) => `publicado: ${file} · ${kb} KB (JS ${jsKb} KB, CSS ${cssKb} KB)`,
  banner: () => '<!-- Gerado por panel/ui (npm run build). Não edite aqui: edite panel/ui/src e rode o build. -->',
};

function fail(msg) {
  console.error(`publish: ${msg}`);
  process.exit(1);
}

function check(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) fail(MESSAGES.scripts(scripts.length));
  if (/\bsrc\s*=/.test(scripts[0][1])) fail(MESSAGES.scriptSrc());
  if (/<link\b(?![^>]*rel="icon"[^>]*href="data:,")[^>]*>/i.test(html)) fail(MESSAGES.externalLink());
  if (/@import|url\(\s*['"]?https?:/i.test(html)) fail(MESSAGES.externalCss());
  const urls = (html.match(/https?:\/\/[^\s"'`)<\\]+/g) || []).filter((u) => !ALLOWED_URLS.some((r) => r.test(u)));
  if (urls.length) fail(MESSAGES.urls([...new Set(urls)].join(' ')));
  if (/\beval\s*\(|new\s+Function\s*\(/.test(scripts[0][2])) fail(MESSAGES.evalUse());
  const ids = html.match(/<meta name="page-id" content="[0-9a-f]{16}">/g) || [];
  if (ids.length !== 1) fail(MESSAGES.pageId(ids.length));
  return scripts[0][2].length;
}

const kb = (n) => (n / 1024).toFixed(1);

if (CHECK_ONLY) {
  const html = fs.readFileSync(TARGET, 'utf8');
  const js = check(html);
  console.log(MESSAGES.ok(path.relative(process.cwd(), TARGET), kb(html.length), kb(js)));
  process.exit(0);
}

let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const read = (rel) => fs.readFileSync(path.join(DIST, rel.replace(/^\.?\//, '')), 'utf8');

const scriptTag = /<script type="module" crossorigin src="([^"]+)"><\/script>/.exec(html);
if (!scriptTag) fail(MESSAGES.noScriptTag());
const cssTag = /<link rel="stylesheet" crossorigin href="([^"]+)">/.exec(html);
if (!cssTag) fail(MESSAGES.noCssTag());

const js = read(scriptTag[1]);
const css = read(cssTag[1]);
if (/<\/script/i.test(js)) fail(MESSAGES.scriptEnd());
if (/<\/style/i.test(css)) fail(MESSAGES.styleEnd());

html = html
  .replace(scriptTag[0], '')
  .replace(cssTag[0], () => `<style>${css}</style>`)
  .replace('</body>', () => `<script type="module">${js}</script>\n</body>`)
  .replace('<!doctype html>', () => `<!doctype html>\n${MESSAGES.banner()}`);
if (!html.includes('<head>')) fail(MESSAGES.noHead());
const pageId = crypto.createHash('sha256').update(html.replace(/\r*\n/g, '\n')).digest('hex').slice(0, 16);
html = html.replace('<head>', () => `<head>\n<meta name="page-id" content="${pageId}">`);

const jsSize = check(html);
fs.writeFileSync(TARGET, html);
console.log(MESSAGES.published(TARGET, kb(html.length), kb(jsSize), kb(css.length)));
