#!/usr/bin/env node
// Junta o build do Vite (dist/) num arquivo único e grava ../index.html, que o servidor.js serve.
// O servidor só serve "/", sem arquivos pelo nome, e a CSP só aceita script e estilo embutidos:
// o JS e o CSS entram no próprio HTML e as fontes já vêm como data: dentro do CSS.
//
//   node scripts/publicar.js              junta dist/ e grava ../index.html
//   node scripts/publicar.js --so-conferir confere o ../index.html atual (nada externo, um só script)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(AQUI, '..');
const DIST = path.join(UI, 'dist');
const DESTINO = path.resolve(UI, '..', 'index.html');
const SO_CONFERIR = process.argv.includes('--so-conferir');

// URLs que podem aparecer como texto no código (namespaces e links seguros); nenhuma é carregada.
const URLS_PERMITIDAS = [/^http:\/\/www\.w3\.org\//, /^https:\/\/trello\.com\//];

function falhar(msg) {
  console.error(`publicar: ${msg}`);
  process.exit(1);
}

function conferir(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) falhar(`esperava 1 <script>, achei ${scripts.length}`);
  if (/\bsrc\s*=/.test(scripts[0][1])) falhar('o <script> não pode ter src');
  if (/<link\b(?![^>]*rel="icon"[^>]*href="data:,")[^>]*>/i.test(html)) falhar('<link> externo no HTML');
  if (/@import|url\(\s*['"]?https?:/i.test(html)) falhar('@import ou url() externo no CSS');
  const urls = (html.match(/https?:\/\/[^\s"'`)<\\]+/g) || []).filter((u) => !URLS_PERMITIDAS.some((r) => r.test(u)));
  if (urls.length) falhar(`URLs inesperadas: ${[...new Set(urls)].join(' ')}`);
  if (/\beval\s*\(|new\s+Function\s*\(/.test(scripts[0][2])) falhar('eval ou new Function no bundle');
  return scripts[0][2].length;
}

if (SO_CONFERIR) {
  const html = fs.readFileSync(DESTINO, 'utf8');
  const js = conferir(html);
  console.log(`ok: ${path.relative(process.cwd(), DESTINO)} · ${(html.length / 1024).toFixed(1)} KB (JS ${(js / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const ler = (rel) => fs.readFileSync(path.join(DIST, rel.replace(/^\.?\//, '')), 'utf8');

const tagScript = /<script type="module" crossorigin src="([^"]+)"><\/script>/.exec(html);
if (!tagScript) falhar('não achei o <script> do bundle em dist/index.html');
const tagCss = /<link rel="stylesheet" crossorigin href="([^"]+)">/.exec(html);
if (!tagCss) falhar('não achei o CSS do bundle em dist/index.html');

const js = ler(tagScript[1]);
const css = ler(tagCss[1]);
if (/<\/script/i.test(js)) falhar('o bundle contém "</script": não dá para embutir');
if (/<\/style/i.test(css)) falhar('o CSS contém "</style": não dá para embutir');

html = html
  .replace(tagScript[0], '')
  .replace(tagCss[0], () => `<style>${css}</style>`)
  .replace('</body>', () => `<script type="module">${js}</script>\n</body>`)
  .replace('<!doctype html>', '<!doctype html>\n<!-- Gerado por painel/ui (npm run build). Não edite aqui: edite painel/ui/src e rode o build. -->');

const tamanhoJs = conferir(html);
fs.writeFileSync(DESTINO, html);
console.log(`publicado: ${DESTINO} · ${(html.length / 1024).toFixed(1)} KB (JS ${(tamanhoJs / 1024).toFixed(1)} KB, CSS ${(css.length / 1024).toFixed(1)} KB)`);
